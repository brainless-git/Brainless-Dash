"""Spotify playback integration for Brainless-Dash."""
import base64
import json
import logging
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

log = logging.getLogger(__name__)

_CLIENT_ID     = os.environ.get("SPOTIFY_CLIENT_ID", "")
_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
# Empty string means "derive from the request host at auth time"
_REDIRECT_URI  = os.environ.get("SPOTIFY_REDIRECT_URI", "")
_TOKEN_FILE = Path(os.environ.get("SPOTIFY_TOKEN_FILE", "/tmp/spotify_token.json"))

_SCOPES       = "user-read-playback-state user-modify-playback-state user-read-recently-played"
_AUTHORIZE_URL = "https://accounts.spotify.com/authorize"
_TOKEN_URL     = "https://accounts.spotify.com/api/token"
_API_BASE      = "https://api.spotify.com/v1"

# ── Token state ─────────────────────────────────────────────────────────────────
_tok_lock      = threading.Lock()
_access_token  = ""
_refresh_token = ""
_token_expiry  = 0.0   # unix timestamp when the access token expires

# ── Playback poll state ─────────────────────────────────────────────────────────
_poll_lock   = threading.Lock()
_poll_result = None
_POLL_SEC    = 10

# ── Detail poll state ───────────────────────────────────────────────────────────
_detail_lock   = threading.Lock()
_detail_result = None
_DETAIL_POLL_SEC = 30

# ── OAuth CSRF state ────────────────────────────────────────────────────────────
_oauth_state         = ""
_effective_redirect  = ""   # set when auth URL is generated; reused in exchange_code


def _client_b64() -> str:
    return base64.b64encode(f"{_CLIENT_ID}:{_CLIENT_SECRET}".encode()).decode()


def _save_tokens() -> None:
    with _tok_lock:
        data = {"access_token": _access_token, "refresh_token": _refresh_token, "expiry": _token_expiry}
    try:
        _TOKEN_FILE.write_text(json.dumps(data))
        _TOKEN_FILE.chmod(0o600)  # restrict to owner only — token is sensitive
    except OSError as exc:
        log.debug("Could not save Spotify tokens: %s", exc)


def _load_tokens() -> None:
    global _access_token, _refresh_token, _token_expiry
    try:
        data = json.loads(_TOKEN_FILE.read_text())
        with _tok_lock:
            _access_token  = data.get("access_token", "")
            _refresh_token = data.get("refresh_token", "")
            _token_expiry  = float(data.get("expiry", 0))
    except (OSError, ValueError):
        pass


def _do_refresh() -> bool:
    """Exchange the refresh token for a new access token. Returns True on success."""
    global _access_token, _refresh_token, _token_expiry
    with _tok_lock:
        rt = _refresh_token
    if not rt:
        return False
    body = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": rt}).encode()
    req = urllib.request.Request(
        _TOKEN_URL, data=body, method="POST",
        headers={"Authorization": f"Basic {_client_b64()}", "Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception as exc:
        log.warning("Spotify token refresh failed: %s", exc)
        return False
    with _tok_lock:
        _access_token  = data.get("access_token", "")
        _token_expiry  = time.time() + data.get("expires_in", 3600) - 30
        if "refresh_token" in data:
            _refresh_token = data["refresh_token"]
    _save_tokens()
    return bool(_access_token)


def _valid_token() -> str:
    """Return a valid access token, refreshing if needed. Empty string means not authorised."""
    with _tok_lock:
        if _access_token and time.time() < _token_expiry:
            return _access_token
    _do_refresh()
    with _tok_lock:
        return _access_token


def exchange_code(code: str) -> bool:
    """Exchange an OAuth authorisation code for access + refresh tokens."""
    global _access_token, _refresh_token, _token_expiry
    # Must use the same redirect_uri that was sent in the authorisation request
    redirect = _effective_redirect or _REDIRECT_URI
    body = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect,
    }).encode()
    req = urllib.request.Request(
        _TOKEN_URL, data=body, method="POST",
        headers={"Authorization": f"Basic {_client_b64()}", "Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception as exc:
        log.warning("Spotify code exchange failed: %s", exc)
        return False
    with _tok_lock:
        _access_token  = data.get("access_token", "")
        _refresh_token = data.get("refresh_token", "")
        _token_expiry  = time.time() + data.get("expires_in", 3600) - 30
    _save_tokens()
    if not _access_token:
        return False
    # Immediately refresh the poll cache so the dashboard shows authorised
    # state as soon as the OAuth redirect lands back on the page.
    try:
        result = _fetch_playback()
        with _poll_lock:
            global _poll_result
            _poll_result = result
    except Exception:
        pass
    return True


def get_auth_url(base_url: str = "") -> str:
    """Return the Spotify OAuth URL. base_url is used to derive the redirect URI when
    SPOTIFY_REDIRECT_URI is not explicitly configured."""
    global _oauth_state, _effective_redirect
    _oauth_state = secrets.token_urlsafe(16)
    # If the user explicitly set SPOTIFY_REDIRECT_URI, always use that.
    # Otherwise derive it from the request's base URL so the callback goes
    # back to whatever host the browser used to reach the dashboard.
    if _REDIRECT_URI:
        _effective_redirect = _REDIRECT_URI
    elif base_url:
        _effective_redirect = base_url.rstrip("/") + "/api/spotify/callback"
    else:
        _effective_redirect = "http://localhost:8090/api/spotify/callback"
    params = urllib.parse.urlencode({
        "client_id": _CLIENT_ID,
        "response_type": "code",
        "redirect_uri": _effective_redirect,
        "scope": _SCOPES,
        "state": _oauth_state,
    })
    return f"{_AUTHORIZE_URL}?{params}"


def get_redirect_uri(base_url: str = "") -> str:
    """Return the redirect URI that will be used for OAuth, for display to the user."""
    if _REDIRECT_URI:
        return _REDIRECT_URI
    if base_url:
        return base_url.rstrip("/") + "/api/spotify/callback"
    return "http://localhost:8090/api/spotify/callback"


# ── Spotify Web API helpers ─────────────────────────────────────────────────────

def _api_get(path: str):
    token = _valid_token()
    if not token:
        return 401, None
    req = urllib.request.Request(f"{_API_BASE}{path}", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 204:
                return 204, None
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except Exception as exc:
        log.debug("Spotify GET %s: %s", path, exc)
        return 0, None


def _api_put(path: str, body=None) -> int:
    token = _valid_token()
    if not token:
        return 401
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        f"{_API_BASE}{path}", data=data, method="PUT",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except Exception as exc:
        log.debug("Spotify PUT %s: %s", path, exc)
        return 0


def _api_post(path: str, body=None) -> int:
    token = _valid_token()
    if not token:
        return 401
    data = json.dumps(body).encode() if body else b""
    req = urllib.request.Request(
        f"{_API_BASE}{path}", data=data, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except Exception as exc:
        log.debug("Spotify POST %s: %s", path, exc)
        return 0


# ── Image + track helpers ───────────────────────────────────────────────────────

def _pick_image(images: list) -> str:
    """Pick a reasonably-sized image URL from a Spotify images list (prefer width >= 100, else last)."""
    if not images:
        return ""
    for img in reversed(images):
        if (img.get("width") or 0) >= 100:
            return img.get("url", "")
    return images[-1].get("url", "")


def _fmt_track(item: dict) -> dict:
    """Format a Spotify track or episode item into a standardised dict."""
    item_type = item.get("type", "track")
    if item_type == "episode":
        name    = item.get("name", "")
        artist  = (item.get("show") or {}).get("name", "")
        album   = ""
        images  = (item.get("show") or {}).get("images") or []
    else:
        name    = item.get("name", "")
        artist  = ", ".join(a.get("name", "") for a in (item.get("artists") or []))
        album   = (item.get("album") or {}).get("name", "")
        images  = (item.get("album") or {}).get("images") or []
    return {
        "name":        name,
        "artist":      artist,
        "album":       album,
        "duration_ms": item.get("duration_ms") or 0,
        "art_url":     _pick_image(images),
        "type":        item_type,
    }


# ── Playback state ─────────────────────────────────────────────────────────────

# Last successful active-playback result, kept briefly so a transient API
# error (rate limit, 5xx, network blip) doesn't blank the card mid-song.
_last_active: dict | None = None
_last_active_ts = 0.0
_STALE_TOLERANCE = 60   # seconds


def _parse_playback(data: dict) -> dict:
    """Build the playback dict from a /me/player or /me/player/currently-playing payload."""
    item      = data.get("item") or {}
    item_type = data.get("currently_playing_type", "track")
    is_playing = data.get("is_playing", False)

    if item_type == "episode":
        track  = item.get("name", "")
        artist = (item.get("show") or {}).get("name", "")
        album  = ""
        images = (item.get("show") or {}).get("images") or []
    else:
        track  = item.get("name", "")
        artist = ", ".join(a.get("name", "") for a in (item.get("artists") or []))
        album  = (item.get("album") or {}).get("name", "")
        images = (item.get("album") or {}).get("images") or []

    # device/shuffle/repeat are absent from the currently-playing payload
    device = data.get("device") or {}

    return {
        "configured":    True,
        "authorized":    True,
        "active":        True,
        "is_playing":    is_playing,
        "track":         track,
        "artist":        artist,
        "album":         album,
        "art_url":       _pick_image(images),
        "progress_ms":   data.get("progress_ms") or 0,
        "duration_ms":   item.get("duration_ms") or 0,
        "shuffle":       data.get("shuffle_state", False),
        "repeat":        data.get("repeat_state", "off"),
        "volume":        device.get("volume_percent"),
        "device_name":   device.get("name", ""),
        "item_type":     item_type,
        "context":       data.get("context"),
    }


def _fetch_playback() -> dict:
    global _last_active, _last_active_ts
    with _tok_lock:
        has_refresh = bool(_refresh_token)
        has_access  = bool(_access_token)
    if not has_refresh and not has_access:
        return {"configured": True, "authorized": False}

    status1, d1 = _api_get("/me/player?additional_types=track,episode")
    if status1 == 401:
        return {"configured": True, "authorized": False}

    # Happy path: actively playing — /me/player has full device/shuffle/repeat context
    if status1 == 200 and d1 and d1.get("item") and d1.get("is_playing"):
        result = _parse_playback(d1)
        _last_active, _last_active_ts = result, time.time()
        return result

    # /me/player returned paused, no item, or 204. Fall back to
    # /me/player/currently-playing to catch Connect devices (TVs, speakers,
    # consoles) that report 204 or paused from /me/player while actively playing.
    if status1 in (200, 204):
        status2, d2 = _api_get("/me/player/currently-playing?additional_types=track,episode")
        if status2 == 401:
            return {"configured": True, "authorized": False}

        best = None
        if status2 == 200 and d2 and d2.get("item") and d2.get("is_playing"):
            # Connect device playing — use currently-playing, overlay device info from /me/player
            best = _parse_playback(d2)
            if status1 == 200 and d1 and d1.get("device"):
                dev = d1.get("device") or {}
                best["device_name"] = dev.get("name", "") or best["device_name"]
                if best["volume"] is None:
                    best["volume"] = dev.get("volume_percent")
                best["shuffle"] = d1.get("shuffle_state", best["shuffle"])
                best["repeat"]  = d1.get("repeat_state",  best["repeat"])
        elif status1 == 200 and d1 and d1.get("item"):
            best = _parse_playback(d1)  # paused on a regular device
        elif status2 == 200 and d2 and d2.get("item"):
            best = _parse_playback(d2)  # paused on a Connect device

        if best:
            _last_active, _last_active_ts = best, time.time()
            return best

        log.warning(
            "Spotify: idle — /me/player=%d (item=%s, playing=%s)"
            " /currently-playing=%d (item=%s, playing=%s)",
            status1, bool(d1 and d1.get("item")), bool(d1 and d1.get("is_playing")),
            status2, bool(d2 and d2.get("item")), bool(d2 and d2.get("is_playing")),
        )
        _last_active = None
        return {"configured": True, "authorized": True, "active": False}

    # /me/player returned a transient error (rate limit, 5xx, network error).
    # Hold the last known active state briefly rather than blanking the card mid-song.
    log.warning("Spotify: transient error — /me/player=%d", status1)
    if _last_active and time.time() - _last_active_ts < _STALE_TOLERANCE:
        return {**_last_active, "stale": True}
    return {"configured": True, "authorized": True, "active": False}


def _poll_worker() -> None:
    global _poll_result
    while True:
        try:
            result = _fetch_playback()
            with _poll_lock:
                _poll_result = result
        except Exception as exc:
            # Keep the previous result rather than clobbering it with idle
            log.warning("Spotify poll error: %s", exc)
        time.sleep(_POLL_SEC)


def get_playback():
    """Return current playback state dict, or None if Spotify is not configured."""
    global _poll_result
    if not _CLIENT_ID:
        return None
    with _poll_lock:
        if _poll_result is not None:
            return dict(_poll_result)
    # First call before the worker has run — fetch directly
    result = _fetch_playback()
    with _poll_lock:
        _poll_result = result
    return dict(result)


# ── Detail data ─────────────────────────────────────────────────────────────────

def _fetch_detail() -> dict:
    """Fetch queue, recently played, devices and context info."""
    # Queue
    queue = []
    status, data = _api_get("/me/player/queue")
    if status == 200 and data:
        for item in (data.get("queue") or [])[:5]:
            queue.append(_fmt_track(item))

    # Recently played
    recently_played = []
    recent_scope_missing = False
    status, data = _api_get("/me/player/recently-played?limit=15")
    if status == 403:
        recent_scope_missing = True
    elif status == 200 and data:
        for history_item in (data.get("items") or []):
            track_data = history_item.get("track") or {}
            if not track_data:
                continue
            fmt = _fmt_track(track_data)
            fmt["played_at"] = history_item.get("played_at", "")
            recently_played.append(fmt)

    # Devices
    devices = []
    status, data = _api_get("/me/player/devices")
    if status == 200 and data:
        for dev in (data.get("devices") or []):
            devices.append({
                "id":        dev.get("id", ""),
                "name":      dev.get("name", ""),
                "type":      dev.get("type", ""),
                "is_active": dev.get("is_active", False),
                "volume":    dev.get("volume_percent"),
            })

    # Context
    context = {}
    status, pb_data = _api_get("/me/player?additional_types=track,episode")
    if status == 200 and pb_data:
        raw_ctx = pb_data.get("context") or {}
        ctx_type = raw_ctx.get("type", "")
        ctx_uri  = raw_ctx.get("uri", "")
        if ctx_type and ctx_uri:
            ctx_id = ctx_uri.split(":")[-1] if ":" in ctx_uri else ""
            ctx_name  = ""
            ctx_owner = ""
            if ctx_type == "playlist" and ctx_id:
                s2, pdata = _api_get(f"/playlists/{ctx_id}?fields=name,owner(display_name)")
                if s2 == 200 and pdata:
                    ctx_name  = pdata.get("name", "")
                    ctx_owner = (pdata.get("owner") or {}).get("display_name", "")
            elif ctx_type == "album" and ctx_id:
                s2, adata = _api_get(f"/albums/{ctx_id}")
                if s2 == 200 and adata:
                    ctx_name = adata.get("name", "")
            elif ctx_type == "artist" and ctx_id:
                s2, ardata = _api_get(f"/artists/{ctx_id}")
                if s2 == 200 and ardata:
                    ctx_name = ardata.get("name", "")
            context = {"type": ctx_type, "name": ctx_name, "owner": ctx_owner}

    return {
        "queue":               queue,
        "recently_played":     recently_played,
        "recent_scope_missing": recent_scope_missing,
        "devices":             devices,
        "context":             context,
    }


def _detail_worker() -> None:
    global _detail_result
    while True:
        try:
            with _tok_lock:
                has_token = bool(_refresh_token) or bool(_access_token)
            if has_token:
                result = _fetch_detail()
                with _detail_lock:
                    _detail_result = result
        except Exception as exc:
            log.warning("Spotify detail poll error: %s", exc)
        time.sleep(_DETAIL_POLL_SEC)


def get_detail() -> dict | None:
    """Return combined playback + detail data, or None if Spotify is not configured."""
    if not _CLIENT_ID:
        return None
    pb = get_playback()
    with _detail_lock:
        det = dict(_detail_result) if _detail_result is not None else {}
    return {
        "playback":            pb,
        "queue":               det.get("queue", []),
        "recently_played":     det.get("recently_played", []),
        "recent_scope_missing": det.get("recent_scope_missing", False),
        "devices":             det.get("devices", []),
        "context":             det.get("context", {}),
    }


def spotify_action(action: str, **kwargs) -> dict:
    """Perform a Spotify playback action. Returns {"ok": bool, "error": str|None}."""
    token = _valid_token()
    if not token:
        return {"ok": False, "error": "not authorised"}

    try:
        if action == "play":
            code = _api_put("/me/player/play")
        elif action == "pause":
            code = _api_put("/me/player/pause")
        elif action == "next":
            code = _api_post("/me/player/next")
        elif action == "previous":
            code = _api_post("/me/player/previous")
        elif action == "shuffle":
            state = "true" if kwargs.get("state") else "false"
            code = _api_put(f"/me/player/shuffle?state={state}")
        elif action == "repeat":
            mode = kwargs.get("mode", "off")
            if mode not in ("off", "context", "track"):
                return {"ok": False, "error": "invalid repeat mode"}
            code = _api_put(f"/me/player/repeat?state={mode}")
        elif action == "volume":
            vol = max(0, min(100, int(kwargs.get("volume_percent", 50))))
            code = _api_put(f"/me/player/volume?volume_percent={vol}")
        elif action == "seek":
            pos = max(0, int(kwargs.get("position_ms", 0)))
            code = _api_put(f"/me/player/seek?position_ms={pos}")
        elif action == "transfer":
            device_id = str(kwargs.get("device_id", ""))
            if not device_id:
                return {"ok": False, "error": "device_id required"}
            code = _api_put("/me/player", {"device_ids": [device_id], "play": True})
        else:
            return {"ok": False, "error": "unknown action"}
    except Exception as exc:
        log.warning("Spotify action %s failed: %s", action, exc)
        return {"ok": False, "error": str(exc)}

    if code in (200, 204):
        # Immediately refresh the cached state so the next poll reflects the change
        try:
            result = _fetch_playback()
            with _poll_lock:
                global _poll_result
                _poll_result = result
        except Exception:
            pass
        return {"ok": True, "error": None}
    return {"ok": False, "error": f"Spotify returned HTTP {code}"}


# ── Startup ─────────────────────────────────────────────────────────────────────

if _CLIENT_ID:
    _load_tokens()
    threading.Thread(target=_poll_worker, daemon=True, name="spotify-poller").start()
    threading.Thread(target=_detail_worker, daemon=True, name="spotify-detail-poller").start()

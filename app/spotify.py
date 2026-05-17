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
_TOKEN_FILE = Path("/tmp/spotify_token.json")

_SCOPES       = "user-read-playback-state user-modify-playback-state"
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
_POLL_SEC    = 5

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
    return bool(_access_token)


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


# ── Playback state ─────────────────────────────────────────────────────────────

def _fetch_playback() -> dict:
    with _tok_lock:
        has_refresh = bool(_refresh_token)
        has_access  = bool(_access_token)
    if not has_refresh and not has_access:
        return {"configured": True, "authorized": False}

    status, data = _api_get("/me/player?additional_types=track,episode")
    if status == 401:
        return {"configured": True, "authorized": False}
    if status == 204 or not data:
        return {"configured": True, "authorized": True, "active": False}

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

    # Pick a reasonably-sized image; Spotify returns images largest-first
    art_url = ""
    for img in reversed(images):
        if (img.get("width") or 0) >= 100:
            art_url = img.get("url", "")
            break
    if not art_url and images:
        art_url = images[-1].get("url", "")

    device = data.get("device") or {}

    return {
        "configured":    True,
        "authorized":    True,
        "active":        True,
        "is_playing":    is_playing,
        "track":         track,
        "artist":        artist,
        "album":         album,
        "art_url":       art_url,
        "progress_ms":   data.get("progress_ms") or 0,
        "duration_ms":   item.get("duration_ms") or 0,
        "shuffle":       data.get("shuffle_state", False),
        "repeat":        data.get("repeat_state", "off"),
        "volume":        device.get("volume_percent"),
        "device_name":   device.get("name", ""),
        "item_type":     item_type,
    }


def _poll_worker() -> None:
    global _poll_result
    while True:
        try:
            result = _fetch_playback()
        except Exception as exc:
            log.warning("Spotify poll error: %s", exc)
            result = {"configured": True, "authorized": True, "active": False}
        with _poll_lock:
            _poll_result = result
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

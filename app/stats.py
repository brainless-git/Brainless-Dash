"""System statistics collection for Unraid monitoring."""
import json
import logging
import os
import re
import signal
import socket
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import psutil
from datetime import date, timedelta
from pathlib import Path

log = logging.getLogger(__name__)

# ── Runtime config ─────────────────────────────────────────────────────────────
_PLEX_URL   = os.environ.get("PLEX_URL",   "http://localhost:32400").rstrip("/")
_PLEX_TOKEN = os.environ.get("PLEX_TOKEN", "")
_SONARR_URL     = os.environ.get("SONARR_URL",     "http://localhost:8989").rstrip("/")
_SONARR_API_KEY = os.environ.get("SONARR_API_KEY", "")
_SABNZBD_URL     = os.environ.get("SABNZBD_URL",     "http://localhost:8080").rstrip("/")
_SABNZBD_API_KEY = os.environ.get("SABNZBD_API_KEY", "")
_QB_URL      = os.environ.get("QB_URL",      "http://localhost:8080").rstrip("/")
_QB_USERNAME = os.environ.get("QB_USERNAME", "admin")
_QB_PASSWORD = os.environ.get("QB_PASSWORD", "")
_QB_API_KEY  = os.environ.get("QB_API_KEY",  "")
_ACME_DOMAIN         = os.environ.get("ACME_DOMAIN",         "")
_ACME_CHALLENGE_PORT = os.environ.get("ACME_CHALLENGE_PORT", "8180")
_ACME_CERTDIR        = "/data/certs"

_MC_HOST          = os.environ.get("MC_HOST",          "")
_MC_PORT          = int(os.environ.get("MC_PORT",          "25565"))
_MC_RCON_PORT     = int(os.environ.get("MC_RCON_PORT",     "25575"))
_MC_RCON_PASSWORD = os.environ.get("MC_RCON_PASSWORD", "")
_MC_LOG_PATH      = os.environ.get("MC_LOG_PATH",      "")

# Matches vanilla/Paper/Spigot chat and server-say lines in latest.log
_MC_CHAT_RE  = re.compile(r'^\[(\d{2}:\d{2}:\d{2})\] \[Server thread/INFO\](?:\[.*?\])?: <([^>]+)> (.+)$')
_MC_SERVER_RE = re.compile(r'^\[(\d{2}:\d{2}:\d{2})\] \[Server thread/INFO\](?:\[.*?\])?: \[Server\] (.+)$')


def _check_service_url(name, url):
    """Warn at startup if a service URL has an unexpected scheme."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        log.warning("%s has an unexpected URL (expected http or https): %s", name, url)


if _PLEX_TOKEN:                 _check_service_url("PLEX_URL",    _PLEX_URL)
if _SONARR_API_KEY:             _check_service_url("SONARR_URL",  _SONARR_URL)
if _SABNZBD_API_KEY:            _check_service_url("SABNZBD_URL", _SABNZBD_URL)
if _QB_API_KEY or _QB_PASSWORD: _check_service_url("QB_URL",      _QB_URL)

# ── Values that never change: computed once at startup ─────────────────────────
try:
    _HOSTNAME = os.uname().nodename
except AttributeError:
    import socket
    _HOSTNAME = socket.gethostname()

_CPU_CORES   = psutil.cpu_count(logical=False) or psutil.cpu_count()
_CPU_THREADS = psutil.cpu_count(logical=True)
_MEM_TOTAL   = psutil.virtual_memory().total
_BOOT_TIME   = psutil.boot_time()

# ── CPU chip temperature filtering ─────────────────────────────────────────────
_CPU_CHIPS = {"k10temp", "coretemp", "zenpower"}
_CPU_PACKAGE_PRIORITY = [
    "tctl", "tdie",
    "package id 0", "package id 1",
    "physical id 0", "physical id 1",
    "cpu temperature", "cpu",
]

# ── Network rate state ─────────────────────────────────────────────────────────
_net_cache = {"time": None, "bytes_sent": 0, "bytes_recv": 0}


# ── CPU ────────────────────────────────────────────────────────────────────────

def get_cpu():
    pct = psutil.cpu_percent(interval=None)
    freq = psutil.cpu_freq()
    try:
        load = os.getloadavg()
    except (AttributeError, OSError):
        load = (0.0, 0.0, 0.0)
    return {
        "percent":  round(pct, 1),
        "cores":    _CPU_CORES,
        "threads":  _CPU_THREADS,
        "freq_mhz": round(freq.current) if freq else None,
        "load_1m":  round(load[0], 2),
        "load_5m":  round(load[1], 2),
        "load_15m": round(load[2], 2),
    }


# ── Memory ─────────────────────────────────────────────────────────────────────

def get_memory():
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    return {
        "total":      _MEM_TOTAL,
        "used":       vm.used,
        "available":  vm.available,
        "percent":    vm.percent,
        "swap_total":   sw.total,
        "swap_used":    sw.used,
        "swap_percent": sw.percent,
    }


# ── Temperatures ───────────────────────────────────────────────────────────────

def _best_cpu_temp(entries):
    valid = [e for e in entries if e.current is not None]
    if not valid:
        return None
    by_label = {e.label.strip().lower(): e for e in valid}
    for key in _CPU_PACKAGE_PRIORITY:
        if key in by_label:
            return by_label[key]
    return max(valid, key=lambda e: e.current)


def get_temps():
    """CPU chips collapsed to one representative reading; all others listed."""
    sensors = []
    try:
        temps = psutil.sensors_temperatures()
    except (AttributeError, OSError):
        return sensors

    cpu_entry = None
    for chip, entries in temps.items():
        if chip.lower() in _CPU_CHIPS:
            if cpu_entry is None:
                best = _best_cpu_temp(entries)
                if best is not None:
                    cpu_entry = {
                        "chip": chip, "label": "CPU",
                        "current": round(best.current, 1),
                        "high": best.high, "critical": best.critical,
                    }
        else:
            for entry in entries:
                if entry.current is None:
                    continue
                sensors.append({
                    "chip": chip, "label": entry.label or chip,
                    "current": round(entry.current, 1),
                    "high": entry.high, "critical": entry.critical,
                })

    if cpu_entry:
        sensors.insert(0, cpu_entry)
    return sensors


# ── Storage ────────────────────────────────────────────────────────────────────

def _read_mdstat():
    path = Path("/proc/mdstat")
    if not path.exists():
        return None
    try:
        return path.read_text()
    except OSError:
        return None


def get_storage():
    disks = []
    seen = set()
    mnt = Path("/mnt")
    unraid_mounts = []
    if mnt.is_dir():
        for child in sorted(mnt.iterdir()):
            # user and user0 are union-filesystem views of the whole array —
            # including them alongside individual disks double-counts capacity.
            if child.name.startswith(("disk", "cache")):
                unraid_mounts.append(str(child))

    candidates = unraid_mounts or [
        p.mountpoint for p in psutil.disk_partitions(all=False)
        if p.fstype and not p.mountpoint.startswith(("/proc", "/sys", "/dev"))
    ]

    for path in candidates:
        if path in seen:
            continue
        seen.add(path)
        try:
            usage = psutil.disk_usage(path)
        except (PermissionError, OSError):
            continue
        disks.append({
            "mount":   path,
            "name":    os.path.basename(path) or path,
            "total":   usage.total,
            "used":    usage.used,
            "free":    usage.free,
            "percent": usage.percent,
        })

    return {"disks": disks, "array_status": _read_mdstat()}


# ── Network ────────────────────────────────────────────────────────────────────

def get_network():
    counters = psutil.net_io_counters(pernic=True)
    now = time.time()
    iface_names = []
    total_sent = 0
    total_recv = 0

    for name, c in counters.items():
        if name == "lo" or name.startswith(("docker", "veth", "br-")):
            continue
        iface_names.append(name)
        total_sent += c.bytes_sent
        total_recv += c.bytes_recv

    rate_sent = 0.0
    rate_recv = 0.0
    if _net_cache["time"] is not None:
        delta = now - _net_cache["time"]
        if delta > 0:
            rate_sent = max(0, (total_sent - _net_cache["bytes_sent"]) / delta)
            rate_recv = max(0, (total_recv - _net_cache["bytes_recv"]) / delta)

    _net_cache["time"] = now
    _net_cache["bytes_sent"] = total_sent
    _net_cache["bytes_recv"] = total_recv

    return {
        "interfaces":    [{"name": n} for n in iface_names],
        "rate_sent_bps": rate_sent,
        "rate_recv_bps": rate_recv,
    }


# ── Plex (background-polled, non-blocking) ─────────────────────────────────────

_plex_lock   = threading.Lock()
_plex_result = None


def _fetch_plex():
    url = f"{_PLEX_URL}/status/sessions"
    req = urllib.request.Request(url, headers={"X-Plex-Token": _PLEX_TOKEN, "Accept": "application/xml"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            root = ET.fromstring(resp.read())
    except Exception as exc:
        log.warning("Plex request failed: %s", exc)
        return {"available": False, "stream_count": 0, "sessions": [], "error": "upstream request failed"}

    sessions = []
    for item in root.findall("Video") + root.findall("Track") + root.findall("Photo"):
        media_type  = item.get("type", "")
        view_offset = int(item.get("viewOffset") or 0)
        duration    = int(item.get("duration") or 0)
        progress    = round(view_offset / duration * 100, 1) if duration else 0
        user_el     = item.find("User")
        player_el   = item.find("Player")
        sessions.append({
            "title":       item.get("title", ""),
            "show":        item.get("grandparentTitle") if media_type == "episode" else None,
            "type":        media_type,
            "user":        user_el.get("title", "unknown") if user_el is not None else "unknown",
            "player":      player_el.get("title", "") if player_el is not None else "",
            "state":       player_el.get("state", "") if player_el is not None else "",
            "transcoding": item.find("TranscodeSession") is not None,
            "progress_pct": progress,
        })
    return {"available": True, "stream_count": len(sessions), "sessions": sessions}


def _plex_worker():
    global _plex_result
    while True:
        result = _fetch_plex()
        with _plex_lock:
            _plex_result = result
        time.sleep(15)


def get_plex_sessions():
    if not _PLEX_TOKEN:
        return None
    with _plex_lock:
        return _plex_result


if _PLEX_TOKEN:
    threading.Thread(target=_plex_worker, daemon=True, name="plex-poller").start()


# ── Sonarr (background-polled, non-blocking) ───────────────────────────────────

_sonarr_lock   = threading.Lock()
_sonarr_result = None


def _fetch_sonarr():
    today = date.today()
    end   = today + timedelta(days=5)
    url = (
        f"{_SONARR_URL}/api/v3/calendar"
        f"?start={today.isoformat()}&end={end.isoformat()}"
        f"&includeSeries=true"
    )
    req = urllib.request.Request(url, headers={"X-Api-Key": _SONARR_API_KEY})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            items = json.loads(resp.read())
    except Exception as exc:
        log.warning("Sonarr request failed: %s", exc)
        return {"available": False, "episodes": [], "error": "upstream request failed"}

    day_labels = {
        today.isoformat(): "Today",
        (today + timedelta(days=1)).isoformat(): "Tomorrow",
    }
    for i in range(2, 5):
        d = today + timedelta(days=i)
        day_labels[d.isoformat()] = d.strftime("%A")

    episodes = []
    for item in items:
        air_date = item.get("airDate", "")
        if not air_date:
            continue
        series = item.get("series") or {}
        show   = series.get("title") or item.get("seriesTitle", "")
        episodes.append({
            "show":      show,
            "season":    item.get("seasonNumber"),
            "episode":   item.get("episodeNumber"),
            "title":     item.get("title", ""),
            "air_date":  air_date,
            "day_label": day_labels.get(air_date, air_date),
            "downloaded": bool(item.get("hasFile")),
        })

    episodes.sort(key=lambda e: (e["air_date"], e["show"]))
    return {"available": True, "episodes": episodes}


def _sonarr_worker():
    global _sonarr_result
    while True:
        result = _fetch_sonarr()
        with _sonarr_lock:
            _sonarr_result = result
        time.sleep(300)


def get_sonarr_calendar():
    if not _SONARR_API_KEY:
        return None
    with _sonarr_lock:
        return _sonarr_result


if _SONARR_API_KEY:
    threading.Thread(target=_sonarr_worker, daemon=True, name="sonarr-poller").start()


# ── SABnzbd (background-polled, non-blocking) ─────────────────────────────────

_sabnzbd_lock   = threading.Lock()
_sabnzbd_result = None


def _fetch_sabnzbd():
    # Use apikey query param: SABnzbd's X-API-Key header is not honoured by
    # all versions/endpoints (5.0.1 returns 403 for queue mode with the header
    # but accepts the query param). Redact the key from exception messages so
    # it never lands in logs.
    url = f"{_SABNZBD_URL}/api?mode=queue&output=json&apikey={_SABNZBD_API_KEY}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=5) as resp:
            data = json.loads(resp.read())
    except Exception as exc:
        msg = str(exc).replace(_SABNZBD_API_KEY, "***") if _SABNZBD_API_KEY else str(exc)
        log.warning("SABnzbd request failed: %s", msg)
        return {"available": False, "error": "upstream request failed"}

    q = data.get("queue", {})
    slots = q.get("slots", [])
    return {
        "available":   True,
        "status":      q.get("status", "Unknown"),
        "speed":       q.get("speed", "0"),       # formatted string e.g. "1.23 MB"
        "size_left":   q.get("sizeleft", "0 B"),  # formatted string
        "queue_count": int(q.get("noofslots", 0)),
        "slots": [
            {
                "filename": s.get("filename", ""),
                "status":   s.get("status", ""),
                "percent":  float(s.get("percentage", 0)),
            }
            for s in slots[:5]
        ],
    }


def _sabnzbd_worker():
    global _sabnzbd_result
    while True:
        result = _fetch_sabnzbd()
        with _sabnzbd_lock:
            _sabnzbd_result = result
        time.sleep(10)


def get_sabnzbd():
    if not _SABNZBD_API_KEY:
        return None
    with _sabnzbd_lock:
        return _sabnzbd_result


if _SABNZBD_API_KEY:
    threading.Thread(target=_sabnzbd_worker, daemon=True, name="sabnzbd-poller").start()


# ── qBittorrent (background-polled, non-blocking) ──────────────────────────────

_qb_lock   = threading.Lock()
_qb_result = None
_qb_sid    = ""  # used only when falling back to username/password auth

_QB_DL_STATES   = {"downloading", "stalledDL", "queuedDL", "checkingDL", "forcedDL", "metaDL", "allocating"}
_QB_SEED_STATES = {"uploading", "seeding", "stalledUP", "queuedUP", "checkingUP", "forcedUP"}


def _qb_headers():
    """Return auth headers. API key (qBittorrent 5+) takes priority over SID cookie."""
    if _QB_API_KEY:
        return {"Authorization": f"Bearer {_QB_API_KEY}"}
    return {"Cookie": f"SID={_qb_sid}"}


def _qb_login():
    global _qb_sid
    data = urllib.parse.urlencode({"username": _QB_USERNAME, "password": _QB_PASSWORD}).encode()
    req  = urllib.request.Request(
        f"{_QB_URL}/api/v2/auth/login", data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.read().decode().strip() == "Ok.":
                for name, val in resp.headers.items():
                    if name.lower() == "set-cookie" and "SID=" in val:
                        _qb_sid = val.split("SID=")[1].split(";")[0]
                        return True
    except Exception as exc:
        log.warning("qBittorrent login failed: %s", exc)
    return False


def _qb_get(path):
    req = urllib.request.Request(f"{_QB_URL}{path}", headers=_qb_headers())
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


def _fetch_qbittorrent():
    global _qb_sid
    # Cookie-based auth needs a valid SID before the first request.
    if not _QB_API_KEY and not _qb_sid and not _qb_login():
        return {"available": False, "error": "authentication failed"}

    def _attempt():
        return _qb_get("/api/v2/transfer/info"), _qb_get("/api/v2/torrents/info")

    try:
        transfer, torrents = _attempt()
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403) and not _QB_API_KEY:
            # SID expired — re-authenticate once
            _qb_sid = ""
            if not _qb_login():
                return {"available": False, "error": "authentication failed"}
            try:
                transfer, torrents = _attempt()
            except Exception as exc2:
                log.warning("qBittorrent request failed after re-auth: %s", exc2)
                return {"available": False, "error": "upstream request failed"}
        else:
            log.warning("qBittorrent request failed: %s", exc)
            return {"available": False, "error": "upstream request failed"}
    except Exception as exc:
        log.warning("qBittorrent request failed: %s", exc)
        return {"available": False, "error": "upstream request failed"}

    states = [t.get("state", "") for t in torrents]
    return {
        "available":   True,
        "dl_speed":    transfer.get("dl_info_speed", 0),
        "ul_speed":    transfer.get("ul_info_speed", 0),
        "downloading": sum(1 for s in states if s in _QB_DL_STATES),
        "seeding":     sum(1 for s in states if s in _QB_SEED_STATES),
        "paused":      sum(1 for s in states if "paused" in s),
        "total":       len(torrents),
    }


def _qb_worker():
    global _qb_result
    while True:
        result = _fetch_qbittorrent()
        with _qb_lock:
            _qb_result = result
        time.sleep(10)


def get_qbittorrent():
    if not _QB_API_KEY and not _QB_PASSWORD:
        return None
    with _qb_lock:
        return _qb_result


if _QB_API_KEY or _QB_PASSWORD:
    threading.Thread(target=_qb_worker, daemon=True, name="qb-poller").start()


# ── Minecraft server status ────────────────────────────────────────────────────

_mc_lock   = threading.Lock()
_mc_result = None


def _mc_varint(n):
    """Encode a non-negative integer as a Minecraft protocol varint."""
    b = b''
    n &= 0xFFFFFFFF
    while True:
        part = n & 0x7F
        n >>= 7
        b += bytes([part | (0x80 if n else 0)])
        if not n:
            return b


def _mc_read_varint(data, pos):
    n, shift = 0, 0
    while pos < len(data):
        byte = data[pos]; pos += 1
        n |= (byte & 0x7F) << shift
        shift += 7
        if not (byte & 0x80):
            return n, pos
    raise ValueError("varint truncated")


def _mc_recv_all(sock, n):
    buf = b''
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise EOFError("connection closed")
        buf += chunk
    return buf


def _mc_motd(desc):
    """Extract plain text from a Minecraft description field."""
    if isinstance(desc, str):
        text = desc
    elif isinstance(desc, dict):
        text = desc.get("text", "")
        for extra in desc.get("extra", []):
            if isinstance(extra, dict):
                text += extra.get("text", "")
            elif isinstance(extra, str):
                text += extra
    else:
        return ""
    return re.sub(r'§.', '', text).strip()


def _fetch_minecraft():
    try:
        with socket.create_connection((_MC_HOST, _MC_PORT), timeout=3) as s:
            host_b = _MC_HOST.encode('utf-8')
            payload = (
                _mc_varint(0x00) +
                _mc_varint(0) +
                _mc_varint(len(host_b)) + host_b +
                struct.pack('>H', _MC_PORT) +
                _mc_varint(1)
            )
            s.sendall(_mc_varint(len(payload)) + payload)
            s.sendall(b'\x01\x00')

            # Read response length varint byte by byte
            length, shift = 0, 0
            while True:
                byte = s.recv(1)
                if not byte:
                    raise EOFError("connection closed")
                b = byte[0]
                length |= (b & 0x7F) << shift
                shift += 7
                if not (b & 0x80):
                    break

            pkt = _mc_recv_all(s, length)
            _, pos = _mc_read_varint(pkt, 0)          # skip packet ID
            str_len, pos = _mc_read_varint(pkt, pos)
            status = json.loads(pkt[pos:pos + str_len])
    except Exception as exc:
        log.debug("Minecraft ping failed: %s", exc)
        return {"online": False, "error": "server unreachable", "log_enabled": bool(_MC_LOG_PATH)}

    players  = status.get("players", {})
    sample   = players.get("sample") or []
    return {
        "online":         True,
        "version":        status.get("version", {}).get("name", ""),
        "motd":           _mc_motd(status.get("description", "")),
        "players_online": players.get("online", 0),
        "players_max":    players.get("max", 0),
        "players":        [p["name"] for p in sample if "name" in p],
        "rcon_enabled":   bool(_MC_RCON_PASSWORD),
        "log_enabled":    bool(_MC_LOG_PATH),
    }


def _mc_worker():
    global _mc_result
    while True:
        result = _fetch_minecraft()
        with _mc_lock:
            _mc_result = result
        time.sleep(30)


def get_minecraft():
    if not _MC_HOST:
        return None
    with _mc_lock:
        return _mc_result


def send_mc_chat(message):
    """Send a message to the server via RCON. Returns (ok, error_str)."""
    if not _MC_RCON_PASSWORD:
        return False, "RCON not configured"
    # Strip control characters to prevent RCON command injection via newline chaining.
    message = re.sub(r'[\x00-\x1f\x7f]', '', message)
    if not message:
        return False, "message is empty"
    try:
        with socket.create_connection((_MC_HOST, _MC_RCON_PORT), timeout=5) as s:
            def _recv_exact(n):
                d = b''
                while len(d) < n:
                    chunk = s.recv(n - len(d))
                    if not chunk:
                        raise EOFError("connection closed")
                    d += chunk
                return d

            def _rcon(req_id, ptype, body):
                body_b = body.encode('utf-8') + b'\x00\x00'
                s.sendall(struct.pack('<iii', len(body_b) + 8, req_id, ptype) + body_b)
                # Some servers (Paper, Spigot) send extra packets before the real response.
                # Try up to 3 reads to find the packet whose ID matches what we sent.
                for _ in range(3):
                    length = struct.unpack('<i', _recv_exact(4))[0]
                    if not (10 <= length <= 4096):
                        raise ValueError(f"RCON: unexpected response length {length}")
                    payload = _recv_exact(length)
                    resp_id  = struct.unpack('<i', payload[:4])[0]
                    resp_body = payload[8:].rstrip(b'\x00').decode('utf-8', errors='replace')
                    if resp_id == -1 or resp_id == req_id:
                        return resp_id, resp_body
                    log.debug("RCON: discarding stale packet id=%d (waiting for %d)", resp_id, req_id)
                raise ValueError("RCON: no matching response after 3 packets")

            resp_id, _ = _rcon(1, 3, _MC_RCON_PASSWORD)
            if resp_id == -1:
                return False, "RCON authentication failed — check MC_RCON_PASSWORD"
            _, resp_body = _rcon(2, 2, f"say {message}")
            if resp_body:
                log.debug("RCON say response: %r", resp_body)
            return True, None
    except Exception as exc:
        log.warning("RCON error: %s", exc)
        return False, "RCON command failed"


if _MC_HOST:
    threading.Thread(target=_mc_worker, daemon=True, name="mc-poller").start()


def get_mc_log():
    """Return recent chat lines from the Minecraft server log file (last 50 entries)."""
    if not _MC_LOG_PATH:
        return None
    path = Path(_MC_LOG_PATH)
    if not path.exists():
        return []
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 65536))
            raw = f.read().decode('utf-8', errors='replace').splitlines()
        lines = []
        for line in raw[-300:]:
            m = _MC_CHAT_RE.match(line)
            if m:
                lines.append({"time": m.group(1), "player": m.group(2), "msg": m.group(3)})
                continue
            m = _MC_SERVER_RE.match(line)
            if m:
                lines.append({"time": m.group(1), "player": "[Server]", "msg": m.group(2)})
        return lines[-50:]
    except OSError as exc:
        log.warning("MC log read error: %s", exc)
        return []


# ── ACME auto-renewal ──────────────────────────────────────────────────────────

def _acme_renewal_worker():
    """Check weekly; renew cert if needed; restart process so uvicorn loads new cert."""
    cert_path = f"{_ACME_CERTDIR}/live/{_ACME_DOMAIN}/fullchain.pem"
    while True:
        time.sleep(86400 * 7)  # check every 7 days
        try:
            mtime_before = Path(cert_path).stat().st_mtime if Path(cert_path).exists() else 0
            result = subprocess.run(
                [
                    "certbot", "renew",
                    "--config-dir", _ACME_CERTDIR,
                    "--work-dir",   "/tmp/certbot/work",
                    "--logs-dir",   "/tmp/certbot/logs",
                    "--non-interactive", "--quiet",
                ],
                capture_output=True, text=True, timeout=120,
            )
            if result.returncode != 0:
                log.warning("certbot renew failed: %s", result.stderr.strip())
                continue
            mtime_after = Path(cert_path).stat().st_mtime if Path(cert_path).exists() else 0
            if mtime_after > mtime_before:
                log.info("Certificate renewed — restarting to apply new cert")
                os.kill(os.getpid(), signal.SIGTERM)
        except Exception as exc:
            log.warning("ACME renewal error: %s", exc)


if _ACME_DOMAIN:
    threading.Thread(target=_acme_renewal_worker, daemon=True, name="acme-renewal").start()


# ── Aggregator ─────────────────────────────────────────────────────────────────

def collect_all():
    result = {
        "timestamp": int(time.time()),
        "hostname":  _HOSTNAME,
        "uptime":    int(time.time() - _BOOT_TIME),
        "cpu":       get_cpu(),
        "memory":    get_memory(),
        "temps":     get_temps(),
        "storage":   get_storage(),
        "network":   get_network(),
    }
    plex = get_plex_sessions()
    if plex is not None:
        result["plex"] = plex
    sonarr = get_sonarr_calendar()
    if sonarr is not None:
        result["sonarr"] = sonarr
    sabnzbd = get_sabnzbd()
    if sabnzbd is not None:
        result["sabnzbd"] = sabnzbd
    qb = get_qbittorrent()
    if qb is not None:
        result["qbittorrent"] = qb
    mc = get_minecraft()
    if mc is not None:
        result["minecraft"] = mc
    return result

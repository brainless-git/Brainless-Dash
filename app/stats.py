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
_MC_DATA_DIR      = os.environ.get("MC_DATA_DIR",          "")
_MC_RCON_PORT     = int(os.environ.get("MC_RCON_PORT",     "25575"))
_MC_RCON_PASSWORD = os.environ.get("MC_RCON_PASSWORD",     "")

_WEATHER_UNITS = os.environ.get("WEATHER_UNITS", "metric")  # metric | imperial



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

# Motherboard superio / embedded controller chip name prefixes.
# Only these + CPU chips are shown in the temperature view.
_MOBO_CHIP_PREFIXES = (
    "nct", "it8", "w83", "f718", "smsc", "gpio_fan",
    "asus_wmi", "asusec", "nuvoton",
)

# ── Network rate state ─────────────────────────────────────────────────────────
_net_cache = {"time": None, "bytes_sent": 0, "bytes_recv": 0}
_net_iface_prev = {}  # name → (bytes_sent, bytes_recv)


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
    """CPU chips collapsed to one representative reading; motherboard chips listed."""
    sensors = []
    try:
        temps = psutil.sensors_temperatures()
    except (AttributeError, OSError):
        return sensors

    cpu_entry = None
    for chip, entries in temps.items():
        chip_lower = chip.lower()
        if chip_lower in _CPU_CHIPS:
            if cpu_entry is None:
                best = _best_cpu_temp(entries)
                if best is not None:
                    cpu_entry = {
                        "chip": chip, "label": "CPU",
                        "current": round(best.current, 1),
                        "high": best.high, "critical": best.critical,
                    }
        elif chip_lower.startswith(_MOBO_CHIP_PREFIXES):
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


def get_fans():
    """Return fan speed readings for fans with RPM > 0."""
    fans = []
    try:
        fan_data = psutil.sensors_fans()
    except (AttributeError, OSError):
        return fans
    for chip, entries in (fan_data or {}).items():
        for entry in entries:
            if entry.current is None or entry.current <= 0:
                continue
            fans.append({
                "chip":  chip,
                "label": entry.label or chip,
                "rpm":   round(entry.current),
            })
    return fans


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

    fstype_map = {}
    try:
        for p in psutil.disk_partitions(all=True):
            fstype_map[p.mountpoint] = p.fstype
    except Exception:
        pass

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
            "fstype":  fstype_map.get(path, ""),
        })

    return {"disks": disks, "array_status": _read_mdstat()}


# ── Network ────────────────────────────────────────────────────────────────────

def get_network():
    counters = psutil.net_io_counters(pernic=True)
    now = time.time()
    ifaces = []
    total_sent = 0
    total_recv = 0

    delta = 0.0
    if _net_cache["time"] is not None:
        delta = now - _net_cache["time"]

    for name, c in counters.items():
        if name == "lo" or name.startswith(("docker", "veth", "br-")):
            continue
        total_sent += c.bytes_sent
        total_recv += c.bytes_recv

        rate_s = 0.0
        rate_r = 0.0
        if name in _net_iface_prev and delta > 0:
            ps, pr = _net_iface_prev[name]
            rate_s = max(0, (c.bytes_sent - ps) / delta)
            rate_r = max(0, (c.bytes_recv - pr) / delta)
        _net_iface_prev[name] = (c.bytes_sent, c.bytes_recv)

        ifaces.append({
            "name":          name,
            "rate_sent_bps": rate_s,
            "rate_recv_bps": rate_r,
            "bytes_sent":    c.bytes_sent,
            "bytes_recv":    c.bytes_recv,
        })

    rate_sent = 0.0
    rate_recv = 0.0
    if _net_cache["time"] is not None and delta > 0:
        rate_sent = max(0, (total_sent - _net_cache["bytes_sent"]) / delta)
        rate_recv = max(0, (total_recv - _net_cache["bytes_recv"]) / delta)

    _net_cache["time"]       = now
    _net_cache["bytes_sent"] = total_sent
    _net_cache["bytes_recv"] = total_recv

    return {
        "interfaces":       ifaces,
        "rate_sent_bps":    rate_sent,
        "rate_recv_bps":    rate_recv,
        "total_bytes_sent": total_sent,
        "total_bytes_recv": total_recv,
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
        transcode_el = item.find("TranscodeSession")
        sessions.append({
            "title":       item.get("title", ""),
            "show":        item.get("grandparentTitle") if media_type == "episode" else None,
            "season":      item.get("parentIndex") if media_type == "episode" else None,
            "episode":     item.get("index") if media_type == "episode" else None,
            "year":        item.get("year", ""),
            "type":        media_type,
            "library":     item.get("librarySectionTitle", ""),
            "user":        user_el.get("title", "unknown") if user_el is not None else "unknown",
            "player":      player_el.get("title", "") if player_el is not None else "",
            "platform":    player_el.get("platform", "") if player_el is not None else "",
            "address":     player_el.get("address", "") if player_el is not None else "",
            "state":       player_el.get("state", "") if player_el is not None else "",
            "transcoding": transcode_el is not None,
            "transcode_reason": transcode_el.get("transcodeReason", "") if transcode_el is not None else "",
            "video_decision": transcode_el.get("videoDecision", "") if transcode_el is not None else "directplay",
            "audio_decision": transcode_el.get("audioDecision", "") if transcode_el is not None else "directplay",
            "duration":    duration,
            "view_offset": view_offset,
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
    end   = today + timedelta(days=14)
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
    for i in range(2, 15):
        d = today + timedelta(days=i)
        day_labels[d.isoformat()] = d.strftime("%A, %d %b")

    episodes = []
    for item in items:
        air_date = item.get("airDate", "")
        if not air_date:
            continue
        series = item.get("series") or {}
        show   = series.get("title") or item.get("seriesTitle", "")
        episodes.append({
            "show":       show,
            "network":    series.get("network", ""),
            "season":     item.get("seasonNumber"),
            "episode":    item.get("episodeNumber"),
            "title":      item.get("title", ""),
            "overview":   item.get("overview", ""),
            "air_date":   air_date,
            "air_time":   item.get("airDateUtc", ""),
            "runtime":    item.get("runtime", 0),
            "day_label":  day_labels.get(air_date, air_date),
            "downloaded": bool(item.get("hasFile")),
            "monitored":  bool(item.get("monitored")),
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
        "time_left":   q.get("timeleft", ""),     # formatted string e.g. "0:12:34"
        "mb_left":     q.get("mbleft", "0"),
        "mb":          q.get("mb", "0"),
        "queue_count": int(q.get("noofslots", 0)),
        "paused":      bool(q.get("paused", False)),
        "diskspace1":  q.get("diskspace1", ""),
        "diskspace2":  q.get("diskspace2", ""),
        "slots": [
            {
                "filename": s.get("filename", ""),
                "status":   s.get("status", ""),
                "percent":  float(s.get("percentage", 0)),
                "size":     s.get("size", ""),
                "size_left": s.get("sizeleft", ""),
                "time_left": s.get("timeleft", ""),
                "category":  s.get("cat", ""),
                "priority":  s.get("priority", ""),
            }
            for s in slots
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
    # Surface the most interesting torrents first: active downloads, then seeding,
    # then anything else. Cap to keep the payload bounded on busy clients.
    def _rank(t):
        st = t.get("state", "")
        if st in _QB_DL_STATES: return 0
        if st in _QB_SEED_STATES: return 1
        return 2
    sorted_torrents = sorted(torrents, key=lambda t: (_rank(t), -t.get("dlspeed", 0)))
    torrent_list = [
        {
            "hash":      t.get("hash", ""),
            "name":      t.get("name", ""),
            "state":     t.get("state", ""),
            "progress":  round(float(t.get("progress", 0)) * 100, 1),
            "size":      t.get("size", 0),
            "downloaded": t.get("downloaded", 0),
            "dl_speed":  t.get("dlspeed", 0),
            "ul_speed":  t.get("upspeed", 0),
            "eta":       t.get("eta", 0),
            "ratio":     round(float(t.get("ratio", 0)), 2),
            "category":  t.get("category", ""),
            "num_seeds": t.get("num_seeds", 0),
            "num_leechs": t.get("num_leechs", 0),
        }
        for t in sorted_torrents[:100]
    ]
    return {
        "available":   True,
        "dl_speed":    transfer.get("dl_info_speed", 0),
        "ul_speed":    transfer.get("ul_info_speed", 0),
        "dl_total":    transfer.get("dl_info_data", 0),
        "ul_total":    transfer.get("up_info_data", 0),
        "downloading": sum(1 for s in states if s in _QB_DL_STATES),
        "seeding":     sum(1 for s in states if s in _QB_SEED_STATES),
        "paused":      sum(1 for s in states if "paused" in s),
        "total":       len(torrents),
        "torrents":    torrent_list,
    }


_QB_ACTIONS = {
    "recheck":    "/api/v2/torrents/recheck",
    "reannounce": "/api/v2/torrents/reannounce",
}


def qb_action(action, hashes):
    """Trigger a qBittorrent action on one or more torrents.

    hashes may be the string "all" or an iterable of hash strings. Returns
    {"ok": bool, "error": str|None}.
    """
    if not _QB_API_KEY and not _QB_PASSWORD:
        return {"ok": False, "error": "qbittorrent not configured"}
    path = _QB_ACTIONS.get(action)
    if not path:
        return {"ok": False, "error": "unknown action"}

    if isinstance(hashes, str):
        if hashes != "all":
            return {"ok": False, "error": "invalid hashes value"}
        payload = "all"
    else:
        cleaned = [h for h in hashes if isinstance(h, str) and re.fullmatch(r"[0-9a-fA-F]{40}", h)]
        if not cleaned:
            return {"ok": False, "error": "no valid hashes provided"}
        payload = "|".join(cleaned)

    global _qb_sid
    if not _QB_API_KEY and not _qb_sid and not _qb_login():
        return {"ok": False, "error": "authentication failed"}

    def _post():
        data = urllib.parse.urlencode({"hashes": payload}).encode()
        req = urllib.request.Request(
            f"{_QB_URL}{path}", data=data, method="POST",
            headers={**_qb_headers(), "Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status

    try:
        _post()
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403) and not _QB_API_KEY:
            _qb_sid = ""
            if not _qb_login():
                return {"ok": False, "error": "authentication failed"}
            try:
                _post()
            except Exception as exc2:
                log.warning("qBittorrent %s failed after re-auth: %s", action, exc2)
                return {"ok": False, "error": "upstream request failed"}
        else:
            log.warning("qBittorrent %s failed: %s", action, exc)
            return {"ok": False, "error": "upstream request failed"}
    except Exception as exc:
        log.warning("qBittorrent %s failed: %s", action, exc)
        return {"ok": False, "error": "upstream request failed"}
    return {"ok": True, "error": None}


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

_mc_lock          = threading.Lock()
_mc_result        = None
_mc_player_times: dict = {}   # player_name → accumulated seconds seen online
_mc_count_history: list = []  # rolling player-count samples (one per poll)
_MC_POLL_INTERVAL = 30
_MC_HISTORY_MAX   = 240       # 2 hours at 30 s/sample


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
    # Strip § colour/format codes but preserve newlines for multi-line MOTDs.
    return re.sub(r'§.', '', text).strip('\r\t ').strip('\n').strip()


def _mc_read_varint_sock(sock):
    """Read a Minecraft varint directly from a socket."""
    n, shift = 0, 0
    while True:
        byte = sock.recv(1)
        if not byte:
            raise EOFError("connection closed")
        b = byte[0]
        n |= (b & 0x7F) << shift
        shift += 7
        if not (b & 0x80):
            return n


def _read_mc_ops():
    """Return list of {uuid, name, level} from <MC_DATA_DIR>/ops.json, or []."""
    if not _MC_DATA_DIR:
        return []
    path = Path(_MC_DATA_DIR) / "ops.json"
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    out = []
    for entry in data:
        if isinstance(entry, dict) and entry.get("name"):
            out.append({
                "uuid": entry.get("uuid", ""),
                "name": entry["name"],
                "level": entry.get("level", 4),
            })
    return out


def _read_mc_properties():
    """Return {gamemode, hardcore, difficulty, ...} from server.properties, or {}."""
    if not _MC_DATA_DIR:
        return {}
    path = Path(_MC_DATA_DIR) / "server.properties"
    try:
        text = path.read_text()
    except OSError:
        return {}
    props = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        props[k.strip()] = v.strip()
    return {
        "gamemode":   props.get("gamemode", ""),
        "hardcore":   props.get("hardcore", "").lower() == "true",
        "difficulty": props.get("difficulty", ""),
        "pvp":        props.get("pvp", "").lower() == "true",
        "max_players": props.get("max-players", ""),
        "level_name":  props.get("level-name", ""),
        "motd":        props.get("motd", ""),
    }


def _mc_data_dir_diag():
    """Inspect MC_DATA_DIR. Returned in /api/minecraft so users can see why
    the ops list or mod count are empty."""
    diag = {
        "configured":   bool(_MC_DATA_DIR),
        "path":         _MC_DATA_DIR,
        "exists":       False,
        "readable":     False,
        "has_mods_dir": False,
        "has_ops_json": False,
        "has_properties": False,
    }
    if not _MC_DATA_DIR:
        return diag
    p = Path(_MC_DATA_DIR)
    try:
        diag["exists"] = p.is_dir()
    except OSError:
        return diag
    if not diag["exists"]:
        return diag
    try:
        # Touch the dir to verify read permission
        next(p.iterdir(), None)
        diag["readable"] = True
    except (OSError, StopIteration):
        diag["readable"] = False
    diag["has_mods_dir"]   = (p / "mods").is_dir()
    diag["has_ops_json"]   = (p / "ops.json").is_file()
    diag["has_properties"] = (p / "server.properties").is_file()
    return diag


def _count_mods_on_disk():
    """Count *.jar files in <MC_DATA_DIR>/mods/. Returns (count, [names])."""
    if not _MC_DATA_DIR:
        return 0, []
    mods_dir = Path(_MC_DATA_DIR) / "mods"
    try:
        jars = sorted(p.name for p in mods_dir.iterdir() if p.suffix == ".jar")
    except OSError:
        return 0, []
    # Strip the version suffix where it's the conventional "name-1.2.3.jar" form.
    names = [re.sub(r'-[0-9].*\.jar$', '', j) or j for j in jars]
    return len(jars), names


# ── Minecraft RCON ─────────────────────────────────────────────────────────────

_RCON_AUTH = 3
_RCON_EXEC = 2
_RCON_RESP = 0


def _rcon_send(sock, req_id, ptype, body):
    payload = struct.pack('<ii', req_id, ptype) + body.encode('utf-8') + b'\x00\x00'
    sock.sendall(struct.pack('<i', len(payload)) + payload)


def _rcon_recv(sock):
    raw_len = _mc_recv_all(sock, 4)
    (length,) = struct.unpack('<i', raw_len)
    if length < 10 or length > 4096:
        raise ValueError("invalid rcon length")
    data = _mc_recv_all(sock, length)
    req_id, ptype = struct.unpack('<ii', data[:8])
    body = data[8:-2].decode('utf-8', errors='replace')
    return req_id, ptype, body


def mc_rcon(command):
    """Run a single RCON command. Returns {"ok": bool, "response": str, "error": str|None}."""
    if not _MC_HOST:
        return {"ok": False, "response": "", "error": "MC_HOST not set"}
    if not _MC_RCON_PASSWORD:
        return {"ok": False, "response": "", "error": "MC_RCON_PASSWORD not set"}
    try:
        with socket.create_connection((_MC_HOST, _MC_RCON_PORT), timeout=5) as s:
            s.settimeout(5)
            _rcon_send(s, 1, _RCON_AUTH, _MC_RCON_PASSWORD)
            # The Source RCON spec allows the server to emit an empty
            # SERVERDATA_RESPONSE_VALUE before the SERVERDATA_AUTH_RESPONSE.
            # Loop until we see the auth response (or the request id of -1).
            auth_ok = False
            for _ in range(2):
                req_id, ptype, _body = _rcon_recv(s)
                if req_id == -1:
                    return {"ok": False, "response": "", "error": "auth failed (wrong password?)"}
                if ptype == _RCON_EXEC:        # AUTH_RESPONSE uses the same value as EXEC (2)
                    auth_ok = True
                    break
            if not auth_ok:
                return {"ok": False, "response": "", "error": "auth handshake failed"}
            _rcon_send(s, 2, _RCON_EXEC, command)
            _, _, body = _rcon_recv(s)
            return {"ok": True, "response": body, "error": None}
    except socket.timeout:
        log.warning("RCON timed out connecting to %s:%s", _MC_HOST, _MC_RCON_PORT)
        return {"ok": False, "response": "", "error": f"timed out ({_MC_HOST}:{_MC_RCON_PORT})"}
    except ConnectionRefusedError:
        return {"ok": False, "response": "",
                "error": f"connection refused on {_MC_HOST}:{_MC_RCON_PORT} (enable-rcon=true?)"}
    except OSError as exc:
        log.warning("RCON network error: %s", exc)
        return {"ok": False, "response": "", "error": f"network error: {exc}"}
    except Exception as exc:
        log.warning("RCON command failed: %s", exc)
        return {"ok": False, "response": "", "error": "rcon request failed"}


_MC_PLAYER_NAME_RE = re.compile(r'^[A-Za-z0-9_]{1,16}$')


def mc_op_action(action, player):
    """Run /op <player> or /deop <player>. action must be 'op' or 'deop'."""
    if action not in ("op", "deop"):
        return {"ok": False, "error": "unknown action"}
    if not _MC_PLAYER_NAME_RE.match(player or ""):
        return {"ok": False, "error": "invalid player name"}
    return mc_rcon(f"{action} {player}")


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

            length = _mc_read_varint_sock(s)
            pkt = _mc_recv_all(s, length)
            _, pos = _mc_read_varint(pkt, 0)          # skip packet ID
            str_len, pos = _mc_read_varint(pkt, pos)
            status = json.loads(pkt[pos:pos + str_len])

            # SLP ping/pong round-trip — gives a real-time latency reading.
            latency_ms = None
            try:
                t_send = time.perf_counter()
                s.sendall(b'\x09\x01' + struct.pack('>q', int(t_send * 1000)))
                plen = _mc_read_varint_sock(s)
                if plen >= 9:
                    _mc_recv_all(s, plen)
                    latency_ms = round((time.perf_counter() - t_send) * 1000, 1)
            except Exception:
                pass
    except Exception as exc:
        log.debug("Minecraft ping failed: %s", exc)
        return {"online": False, "error": "server unreachable"}

    players  = status.get("players", {}) or {}
    sample   = players.get("sample") or []
    version  = status.get("version", {}) or {}
    online_n = players.get("online", 0)
    names    = [p["name"] for p in sample if isinstance(p, dict) and "name" in p]
    hidden   = max(0, online_n - len(names))

    favicon = status.get("favicon") or ""
    if not (isinstance(favicon, str) and favicon.startswith("data:image/") and len(favicon) <= 50000):
        favicon = ""

    mod_names = []
    mod_count = 0
    mod_source = "none"
    for key in ("forgeData", "modinfo"):
        forge = status.get(key)
        if isinstance(forge, dict):
            raw_mods = forge.get("mods") or forge.get("modList") or []
            if isinstance(raw_mods, list) and raw_mods:
                mod_count = len(raw_mods)
                for m in raw_mods:
                    if isinstance(m, dict):
                        name = m.get("modId") or m.get("modid") or m.get("name") or ""
                        if name:
                            mod_names.append(name)
                mod_source = "slp:" + key
                break

    # NeoForge / Forge 1.18+ often advertise nothing usable in the SLP ping.
    # Fall back to the on-disk mods/ directory if MC_DATA_DIR is mounted.
    if mod_count == 0:
        disk_count, disk_names = _count_mods_on_disk()
        if disk_count:
            mod_count = disk_count
            mod_names = disk_names
            mod_source = "disk"

    ops        = _read_mc_ops()
    properties = _read_mc_properties()
    op_names   = {o["name"].lower() for o in ops}
    data_dir_diag = _mc_data_dir_diag()

    return {
        "online":          True,
        "version":         version.get("name", ""),
        "protocol":        version.get("protocol"),
        "motd":            _mc_motd(status.get("description", "")),
        "players_online":  online_n,
        "players_max":     players.get("max", 0),
        "players":         names,
        "ops":             ops,
        "online_op_names": [n for n in names if n.lower() in op_names],
        "hidden_players":  hidden,
        "latency_ms":      latency_ms,
        "favicon":         favicon,
        "mod_count":       mod_count,
        "mods":            mod_names,
        "mod_source":      mod_source,
        "gamemode":        properties.get("gamemode", ""),
        "hardcore":        properties.get("hardcore", False),
        "difficulty":      properties.get("difficulty", ""),
        "pvp":             properties.get("pvp", False),
        "level_name":      properties.get("level_name", ""),
        "rcon_available":  bool(_MC_RCON_PASSWORD),
        "rcon_host":       _MC_HOST,
        "rcon_port":       _MC_RCON_PORT,
        "data_dir_diag":   data_dir_diag,
        "enforces_secure_chat": bool(status.get("enforcesSecureChat")),
    }


def _mc_worker():
    global _mc_result
    while True:
        result = _fetch_minecraft()

        if result.get("online"):
            for name in result.get("players", []):
                _mc_player_times[name] = _mc_player_times.get(name, 0) + _MC_POLL_INTERVAL
            _mc_count_history.append(result["players_online"])
        else:
            _mc_count_history.append(0)

        if len(_mc_count_history) > _MC_HISTORY_MAX:
            _mc_count_history.pop(0)

        leaderboard = sorted(
            [{"name": k, "seconds": v} for k, v in _mc_player_times.items()],
            key=lambda x: x["seconds"],
            reverse=True,
        )

        with _mc_lock:
            _mc_result = {
                **(result or {}),
                "player_count_history": list(_mc_count_history),
                "player_leaderboard":   leaderboard,
            }

        time.sleep(_MC_POLL_INTERVAL)


def get_minecraft():
    if not _MC_HOST:
        return None
    with _mc_lock:
        return _mc_result


if _MC_HOST:
    threading.Thread(target=_mc_worker, daemon=True, name="mc-poller").start()




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

def _compact_sabnzbd(sab):
    if not sab or not sab.get("available"):
        return sab
    return {**sab, "slots": sab.get("slots", [])[:5]}


def _compact_qb(qb):
    if not qb or not qb.get("available"):
        return qb
    # Dashboard card only needs counters; full torrent list lives at /api/qbittorrent.
    return {k: v for k, v in qb.items() if k != "torrents"}


def _compact_minecraft(mc):
    if not mc or not mc.get("online"):
        return mc
    mods = mc.get("mods") or []
    # Detail page renders the full ops list and mod list; the dashboard card
    # shouldn't ship them on every 2-second poll.
    return {**mc, "mods": mods[:6], "ops": [], "data_dir_diag": None}


def _compact_sonarr(sonarr):
    if not sonarr or not sonarr.get("available"):
        return sonarr
    # Dashboard shows the next 5 days; detail page renders the full 14-day window.
    cutoff = (date.today() + timedelta(days=5)).isoformat()
    eps = [e for e in sonarr.get("episodes", []) if e.get("air_date", "") < cutoff]
    return {**sonarr, "episodes": eps}


def collect_all(base_url: str = ""):
    from . import spotify as _spotify
    result = {
        "timestamp": int(time.time()),
        "hostname":  _HOSTNAME,
        "uptime":    int(time.time() - _BOOT_TIME),
        "cpu":       get_cpu(),
        "memory":    get_memory(),
        "temps":     get_temps(),
        "fans":      get_fans(),
        "storage":   get_storage(),
        "network":   get_network(),
    }
    plex = get_plex_sessions()
    if plex is not None:
        result["plex"] = plex
    sonarr = get_sonarr_calendar()
    if sonarr is not None:
        result["sonarr"] = _compact_sonarr(sonarr)
    sabnzbd = get_sabnzbd()
    if sabnzbd is not None:
        result["sabnzbd"] = _compact_sabnzbd(sabnzbd)
    qb = get_qbittorrent()
    if qb is not None:
        result["qbittorrent"] = _compact_qb(qb)
    mc = get_minecraft()
    if mc is not None:
        result["minecraft"] = _compact_minecraft(mc)
    sp = _spotify.get_playback()
    if sp is not None:
        if not sp.get("authorized"):
            sp["redirect_uri"] = _spotify.get_redirect_uri(base_url)
        result["spotify"] = sp
    return result


# ── Weather ──────────────────────────────────────────────────────────────────

_weather_lock    = threading.Lock()
_weather_cache: dict = {}   # (lat2, lon2) -> (timestamp, data)
_location_cache: dict = {}  # (lat2, lon2) -> (timestamp, name)
_WEATHER_TTL  = 600    # 10 minutes
_LOCATION_TTL = 86400  # 24 hours


def _wmo_description(code: int) -> str:
    if code == 0:               return "Clear sky"
    if code <= 2:               return "Mainly clear"
    if code == 3:               return "Overcast"
    if code in (45, 48):        return "Fog"
    if code in (51, 53, 55):    return "Drizzle"
    if code in (61, 63, 65):    return "Rain"
    if code in (71, 73, 75):    return "Snow"
    if code == 77:              return "Snow grains"
    if code in (80, 81, 82):    return "Showers"
    if code in (85, 86):        return "Snow showers"
    if code == 95:              return "Thunderstorm"
    if code in (96, 99):        return "Heavy thunderstorm"
    return "Unknown"


def _wmo_icon(code: int) -> str:
    if code == 0:               return "clear"
    if code <= 2:               return "partly-cloudy"
    if code == 3:               return "cloudy"
    if code <= 48:              return "fog"
    if code <= 55:              return "drizzle"
    if code <= 65:              return "rain"
    if code <= 77:              return "snow"
    if code <= 82:              return "showers"
    if code <= 86:              return "snow-showers"
    return "thunderstorm"


def _weather_location(lat: float, lon: float) -> str:
    key = (round(lat, 2), round(lon, 2))
    now = time.time()
    with _weather_lock:
        if key in _location_cache:
            ts, name = _location_cache[key]
            if now - ts < _LOCATION_TTL:
                return name
    try:
        url = (f"https://nominatim.openstreetmap.org/reverse"
               f"?lat={lat}&lon={lon}&format=json&zoom=10")
        req = urllib.request.Request(url, headers={"User-Agent": "brainless-dash/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
        addr = data.get("address", {})
        city = (addr.get("city") or addr.get("town") or addr.get("village")
                or addr.get("county") or "")
        cc = addr.get("country_code", "").upper()
        name = f"{city}, {cc}" if city and cc else city or cc or ""
    except Exception:
        name = ""
    with _weather_lock:
        _location_cache[key] = (time.time(), name)
    return name


def get_weather(lat: float, lon: float) -> dict:
    key = (round(lat, 2), round(lon, 2))
    now = time.time()
    with _weather_lock:
        if key in _weather_cache:
            ts, data = _weather_cache[key]
            if now - ts < _WEATHER_TTL:
                return data

    temp_unit = "fahrenheit" if _WEATHER_UNITS == "imperial" else "celsius"
    wind_unit = "mph"        if _WEATHER_UNITS == "imperial" else "kmh"
    url = (
        f"https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat}&longitude={lon}"
        f"&current=temperature_2m,apparent_temperature,weather_code,"
        f"wind_speed_10m,relative_humidity_2m,is_day"
        f"&daily=temperature_2m_max,temperature_2m_min,weather_code,"
        f"precipitation_probability_max"
        f"&temperature_unit={temp_unit}&wind_speed_unit={wind_unit}"
        f"&timezone=auto&forecast_days=1"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "brainless-dash/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = json.loads(resp.read())
    except Exception as exc:
        log.debug("Weather fetch failed: %s", exc)
        return {"available": False, "error": str(exc)}

    cur   = raw.get("current", {})
    daily = raw.get("daily", {})
    code  = cur.get("weather_code", 0)

    result = {
        "available":  True,
        "temp":       cur.get("temperature_2m"),
        "feels_like": cur.get("apparent_temperature"),
        "humidity":   cur.get("relative_humidity_2m"),
        "wind":       cur.get("wind_speed_10m"),
        "is_day":     bool(cur.get("is_day", 1)),
        "condition":  _wmo_description(code),
        "icon":       _wmo_icon(code),
        "high":       (daily.get("temperature_2m_max") or [None])[0],
        "low":        (daily.get("temperature_2m_min")  or [None])[0],
        "precip_pct": (daily.get("precipitation_probability_max") or [None])[0],
        "temp_unit":  "°F" if _WEATHER_UNITS == "imperial" else "°C",
        "wind_unit":  "mph" if _WEATHER_UNITS == "imperial" else "km/h",
        "location":   _weather_location(lat, lon),
    }
    with _weather_lock:
        _weather_cache[key] = (time.time(), result)
    return result


_weather_detail_cache: dict = {}
_WEATHER_DETAIL_TTL = 1800  # 30 minutes


def get_weather_detail(lat: float, lon: float) -> dict:
    key = (round(lat, 2), round(lon, 2))
    now = time.time()
    with _weather_lock:
        if key in _weather_detail_cache:
            ts, data = _weather_detail_cache[key]
            if now - ts < _WEATHER_DETAIL_TTL:
                return data

    temp_unit = "fahrenheit" if _WEATHER_UNITS == "imperial" else "celsius"
    wind_unit = "mph"        if _WEATHER_UNITS == "imperial" else "kmh"

    # 7-day forecast
    forecast: list = []
    forecast_url = (
        f"https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat}&longitude={lon}"
        f"&daily=temperature_2m_max,temperature_2m_min,weather_code,"
        f"precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant"
        f"&temperature_unit={temp_unit}&wind_speed_unit={wind_unit}"
        f"&timezone=auto&forecast_days=7"
    )
    try:
        req = urllib.request.Request(forecast_url, headers={"User-Agent": "brainless-dash/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = json.loads(resp.read())
        daily = raw.get("daily", {})

        def _d(key2: str, i: int):
            lst = daily.get(key2) or []
            return lst[i] if i < len(lst) else None

        for i, d in enumerate(daily.get("time") or []):
            code = _d("weather_code", i) or 0
            forecast.append({
                "date":       d,
                "high":       _d("temperature_2m_max", i),
                "low":        _d("temperature_2m_min", i),
                "code":       code,
                "condition":  _wmo_description(code),
                "icon":       _wmo_icon(code),
                "precip_pct": _d("precipitation_probability_max", i),
                "wind_max":   _d("wind_speed_10m_max", i),
                "wind_dir":   _d("wind_direction_10m_dominant", i),
            })
    except Exception as exc:
        log.debug("Weather forecast fetch failed: %s", exc)

    # Marine wave/swell — gracefully empty for inland locations
    marine: list = []
    try:
        marine_url = (
            f"https://marine-api.open-meteo.com/v1/marine"
            f"?latitude={lat}&longitude={lon}"
            f"&hourly=wave_height,swell_wave_height,swell_wave_direction,swell_wave_period"
            f"&forecast_days=2&timezone=auto"
        )
        req = urllib.request.Request(marine_url, headers={"User-Agent": "brainless-dash/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            mraw = json.loads(resp.read())
        hourly = mraw.get("hourly", {})
        times      = hourly.get("time", [])
        wave_h     = hourly.get("wave_height", [])
        swell_h    = hourly.get("swell_wave_height", [])
        swell_dir  = hourly.get("swell_wave_direction", [])
        swell_per  = hourly.get("swell_wave_period", [])

        def _m(lst: list, i: int):
            return lst[i] if i < len(lst) else None

        for i, t in enumerate(times[:48]):
            marine.append({
                "time":         t,
                "wave_height":  _m(wave_h, i),
                "swell_height": _m(swell_h, i),
                "swell_dir":    _m(swell_dir, i),
                "swell_period": _m(swell_per, i),
            })
        # Discard entirely if no non-zero wave data (inland location)
        if not any(e["wave_height"] for e in marine):
            marine = []
    except Exception as exc:
        log.debug("Marine fetch failed: %s", exc)

    result = {
        "available": True,
        "forecast":  forecast,
        "marine":    marine,
        "temp_unit": "°F" if _WEATHER_UNITS == "imperial" else "°C",
        "wind_unit": "mph" if _WEATHER_UNITS == "imperial" else "km/h",
        "location":  _weather_location(lat, lon),
    }
    with _weather_lock:
        _weather_detail_cache[key] = (time.time(), result)
    return result

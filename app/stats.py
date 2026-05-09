"""System statistics collection for Unraid monitoring."""
import json
import logging
import os
import ssl
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

# ── SSL context for HTTPS Plex ─────────────────────────────────────────────────
_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE

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
            if child.name.startswith(("disk", "cache")) or child.name in ("user", "user0"):
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
    url = f"{_PLEX_URL}/status/sessions?X-Plex-Token={_PLEX_TOKEN}"
    req = urllib.request.Request(url, headers={"X-Plex-Token": _PLEX_TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=5, context=_ssl_ctx) as resp:
            root = ET.fromstring(resp.read())
    except Exception as exc:
        log.warning("Plex request failed: %s", exc)
        return {"available": False, "stream_count": 0, "sessions": [], "error": str(exc)}

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
        f"?apikey={_SONARR_API_KEY}"
        f"&start={today.isoformat()}&end={end.isoformat()}"
        f"&includeSeries=true"
    )
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=5) as resp:
            items = json.loads(resp.read())
    except Exception as exc:
        log.warning("Sonarr request failed: %s", exc)
        return {"available": False, "episodes": [], "error": str(exc)}

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
    url = (
        f"{_SABNZBD_URL}/api"
        f"?mode=queue&output=json&apikey={_SABNZBD_API_KEY}"
    )
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=5) as resp:
            data = json.loads(resp.read())
    except Exception as exc:
        log.warning("SABnzbd request failed: %s", exc)
        return {"available": False, "error": str(exc)}

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
_qb_sid    = ""

_QB_DL_STATES   = {"downloading", "stalledDL", "queuedDL", "checkingDL", "forcedDL", "metaDL", "allocating"}
_QB_SEED_STATES = {"uploading", "seeding", "stalledUP", "queuedUP", "checkingUP", "forcedUP"}


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
    req = urllib.request.Request(
        f"{_QB_URL}{path}", headers={"Cookie": f"SID={_qb_sid}"}
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


def _fetch_qbittorrent():
    global _qb_sid
    if not _qb_sid and not _qb_login():
        return {"available": False, "error": "authentication failed"}

    def _attempt():
        transfer  = _qb_get("/api/v2/transfer/info")
        torrents  = _qb_get("/api/v2/torrents/info")
        return transfer, torrents

    try:
        transfer, torrents = _attempt()
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            _qb_sid = ""
            if not _qb_login():
                return {"available": False, "error": "authentication failed"}
            try:
                transfer, torrents = _attempt()
            except Exception as exc2:
                return {"available": False, "error": str(exc2)}
        else:
            return {"available": False, "error": str(exc)}
    except Exception as exc:
        return {"available": False, "error": str(exc)}

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
    if not _QB_PASSWORD:
        return None
    with _qb_lock:
        return _qb_result


if _QB_PASSWORD:
    threading.Thread(target=_qb_worker, daemon=True, name="qb-poller").start()


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
    return result

"""System statistics collection for Unraid monitoring."""
import logging
import os
import ssl
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import psutil
from pathlib import Path

log = logging.getLogger(__name__)


# Cache for network rate calculation
_net_cache = {"time": None, "bytes_sent": 0, "bytes_recv": 0}

# Plex config
_PLEX_URL = os.environ.get("PLEX_URL", "http://localhost:32400").rstrip("/")
_PLEX_TOKEN = os.environ.get("PLEX_TOKEN", "")

# Chips that expose CPU temperatures
_CPU_CHIPS = {"k10temp", "coretemp", "zenpower"}

# Preferred representative labels, checked in order (lowercase)
_CPU_PACKAGE_PRIORITY = [
    "tctl", "tdie",                          # AMD k10temp / zenpower
    "package id 0", "package id 1",          # Intel coretemp
    "physical id 0", "physical id 1",        # Intel older kernels
    "cpu temperature", "cpu",
]


def get_cpu():
    """Return CPU usage, frequency and load."""
    per_cpu = psutil.cpu_percent(interval=None, percpu=True)
    freq = psutil.cpu_freq()
    try:
        load = os.getloadavg()
    except (AttributeError, OSError):
        load = (0.0, 0.0, 0.0)

    return {
        "percent": round(sum(per_cpu) / len(per_cpu), 1) if per_cpu else 0.0,
        "per_cpu": [round(p, 1) for p in per_cpu],
        "cores": psutil.cpu_count(logical=False) or psutil.cpu_count(),
        "threads": psutil.cpu_count(logical=True),
        "freq_mhz": round(freq.current) if freq else None,
        "load_1m": round(load[0], 2),
        "load_5m": round(load[1], 2),
        "load_15m": round(load[2], 2),
    }


def get_memory():
    """Return memory and swap usage."""
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    return {
        "total": vm.total,
        "used": vm.used,
        "available": vm.available,
        "percent": vm.percent,
        "swap_total": sw.total,
        "swap_used": sw.used,
        "swap_percent": sw.percent,
    }


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
    """Return temperature sensors. CPU chips are consolidated to one representative reading."""
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
                        "chip": chip,
                        "label": "CPU",
                        "current": round(best.current, 1),
                        "high": best.high,
                        "critical": best.critical,
                    }
        else:
            for entry in entries:
                if entry.current is None:
                    continue
                sensors.append({
                    "chip": chip,
                    "label": entry.label or chip,
                    "current": round(entry.current, 1),
                    "high": entry.high,
                    "critical": entry.critical,
                })

    if cpu_entry:
        sensors.insert(0, cpu_entry)
    return sensors


def _read_mdstat():
    """Parse /proc/mdstat for Unraid array status if available."""
    path = Path("/proc/mdstat")
    if not path.exists():
        return None
    try:
        return path.read_text()
    except OSError:
        return None


def get_storage():
    """Return storage information for Unraid mounts and other filesystems."""
    disks = []
    seen = set()

    # Prefer Unraid specific mounts when present
    unraid_mounts = []
    mnt = Path("/mnt")
    if mnt.is_dir():
        for child in sorted(mnt.iterdir()):
            name = child.name
            if name.startswith(("disk", "cache")) or name in ("user", "user0"):
                unraid_mounts.append(str(child))

    # Fall back to all real partitions
    candidate_paths = unraid_mounts or [
        p.mountpoint for p in psutil.disk_partitions(all=False)
        if p.fstype and not p.mountpoint.startswith(("/proc", "/sys", "/dev"))
    ]

    for path in candidate_paths:
        if path in seen:
            continue
        seen.add(path)
        try:
            usage = psutil.disk_usage(path)
        except (PermissionError, OSError):
            continue
        disks.append({
            "mount": path,
            "name": os.path.basename(path) or path,
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
            "percent": usage.percent,
        })

    return {
        "disks": disks,
        "array_status": _read_mdstat(),
    }


def get_network():
    """Return current network interface counters and rates (bytes/sec)."""
    counters = psutil.net_io_counters(pernic=True)
    now = time.time()
    interfaces = []

    total_sent = 0
    total_recv = 0

    for name, c in counters.items():
        if name == "lo" or name.startswith(("docker", "veth", "br-")):
            continue
        interfaces.append({
            "name": name,
            "bytes_sent": c.bytes_sent,
            "bytes_recv": c.bytes_recv,
            "packets_sent": c.packets_sent,
            "packets_recv": c.packets_recv,
            "errors_in": c.errin,
            "errors_out": c.errout,
        })
        total_sent += c.bytes_sent
        total_recv += c.bytes_recv

    # Calculate rate from last sample
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
        "interfaces": interfaces,
        "total_sent": total_sent,
        "total_recv": total_recv,
        "rate_sent_bps": rate_sent,
        "rate_recv_bps": rate_recv,
    }


def get_plex_sessions():
    """Return active Plex streams, or None if PLEX_TOKEN is not configured."""
    if not _PLEX_TOKEN:
        return None
    url = f"{_PLEX_URL}/status/sessions?X-Plex-Token={_PLEX_TOKEN}"
    req = urllib.request.Request(url, headers={"X-Plex-Token": _PLEX_TOKEN})
    # Allow self-signed certs for local Plex installs using HTTPS
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, timeout=5, context=ssl_ctx) as resp:
            raw = resp.read()
        root = ET.fromstring(raw)
    except Exception as exc:
        log.warning("Plex request failed: %s", exc)
        return {"available": False, "stream_count": 0, "sessions": [], "error": str(exc)}

    sessions = []
    for item in root.findall("Video") + root.findall("Track") + root.findall("Photo"):
        media_type = item.get("type", "")
        view_offset = int(item.get("viewOffset") or 0)
        duration = int(item.get("duration") or 0)
        progress = round(view_offset / duration * 100, 1) if duration else 0
        user_el = item.find("User")
        player_el = item.find("Player")
        sessions.append({
            "title": item.get("title", ""),
            "show": item.get("grandparentTitle") if media_type == "episode" else None,
            "type": media_type,
            "user": user_el.get("title", "unknown") if user_el is not None else "unknown",
            "player": player_el.get("title", "") if player_el is not None else "",
            "state": player_el.get("state", "") if player_el is not None else "",
            "transcoding": item.find("TranscodeSession") is not None,
            "progress_pct": progress,
        })
    return {"available": True, "stream_count": len(sessions), "sessions": sessions}


def get_uptime():
    return int(time.time() - psutil.boot_time())


def get_hostname():
    try:
        return os.uname().nodename
    except AttributeError:
        import socket
        return socket.gethostname()


def collect_all():
    """Collect every metric in a single payload."""
    result = {
        "timestamp": int(time.time()),
        "hostname": get_hostname(),
        "uptime": get_uptime(),
        "cpu": get_cpu(),
        "memory": get_memory(),
        "temps": get_temps(),
        "storage": get_storage(),
        "network": get_network(),
    }
    plex = get_plex_sessions()
    if plex is not None:
        result["plex"] = plex
    return result

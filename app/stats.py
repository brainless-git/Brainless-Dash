"""System statistics collection for Unraid monitoring."""
import os
import time
import psutil
from pathlib import Path


# Cache for network rate calculation
_net_cache = {"time": None, "bytes_sent": 0, "bytes_recv": 0}


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


def get_temps():
    """Return temperature sensors. Requires /sys to be mounted in the container."""
    sensors = []
    try:
        temps = psutil.sensors_temperatures()
    except (AttributeError, OSError):
        return sensors

    for chip, entries in temps.items():
        for entry in entries:
            if entry.current is None:
                continue
            label = entry.label or chip
            sensors.append({
                "chip": chip,
                "label": label,
                "current": round(entry.current, 1),
                "high": entry.high,
                "critical": entry.critical,
            })
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
    return {
        "timestamp": int(time.time()),
        "hostname": get_hostname(),
        "uptime": get_uptime(),
        "cpu": get_cpu(),
        "memory": get_memory(),
        "temps": get_temps(),
        "storage": get_storage(),
        "network": get_network(),
    }

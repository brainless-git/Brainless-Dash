"""Persistent time-series history for system metrics and Minecraft data."""
import json
import logging
import threading
import time
from pathlib import Path

log = logging.getLogger(__name__)

_DATA_DIR = Path("/data/history")
_SYS_FILE = _DATA_DIR / "system.json"
_MC_FILE  = _DATA_DIR / "minecraft.json"

# 14 days at 1 sample/minute
_SYS_RETENTION  = 14 * 24 * 60
_SAMPLE_INTERVAL = 60    # record system metrics at most once per minute
_SAVE_INTERVAL   = 300   # flush to disk at most every 5 minutes

_lock = threading.Lock()

# [[epoch, cpu_pct, mem_pct, net_recv_bps, net_sent_bps, temp_c], ...]
_sys_data: list = []
_last_record  = 0.0
_last_sys_save = 0.0
_last_mc_save  = 0.0


def _ensure_dir() -> None:
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        log.debug("history: cannot create %s: %s", _DATA_DIR, exc)


def load_system() -> None:
    """Load persisted system history into memory. Call once at startup."""
    global _sys_data
    _ensure_dir()
    try:
        data = json.loads(_SYS_FILE.read_text())
        if isinstance(data, list):
            cutoff = time.time() - _SYS_RETENTION * 60
            _sys_data = [
                r for r in data
                if isinstance(r, list) and len(r) >= 2 and r[0] >= cutoff
            ]
            log.info("history: loaded %d system samples", len(_sys_data))
    except FileNotFoundError:
        pass
    except Exception as exc:
        log.warning("history: failed to load system history: %s", exc)


def _save_system_locked() -> None:
    """Save system data. Must be called with _lock held."""
    _ensure_dir()
    try:
        tmp = _SYS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_sys_data))
        tmp.chmod(0o600)
        tmp.replace(_SYS_FILE)
    except Exception as exc:
        log.warning("history: failed to save system history: %s", exc)


def maybe_record(stats: dict) -> None:
    """Record one system snapshot from collect_all(). Rate-limited to once per minute."""
    global _last_record, _last_sys_save
    now = time.time()
    with _lock:
        if now - _last_record < _SAMPLE_INTERVAL:
            return
        _last_record = now

        cpu_pct = mem_pct = net_recv = net_sent = temp_c = None

        cpu = stats.get("cpu")
        if isinstance(cpu, dict):
            cpu_pct = cpu.get("percent")

        mem = stats.get("memory")
        if isinstance(mem, dict):
            mem_pct = mem.get("percent")

        net = stats.get("network")
        if isinstance(net, dict):
            net_recv = net.get("rate_recv_bps")
            net_sent = net.get("rate_sent_bps")

        temps = stats.get("temps")
        if isinstance(temps, list) and temps:
            vals = [
                t.get("current") for t in temps
                if isinstance(t, dict) and t.get("current") is not None
            ]
            if vals:
                temp_c = max(vals)

        _sys_data.append([int(now), cpu_pct, mem_pct, net_recv, net_sent, temp_c])

        cutoff = now - _SYS_RETENTION * 60
        while _sys_data and _sys_data[0][0] < cutoff:
            _sys_data.pop(0)

        if now - _last_sys_save >= _SAVE_INTERVAL:
            _last_sys_save = now
            _save_system_locked()


def _downsample(lst: list, n: int) -> list:
    if len(lst) <= n:
        return lst
    return [lst[int(i * len(lst) / n)] for i in range(n)]


def get_system_history(max_points: int = 500) -> dict:
    """Return downsampled system history as per-metric arrays of [epoch, value] pairs."""
    with _lock:
        rows = _downsample(_sys_data, max_points)
    return {
        "cpu":      [[r[0], r[1]] for r in rows if r[1] is not None],
        "mem":      [[r[0], r[2]] for r in rows if r[2] is not None],
        "net_recv": [[r[0], r[3]] for r in rows if r[3] is not None],
        "net_sent": [[r[0], r[4]] for r in rows if r[4] is not None],
        "temp":     [[r[0], r[5]] for r in rows if r[5] is not None],
    }


# ── Minecraft ───────────────────────────────────────────────────────────────────

def load_minecraft() -> tuple[dict, list]:
    """Load persisted MC data from disk.

    Returns (player_times, count_history) where count_history is a list of
    [epoch, count] pairs filtered to the last 14 days.
    """
    _ensure_dir()
    try:
        data = json.loads(_MC_FILE.read_text())
        if isinstance(data, dict):
            pt = data.get("player_times") or {}
            ch = data.get("count_history") or []
            if not isinstance(pt, dict):
                pt = {}
            cutoff = time.time() - 14 * 24 * 3600
            ch = [
                r for r in ch
                if isinstance(r, list) and len(r) >= 2 and r[0] >= cutoff
            ]
            log.info("history: loaded %d MC count samples, %d players", len(ch), len(pt))
            return pt, ch
    except FileNotFoundError:
        pass
    except Exception as exc:
        log.warning("history: failed to load MC history: %s", exc)
    return {}, []


def save_minecraft(player_times: dict, count_history: list) -> None:
    """Persist MC state to disk. Throttled to _SAVE_INTERVAL."""
    global _last_mc_save
    now = time.time()
    with _lock:
        if now - _last_mc_save < _SAVE_INTERVAL:
            return
        _last_mc_save = now
        data = {
            "player_times":  dict(player_times),
            "count_history": list(count_history),
        }
    _ensure_dir()
    try:
        tmp = _MC_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data))
        tmp.chmod(0o600)
        tmp.replace(_MC_FILE)
    except Exception as exc:
        log.warning("history: failed to save MC history: %s", exc)

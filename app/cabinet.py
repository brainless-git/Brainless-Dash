"""Cabinet temperature / humidity sensor integration."""
import json
import logging
import os
import pathlib
import threading
import time
import urllib.request

log = logging.getLogger(__name__)

_CABINET_URL     = os.environ.get("CABINET_TEMP_URL", "").rstrip("/")
_POLL_INTERVAL   = 30
_RECORD_INTERVAL = 60      # seconds between history samples
_HIST_MAX        = 1440    # 24 h at 60 s/sample
_HIST_FILE       = pathlib.Path("/data/history/cabinet.json")

_RETRIES     = 3           # attempts per poll cycle
_RETRY_DELAY = 2.0         # seconds between retries

_lock        = threading.Lock()
_result      = None
_last_good   = None        # last successful reading, returned on transient failure
_history: list = []        # [[epoch, temp_c, humidity], ...]
_last_record = 0.0


def _load_history() -> None:
    try:
        if _HIST_FILE.exists():
            raw = json.loads(_HIST_FILE.read_text())
            cutoff = time.time() - 86400
            _history.extend(
                r for r in raw
                if isinstance(r, list) and len(r) >= 3 and r[0] > cutoff
            )
    except Exception as exc:
        log.debug("Cabinet history load: %s", exc)


def _save_history() -> None:
    try:
        _HIST_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _HIST_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_history))
        tmp.chmod(0o600)
        tmp.replace(_HIST_FILE)
    except Exception as exc:
        log.debug("Cabinet history save: %s", exc)


def _record(temp_c: float, humidity: float) -> None:
    global _last_record
    now = time.time()
    if now - _last_record < _RECORD_INTERVAL:
        return
    _last_record = now
    _history.append([int(now), round(temp_c, 2), round(humidity, 2)])
    cutoff = now - 86400
    while _history and _history[0][0] < cutoff:
        _history.pop(0)
    if len(_history) > _HIST_MAX:
        del _history[:-_HIST_MAX]
    _save_history()


def _fetch_once() -> dict:
    req = urllib.request.Request(_CABINET_URL, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        data = json.loads(resp.read())
    return {
        "available":     True,
        "temperature_c": float(data.get("temperature_c", 0)),
        "humidity":      float(data.get("humidity", 0)),
    }


def _fetch() -> dict:
    """Attempt up to _RETRIES times with a short delay, return last good on persistent failure."""
    global _last_good
    last_exc = ""
    for attempt in range(_RETRIES):
        try:
            result = _fetch_once()
            _last_good = result
            return result
        except Exception as exc:
            last_exc = str(exc)
            log.debug("Cabinet sensor attempt %d/%d: %s", attempt + 1, _RETRIES, exc)
            if attempt < _RETRIES - 1:
                time.sleep(_RETRY_DELAY)
    if _last_good:
        log.debug("Cabinet sensor: using last good reading after %d failed attempts", _RETRIES)
        return {**_last_good, "stale": True}
    return {"available": False, "error": last_exc}


def _worker() -> None:
    global _result
    while True:
        result = _fetch()
        if result.get("available"):
            _record(result["temperature_c"], result["humidity"])
        with _lock:
            _result = result
        time.sleep(_POLL_INTERVAL)


def get_cabinet():
    """Return latest sensor data, or None if CABINET_TEMP_URL is not configured."""
    if not _CABINET_URL:
        return None
    with _lock:
        return _result


def get_cabinet_history():
    """Return 24-hour temperature and humidity history, or None if not configured."""
    if not _CABINET_URL:
        return None
    points = list(_history)
    return {
        "temp":     [[r[0], r[1]] for r in points],
        "humidity": [[r[0], r[2]] for r in points],
    }


if _CABINET_URL:
    _load_history()
    threading.Thread(target=_worker, daemon=True, name="cabinet-poller").start()

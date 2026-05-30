"""Cabinet temperature / humidity sensor integration."""
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request

log = logging.getLogger(__name__)

_CABINET_URL   = os.environ.get("CABINET_TEMP_URL", "").rstrip("/")
_POLL_INTERVAL = 30

_lock   = threading.Lock()
_result = None


def _fetch() -> dict:
    try:
        req = urllib.request.Request(_CABINET_URL, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
        return {
            "available":     True,
            "temperature_c": float(data.get("temperature_c", 0)),
            "temperature_f": float(data.get("temperature_f", 0)),
            "humidity":      float(data.get("humidity", 0)),
            "comfort":       str(data.get("comfort", "")),
            "uptime_ms":     int(data.get("uptime_ms", 0)),
        }
    except Exception as exc:
        log.debug("Cabinet sensor poll: %s", exc)
        return {"available": False, "error": str(exc)}


def _worker() -> None:
    global _result
    while True:
        result = _fetch()
        with _lock:
            _result = result
        time.sleep(_POLL_INTERVAL)


def get_cabinet():
    """Return latest sensor data, or None if CABINET_TEMP_URL is not configured."""
    if not _CABINET_URL:
        return None
    with _lock:
        return _result


if _CABINET_URL:
    threading.Thread(target=_worker, daemon=True, name="cabinet-poller").start()

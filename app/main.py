"""FastAPI application serving Unraid monitoring dashboard."""
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, Query
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db, stats


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    if db.enabled():
        stats.start_history_sampler()
    yield


app = FastAPI(title="Brainless-Dash", version="1.0.0", lifespan=lifespan)

STATIC_DIR = Path(__file__).parent / "static"

# Frontend refresh interval (ms) configurable via env var
REFRESH_MS = int(os.environ.get("REFRESH_MS", "2000"))


@app.get("/api/config")
def client_config():
    """Configuration consumed by the frontend at startup."""
    return {
        "refresh_ms":     REFRESH_MS,
        "history_enabled": db.enabled(),
        "history_days":   db.retention_days(),
    }


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/stats")
def all_stats():
    return JSONResponse(stats.collect_all())


@app.get("/api/cpu")
def cpu_stats():
    return stats.get_cpu()


@app.get("/api/memory")
def memory_stats():
    return stats.get_memory()


@app.get("/api/temps")
def temp_stats():
    return {"sensors": stats.get_temps()}


@app.get("/api/storage")
def storage_stats():
    return stats.get_storage()


@app.get("/api/network")
def network_stats():
    return stats.get_network()


@app.get("/api/sonarr")
def sonarr_stats():
    result = stats.get_sonarr_calendar()
    if result is None:
        return JSONResponse({"error": "SONARR_API_KEY not configured"}, status_code=404)
    return result


@app.get("/api/plex")
def plex_stats():
    result = stats.get_plex_sessions()
    if result is None:
        return JSONResponse({"error": "PLEX_TOKEN not configured"}, status_code=404)
    return result


@app.get("/api/sabnzbd")
def sabnzbd_stats():
    result = stats.get_sabnzbd()
    if result is None:
        return JSONResponse({"error": "SABNZBD_API_KEY not configured"}, status_code=404)
    return result


@app.get("/api/qbittorrent")
def qbittorrent_stats():
    result = stats.get_qbittorrent()
    if result is None:
        return JSONResponse({"error": "QB_PASSWORD not configured"}, status_code=404)
    return result


@app.post("/api/qbittorrent/{action}")
def qbittorrent_action(action: str, payload: dict = Body(default={})):
    if action not in ("recheck", "reannounce"):
        return JSONResponse({"ok": False, "error": "unknown action"}, status_code=404)
    hashes = payload.get("hashes", "all")
    result = stats.qb_action(action, hashes)
    return JSONResponse(result, status_code=200 if result["ok"] else 400)


@app.get("/api/minecraft")
def minecraft_stats():
    result = stats.get_minecraft()
    if result is None:
        return JSONResponse({"error": "MC_HOST not configured"}, status_code=404)
    return result


@app.post("/api/minecraft/{action}")
def minecraft_op_action(action: str, payload: dict = Body(default={})):
    if action not in ("op", "deop"):
        return JSONResponse({"ok": False, "error": "unknown action"}, status_code=404)
    player = (payload.get("player") or "").strip()
    result = stats.mc_op_action(action, player)
    return JSONResponse(result, status_code=200 if result["ok"] else 400)


_HISTORY_RANGES = {
    # range key → (seconds back, default bucket size in seconds)
    "1h":  (3600,            60),
    "6h":  (6 * 3600,        60),
    "24h": (24 * 3600,       60),
    "7d":  (7 * 86400,       300),    # 5-minute buckets
    "14d": (14 * 86400,      900),    # 15-minute buckets
    "30d": (30 * 86400,      1800),   # 30-minute buckets
    "90d": (90 * 86400,      3600),
    "1y":  (365 * 86400,     14400),  # 4h
}


@app.get("/api/history/metrics")
def history_metrics():
    """Distinct metric names available in the time-series store."""
    if not db.enabled():
        return JSONResponse({"available": False, "metrics": []})
    return {"available": True, "metrics": db.known_metrics(), "retention_days": db.retention_days()}


@app.get("/api/history/series")
def history_series(metric: str = Query(...), range: str = Query("24h")):
    """Return [{ts, avg, min, max}] for one metric over the requested range."""
    if not db.enabled():
        return JSONResponse({"available": False, "points": []})
    if range not in _HISTORY_RANGES:
        return JSONResponse(
            {"available": False, "error": f"range must be one of {list(_HISTORY_RANGES)}"},
            status_code=400,
        )
    seconds_back, bucket = _HISTORY_RANGES[range]
    since = int(time.time()) - seconds_back
    return {
        "available":  True,
        "metric":     metric,
        "range":      range,
        "bucket_sec": bucket,
        "points":     db.metric_series(metric, since, bucket_seconds=bucket),
    }


@app.get("/api/minecraft/playtime")
def minecraft_playtime():
    """Per-player cumulative playtime plus any sessions in progress."""
    if not db.enabled():
        return JSONResponse({"available": False, "players": [], "active": []})
    return db.mc_playtime()


# Serve static frontend from root
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

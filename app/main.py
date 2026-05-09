"""FastAPI application serving Unraid monitoring dashboard."""
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import stats

app = FastAPI(title="Brainless-Dash", version="1.0.0")

STATIC_DIR = Path(__file__).parent / "static"

# Frontend refresh interval (ms) configurable via env var
REFRESH_MS = int(os.environ.get("REFRESH_MS", "2000"))


@app.get("/api/config")
def client_config():
    """Configuration consumed by the frontend at startup."""
    return {"refresh_ms": REFRESH_MS}


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


# Serve static frontend from root
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

"""FastAPI application serving Unraid monitoring dashboard."""
import os
from pathlib import Path

from fastapi import Body, FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import cabinet, spotify, stats, unifi

app = FastAPI(title="Brainless-Dash", version="1.0.0")

STATIC_DIR = Path(__file__).parent / "static"

# Frontend refresh interval (ms) configurable via env var
REFRESH_MS = int(os.environ.get("REFRESH_MS", "2000"))


def _base_url(request: Request) -> str:
    """Return the public base URL, honouring X-Forwarded-* headers from reverse proxies."""
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host  = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}/"


@app.get("/api/config")
def client_config():
    """Configuration consumed by the frontend at startup."""
    return {"refresh_ms": REFRESH_MS}


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/stats")
def all_stats(request: Request):
    return JSONResponse(stats.collect_all(_base_url(request)))


@app.get("/api/cpu")
def cpu_stats():
    return stats.get_cpu()


@app.get("/api/memory")
def memory_stats():
    return stats.get_memory()


@app.get("/api/temps")
def temp_stats():
    return {"sensors": stats.get_temps(), "fans": stats.get_fans()}


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


@app.get("/api/spotify/auth")
def spotify_auth(request: Request):
    if not spotify._CLIENT_ID:
        return JSONResponse({"error": "SPOTIFY_CLIENT_ID not configured"}, status_code=404)
    return RedirectResponse(spotify.get_auth_url(_base_url(request)), status_code=302)


@app.get("/api/spotify/callback")
def spotify_callback(code: str = None, state: str = None, error: str = None):
    if error:
        return JSONResponse({"error": error}, status_code=400)
    if not code:
        return JSONResponse({"error": "no code received"}, status_code=400)
    if state != spotify._oauth_state or not spotify._oauth_state:
        return JSONResponse({"error": "invalid state parameter"}, status_code=400)
    if spotify.exchange_code(code):
        return RedirectResponse("/")
    return JSONResponse({"error": "token exchange failed"}, status_code=500)


@app.get("/api/spotify")
def spotify_stats(request: Request):
    result = spotify.get_playback()
    if result is None:
        return JSONResponse({"error": "SPOTIFY_CLIENT_ID not configured"}, status_code=404)
    if not result.get("authorized"):
        result["redirect_uri"] = spotify.get_redirect_uri(_base_url(request))
    return result


@app.get("/api/spotify/detail")
def spotify_detail():
    result = spotify.get_detail()
    if result is None:
        return JSONResponse({"error": "SPOTIFY_CLIENT_ID not configured"}, status_code=404)
    return result


@app.post("/api/spotify/{action}")
def spotify_action(action: str, payload: dict = Body(default={})):
    result = spotify.spotify_action(action, **payload)
    return JSONResponse(result, status_code=200 if result["ok"] else 400)


@app.get("/api/resources")
def resources_stats():
    return {"cpu": stats.get_cpu(), "memory": stats.get_memory()}


@app.get("/api/unifi")
def unifi_stats():
    result = unifi.get_unifi()
    if result is None:
        return JSONResponse({"error": "UNIFI_URL / UNIFI_USERNAME not configured"}, status_code=404)
    return result


@app.get("/api/cabinet")
def cabinet_stats():
    result = cabinet.get_cabinet()
    if result is None:
        return JSONResponse({"error": "CABINET_TEMP_URL not configured"}, status_code=404)
    return result


@app.get("/api/history/system")
def system_history():
    return stats.get_system_history()


@app.get("/api/history/minecraft")
def minecraft_history():
    result = stats.get_minecraft_history()
    if result is None:
        return JSONResponse({"error": "MC_HOST not configured"}, status_code=404)
    return result


@app.get("/api/weather")
def weather_stats(lat: float, lon: float):
    return stats.get_weather(lat, lon)


@app.get("/api/weather/detail")
def weather_detail_stats(lat: float, lon: float):
    return stats.get_weather_detail(lat, lon)


# Serve static frontend from root
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

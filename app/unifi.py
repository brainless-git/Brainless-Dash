"""UniFi Network Application integration for Brainless-Dash."""
import http.cookiejar
import json
import logging
import os
import ssl
import threading
import time
import urllib.error
import urllib.request

log = logging.getLogger(__name__)

_UNIFI_URL        = os.environ.get("UNIFI_URL",        "").rstrip("/")
_UNIFI_USERNAME   = os.environ.get("UNIFI_USERNAME",   "")
_UNIFI_PASSWORD   = os.environ.get("UNIFI_PASSWORD",   "")
_UNIFI_SITE       = os.environ.get("UNIFI_SITE",       "default")
_UNIFI_VERIFY_SSL = os.environ.get("UNIFI_VERIFY_SSL", "true").lower() not in ("false", "0", "no")

_POLL_INTERVAL = 30
_LOGIN_TTL     = 3600   # re-authenticate after 1 hour

_lock   = threading.Lock()
_result = None

# Session state — only touched by the worker thread after startup.
_csrf_token  = ""
_last_login  = 0.0
_jar         = http.cookiejar.CookieJar()
_opener      = None   # built once, reused


def _ssl_ctx() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if not _UNIFI_VERIFY_SSL:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _build_opener() -> None:
    global _opener
    _opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=_ssl_ctx()),
        urllib.request.HTTPCookieProcessor(_jar),
    )


def _login() -> bool:
    """Authenticate with the controller. Tries the UniFi OS path then the legacy path."""
    global _csrf_token, _last_login
    if _opener is None:
        _build_opener()
    _jar.clear()

    body = json.dumps({
        "username": _UNIFI_USERNAME,
        "password": _UNIFI_PASSWORD,
        "rememberMe": False,
    }).encode()

    for login_path in ("/api/auth/login", "/api/login"):
        try:
            req = urllib.request.Request(
                f"{_UNIFI_URL}{login_path}", data=body, method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Origin":   _UNIFI_URL,
                    "Referer":  f"{_UNIFI_URL}/",
                },
            )
            with _opener.open(req, timeout=10) as resp:
                if resp.status in (200, 201):
                    _csrf_token = resp.getheader("x-csrf-token", "")
                    _last_login = time.time()
                    log.info("UniFi: authenticated via %s", login_path)
                    return True
        except urllib.error.HTTPError as exc:
            if exc.code == 400:
                log.warning("UniFi: login rejected (wrong credentials?)")
                return False
            # 404 means wrong path for this controller type — try the next one
        except Exception as exc:
            log.warning("UniFi: login error (%s): %s", login_path, exc)
            return False

    log.warning("UniFi: no working login endpoint found")
    return False


def _api_get(path: str):
    """GET a UniFi API path. Returns (http_status, parsed_body_or_None)."""
    if _opener is None:
        return 0, None
    headers = {"Accept": "application/json"}
    if _csrf_token:
        headers["X-Csrf-Token"] = _csrf_token
    try:
        req = urllib.request.Request(f"{_UNIFI_URL}{path}", headers=headers)
        with _opener.open(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except Exception as exc:
        log.debug("UniFi GET %s: %s", path, exc)
        return 0, None


def _fetch_unifi() -> dict:
    global _csrf_token

    if _opener is None:
        _build_opener()

    if time.time() - _last_login > _LOGIN_TTL:
        if not _login():
            return {"available": False, "error": "authentication failed"}

    # Try modern UniFi OS prefix first, then legacy
    for prefix in (
        f"/proxy/network/api/s/{_UNIFI_SITE}",
        f"/api/s/{_UNIFI_SITE}",
    ):
        status, data = _api_get(f"{prefix}/stat/health")

        if status == 401:
            _jar.clear()
            if not _login():
                return {"available": False, "error": "authentication failed"}
            status, data = _api_get(f"{prefix}/stat/health")

        if status != 200 or not isinstance(data, dict):
            continue

        health_list = data.get("data") or []

        # Active wireless + wired clients
        sta_count = 0
        sta_list  = []
        s2, d2 = _api_get(f"{prefix}/stat/sta")
        if s2 == 200 and isinstance(d2, dict):
            sta_list  = d2.get("data") or []
            sta_count = len(sta_list)

        # Access points and other devices
        ap_total  = 0
        ap_online = 0
        device_list = []
        s3, d3 = _api_get(f"{prefix}/stat/device")
        if s3 == 200 and isinstance(d3, dict):
            device_list = d3.get("data") or []
            for dev in device_list:
                if dev.get("type") in ("uap", "ugw", "udm", "usw"):
                    ap_total += 1
                    if dev.get("state") == 1:
                        ap_online += 1

        # Parse WAN subsystem health (remains None when no WAN device detected)
        wan_status   = None
        wan_ip       = ""
        wan_down_bps = 0.0
        wan_up_bps   = 0.0
        for sub in health_list:
            if sub.get("subsystem") == "wan":
                wan_status   = "ok" if sub.get("status") == "ok" else "error"
                wan_ip       = sub.get("wan_ip", "")
                wan_down_bps = float(sub.get("rx_bytes_r") or 0)
                wan_up_bps   = float(sub.get("tx_bytes_r") or 0)

        # Compact client list for the drilldown (cap at 100)
        clients = []
        for sta in sta_list[:100]:
            clients.append({
                "hostname": sta.get("hostname") or sta.get("name") or sta.get("mac", ""),
                "ip":       sta.get("ip", ""),
                "type":     "wireless" if sta.get("is_wired") is False else "wired",
                "rssi":     sta.get("rssi"),
                "dl_bps":   float(sta.get("tx_bytes_r") or 0),   # AP→client = client download
                "ul_bps":   float(sta.get("rx_bytes_r") or 0),   # client→AP = client upload
                "dl_bytes": int(sta.get("tx_bytes") or 0),
                "ul_bytes": int(sta.get("rx_bytes") or 0),
            })

        # Compact device list (name + state + type)
        devices = []
        for dev in device_list[:50]:
            devices.append({
                "name":    dev.get("name") or dev.get("mac", ""),
                "type":    dev.get("type", ""),
                "model":   dev.get("model", ""),
                "version": dev.get("version", ""),
                "online":  dev.get("state") == 1,
                "clients": dev.get("num_sta", 0),
            })

        return {
            "available":    True,
            "wan_status":   wan_status,
            "wan_ip":       wan_ip,
            "wan_down_bps": wan_down_bps,
            "wan_up_bps":   wan_up_bps,
            "clients":      sta_count,
            "ap_total":     ap_total,
            "ap_online":    ap_online,
            "client_list":  clients,
            "device_list":  devices,
        }

    return {"available": False, "error": "could not reach API"}


def _unifi_worker() -> None:
    global _result
    while True:
        try:
            result = _fetch_unifi()
        except Exception as exc:
            log.warning("UniFi poll error: %s", exc)
            result = {"available": False, "error": "poll error"}
        with _lock:
            _result = result
        time.sleep(_POLL_INTERVAL)


def get_unifi():
    """Return latest UniFi data, or None if not configured."""
    if not _UNIFI_URL or not _UNIFI_USERNAME:
        return None
    with _lock:
        return _result


if _UNIFI_URL and _UNIFI_USERNAME:
    threading.Thread(target=_unifi_worker, daemon=True, name="unifi-poller").start()

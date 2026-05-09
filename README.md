<p align="center">
  <img src="assets/logo.svg" alt="Brainless-Dash" width="540">
</p>

<p align="center">
  <strong>A brainless little ghost that dashes around your Unraid server reporting on its health.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT">
  <img src="https://img.shields.io/badge/docker-ready-2496ED.svg" alt="Docker ready">
  <img src="https://img.shields.io/badge/python-3.12-blue.svg" alt="Python 3.12">
  <img src="https://img.shields.io/badge/repo-public-brightgreen.svg" alt="Public repo">
</p>

---

A lightweight, mobile-first web dashboard for monitoring an Unraid server. Runs as a Docker container on the Unraid host and exposes a single page covering CPU, memory, temperatures, storage capacity per array disk and live network bandwidth.

## Features

- CPU usage (overall and per-core), frequency and load averages
- Memory and swap usage
- Temperature sensors (CPU, mainboard, drives where exposed by hwmon)
- Storage usage for Unraid mounts (`/mnt/disk*`, `/mnt/cache*`, `/mnt/user`)
- Live network throughput (download and upload bytes per second) plus per-interface totals
- Auto-refresh (configurable), mobile-first responsive layout
- Dark Unraid-styled theme with the signature red accent
- Runs as non-root, no privileged mode required
- Image size around 80 MB

## Stack

- Python 3.12, FastAPI, psutil
- Static HTML, CSS and vanilla JavaScript frontend (no build step)
- Single Docker image

## Quick start

The container is built locally on the Unraid host rather than pulled from a registry.

```sh
git clone https://github.com/brainless-git/brainless-dash.git /mnt/user/appdata/brainless-dash
cd /mnt/user/appdata/brainless-dash
docker compose up -d --build
```

Open `http://<unraid-ip>:8080` from any device on the LAN.

To update later:

```sh
cd /mnt/user/appdata/brainless-dash
git pull
docker compose up -d --build
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | TCP port the dashboard listens on. With host networking this is the host port directly. |
| `REFRESH_MS` | `2000` | Frontend poll interval in milliseconds. Minimum enforced: 500. |
| `LOG_LEVEL` | `info` | Uvicorn log level. One of: `critical`, `error`, `warning`, `info`, `debug`, `trace`. |
| `TZ` | (unset) | IANA timezone (e.g. `Australia/Sydney`, `Europe/London`, `America/New_York`). |

## Volumes

All volumes are mounted **read-only**. The container needs no write access to the host.

| Container path | Host path | Mode | Purpose |
|----------------|-----------|------|---------|
| `/sys` | `/sys` | ro | Hardware temperature sensors via hwmon |
| `/proc` | `/proc` | ro | CPU, memory, network counters, mdstat |
| `/mnt` | `/mnt` | ro | Unraid array, cache pools, user shares for capacity reporting |

## Network and runtime flags

| Flag | Value | Why |
|------|-------|-----|
| `--network` | `host` | See real interface names (`eth0`, `bond0`) and accurate per-NIC bandwidth, not the Docker bridge. |
| `--pid` | `host` | Allows process and load-average visibility into the host. |
| `--restart` | `unless-stopped` | Survives reboots without coming up after manual stop. |

Privileged mode is **not** required. The container runs as UID 1001.

## Installing on Unraid

### Option A: Docker Compose (simplest)

The `docker compose up -d --build` command above is all you need on a stock Unraid box. The container will appear in the Docker tab of the Unraid web UI like any other.

### Option B: Manual Docker template via the Unraid UI

In the Unraid web UI, go to **Docker** > **Add Container** and use these settings:

| Field | Value |
|-------|-------|
| Name | `brainless-dash` |
| Repository | `brainless-dash:latest` (built locally, so use this image name) |
| Network Type | `host` |
| Privileged | No |
| Extra Parameters | `--pid=host` |
| WebUI | `http://[IP]:[PORT:8080]/` |

Add the three read-only path mappings (`/sys`, `/proc`, `/mnt`) and the four environment variables from the tables above.

### Option C: User template XML

The repo includes `brainless-dash.xml`, a Docker user template. Copy it to `/boot/config/plugins/dockerMan/templates-user/my-brainless-dash.xml` on the Unraid USB stick, then go to **Docker** > **Add Container** and pick the `brainless-dash` template from the dropdown. All variables and paths are pre-configured.

> Note: this template targets a locally built image (`brainless-dash:latest`). Build the image first with `docker compose build` (or `docker build -t brainless-dash:latest .`) before adding the container from the template.

## API endpoints

If you want to scrape data programmatically (Home Assistant, Grafana, etc.):

| Endpoint | Returns |
|----------|---------|
| `GET /api/health` | Liveness check |
| `GET /api/config` | Frontend runtime config (refresh interval) |
| `GET /api/stats` | Full payload: cpu, memory, temps, storage, network |
| `GET /api/cpu` | CPU only |
| `GET /api/memory` | Memory only |
| `GET /api/temps` | Temperature sensors only |
| `GET /api/storage` | Storage mounts and array status |
| `GET /api/network` | Network counters and current rates |

All responses are JSON.

## Local development

```sh
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```

Open `http://localhost:8080`. Note that on macOS or Windows, temperature sensors and Unraid mounts will not be present; storage will fall back to whatever real partitions psutil discovers.

## Notes and limitations

- Temperatures depend on the host kernel exposing hwmon entries. If `/api/temps` returns an empty list, install the **Dynamix System Temperature** plugin on Unraid and confirm `/sys/class/hwmon` is populated.
- Network rate is computed from a delta between successive polls. The first reading after container start will show `0 B/s`.
- The container uses `network_mode: host`, so the `PORT` env var is the host port directly. There is no separate port mapping.
- Default port is `8080`. Change `PORT` in your environment if it conflicts with another service.
- This is a read-only monitoring tool. It cannot start, stop or modify anything on the host.

## License

MIT. See [LICENSE](LICENSE).

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
  <img src="https://img.shields.io/docker/pulls/brainless86/brainless-dash.svg" alt="Docker pulls">
</p>

---

A lightweight, mobile-first web dashboard for monitoring an Unraid server. Runs as a Docker container on the Unraid host. Core metrics are always on; optional integrations with Plex, Sonarr, SABnzbd, qBittorrent and Minecraft are enabled by setting the relevant environment variables.

## Features

**Always on**
- CPU usage, frequency, and load averages
- Memory and swap usage with progress bars
- Temperature sensors displayed as a rolling line graph (CPU, mainboard, drives)
- Storage usage per Unraid array disk and cache pool
- Live network throughput (download and upload bytes/second)
- Auto-refresh (configurable interval), mobile-first responsive layout
- Dark Unraid-themed UI, runs as non-root, no privileged mode required

**Optional integrations**
- [Plex](#plex) — active streams, user, player, and progress
- [Sonarr](#sonarr) — upcoming episodes for the next 5 days
- [SABnzbd](#sabnzbd) — active downloads, speed, and queue
- [qBittorrent](#qbittorrent) — download/upload speeds and torrent counts
- [Minecraft](#minecraft) — server status, favicon, MOTD, latency, version, online players, and Forge mod list
- [HTTPS / Let's Encrypt](#https--lets-encrypt) — automatic TLS with DNS challenge (Cloudflare, DigitalOcean, DuckDNS) or manual cert files

## Stack

- Python 3.12, FastAPI, psutil
- Static HTML, CSS, and vanilla JavaScript frontend (no build step)
- Single Docker image — `brainless86/brainless-dash:latest`

## Quick start

### Via Unraid GUI

1. Go to **Docker** > **Add Container**
2. Set **Repository** to `brainless86/brainless-dash:latest`
3. Set **Network Type** to `Host` and add `--pid=host` to **Extra Parameters**
4. Add the path mappings and environment variables from the tables below
5. Click **Apply**

See [Installing on Unraid](#installing-on-unraid) for the full walkthrough.

### Via terminal

```sh
docker run -d \
  --name brainless-dash \
  --network host \
  --pid host \
  --restart unless-stopped \
  -v /sys:/sys:ro \
  -v /proc:/proc:ro \
  -v /mnt:/mnt:ro \
  -e TZ=Australia/Sydney \
  brainless86/brainless-dash:latest
```

Open `http://<unraid-ip>:8090` from any device on the LAN.

---

## Environment variables

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8090` | Port the dashboard listens on. With host networking this is the host port directly. |
| `REFRESH_MS` | `2000` | Frontend poll interval in milliseconds. Minimum 500. |
| `LOG_LEVEL` | `info` | Uvicorn log level: `critical`, `error`, `warning`, `info`, `debug`, `trace`. |
| `TZ` | (unset) | IANA timezone string, e.g. `Australia/Sydney`, `America/New_York`. |

### Plex

| Variable | Default | Description |
|----------|---------|-------------|
| `PLEX_URL` | `http://localhost:32400` | URL of the Plex Media Server. |
| `PLEX_TOKEN` | (unset) | Plex authentication token. Set this to enable the streams card. |

### Sonarr

| Variable | Default | Description |
|----------|---------|-------------|
| `SONARR_URL` | `http://localhost:8989` | URL of the Sonarr instance. |
| `SONARR_API_KEY` | (unset) | Sonarr API key. Set this to enable the upcoming episodes card. |

### SABnzbd

| Variable | Default | Description |
|----------|---------|-------------|
| `SABNZBD_URL` | `http://localhost:8080` | URL of the SABnzbd instance. |
| `SABNZBD_API_KEY` | (unset) | SABnzbd API key. Set this to enable the downloads card. |

### qBittorrent

| Variable | Default | Description |
|----------|---------|-------------|
| `QB_URL` | `http://localhost:8080` | URL of the qBittorrent WebUI. |
| `QB_API_KEY` | (unset) | API key (qBittorrent 5.0+). Preferred over username/password. |
| `QB_USERNAME` | `admin` | WebUI username. Used only when `QB_API_KEY` is not set. |
| `QB_PASSWORD` | (unset) | WebUI password. Set either this or `QB_API_KEY` to enable the card. |

### Minecraft

| Variable | Default | Description |
|----------|---------|-------------|
| `MC_HOST` | (unset) | Hostname or IP of the Minecraft server. Set this to enable the status card. |
| `MC_PORT` | `25565` | Minecraft server port. |
| `MC_DATA_DIR` | (unset) | Path inside the container to the Minecraft server data dir. Mount it read-only to expose the operator list, gamemode, and an on-disk mod count fallback (useful for NeoForge / Fabric where the SLP ping does not advertise mods). |
| `MC_RCON_PORT` | `25575` | RCON port on the Minecraft server. |
| `MC_RCON_PASSWORD` | (unset) | RCON password. Set this to enable the Op / Deop buttons in the Minecraft drill-down view. Requires `enable-rcon=true` and a matching `rcon.password` in your `server.properties`. |

### UniFi

| Variable | Default | Description |
|----------|---------|-------------|
| `UNIFI_URL` | (unset) | Base URL of your UniFi Network Application or UDM, e.g. `https://192.168.1.1`. Set this to enable the UniFi card. |
| `UNIFI_USERNAME` | (unset) | UniFi local account username. |
| `UNIFI_PASSWORD` | (unset) | UniFi local account password. |
| `UNIFI_SITE` | `default` | UniFi site name. Leave as `default` unless you have multiple sites. |
| `UNIFI_VERIFY_SSL` | `true` | Set to `false` to skip SSL certificate verification. Most home controllers use self-signed certificates and require this. |

### Spotify

| Variable | Default | Description |
|----------|---------|-------------|
| `SPOTIFY_CLIENT_ID` | (unset) | Spotify app Client ID. Set this to enable the playback card. Create an app at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and add `http://<host>:<port>/api/spotify/callback` as a Redirect URI. |
| `SPOTIFY_CLIENT_SECRET` | (unset) | Spotify app Client Secret. |
| `SPOTIFY_REDIRECT_URI` | (unset) | OAuth callback URI. Must match the Redirect URI registered in your Spotify app exactly. Defaults to the request host when empty, which works for most setups. |
| `SPOTIFY_TOKEN_FILE` | `/tmp/spotify_token.json` | Path inside the container where the OAuth token is persisted. Set to a path inside a mounted volume (e.g. `/data/spotify_token.json`) so you do not need to re-authorise after a container restart. |

Once the env vars are set, open the dashboard and click **Connect Spotify** on the card. You will be redirected to Spotify to authorise access. After authorising, the card shows the currently playing track with play, pause, skip, shuffle, and repeat controls.

### Weather

The weather card uses the viewer's browser geolocation — no API key required. The backend proxies requests to [Open-Meteo](https://open-meteo.com/) (free, no account needed) and caches results for 10 minutes. Location names are resolved via Nominatim reverse geocoding and cached for 24 hours.

| Variable | Default | Description |
|----------|---------|-------------|
| `WEATHER_UNITS` | `metric` | Temperature and wind speed units: `metric` (°C, km/h) or `imperial` (°F, mph). |

The card appears automatically once the browser grants location permission.

### HTTPS — manual certificates

| Variable | Default | Description |
|----------|---------|-------------|
| `HTTPS_CERT` | (unset) | Path inside the container to a PEM certificate file, e.g. `/data/certs/cert.pem`. |
| `HTTPS_KEY` | (unset) | Path inside the container to the matching private key file. |

### HTTPS — automatic Let's Encrypt (ACME)

| Variable | Default | Description |
|----------|---------|-------------|
| `ACME_DOMAIN` | (unset) | Domain to obtain a certificate for, e.g. `dash.example.com`. Set this and `ACME_EMAIL` to enable. |
| `ACME_EMAIL` | (unset) | Email for Let's Encrypt account registration and expiry notices. |
| `ACME_DNS_PLUGIN` | (unset) | DNS provider plugin: `cloudflare`, `digitalocean`, or `duckdns`. Recommended — no port forwarding needed. |
| `ACME_DNS_CREDENTIALS` | (unset) | Path inside the container to the DNS provider credentials file, e.g. `/data/certs/cloudflare.ini`. |
| `ACME_CHALLENGE_PORT` | `8180` | HTTP-01 fallback port. Only used when `ACME_DNS_PLUGIN` is not set. Forward port 80 on your router here. |

---

## Volumes

| Container path | Host path | Mode | Purpose |
|----------------|-----------|------|---------|
| `/sys` | `/sys` | ro | Hardware temperature sensors via hwmon |
| `/proc` | `/proc` | ro | CPU, memory, network counters, load averages |
| `/mnt` | `/mnt` | ro | Unraid array disks, cache pools for capacity reporting |
| `/data` | e.g. `/mnt/user/appdata/brainless-dash` | rw | Persistent app data. ACME certs are stored at `/data/certs`; the Spotify token is stored at `/data/spotify_token.json`. |

The `/data` mount is optional but recommended. Without it, ACME certs and the Spotify token are lost on every container restart.

---

## Optional integrations

### Plex

The Plex card shows all active streams — title, user, player, direct play vs transcode, and playback progress.

**Getting your Plex token**

1. Open [app.plex.tv](https://app.plex.tv) in a browser and sign in
2. Browse to any movie or episode, click the three-dot menu, and choose **Get Info**
3. At the bottom of the info panel click **View XML**
4. In the URL bar you will see `?X-Plex-Token=XXXXXXXXXXXXXXXXXX` — that string is your token

Alternatively, retrieve it via the command line:

```sh
curl -s -X POST "https://plex.tv/users/sign_in.xml" \
  -H "X-Plex-Product: Brainless-Dash" \
  -H "X-Plex-Client-Identifier: brainless-dash-setup" \
  --data-urlencode "user[login]=YOUR_EMAIL" \
  --data-urlencode "user[password]=YOUR_PASSWORD" \
  | grep -o 'authenticationToken="[^"]*"'
```

**Configuration**

```
PLEX_URL=http://localhost:32400   # or http://<plex-ip>:32400
PLEX_TOKEN=xxxxxxxxxxxxxxxxxxxx
```

> If Plex runs in a Docker container using macvlan/br0 networking on the same Unraid host, you cannot reach it by its container IP from Brainless-Dash. Switch Plex to host networking and use `localhost`.

---

### Sonarr

The Sonarr card shows episodes airing in the next 5 days with their season/episode number and a downloaded badge.

**Getting your Sonarr API key**

1. Open the Sonarr web UI
2. Go to **Settings** > **General** > **Security**
3. Copy the value under **API Key**

**Configuration**

```
SONARR_URL=http://localhost:8989   # or http://<sonarr-ip>:8989
SONARR_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

### SABnzbd

The SABnzbd card shows download speed, remaining queue size, and a progress bar for each active download slot (up to 5).

**Getting your SABnzbd API key**

1. Open the SABnzbd web UI
2. Go to **Config** (cog icon) > **General**
3. Under **SABnzbd Web Interface**, find **API Key** and click **Generate** if empty
4. Copy the key

**Configuration**

```
SABNZBD_URL=http://localhost:8080   # adjust port for your install
SABNZBD_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

### qBittorrent

The qBittorrent card shows download and upload speeds plus counts of downloading, seeding, and paused torrents.

**Option A: API key (qBittorrent 5.0+, recommended)**

1. Open the qBittorrent WebUI
2. Go to **Tools** > **Options** > **Web UI** > **Security**
3. Enable **API key authentication** and copy the generated key

```
QB_URL=http://localhost:8080
QB_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Option B: Username and password (older versions)**

1. Open **Tools** > **Options** > **Web UI** > **Authentication**
2. Note your username (default `admin`) and the password you set

```
QB_URL=http://localhost:8080
QB_USERNAME=admin
QB_PASSWORD=yourpassword
```

---

### Minecraft

Read-only Server List Ping (SLP). The card shows:

- online/offline status with a coloured dot
- server favicon (the 64x64 PNG the server advertises)
- MOTD, including multi-line MOTDs (colour codes are stripped)
- version name and protocol number
- live latency in ms (measured via the SLP ping/pong round trip)
- player count, sample player names, plus a `+N hidden` chip when the server hides full names
- Forge or NeoForge mod count and a sample of mod IDs (when the server publishes `forgeData` / `modinfo`)
- a `secure` chip when the server enforces secure chat

```
MC_HOST=192.168.1.100   # or the hostname of your Minecraft server
MC_PORT=25565           # default Minecraft port
```

#### Drill-down extras

Click the Minecraft card to open a detail view with:

- a rolling 2-hour player count graph (area chart, one sample every 30 seconds)
- a game-time leaderboard sorted by total time online, with an "online" badge for currently connected players
- operator status, gamemode, and difficulty
- one-click op/deop buttons (when RCON is configured)

The graph and leaderboard are maintained in memory while the container runs; they reset on restart. The operator list, gamemode, and op/deop buttons need access beyond the SLP ping:

- **`MC_DATA_DIR`** (read-only mount of the server data dir): exposes the operator list (`ops.json`), the gamemode and difficulty (`server.properties`), and a fallback mod count from the `mods/` directory (NeoForge and Fabric servers usually do not advertise mods over SLP).
- **`MC_RCON_PASSWORD`** (and `MC_RCON_PORT` if non-default): enables the Op / Deop buttons next to each connected player. The server must have `enable-rcon=true` and a matching `rcon.password` in `server.properties`. Op/deop are the only commands sent — no chat, no log scraping.

Example:

```yaml
volumes:
  - /mnt/user/appdata/minecraft:/mnt/mc:ro
environment:
  - MC_DATA_DIR=/mnt/mc
  - MC_RCON_PORT=25575
  - MC_RCON_PASSWORD=changeme
```

Without these extras, the drill-down still works but the operator list and gamemode display as `—` and the op/deop buttons are hidden.

---

### HTTPS / Let's Encrypt

Brainless-Dash supports HTTPS via manually supplied certificates or automatic Let's Encrypt certificate management using certbot.

---

#### Option A: Manual certificate files

If you already have a certificate (from Nginx Proxy Manager, certbot, or anywhere else), mount the files into the container and point to them:

```yaml
volumes:
  - /path/to/your/certs:/data/certs:ro
environment:
  - HTTPS_CERT=/data/certs/cert.pem
  - HTTPS_KEY=/data/certs/key.pem
```

---

#### Option B: Automatic Let's Encrypt — DNS challenge (recommended)

DNS challenge does not require any port forwarding. Your domain only needs to resolve to a public IP; the server does not need to be reachable on port 80.

**Supported DNS providers**

| Provider | Plugin value | Credentials file |
|----------|-------------|-----------------|
| Cloudflare | `cloudflare` | See below |
| DigitalOcean | `digitalocean` | See below |
| DuckDNS | `duckdns` | See below |

Need a different provider? Open an issue — adding new certbot DNS plugins is straightforward.

**Step 1 — Create a credentials file**

Create a file on the Unraid host (e.g. `/mnt/user/appdata/brainless-dash/certs/dns.ini`) with your DNS provider credentials. Keep this file private.

*Cloudflare* — create a scoped API token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) with **Zone:DNS:Edit** permission:

```ini
dns_cloudflare_api_token = your-cloudflare-api-token
```

*DigitalOcean* — create a personal access token at [cloud.digitalocean.com/account/api/tokens](https://cloud.digitalocean.com/account/api/tokens) with **write** scope:

```ini
dns_digitalocean_token = your-digitalocean-token
```

*DuckDNS* — find your token at [duckdns.org](https://www.duckdns.org) after signing in:

```ini
dns_duckdns_token = your-duckdns-token
```

**Step 2 — Configure environment variables**

```
ACME_DOMAIN=dash.example.com
ACME_EMAIL=you@example.com
ACME_DNS_PLUGIN=cloudflare
ACME_DNS_CREDENTIALS=/data/certs/dns.ini
```

**Step 3 — Mount the certs directory**

```yaml
volumes:
  - /mnt/user/appdata/brainless-dash/certs:/data/certs
```

The credentials file must be inside the mounted directory (or mounted separately). On first start certbot obtains the certificate and uvicorn starts with HTTPS. The certificate renews automatically every 7 days (certbot only renews if expiry is within 30 days) with a brief container restart — typically under 10 seconds every 60–90 days.

---

#### Option C: Automatic Let's Encrypt — HTTP challenge (fallback)

Use this if you do not have DNS API access. Port 80 on your router must be forwarded to the Unraid host on `ACME_CHALLENGE_PORT`.

```
ACME_DOMAIN=dash.example.com
ACME_EMAIL=you@example.com
ACME_CHALLENGE_PORT=8180
```

Forward port `80` → `<unraid-ip>:8180` in your router. No `ACME_DNS_PLUGIN` or credentials file needed.

---

## Network and runtime flags

| Flag | Value | Why |
|------|-------|-----|
| `--network` | `host` | Sees real interface names (`eth0`, `bond0`) and accurate per-NIC bandwidth. |
| `--pid` | `host` | Accurate load averages and process visibility into the host. |
| `--restart` | `unless-stopped` | Survives reboots; does not restart after a manual `docker stop`. |

Privileged mode is **not** required. The container runs as UID 1001.

---

## Installing on Unraid

### Option A: Add Container manually

Go to **Docker** > **Add Container** and fill in:

| Field | Value |
|-------|-------|
| Name | `brainless-dash` |
| Repository | `brainless86/brainless-dash:latest` |
| Network Type | `Host` |
| Privileged | No |
| Extra Parameters | `--pid=host` |
| WebUI | `http://[IP]:[PORT:8090]/` |

Add the path mappings and environment variables from the tables above. Click **Apply**.

### Option B: User template XML

The repo includes `brainless-dash.xml` with all fields pre-filled. Copy it to your Unraid USB:

```sh
curl -o /boot/config/plugins/dockerMan/templates-user/my-brainless-dash.xml \
  https://raw.githubusercontent.com/brainless-git/brainless-dash/main/brainless-dash.xml
```

Go to **Docker** > **Add Container**, pick `brainless-dash` from the template dropdown, fill in any optional integration credentials, and click **Apply**.

### Option C: Docker Compose

```sh
curl -o docker-compose.yml \
  https://raw.githubusercontent.com/brainless-git/brainless-dash/main/docker-compose.yml
docker compose up -d
```

Edit `docker-compose.yml` to set your credentials before running.

---

## API endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Liveness check — returns `{"status":"ok"}` |
| `/api/config` | GET | Frontend runtime config (refresh interval) |
| `/api/stats` | GET | Full payload: all metrics and enabled integrations |
| `/api/cpu` | GET | CPU metrics only |
| `/api/memory` | GET | Memory and swap only |
| `/api/temps` | GET | Temperature sensors only |
| `/api/storage` | GET | Storage mounts and array status |
| `/api/network` | GET | Network counters and current rates |
| `/api/plex` | GET | Plex sessions (404 if not configured) |
| `/api/sonarr` | GET | Sonarr calendar (404 if not configured) |
| `/api/sabnzbd` | GET | SABnzbd queue (404 if not configured) |
| `/api/qbittorrent` | GET | qBittorrent stats (404 if not configured) |
| `/api/minecraft` | GET | Minecraft server status (404 if not configured) |

All responses are JSON.

---

## Local development

```sh
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8090
```

Open `http://localhost:8090`. Temperature sensors and Unraid mounts will not be present on macOS or Windows; storage falls back to whatever partitions psutil finds locally.

---

## Notes and limitations

- **Temperatures** depend on the host kernel exposing hwmon entries. If the temperature card shows no sensors, install the **Dynamix System Temperature** Unraid plugin and confirm `/sys/class/hwmon` is populated.
- **Network rate** is calculated from the delta between successive polls. The first reading after container start shows `0 B/s`.
- **Storage totals** are calculated from individual disk mounts (`/mnt/disk*`, `/mnt/cache*`) only. The `/mnt/user` and `/mnt/user0` union filesystem mounts are excluded to avoid double-counting.
- **Plex on macvlan/br0** — the Unraid host cannot reach containers using macvlan networking by their container IP. Switch Plex to host networking and use `localhost`, or use a bridge network.
- **Minecraft player names** — some servers hide the player sample list even when players are online. In that case the count is shown but names are not.
- **Let's Encrypt rate limits** — the `/data/certs` volume must be mounted persistently. If certs are lost and re-requested too frequently, Let's Encrypt will temporarily block issuance. The stored certbot configuration is also what drives automatic renewal, so without the volume mount, renewals will not work.
- This is a read-only monitoring tool. It cannot start, stop, or modify anything on the host.

## License

MIT. See [LICENSE](LICENSE).

# Brainless-Dash

A lightweight, mobile-first Unraid monitoring dashboard. Deploys as a Docker container on the Unraid host. See `README.md` for the full user-facing overview.

## Stack

- Backend: Python 3.12, FastAPI, psutil (`app/main.py`, `app/stats.py`)
- Frontend: vanilla HTML, CSS, JS in `app/static/`. No build step, no framework, no transpilation.
- Container: single Dockerfile, non-root UID 1001
- Deploy: Docker Compose with host networking and read-only mounts of `/sys`, `/proc`, `/mnt`

## Key commands

```sh
# Local dev (no host metrics on macOS/Windows, as expected)
python -m venv .venv
source .venv/bin/activate          # PowerShell: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080

# Docker
docker compose up -d --build

# Smoke tests
curl http://localhost:8080/api/health      # {"status":"ok"}
curl http://localhost:8080/api/stats       # full JSON payload
```

## Endpoints

`/api/health`, `/api/config`, `/api/stats`, `/api/cpu`, `/api/memory`, `/api/temps`, `/api/storage`, `/api/network`. Frontend renders at `/`.

## Conventions

### Code
- Stdlib plus the three pinned deps in `requirements.txt` only. No new dependencies without a strong reason.
- Type hints where they aid readability, not religiously.
- Frontend stays vanilla. No React, no bundler, no TypeScript.
- All host access is READ-ONLY. This is a monitoring tool. Never write to `/sys`, `/proc`, `/mnt`, never call subprocess for anything that mutates host state.

### Adding an environment variable
Update all four locations or it'll drift:
1. `Dockerfile` (set ENV default)
2. `docker-compose.yml` (environment block)
3. `README.md` (env vars table)
4. `brainless-dash.xml` (Unraid Docker user template, `<Config>` block)

### Theme
- Accent (Unraid red): `#e22828`
- Background `#1c1c1c`, card `#2a2a2a`, border `#3a3a3a`, text `#e8e8e8`, dim `#9a9a9a`
- All colours live in `app/static/style.css` `:root`. Reuse the variables, don't hardcode hex elsewhere.
- Mobile first. Layout must work at 320px. Breakpoints at 700px and 1000px.

### Branding
- Mascot: brainless red ghost. Lives in `assets/icon.svg` (square), `assets/logo.svg` (horizontal lockup with wordmark), `app/static/favicon.svg` (favicon), and inline in `app/static/index.html` topbar.
- Don't change the mascot or wordmark without an explicit request.

## Writing style (docs, comments, commit messages, generated content)

- Australian English (colour, organisation, behaviour, optimise).
- Numerals as numerals: "2 cores", not "two cores".
- Avoid em-dashes and en-dashes. Prefer commas, parentheses, full stops.
- Concise and direct. No filler, no hype, no marketing language.
- Don't invent facts. If something is unknown, state it.

## Project layout

```
brainless-dash/
├── app/
│   ├── main.py              FastAPI routes and static file mount
│   ├── stats.py             psutil-based metric collection
│   └── static/              frontend (index.html, style.css, app.js, favicon.svg)
├── assets/                  logo SVGs (icon.svg, logo.svg)
├── Dockerfile
├── docker-compose.yml
├── brainless-dash.xml       Unraid Docker user template
├── requirements.txt
├── README.md
└── CLAUDE.md                this file
```

## Repo

Public GitHub repo: `brainless-git/brainless-dash`. Image is published to Docker Hub as `brainless86/brainless-dash` via GitHub Actions on every push to `main`.

## Out of scope

- Writing to or modifying the Unraid host
- Authentication, user accounts, multi-user features (LAN-only tool)
- Replacing dedicated time-series stores. The built-in SQLite history (see below) is for at-a-glance trends and Minecraft playtime — not for long-retention dashboards. For full historical analysis, Grafana + Prometheus is still the right tool.
- Alerting
- Rewriting the frontend in React or any framework

## History storage

A SQLite database at `DB_PATH` (default `/data/db/brainless.db`) stores 1-minute-bucketed metric averages and Minecraft player session data. Retention is `DB_RETENTION_DAYS` (default 14, max 365). The per-player `mc_playtime` totals are retained indefinitely; only the per-session detail rows and time-series buckets are pruned. The DB lives in `app/db.py`; the schema is created on startup if missing. WAL mode + a background flusher thread keeps the writes off the request path. If `DB_PATH`'s parent directory cannot be created (no volume mount), history disables itself silently and `db.enabled()` returns `False`.

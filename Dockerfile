FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

# System deps for psutil (minimal)
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt \
    && apt-get purge -y gcc \
    && apt-get autoremove -y

COPY app ./app

EXPOSE 8090

ENV PORT=8090 \
    REFRESH_MS=2000 \
    LOG_LEVEL=info \
    PLEX_URL=http://localhost:32400 \
    PLEX_TOKEN= \
    SONARR_URL=http://localhost:8989 \
    SONARR_API_KEY= \
    SABNZBD_URL=http://localhost:8080 \
    SABNZBD_API_KEY= \
    QB_URL=http://localhost:8080 \
    QB_USERNAME=admin \
    QB_PASSWORD= \
    QB_API_KEY= \
    MC_HOST= \
    MC_PORT=25565 \
    MC_RCON_PORT=25575 \
    MC_RCON_PASSWORD= \
    HTTPS_CERT= \
    HTTPS_KEY=

# Run as non-root for safety. Mounts /sys and /proc remain readable.
RUN useradd -r -u 1001 monitor && chown -R monitor:monitor /srv
USER monitor

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8080\")}/api/health', timeout=3)" || exit 1

CMD ["sh", "-c", "SSL=''; [ -n \"$HTTPS_CERT\" ] && [ -n \"$HTTPS_KEY\" ] && SSL=\"--ssl-certfile $HTTPS_CERT --ssl-keyfile $HTTPS_KEY\"; exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --log-level ${LOG_LEVEL} $SSL"]

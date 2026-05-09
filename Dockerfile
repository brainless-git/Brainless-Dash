FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

# gcc is only needed to compile psutil; certbot is kept for ACME cert management
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt \
    && apt-get purge -y gcc \
    && apt-get autoremove -y

RUN apt-get update \
    && apt-get install -y --no-install-recommends certbot \
    && rm -rf /var/lib/apt/lists/*

COPY app ./app
COPY entrypoint.sh /entrypoint.sh

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
    HTTPS_KEY= \
    ACME_DOMAIN= \
    ACME_EMAIL= \
    ACME_CHALLENGE_PORT=8180

# Run as non-root. /data/certs is owned by monitor so certbot can write there.
RUN useradd -r -u 1001 monitor \
    && chown -R monitor:monitor /srv \
    && chmod +x /entrypoint.sh \
    && mkdir -p /data/certs \
    && chown -R monitor:monitor /data
USER monitor

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "\
import os, ssl, urllib.request; \
port = os.environ.get('PORT','8090'); \
https = os.environ.get('HTTPS_CERT') or os.environ.get('ACME_DOMAIN'); \
scheme = 'https' if https else 'http'; \
ctx = ssl.create_default_context() if https else None; \
https and setattr(ctx, 'check_hostname', False) or None; \
https and setattr(ctx, 'verify_mode', ssl.CERT_NONE) or None; \
urllib.request.urlopen(f'{scheme}://127.0.0.1:{port}/api/health', timeout=3, context=ctx)" \
    || exit 1

CMD ["/entrypoint.sh"]

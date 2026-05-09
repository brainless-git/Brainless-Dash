#!/bin/sh
# Brainless-Dash entrypoint — optional Let's Encrypt cert acquisition before uvicorn starts.
#
# Required env vars for ACME:
#   ACME_DOMAIN          e.g. dash.example.com
#   ACME_EMAIL           e.g. admin@example.com
#
# Optional:
#   ACME_CHALLENGE_PORT  Port certbot binds for the HTTP-01 challenge (default 8180).
#                        Your router must forward port 80 → host:<ACME_CHALLENGE_PORT>.
#
# Certs are stored under /data/certs (mount a persistent volume there).
# Once a valid cert exists the container auto-renews weekly via a background thread.

set -e

CERTDIR=/data/certs

if [ -n "$ACME_DOMAIN" ] && [ -n "$ACME_EMAIL" ]; then
    CHALLENGE_PORT="${ACME_CHALLENGE_PORT:-8180}"
    LIVE="$CERTDIR/live/$ACME_DOMAIN"

    mkdir -p /tmp/certbot/work /tmp/certbot/logs "$CERTDIR"

    if [ ! -f "$LIVE/fullchain.pem" ]; then
        echo "[acme] Obtaining certificate for $ACME_DOMAIN (challenge port $CHALLENGE_PORT)..."
        certbot certonly \
            --standalone \
            --http-01-port "$CHALLENGE_PORT" \
            --email "$ACME_EMAIL" \
            --agree-tos \
            --no-eff-email \
            -d "$ACME_DOMAIN" \
            --config-dir "$CERTDIR" \
            --work-dir /tmp/certbot/work \
            --logs-dir /tmp/certbot/logs \
            --non-interactive
    else
        echo "[acme] Certificate already present for $ACME_DOMAIN."
    fi

    if [ -f "$LIVE/fullchain.pem" ]; then
        export HTTPS_CERT="$LIVE/fullchain.pem"
        export HTTPS_KEY="$LIVE/privkey.pem"
    else
        echo "[acme] WARNING: cert acquisition failed — starting without HTTPS."
    fi
fi

SSL=""
if [ -n "$HTTPS_CERT" ] && [ -n "$HTTPS_KEY" ]; then
    SSL="--ssl-certfile $HTTPS_CERT --ssl-keyfile $HTTPS_KEY"
    echo "[acme] Starting with HTTPS."
fi

exec uvicorn app.main:app \
    --host 0.0.0.0 \
    --port "${PORT:-8090}" \
    --log-level "${LOG_LEVEL:-info}" \
    $SSL

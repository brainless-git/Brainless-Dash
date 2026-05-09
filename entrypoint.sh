#!/bin/bash
# Brainless-Dash entrypoint — optional Let's Encrypt cert acquisition before uvicorn starts.
#
# Set ACME_DOMAIN + ACME_EMAIL to enable automatic HTTPS.
#
# DNS-01 challenge (recommended — no port forwarding required):
#   ACME_DNS_PLUGIN       e.g. cloudflare | digitalocean | duckdns
#   ACME_DNS_CREDENTIALS  path inside container to the credentials file
#                         (mount your creds file into /data/certs/ or similar)
#
#   Cloudflare creds file:
#     dns_cloudflare_api_token = YOUR_TOKEN
#
#   DigitalOcean creds file:
#     dns_digitalocean_token = YOUR_TOKEN
#
#   DuckDNS creds file:
#     dns_duckdns_token = YOUR_TOKEN
#
# HTTP-01 challenge (fallback — requires port 80 forwarded to ACME_CHALLENGE_PORT):
#   ACME_CHALLENGE_PORT   default 8180
#
# Certs are stored under /data/certs (mount a persistent volume there).
# The app renews automatically every 7 days via a background thread.

set -e

CERTDIR=/data/certs

if [ -n "$ACME_DOMAIN" ] && [ -n "$ACME_EMAIL" ]; then
    LIVE="$CERTDIR/live/$ACME_DOMAIN"

    mkdir -p /tmp/certbot/work /tmp/certbot/logs "$CERTDIR"

    # Build challenge arguments as an array to prevent word-splitting and injection.
    CHALLENGE_ARGS=()
    if [ -n "$ACME_DNS_PLUGIN" ]; then
        # Validate plugin name against the supported allowlist.
        case "$ACME_DNS_PLUGIN" in
            cloudflare|digitalocean|duckdns) ;;
            *)
                echo "[acme] ERROR: ACME_DNS_PLUGIN '$ACME_DNS_PLUGIN' is not supported. Allowed: cloudflare, digitalocean, duckdns."
                exit 1
                ;;
        esac
        CHALLENGE_ARGS+=(--dns-"${ACME_DNS_PLUGIN}")
        if [ -n "$ACME_DNS_CREDENTIALS" ]; then
            CHALLENGE_ARGS+=(--dns-"${ACME_DNS_PLUGIN}"-credentials "$ACME_DNS_CREDENTIALS")
        fi
        echo "[acme] Using DNS-01 challenge via plugin: $ACME_DNS_PLUGIN"
    else
        CHALLENGE_ARGS+=(--standalone --http-01-port "${ACME_CHALLENGE_PORT:-8180}")
        echo "[acme] Using HTTP-01 challenge on port ${ACME_CHALLENGE_PORT:-8180}"
    fi

    if [ ! -f "$LIVE/fullchain.pem" ]; then
        echo "[acme] Obtaining certificate for $ACME_DOMAIN..."
        certbot certonly \
            "${CHALLENGE_ARGS[@]}" \
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

# Build SSL args as an array to handle paths with spaces correctly.
SSL_ARGS=()
if [ -n "$HTTPS_CERT" ] && [ -n "$HTTPS_KEY" ]; then
    SSL_ARGS+=(--ssl-certfile "$HTTPS_CERT" --ssl-keyfile "$HTTPS_KEY")
    echo "[acme] Starting with HTTPS."
fi

exec uvicorn app.main:app \
    --host 0.0.0.0 \
    --port "${PORT:-8090}" \
    --log-level "${LOG_LEVEL:-info}" \
    "${SSL_ARGS[@]}"

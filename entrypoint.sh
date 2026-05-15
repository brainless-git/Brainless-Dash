#!/bin/bash
# Brainless-Dash entrypoint.
#
# Runs as root so it can write to host-mounted volumes regardless of host
# directory ownership, then drops to UID 1001 (monitor) via gosu before
# exec'ing uvicorn.
#
# Set ACME_DOMAIN + ACME_EMAIL to enable automatic HTTPS via Let's Encrypt.
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

# Ensure the cert storage directory exists and is writable.
# Running as root means we can always fix ownership of the host-mounted volume.
mkdir -p "$CERTDIR"
chown monitor:monitor "$CERTDIR"

if [ -n "$ACME_DOMAIN" ] && [ -n "$ACME_EMAIL" ]; then
    LIVE="$CERTDIR/live/$ACME_DOMAIN"

    mkdir -p /tmp/certbot/work /tmp/certbot/logs

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

    # Certbot warns and ignores credentials files that are world/group readable.
    if [ -n "$ACME_DNS_CREDENTIALS" ] && [ -f "$ACME_DNS_CREDENTIALS" ]; then
        chmod 600 "$ACME_DNS_CREDENTIALS" 2>/dev/null || true
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
        # Make cert files readable by monitor (UID 1001) before dropping privileges.
        # The privkey.pem under live/ is a symlink into archive/, so chown the
        # whole CERTDIR tree (covers live/, archive/, renewal/, accounts/).
        chown -R monitor:monitor "$CERTDIR"
        # Lock down the real key file (chmod follows symlinks, so this hits archive/).
        chmod 640 "$LIVE/privkey.pem"
        export HTTPS_CERT="$LIVE/fullchain.pem"
        export HTTPS_KEY="$LIVE/privkey.pem"
    else
        echo "[acme] WARNING: cert acquisition failed — starting without HTTPS."
    fi
fi

# ── Embedded Tailscale connectivity ───────────────────────────────────────────
# Set TAILSCALE_AUTHKEY to start tailscaled inside the container and publish
# the dashboard via `tailscale serve` (HTTPS at https://<hostname>.ts.net).
# Requires MagicDNS and HTTPS certificates to be enabled in the Tailscale admin
# console (https://login.tailscale.com/admin/dns). State is persisted in
# TAILSCALE_STATE_DIR so the node reconnects without re-auth on restart.
if [ -n "$TAILSCALE_AUTHKEY" ]; then
    TS_STATE="${TAILSCALE_STATE_DIR:-/data/tailscale}"
    mkdir -p "$TS_STATE" /var/run/tailscale
    chown monitor:monitor "$TS_STATE"

    if ! command -v tailscaled >/dev/null 2>&1; then
        echo "[tailscale] ERROR: tailscaled binary not found — image may not include Tailscale binaries."
    else
        echo "[tailscale] Starting tailscaled (userspace networking)..."
        tailscaled \
            --tun=userspace-networking \
            --state="$TS_STATE/tailscaled.state" \
            --socket=/var/run/tailscale/tailscaled.sock \
            > /tmp/tailscaled.log 2>&1 &

        # Wait for the socket to appear (up to 15 s).
        for i in $(seq 1 30); do
            [ -S /var/run/tailscale/tailscaled.sock ] && break
            sleep 0.5
        done

        if [ ! -S /var/run/tailscale/tailscaled.sock ]; then
            echo "[tailscale] WARNING: tailscaled did not start — skipping Tailscale setup."
            echo "[tailscale] tailscaled log:"
            cat /tmp/tailscaled.log 2>/dev/null || true
        else
            echo "[tailscale] Connecting to tailnet as '${TAILSCALE_HOSTNAME:-brainless-dash}'..."
            if tailscale up \
                   --authkey="$TAILSCALE_AUTHKEY" \
                   --hostname="${TAILSCALE_HOSTNAME:-brainless-dash}" \
                   --accept-dns=false \
                   --accept-routes=false; then

                TS_SERVE_PORT="${TAILSCALE_SERVE_PORT:-443}"
                echo "[tailscale] Configuring serve: HTTPS port ${TS_SERVE_PORT} → http://localhost:${PORT:-8090}..."
                # Run in background: older Tailscale versions treat 'serve' as a
                # long-running foreground process; newer versions return immediately.
                # Backgrounding works correctly in both cases.
                tailscale serve --https="${TS_SERVE_PORT}" \
                    http://localhost:"${PORT:-8090}" \
                    > /tmp/tailscale-serve.log 2>&1 &
                sleep 2  # give it a moment to register the config

                # Log the exact URL so there is no ambiguity about which node to connect to.
                TS_DNS=$(tailscale status --json 2>/dev/null \
                    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("Self",{}).get("DNSName","").rstrip("."))' \
                    2>/dev/null || true)
                TS_IP=$(tailscale ip --4 2>/dev/null || true)
                if [ -n "$TS_DNS" ]; then
                    if [ "$TS_SERVE_PORT" = "443" ]; then
                        echo "[tailscale] Dashboard: https://${TS_DNS}/"
                    else
                        echo "[tailscale] Dashboard: https://${TS_DNS}:${TS_SERVE_PORT}/"
                    fi
                fi
                [ -n "$TS_IP" ] && echo "[tailscale] Tailscale IP: ${TS_IP}"
            else
                echo "[tailscale] WARNING: tailscale up failed — check TAILSCALE_AUTHKEY."
            fi
        fi
    fi
fi

# Build SSL args as an array to handle paths with spaces correctly.
SSL_ARGS=()
if [ -n "$HTTPS_CERT" ] && [ -n "$HTTPS_KEY" ]; then
    SSL_ARGS+=(--ssl-certfile "$HTTPS_CERT" --ssl-keyfile "$HTTPS_KEY")
    echo "[acme] Starting with HTTPS."
fi

# Drop from root to monitor (UID 1001) for uvicorn.
exec gosu monitor uvicorn app.main:app \
    --host 0.0.0.0 \
    --port "${PORT:-8090}" \
    --log-level "${LOG_LEVEL:-info}" \
    "${SSL_ARGS[@]}"

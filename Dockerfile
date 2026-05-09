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

EXPOSE 8080

ENV PORT=8080 \
    REFRESH_MS=2000 \
    LOG_LEVEL=info \
    PLEX_URL=http://localhost:32400 \
    PLEX_TOKEN=

# Run as non-root for safety. Mounts /sys and /proc remain readable.
RUN useradd -r -u 1001 monitor && chown -R monitor:monitor /srv
USER monitor

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8080\")}/api/health', timeout=3)" || exit 1

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --log-level ${LOG_LEVEL}"]

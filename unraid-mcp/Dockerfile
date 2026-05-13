FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY server.py .

ENV MCP_API_KEY="" \
    ALLOWED_PATHS="/host/mnt/user/appdata" \
    PORT="8765"

EXPOSE 8765

CMD ["python", "server.py"]

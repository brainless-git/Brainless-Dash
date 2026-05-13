#!/usr/bin/env python3
"""
Unraid MCP Server — exposes Docker management and file tools to Claude Code
via the Model Context Protocol (SSE transport).

Environment variables:
  MCP_API_KEY    Required. Shared secret; send as X-Api-Key header from Claude Code.
  ALLOWED_PATHS  Comma-separated list of paths the file tools may access.
                 Default: /host/mnt/user/appdata
  PORT           Port to listen on. Default: 8765
"""
import json
import os
import pathlib

import docker
import uvicorn
from mcp.server.fastmcp import FastMCP
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import PlainTextResponse

_API_KEY = os.environ.get("MCP_API_KEY", "")
_ALLOWED_PATHS = [
    pathlib.Path(p.strip()).resolve()
    for p in os.environ.get("ALLOWED_PATHS", "/host/mnt/user/appdata").split(",")
    if p.strip()
]
_PORT = int(os.environ.get("PORT", "8765"))

mcp = FastMCP("unraid")
_dc = docker.from_env()


class _AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if _API_KEY and request.headers.get("x-api-key") != _API_KEY:
            return PlainTextResponse("Unauthorised", status_code=401)
        return await call_next(request)


def _safe_path(path: str) -> pathlib.Path:
    p = pathlib.Path(path).resolve()
    if not any(str(p).startswith(str(base)) for base in _ALLOWED_PATHS):
        raise PermissionError(f"Path not within allowed paths: {path}")
    return p


# ── Docker tools ──────────────────────────────────────────────────────────────

@mcp.tool()
def list_containers(all_containers: bool = False) -> str:
    """List Docker containers. Pass all_containers=True to include stopped ones."""
    result = [
        {
            "id": c.short_id,
            "name": c.name,
            "status": c.status,
            "image": c.image.tags[0] if c.image.tags else c.image.short_id,
        }
        for c in _dc.containers.list(all=all_containers)
    ]
    return json.dumps(result, indent=2)


@mcp.tool()
def start_container(name: str) -> str:
    """Start a stopped Docker container by name."""
    _dc.containers.get(name).start()
    return f"Started {name}."


@mcp.tool()
def stop_container(name: str) -> str:
    """Stop a running Docker container by name."""
    _dc.containers.get(name).stop()
    return f"Stopped {name}."


@mcp.tool()
def restart_container(name: str) -> str:
    """Restart a Docker container by name."""
    _dc.containers.get(name).restart()
    return f"Restarted {name}."


@mcp.tool()
def container_logs(name: str, lines: int = 100) -> str:
    """Return the most recent log lines from a container."""
    c = _dc.containers.get(name)
    return c.logs(tail=lines, timestamps=True).decode("utf-8", errors="replace")


@mcp.tool()
def pull_image(image: str) -> str:
    """Pull the latest version of a Docker image tag (e.g. 'brainless86/brainless-dash:latest')."""
    _dc.images.pull(image)
    return f"Pulled {image}."


# ── File tools ────────────────────────────────────────────────────────────────

@mcp.tool()
def list_files(path: str) -> str:
    """List files and directories at path. Path must be within ALLOWED_PATHS."""
    p = _safe_path(path)
    entries = [
        {
            "name": e.name,
            "type": "dir" if e.is_dir() else "file",
            "size": e.stat(follow_symlinks=False).st_size,
        }
        for e in sorted(p.iterdir())
    ]
    return json.dumps(entries, indent=2)


@mcp.tool()
def read_file(path: str) -> str:
    """Read a text file. Path must be within ALLOWED_PATHS."""
    return _safe_path(path).read_text(errors="replace")


@mcp.tool()
def write_file(path: str, content: str) -> str:
    """Write content to a file, creating parent directories as needed. Path must be within ALLOWED_PATHS."""
    p = _safe_path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    return f"Written {path}."


@mcp.tool()
def delete_file(path: str) -> str:
    """Delete a file (not a directory). Path must be within ALLOWED_PATHS."""
    p = _safe_path(path)
    if p.is_dir():
        raise ValueError(f"{path} is a directory.")
    p.unlink()
    return f"Deleted {path}."


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = mcp.sse_app()
    app.add_middleware(_AuthMiddleware)
    uvicorn.run(app, host="0.0.0.0", port=_PORT, log_level="info")

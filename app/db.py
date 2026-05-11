"""SQLite-backed historical storage.

Two concerns live here:

1. Time-series of system + integration metrics, stored as 1-minute
   averages. The poll cadence is much faster (REFRESH_MS) but writing
   every sample would blow up the DB on a 14-day window. Callers feed
   raw samples into ``record_sample``; a background flusher rolls them
   up and writes one row per (metric, minute) bucket.

2. Minecraft player playtime. The MC poller hands us the set of online
   names each tick and we maintain per-player open sessions plus a
   cumulative ``mc_playtime`` total.

Retention is enforced by a daily prune. The DB is a single SQLite file
at ``DB_PATH`` (default ``/data/db/brainless.db``), opened in WAL mode
so the writer thread does not block readers.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from collections import defaultdict
from pathlib import Path

log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
_DB_PATH            = os.environ.get("DB_PATH", "/data/db/brainless.db")
_RETENTION_DAYS     = max(1, min(365, int(os.environ.get("DB_RETENTION_DAYS", "14"))))
_FLUSH_INTERVAL_SEC = 60   # how often we roll up samples into the DB
_PRUNE_INTERVAL_SEC = 86400  # daily

# ── Connection state ──────────────────────────────────────────────────────────
_conn: sqlite3.Connection | None = None
_conn_lock = threading.Lock()
_enabled = False


def enabled() -> bool:
    return _enabled


def retention_days() -> int:
    return _RETENTION_DAYS


# ── In-memory accumulator (raw samples) ───────────────────────────────────────
# Keyed by metric → list of values inside the current minute bucket.
_samples: dict[str, list[float]] = defaultdict(list)
_samples_lock = threading.Lock()


def record_sample(metric: str, value: float | int | None) -> None:
    """Add a single sample. NaN / None values are dropped silently."""
    if value is None or not _enabled:
        return
    try:
        v = float(value)
    except (TypeError, ValueError):
        return
    if v != v:  # NaN
        return
    with _samples_lock:
        _samples[metric].append(v)


# ── Schema ────────────────────────────────────────────────────────────────────
_SCHEMA = """
CREATE TABLE IF NOT EXISTS metrics (
    metric TEXT    NOT NULL,
    ts     INTEGER NOT NULL,
    avg    REAL    NOT NULL,
    min    REAL,
    max    REAL,
    PRIMARY KEY (metric, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts);

CREATE TABLE IF NOT EXISTS mc_sessions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    player    TEXT    NOT NULL,
    start_ts  INTEGER NOT NULL,
    end_ts    INTEGER,
    seconds   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mc_sessions_player ON mc_sessions(player);
CREATE INDEX IF NOT EXISTS idx_mc_sessions_start  ON mc_sessions(start_ts);

CREATE TABLE IF NOT EXISTS mc_playtime (
    player        TEXT    PRIMARY KEY,
    total_seconds INTEGER NOT NULL DEFAULT 0,
    sessions      INTEGER NOT NULL DEFAULT 0,
    first_seen    INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL
) WITHOUT ROWID;
"""


def init() -> None:
    """Open the DB, create schema, start background workers. Safe to call once."""
    global _conn, _enabled

    db_path = Path(_DB_PATH)
    try:
        db_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        log.warning("History DB disabled — cannot create %s: %s", db_path.parent, exc)
        return

    try:
        _conn = sqlite3.connect(
            str(db_path),
            check_same_thread=False,
            isolation_level=None,   # autocommit; we wrap multi-statement work in BEGIN
            timeout=30,
        )
        # WAL gives concurrent reads + a single writer, which is exactly our pattern.
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA synchronous=NORMAL")
        _conn.execute("PRAGMA foreign_keys=ON")
        _conn.executescript(_SCHEMA)
    except sqlite3.Error as exc:
        log.warning("History DB disabled — open/init failed: %s", exc)
        _conn = None
        return

    # Defensive: lock down file mode so other users on the host cannot read it.
    try:
        os.chmod(db_path, 0o600)
    except OSError:
        pass

    _enabled = True
    log.info("History DB enabled at %s (retention %d days)", db_path, _RETENTION_DAYS)

    threading.Thread(target=_flusher, daemon=True, name="db-flusher").start()
    threading.Thread(target=_pruner,  daemon=True, name="db-pruner").start()
    # Closing any sessions left open by a previous process keeps playtime
    # sane on restart — we do not know when those players actually left.
    _close_open_sessions(int(time.time()))


# ── Metric flush ──────────────────────────────────────────────────────────────

def _flush_locked() -> None:
    """Drain the accumulator into the DB. Caller holds _conn_lock."""
    if not _conn:
        return
    with _samples_lock:
        snapshot = {k: v for k, v in _samples.items() if v}
        _samples.clear()
    if not snapshot:
        return
    bucket = (int(time.time()) // 60) * 60
    rows = []
    for metric, values in snapshot.items():
        rows.append((metric, bucket, sum(values) / len(values), min(values), max(values)))
    try:
        with _conn:
            _conn.executemany(
                "INSERT INTO metrics (metric, ts, avg, min, max) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(metric, ts) DO UPDATE SET "
                "avg = (avg + excluded.avg) / 2, "
                "min = MIN(min, excluded.min), "
                "max = MAX(max, excluded.max)",
                rows,
            )
    except sqlite3.Error as exc:
        log.warning("metric flush failed: %s", exc)


def _flusher() -> None:
    while True:
        time.sleep(_FLUSH_INTERVAL_SEC)
        with _conn_lock:
            _flush_locked()


# ── Retention prune ───────────────────────────────────────────────────────────

def _pruner() -> None:
    while True:
        # Run once shortly after start so a long-paused container catches up.
        time.sleep(60)
        prune()
        time.sleep(_PRUNE_INTERVAL_SEC)


def prune() -> None:
    if not _conn:
        return
    cutoff = int(time.time()) - _RETENTION_DAYS * 86400
    with _conn_lock:
        try:
            with _conn:
                _conn.execute("DELETE FROM metrics     WHERE ts       < ?", (cutoff,))
                _conn.execute("DELETE FROM mc_sessions WHERE end_ts IS NOT NULL AND end_ts < ?", (cutoff,))
        except sqlite3.Error as exc:
            log.warning("prune failed: %s", exc)


# ── Reads: metric series ──────────────────────────────────────────────────────

def metric_series(metric: str, since_ts: int, until_ts: int | None = None,
                  bucket_seconds: int = 60) -> list[dict]:
    """Return [{ts, avg, min, max}] sorted by ts.

    bucket_seconds > 60 downsamples on the way out so the wire payload stays
    small for long ranges (e.g. a 14-day chart at 60s = 20k points; at 1h
    bucket it's 336).
    """
    if not _conn:
        return []
    until = until_ts if until_ts is not None else int(time.time())
    with _conn_lock:
        if bucket_seconds <= 60:
            cur = _conn.execute(
                "SELECT ts, avg, min, max FROM metrics "
                "WHERE metric = ? AND ts >= ? AND ts <= ? ORDER BY ts",
                (metric, since_ts, until),
            )
            return [{"ts": r[0], "avg": r[1], "min": r[2], "max": r[3]} for r in cur]
        cur = _conn.execute(
            "SELECT (ts / ?) * ? AS bucket, AVG(avg), MIN(min), MAX(max) "
            "FROM metrics WHERE metric = ? AND ts >= ? AND ts <= ? "
            "GROUP BY bucket ORDER BY bucket",
            (bucket_seconds, bucket_seconds, metric, since_ts, until),
        )
        return [{"ts": r[0], "avg": r[1], "min": r[2], "max": r[3]} for r in cur]


# ── Minecraft session tracking ────────────────────────────────────────────────

def mc_tick(now_players: list[str], now_ts: int | None = None) -> None:
    """Update player sessions given the currently-online set.

    Called from the Minecraft poller every poll cycle. Players that
    appear are session-started; players that disappear have their open
    session closed and their cumulative playtime updated.
    """
    if not _conn:
        return
    now = now_ts if now_ts is not None else int(time.time())
    now_set = set(now_players)
    with _conn_lock:
        try:
            cur = _conn.execute("SELECT player FROM mc_sessions WHERE end_ts IS NULL")
            previously_open = {r[0] for r in cur}

            new_players  = now_set - previously_open
            gone_players = previously_open - now_set

            with _conn:
                for p in new_players:
                    _conn.execute(
                        "INSERT INTO mc_sessions (player, start_ts) VALUES (?, ?)",
                        (p, now),
                    )
                    _conn.execute(
                        "INSERT INTO mc_playtime (player, total_seconds, sessions, first_seen, last_seen) "
                        "VALUES (?, 0, 0, ?, ?) "
                        "ON CONFLICT(player) DO UPDATE SET last_seen = excluded.last_seen",
                        (p, now, now),
                    )
                for p in gone_players:
                    _close_session(p, now)
                # Keep last_seen fresh for everyone currently online so
                # the totals UI shows "active now" correctly without
                # waiting for a session close.
                for p in now_set:
                    _conn.execute(
                        "UPDATE mc_playtime SET last_seen = ? WHERE player = ?",
                        (now, p),
                    )
        except sqlite3.Error as exc:
            log.warning("mc_tick failed: %s", exc)


def _close_session(player: str, end_ts: int) -> None:
    """Caller holds _conn_lock and is inside a transaction."""
    cur = _conn.execute(
        "SELECT id, start_ts FROM mc_sessions WHERE player = ? AND end_ts IS NULL "
        "ORDER BY start_ts DESC LIMIT 1",
        (player,),
    )
    row = cur.fetchone()
    if not row:
        return
    sid, start_ts = row
    seconds = max(0, end_ts - start_ts)
    _conn.execute(
        "UPDATE mc_sessions SET end_ts = ?, seconds = ? WHERE id = ?",
        (end_ts, seconds, sid),
    )
    _conn.execute(
        "UPDATE mc_playtime SET total_seconds = total_seconds + ?, "
        "sessions = sessions + 1, last_seen = ? WHERE player = ?",
        (seconds, end_ts, player),
    )


def _close_open_sessions(now_ts: int) -> None:
    """Close any sessions left open from a prior process — typically a restart."""
    if not _conn:
        return
    with _conn_lock:
        try:
            cur = _conn.execute("SELECT player FROM mc_sessions WHERE end_ts IS NULL")
            stale = [r[0] for r in cur]
            with _conn:
                for p in stale:
                    _close_session(p, now_ts)
        except sqlite3.Error as exc:
            log.warning("close_open_sessions failed: %s", exc)


def mc_playtime(limit: int = 100) -> dict:
    """Return per-player totals plus sessions in progress."""
    if not _conn:
        return {"available": False, "players": [], "active": []}
    with _conn_lock:
        cur = _conn.execute(
            "SELECT player, total_seconds, sessions, first_seen, last_seen "
            "FROM mc_playtime ORDER BY total_seconds DESC LIMIT ?",
            (limit,),
        )
        players = [
            {"player": r[0], "total_seconds": r[1], "sessions": r[2],
             "first_seen": r[3], "last_seen": r[4]}
            for r in cur
        ]
        cur = _conn.execute(
            "SELECT player, start_ts FROM mc_sessions WHERE end_ts IS NULL"
        )
        active = [{"player": r[0], "start_ts": r[1]} for r in cur]
    return {"available": True, "players": players, "active": active}


def known_metrics() -> list[str]:
    """Distinct metric names that have ever been written. Used by the UI."""
    if not _conn:
        return []
    with _conn_lock:
        try:
            cur = _conn.execute(
                "SELECT DISTINCT metric FROM metrics ORDER BY metric"
            )
            return [r[0] for r in cur]
        except sqlite3.Error:
            return []

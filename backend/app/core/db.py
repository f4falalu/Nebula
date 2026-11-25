"""Database access. All writes happen inside `tx()` so that business changes
and their audit events commit together."""
from __future__ import annotations

import contextlib
import os
from typing import Any, Iterator

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from .config import settings

_pool: ConnectionPool | None = None


def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(settings.database_url, min_size=1, max_size=int(os.environ.get("DB_POOL_SIZE", "8")),
                               kwargs={"row_factory": dict_row, "autocommit": False}, open=True)
    return _pool


def reset_pool(url: str | None = None) -> None:
    global _pool
    if _pool is not None:
        _pool.close()
    _pool = None
    if url:
        settings.database_url = url


@contextlib.contextmanager
def tx(edit_request_id: str | None = None, conversion_resolution: bool = False) -> Iterator[Connection]:
    """A transaction. Optional context flags are read by the finalization-lock triggers."""
    with pool().connection() as conn:
        with conn.transaction():
            if edit_request_id:
                conn.execute("SELECT set_config('nebula.edit_request_id', %s, true)", (edit_request_id,))
            if conversion_resolution:
                conn.execute("SELECT set_config('nebula.conversion_resolution', 'on', true)")
            yield conn


def one(conn: Connection, sql: str, params: Any = None) -> dict | None:
    return conn.execute(sql, params).fetchone()


def all_(conn: Connection, sql: str, params: Any = None) -> list[dict]:
    return conn.execute(sql, params).fetchall()


def J(v: Any) -> Jsonb:
    return Jsonb(v)


def migrate(url: str | None = None) -> list[str]:
    """Apply migrations/*.sql in order, once each."""
    import psycopg

    here = os.path.join(os.path.dirname(__file__), "..", "..", "migrations")
    applied: list[str] = []
    with psycopg.connect(url or settings.database_url, autocommit=False) as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
        conn.execute("SELECT pg_advisory_xact_lock(4242)")
        done = {r[0] for r in conn.execute("SELECT name FROM schema_migrations").fetchall()}
        for name in sorted(f for f in os.listdir(here) if f.endswith(".sql")):
            if name in done:
                continue
            with open(os.path.join(here, name)) as fh:
                conn.execute(fh.read())
            conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (name,))
            applied.append(name)
        conn.commit()
    return applied

"""Document-reading job queue. Owned by the AI/worker part; the requisition
endpoints only call queue_extraction()."""
from __future__ import annotations

from psycopg import Connection

from .core.common import new_id


def queue_extraction(conn: Connection, actor_id: str, requisition_id: str) -> str:
    """Queue a reading job for the requisition's original documents and set the
    record to Processing. Runs inside the caller's transaction. Returns job id."""
    attempt = conn.execute("SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM processing_jobs WHERE requisition_id=%s", (requisition_id,)).fetchone()["n"]
    job_id = new_id()
    conn.execute("INSERT INTO processing_jobs (id, requisition_id, attempt, status, created_by) VALUES (%s,%s,%s,'queued',%s)",
                 (job_id, requisition_id, attempt, actor_id))
    conn.execute("UPDATE requisitions SET record_status='processing' WHERE id=%s", (requisition_id,))
    return job_id

"""Shared helpers: ids, errors, time, audit."""
from __future__ import annotations

import datetime as dt
import secrets
import time
from typing import Any

from fastapi import HTTPException
from psycopg import Connection

from .db import J

LAGOS = dt.timezone(dt.timedelta(hours=1))  # Africa/Lagos: UTC+01:00, no DST
_ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789"


def new_id() -> str:
    """Time-sortable id, ASCII letters/digits only (same format as V1)."""
    t = int(time.time() * 1000)
    out = ""
    while t:
        t, r = divmod(t, 36)
        out = _ALPHA[r] + out
    return out.rjust(9, "0") + "".join(secrets.choice(_ALPHA) for _ in range(8))


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def lagos_date(t: dt.datetime) -> dt.date:
    return t.astimezone(LAGOS).date()


def format_requisition_number(d: dt.date, serial: int) -> str:
    return f"REQ-{d:%y}-{d:%m}-{d:%d}_{serial:03d}"


def parse_ts(v: Any) -> dt.datetime:
    if isinstance(v, dt.datetime):
        return v if v.tzinfo else v.replace(tzinfo=dt.timezone.utc)
    try:
        t = dt.datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        raise UserError("Enter a valid date and time.")
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def minute(t: dt.datetime) -> int:
    return int(t.timestamp() // 60)


class UserError(HTTPException):
    """A rule the user broke; the message is shown to them as-is."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(status_code=status, detail=message)


def forbidden(message: str = "Your role doesn't allow this action.") -> UserError:
    return UserError(message, 403)


def audit(conn: Connection, actor: str | None, event_type: str, entity_type: str, entity_id: str | None = None, *,
          requisition_id: str | None = None, old: Any = None, new: Any = None, reason: str | None = None,
          edit_request_id: str | None = None, system: bool = False) -> None:
    conn.execute(
        """INSERT INTO audit_events (id, requisition_id, actor_user_id, actor_type, event_type, entity_type, entity_id,
               old_value, new_value, reason, edit_request_id)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (new_id(), requisition_id, None if system else actor, "system" if system else "user", event_type, entity_type,
         entity_id, J(jsonable(old)) if old is not None else None, J(jsonable(new)) if new is not None else None,
         reason, edit_request_id),
    )


def jsonable(v: Any) -> Any:
    if isinstance(v, dict):
        return {k: jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    if isinstance(v, dt.datetime):
        return iso(v)
    if isinstance(v, dt.date):
        return v.isoformat()
    from decimal import Decimal

    if isinstance(v, Decimal):
        f = float(v)
        return int(f) if f.is_integer() else f
    return v


def iso(t: dt.datetime | None) -> str | None:
    if t is None:
        return None
    return t.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

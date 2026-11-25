"""Document reading with OpenRouter: admin settings, the encrypted API key,
limits computed from the append-only ai_usage ledger, and usage reporting."""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import os
import time
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, Request
from psycopg import Connection

from .. import openrouter
from ..core.auth import Actor, require_actor
from ..core.common import LAGOS, UserError, audit, forbidden, new_id, now
from ..core.config import settings
from ..core.db import J, tx

router = APIRouter()

DEFAULT_AI = {
    "enabled": False,
    "model": "google/gemini-2.5-flash",
    "fallbackModel": None,
    "maxPagesPerJob": 20,
    "perUserPagesPerDay": 200,
    "perUserJobsPerHour": 30,
    "orgMonthlyBudgetUsd": 50,
    "lowBalanceUsd": 5,
}
KEY_NAME = "openrouter_api_key"


def actor_dep(request: Request) -> Actor:
    return getattr(request.state, "actor", None) or require_actor(request)


def _admin(actor: Actor) -> None:
    if actor.role != "admin":
        raise forbidden("Only Administrators can manage document reading.")


# ------------------------------------------------------------------ settings & secrets
def ai_settings(conn: Connection) -> dict:
    s = dict(DEFAULT_AI)
    row = conn.execute("SELECT value FROM settings WHERE key='ai'").fetchone()
    if row:
        s.update({k: v for k, v in row["value"].items() if k in DEFAULT_AI})
    return s


def _fernet() -> Fernet:
    if not settings.secret_key:
        raise UserError("NEBULA_SECRET_KEY isn't set on the server, so the API key can't be stored securely.", 503)
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(("secrets:" + settings.secret_key).encode()).digest()))


def api_key(conn: Connection) -> tuple[str | None, str | None]:
    """(key, source) where source is 'database' or 'environment'."""
    row = conn.execute("SELECT ciphertext FROM secrets WHERE key=%s", (KEY_NAME,)).fetchone()
    if row:
        try:
            return _fernet().decrypt(row["ciphertext"].encode()).decode(), "database"
        except (InvalidToken, UserError):
            return None, None
    env = os.environ.get("OPENROUTER_API_KEY")
    return (env, "environment") if env else (None, None)


def _key_info(conn: Connection) -> dict:
    row = conn.execute("SELECT hint, updated_at FROM secrets WHERE key=%s", (KEY_NAME,)).fetchone()
    if row:
        return {"keyConfigured": True, "keyHint": row["hint"], "keySource": "database"}
    env = os.environ.get("OPENROUTER_API_KEY")
    if env:
        return {"keyConfigured": True, "keyHint": env[-4:], "keySource": "environment"}
    return {"keyConfigured": False, "keyHint": None, "keySource": None}


@router.get("/ai/settings")
def get_ai_settings(actor: Actor = Depends(actor_dep)):
    _admin(actor)
    with tx() as conn:
        return {**ai_settings(conn), **_key_info(conn)}


def _validate(body: dict) -> dict:
    out = dict(DEFAULT_AI)
    out.update({k: body[k] for k in DEFAULT_AI if k in body})
    if not isinstance(out["enabled"], bool):
        raise UserError("Enabled must be true or false.")
    if not isinstance(out["model"], str) or "/" not in out["model"].strip():
        raise UserError("Enter an OpenRouter model id, such as google/gemini-2.5-flash.")
    out["model"] = out["model"].strip()
    fb = out.get("fallbackModel")
    if fb in ("", None):
        out["fallbackModel"] = None
    elif not isinstance(fb, str) or "/" not in fb:
        raise UserError("The fallback model must be an OpenRouter model id, or empty.")
    for k, lo, hi in (("maxPagesPerJob", 1, 100), ("perUserPagesPerDay", 0, 100000), ("perUserJobsPerHour", 0, 10000)):
        try:
            out[k] = int(out[k])
        except (TypeError, ValueError):
            raise UserError(f"{k} must be a whole number.")
        if not lo <= out[k] <= hi:
            raise UserError(f"{k} must be between {lo} and {hi}.")
    for k in ("orgMonthlyBudgetUsd", "lowBalanceUsd"):
        try:
            out[k] = float(out[k])
        except (TypeError, ValueError):
            raise UserError(f"{k} must be a number.")
        if out[k] < 0:
            raise UserError(f"{k} can't be negative.")
    return out


@router.put("/ai/settings")
def put_ai_settings(body: dict, actor: Actor = Depends(actor_dep)):
    _admin(actor)
    new = _validate(body)
    with tx() as conn:
        old = ai_settings(conn)
        conn.execute("INSERT INTO settings (key, value, updated_by) VALUES ('ai', %s, %s) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()",
                     (J(new), actor.id))
        audit(conn, actor.id, "ai.settings_changed", "system_setting", "ai", old=old, new=new)
        return {**new, **_key_info(conn)}


@router.put("/ai/key")
def put_key(body: dict, actor: Actor = Depends(actor_dep)):
    _admin(actor)
    key = str(body.get("key") or "").strip()
    if len(key) < 10:
        raise UserError("Paste the full OpenRouter API key.")
    cipher = _fernet().encrypt(key.encode()).decode()
    with tx() as conn:
        conn.execute("INSERT INTO secrets (key, ciphertext, hint, updated_by) VALUES (%s,%s,%s,%s) ON CONFLICT (key) DO UPDATE SET ciphertext=EXCLUDED.ciphertext, hint=EXCLUDED.hint, updated_by=EXCLUDED.updated_by, updated_at=now()",
                     (KEY_NAME, cipher, key[-4:], actor.id))
        audit(conn, actor.id, "ai.key_changed", "secret", KEY_NAME, new={"hint": key[-4:]})
        return _key_info(conn)


@router.delete("/ai/key")
def delete_key(actor: Actor = Depends(actor_dep)):
    _admin(actor)
    with tx() as conn:
        conn.execute("DELETE FROM secrets WHERE key=%s", (KEY_NAME,))
        audit(conn, actor.id, "ai.key_changed", "secret", KEY_NAME, new={"removed": True})
        return _key_info(conn)


@router.post("/ai/test")
def test_model(actor: Actor = Depends(actor_dep)):
    _admin(actor)
    with tx() as conn:
        s = ai_settings(conn)
        key, _ = api_key(conn)
    if not key:
        return {"ok": False, "model": s["model"], "latencyMs": None, "error": "No OpenRouter API key is set."}
    t0 = time.monotonic()
    try:
        r = openrouter.chat(s["model"], [{"role": "user", "content": 'Reply with only this JSON: {"ok": true}'}], api_key=key, timeout=60)
        return {"ok": True, "model": r["model"], "latencyMs": int((time.monotonic() - t0) * 1000), "costUsd": r["usage"]["cost"]}
    except openrouter.OpenRouterError as e:
        return {"ok": False, "model": s["model"], "latencyMs": int((time.monotonic() - t0) * 1000), "error": str(e)}


# ------------------------------------------------------------------ limits
def _lagos_bounds(at: dt.datetime) -> tuple[dt.datetime, dt.datetime]:
    """Start of the Lagos day and of the Lagos month containing `at`, as UTC instants."""
    local = at.astimezone(LAGOS)
    day = local.replace(hour=0, minute=0, second=0, microsecond=0)
    month = day.replace(day=1)
    return day.astimezone(dt.timezone.utc), month.astimezone(dt.timezone.utc)


def month_spend(conn: Connection, at: dt.datetime | None = None) -> float:
    _, month = _lagos_bounds(at or now())
    return float(conn.execute("SELECT COALESCE(SUM(cost_usd),0) AS s FROM ai_usage WHERE created_at >= %s", (month,)).fetchone()["s"])


def limit_reason(conn: Connection, user_id: str, pages: int, s: dict | None = None) -> str | None:
    """Why a reading job for `pages` pages must be refused now, or None."""
    s = s or ai_settings(conn)
    if not s["enabled"]:
        return "Document reading is switched off. An Administrator can switch it on in Administration → Document reading."
    if not api_key(conn)[0]:
        return "No OpenRouter API key is set. An Administrator needs to add one in Administration → Document reading."
    day, _ = _lagos_bounds(now())
    used_pages = int(conn.execute("SELECT COALESCE(SUM(pages),0) AS p FROM ai_usage WHERE user_id=%s AND outcome='ok' AND created_at >= %s",
                                  (user_id, day)).fetchone()["p"])
    if s["perUserPagesPerDay"] and used_pages + pages > s["perUserPagesPerDay"]:
        return f"You've reached today's limit of {s['perUserPagesPerDay']} pages read by AI ({used_pages} used). Enter the lines by hand, or ask an Administrator to raise the limit."
    jobs = int(conn.execute("SELECT COUNT(*) AS n FROM ai_usage WHERE user_id=%s AND outcome IN ('ok','error') AND created_at >= now() - interval '1 hour'",
                            (user_id,)).fetchone()["n"])
    if s["perUserJobsPerHour"] and jobs >= s["perUserJobsPerHour"]:
        return f"You've reached the limit of {s['perUserJobsPerHour']} documents read per hour. Try again later."
    if s["orgMonthlyBudgetUsd"] is not None and month_spend(conn) >= float(s["orgMonthlyBudgetUsd"]):
        return f"This month's document-reading budget (${float(s['orgMonthlyBudgetUsd']):.2f}) is used up. An Administrator can raise it in Administration → Document reading."
    return None


def record_usage(conn: Connection, *, user_id: str, requisition_id: str | None, job_id: str | None, model: str, pages: int,
                 outcome: str, cost: float = 0.0, prompt_tokens: int | None = None, completion_tokens: int | None = None, detail: str | None = None) -> None:
    conn.execute(
        """INSERT INTO ai_usage (id, user_id, requisition_id, job_id, model, pages, prompt_tokens, completion_tokens, cost_usd, outcome, detail)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (new_id(), user_id, requisition_id, job_id, model, pages, prompt_tokens, completion_tokens, cost, outcome, detail),
    )


@router.get("/ai/status")
def status(actor: Actor = Depends(actor_dep)):
    with tx() as conn:
        s = ai_settings(conn)
        reason = limit_reason(conn, actor.id, 1, s)
        return {"enabled": s["enabled"], "readyForReading": reason is None, "reason": reason, "model": s["model"] if s["enabled"] else None}


@router.get("/ai/usage")
def usage(month: str | None = None, actor: Actor = Depends(actor_dep)):
    _admin(actor)
    if month:
        try:
            y, m = (int(x) for x in month.split("-"))
            start_local = dt.datetime(y, m, 1, tzinfo=LAGOS)
        except (ValueError, TypeError):
            raise UserError("Use the month format YYYY-MM.")
    else:
        start_local = now().astimezone(LAGOS).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end_local = (start_local + dt.timedelta(days=32)).replace(day=1)
    a, b = start_local.astimezone(dt.timezone.utc), end_local.astimezone(dt.timezone.utc)
    with tx() as conn:
        s = ai_settings(conn)
        t = conn.execute(
            """SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(pages) FILTER (WHERE outcome='ok'),0) AS pages,
                      COUNT(*) FILTER (WHERE outcome='ok') AS jobs, COUNT(*) FILTER (WHERE outcome='error') AS errors,
                      COUNT(*) FILTER (WHERE outcome='refused_limit') AS refused
               FROM ai_usage WHERE created_at >= %s AND created_at < %s""", (a, b)).fetchone()
        users = conn.execute(
            """SELECT user_id, COALESCE(SUM(pages) FILTER (WHERE outcome='ok'),0) AS pages, COUNT(*) FILTER (WHERE outcome='ok') AS jobs,
                      COALESCE(SUM(cost_usd),0) AS cost
               FROM ai_usage WHERE created_at >= %s AND created_at < %s GROUP BY user_id ORDER BY cost DESC""", (a, b)).fetchall()
        days = conn.execute(
            """SELECT (created_at AT TIME ZONE 'Africa/Lagos')::date AS day, COALESCE(SUM(pages) FILTER (WHERE outcome='ok'),0) AS pages,
                      COUNT(*) FILTER (WHERE outcome='ok') AS jobs, COALESCE(SUM(cost_usd),0) AS cost
               FROM ai_usage WHERE created_at >= %s AND created_at < %s GROUP BY 1 ORDER BY 1""", (a, b)).fetchall()
        key, _ = api_key(conn)
    spent = float(t["cost"])
    budget = float(s["orgMonthlyBudgetUsd"])
    credits: dict[str, Any] | None = None
    credits_note = None
    if key:
        try:
            credits = openrouter.credits(key)
        except openrouter.OpenRouterError as e:
            credits_note = str(e)
        except Exception:
            credits_note = "Couldn't read the OpenRouter balance."
    else:
        credits_note = "No OpenRouter API key is set."
    low = credits is not None and credits["remaining"] < float(s["lowBalanceUsd"])
    return {
        "month": f"{start_local:%Y-%m}",
        "totals": {"costUsd": round(spent, 6), "pages": int(t["pages"]), "jobs": int(t["jobs"]), "errors": int(t["errors"]), "refused": int(t["refused"])},
        "users": [{"userId": u["user_id"], "pages": int(u["pages"]), "jobs": int(u["jobs"]), "costUsd": round(float(u["cost"]), 6)} for u in users],
        "days": [{"day": d["day"].isoformat(), "pages": int(d["pages"]), "jobs": int(d["jobs"]), "costUsd": round(float(d["cost"]), 6)} for d in days],
        "budget": {"monthlyBudgetUsd": budget, "spentUsd": round(spent, 6), "remainingUsd": round(max(budget - spent, 0), 6)},
        "openrouter": credits,
        "openrouterNote": credits_note,
        "lowBalance": low,
    }

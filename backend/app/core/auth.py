"""Authentication (Clerk session tokens) and permissions (PRD §6).

Clerk proves who someone is. Nebula decides what they may do: roles and grants
live in Nebula's own database. A person who signs in for the first time gets a
pending account until an Administrator activates it, unless their email is in
ADMIN_EMAILS (bootstrap Administrators).
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

import httpx
import jwt
from fastapi import Request

from .common import UserError, forbidden, new_id, now
from .config import settings
from .db import tx

ROLE_LABEL = {"ra": "Requisition Assistant", "supervisor": "Supervisor", "admin": "Administrator"}

RA_ACTIONS = {
    "requisition.create", "requisition.edit", "requisition.validate", "requisition.finalize", "requisition.cancel",
    "lifecycle.record", "fulfillment.record", "fulfillment.close", "evidence.upload", "documents.download",
    "edit_request.submit", "conversion.propose", "extraction.retry",
}
GRANT_ACTIONS = {"requisition.reopen", "edit_request.approve", "documents.download"}


@dataclass
class Actor:
    id: str
    role: str
    grants: list[str] = field(default_factory=list)
    email: str | None = None
    name: str | None = None

    def can(self, action: str) -> bool:
        if self.role == "admin":
            return action != "edit_request.submit"
        if self.role == "ra":
            return action in RA_ACTIONS
        if action == "audit.global":
            return True
        return action in GRANT_ACTIONS and action in self.grants

    def need(self, action: str) -> None:
        if not self.can(action):
            raise forbidden()


# ------------------------------------------------------------------ Clerk
_jwks_client: jwt.PyJWKClient | None = None
_jwks_lock = threading.Lock()


def _jwks() -> jwt.PyJWKClient:
    global _jwks_client
    with _jwks_lock:
        if _jwks_client is None:
            if not settings.clerk_issuer:
                raise UserError("Sign-in isn't configured: set CLERK_PUBLISHABLE_KEY.", 503)
            _jwks_client = jwt.PyJWKClient(f"{settings.clerk_issuer}/.well-known/jwks.json", cache_keys=True, lifespan=3600)
        return _jwks_client


def verify_clerk_token(token: str) -> dict:
    try:
        key = _jwks().get_signing_key_from_jwt(token)
        claims = jwt.decode(token, key.key, algorithms=["RS256"], issuer=settings.clerk_issuer, options={"require": ["exp", "sub"]}, leeway=10)
    except jwt.PyJWTError:
        raise UserError("Your session has expired. Sign in again.", 401)
    azp = claims.get("azp")
    if settings.clerk_authorized_parties and azp and azp not in settings.clerk_authorized_parties:
        raise UserError("This sign-in isn't valid for this site.", 401)
    return claims


def clerk_profile(user_id: str) -> tuple[str | None, str | None]:
    """Email and name from Clerk's Backend API (session tokens don't carry them)."""
    if not settings.clerk_secret_key:
        return None, None
    try:
        r = httpx.get(f"https://api.clerk.com/v1/users/{user_id}", headers={"Authorization": f"Bearer {settings.clerk_secret_key}"}, timeout=10)
        r.raise_for_status()
        u = r.json()
        primary = next((e["email_address"] for e in u.get("email_addresses", []) if e.get("id") == u.get("primary_email_address_id")), None)
        name = " ".join(x for x in [u.get("first_name"), u.get("last_name")] if x) or None
        return primary, name
    except Exception:
        return None, None


# ------------------------------------------------------------------ actor resolution
_actor_cache: dict[str, tuple[float, Actor]] = {}


def _load_actor(conn, user: dict) -> Actor:
    grants = [r["permission"] for r in conn.execute(
        "SELECT permission FROM permission_grants WHERE user_id=%s AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
        (user["id"],)).fetchall()]
    return Actor(id=user["id"], role=user["role"], grants=grants if user["role"] == "supervisor" else [], email=user["email"], name=user["full_name"])


def provision(external_id: str, email: str | None, name: str | None) -> dict:
    """Find or create the Nebula user for a signed-in identity."""
    with tx() as conn:
        u = conn.execute("SELECT * FROM users WHERE clerk_user_id=%s", (external_id,)).fetchone()
        if u:
            return u
        is_admin = bool(email and email.lower() in settings.admin_emails)
        uid = new_id()
        u = conn.execute(
            "INSERT INTO users (id, clerk_user_id, email, full_name, status, role) VALUES (%s,%s,%s,%s,%s,%s) RETURNING *",
            (uid, external_id, email, name, "active" if is_admin else "pending", "admin" if is_admin else None),
        ).fetchone()
        conn.execute(
            "INSERT INTO audit_events (id, actor_user_id, actor_type, event_type, entity_type, entity_id, new_value) VALUES (%s,%s,'system','user.signed_up','user',%s,%s::jsonb)",
            (new_id(), None, uid, '{"status": "%s"}' % u["status"]),
        )
        return u


def token_from(request: Request) -> str | None:
    h = request.headers.get("authorization", "")
    if h.lower().startswith("bearer "):
        return h[7:].strip()
    return request.cookies.get("__session")


def current_user(request: Request, allow_pending: bool = False) -> Actor | dict:
    if settings.dev and request.headers.get("x-dev-user"):
        # Development/test only: never active when NEBULA_ENV=production.
        email = request.headers["x-dev-user"].lower()
        role = request.headers.get("x-dev-role", "admin")
        with tx() as conn:
            u = conn.execute("SELECT * FROM users WHERE clerk_user_id=%s", ("dev:" + email,)).fetchone()
            if not u:
                u = conn.execute("INSERT INTO users (id, clerk_user_id, email, full_name, status, role) VALUES (%s,%s,%s,%s,'active',%s) RETURNING *",
                                 (new_id(), "dev:" + email, email, email.split("@")[0].title(), role)).fetchone()
            grants = request.headers.get("x-dev-grants")
            if grants is not None:
                conn.execute("UPDATE permission_grants SET revoked_at=now(), revoked_by=%s WHERE user_id=%s AND revoked_at IS NULL", (u["id"], u["id"]))
                for g in filter(None, grants.split(",")):
                    conn.execute("INSERT INTO permission_grants (id,user_id,permission,granted_by) VALUES (%s,%s,%s,%s)", (new_id(), u["id"], g, u["id"]))
            return _load_actor(conn, u)

    token = token_from(request)
    if not token:
        raise UserError("Sign in to use Nebula.", 401)
    claims = verify_clerk_token(token)
    sub = claims["sub"]
    cached = _actor_cache.get(sub)
    if cached and cached[0] > time.time():
        return cached[1]
    with tx() as conn:
        u = conn.execute("SELECT * FROM users WHERE clerk_user_id=%s", (sub,)).fetchone()
    if not u:
        email, name = clerk_profile(sub)
        u = provision(sub, email, name)
    if u["status"] != "active" or not u["role"]:
        if allow_pending:
            return u
        raise UserError("Your account is waiting for an Administrator to give you access.", 403)
    with tx() as conn:
        actor = _load_actor(conn, u)
    _actor_cache[sub] = (time.time() + 30, actor)
    return actor


def require_actor(request: Request) -> Actor:
    a = current_user(request)
    assert isinstance(a, Actor)
    request.state.actor = a
    return a


def forget_cached_actors() -> None:
    _actor_cache.clear()
    _ = now()

"""Nebula V2 API. Serves the JSON API under /api, signed document downloads
under /files, and the built React app for every other path."""
from __future__ import annotations

import logging
import os

import psycopg
from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from .core import storage
from .core.auth import Actor, current_user, require_actor
from .core.common import UserError, audit
from .core.config import settings
from .core.db import migrate, tx
from .core.ratelimit import api_bucket
from .core.state import load_master, load_proposals, load_requisitions, load_roles, load_users

log = logging.getLogger("nebula")
app = FastAPI(title="Nebula", version="2.0.0", docs_url="/api/docs" if settings.dev else None, redoc_url=None, openapi_url="/api/openapi.json" if settings.dev else None)


def api_actor(request: Request) -> Actor:
    """Every API call: signed in, active, and within the per-user rate limit."""
    actor = require_actor(request)
    api_bucket.take(actor.id, settings.api_requests_per_minute)
    return actor


@app.exception_handler(psycopg.errors.RaiseException)
async def db_rule(_: Request, e: psycopg.errors.RaiseException):
    # A database rule (trigger) refused the change; its message is written for users.
    return JSONResponse({"detail": str(e.diag.message_primary or e).capitalize()}, status_code=409)


@app.exception_handler(psycopg.errors.IntegrityError)
async def db_integrity(_: Request, e: psycopg.errors.IntegrityError):
    log.warning("integrity error: %s", e)
    return JSONResponse({"detail": "The change was refused because it breaks a data rule."}, status_code=409)


@app.on_event("startup")
def startup() -> None:
    applied = migrate()
    if applied:
        log.warning("applied migrations: %s", applied)
    os.makedirs(settings.storage_dir, exist_ok=True)
    if settings.run_worker:
        from .worker import start_worker

        start_worker()


@app.get("/api/health")
def health():
    with tx() as conn:
        conn.execute("SELECT 1")
    return {"ok": True}


@app.get("/api/config")
def public_config():
    """Public, non-secret configuration the browser needs before sign-in."""
    return {"clerkPublishableKey": settings.clerk_publishable_key, "env": settings.env, "devAuth": settings.dev}


@app.get("/api/me")
def me(request: Request):
    u = current_user(request, allow_pending=True)
    if isinstance(u, Actor):
        return {"id": u.id, "email": u.email, "name": u.name, "role": u.role, "grants": u.grants, "status": "active"}
    return {"id": u["id"], "email": u["email"], "name": u["full_name"], "role": None, "grants": [], "status": u["status"]}


@app.get("/api/state")
def state(actor: Actor = Depends(api_actor)):
    """Everything the app renders: requisitions, master data, roles, proposals."""
    with tx() as conn:
        return {
            "reqs": load_requisitions(conn),
            "md": load_master(conn),
            "roles": load_roles(conn),
            "proposals": load_proposals(conn) if actor.role in ("admin", "ra") else {},
            "users": load_users(conn) if actor.role == "admin" else [],
        }


@app.get("/files/{doc_id}")
def file(doc_id: str, u: str, e: int, d: int, s: str):
    if not storage.verify(doc_id, u, e, d, s):
        raise UserError("This link has expired. Open the document again from Nebula.", 403)
    with tx() as conn:
        doc = conn.execute("SELECT * FROM documents WHERE id=%s", (doc_id,)).fetchone()
        if not doc:
            raise UserError("Document not found.", 404)
        if d:
            audit(conn, u, "document.downloaded", "document", doc_id, requisition_id=doc["requisition_id"])
    headers = {"Cache-Control": "private, max-age=300"}
    if d:
        headers["Content-Disposition"] = f'attachment; filename="{doc["file_name"]}"'
    return Response(storage.get(doc["storage_key"]), media_type=doc["mime_type"], headers=headers)


from .routers import admin, ai, requisitions  # noqa: E402

app.include_router(requisitions.router, prefix="/api", dependencies=[Depends(api_actor)])
app.include_router(admin.router, prefix="/api", dependencies=[Depends(api_actor)])
app.include_router(ai.router, prefix="/api", dependencies=[Depends(api_actor)])


# ---------------------------------------------------------------- the React app
@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    root = os.path.abspath(settings.static_dir)
    target = os.path.abspath(os.path.join(root, path))
    if path and target.startswith(root) and os.path.isfile(target):
        return FileResponse(target)
    index = os.path.join(root, "index.html")
    if os.path.isfile(index):
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
    return JSONResponse({"detail": "The web app isn't built. Run the frontend build."}, status_code=404)

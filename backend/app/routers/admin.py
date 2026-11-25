"""Master data, aliases, unit conversions, substitution equivalences, settings
and user access (PRD §6, §17–§19). Ported from app/src/data/services.ts."""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, Request
from psycopg import Connection

from ..core.auth import Actor, forget_cached_actors, require_actor
from ..core.common import UserError, audit, forbidden, new_id
from ..core.db import J, tx
from ..core.state import DEFAULT_SETTINGS, alias_json, conversion_json, equivalence_json, load_settings, load_users
from ..domain import convert_to_base, normalize, normalize_unit

router = APIRouter()


def actor_dep(request: Request) -> Actor:
    return getattr(request.state, "actor", None) or require_actor(request)


def _row(conn: Connection, table: str, rid: str) -> dict | None:
    return conn.execute(f"SELECT * FROM {table} WHERE id=%s", (rid,)).fetchone()


def _s(v: Any) -> str | None:
    v = (str(v).strip() if v is not None else "")
    return v or None


def _status(v: Any, default: str = "active") -> str:
    v = v or default
    if v not in ("active", "inactive"):
        raise UserError("Status must be active or inactive.")
    return v


# ------------------------------------------------------------------ master data
def _save_facility(conn: Connection, actor: Actor, b: dict) -> str:
    name = _s(b.get("name"))
    if not name:
        raise UserError("Enter the facility name.")
    old = _row(conn, "facilities", b["id"]) if b.get("id") else None
    if b.get("id") and not old:
        raise UserError("Facility not found.", 404)
    fid = old["id"] if old else new_id()
    vals = (name, _s(b.get("lga")), _s(b.get("location")), _status(b.get("status"), old["status"] if old else "active"))
    if old:
        new = conn.execute("UPDATE facilities SET name=%s, lga=%s, location=%s, status=%s, updated_at=now() WHERE id=%s RETURNING *", (*vals, fid)).fetchone()
    else:
        new = conn.execute("INSERT INTO facilities (id, name, lga, location, status) VALUES (%s,%s,%s,%s,%s) RETURNING *", (fid, *vals)).fetchone()
    audit(conn, actor.id, "facility.changed" if old else "facility.created", "facility", fid, old=old, new=new)
    return fid


def _save_item(conn: Connection, actor: Actor, b: dict) -> str:
    code, name, base = _s(b.get("code")), _s(b.get("name")), normalize_unit(b.get("baseUnit"))
    if not (code and name and base):
        raise UserError("Item code, name and base unit are required.")
    dup = conn.execute("SELECT id, name FROM items WHERE lower(code)=lower(%s) AND id IS DISTINCT FROM %s", (code, b.get("id"))).fetchone()
    if dup:
        raise UserError(f"Item code {code} is already used by {dup['name']}.")
    old = _row(conn, "items", b["id"]) if b.get("id") else None
    if b.get("id") and not old:
        raise UserError("Item not found.", 404)
    iid = old["id"] if old else new_id()
    vals = (code, name, _s(b.get("genericName")), _s(b.get("strength")), _s(b.get("form")), _s(b.get("packSize")), base,
            _status(b.get("status"), old["status"] if old else "active"))
    if old:
        new = conn.execute("""UPDATE items SET code=%s, name=%s, generic_name=%s, strength=%s, form=%s, pack_size=%s, base_unit=%s, status=%s, updated_at=now()
                              WHERE id=%s RETURNING *""", (*vals, iid)).fetchone()
    else:
        new = conn.execute("""INSERT INTO items (id, code, name, generic_name, strength, form, pack_size, base_unit, status)
                              VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""", (iid, *vals)).fetchone()
    audit(conn, actor.id, "item.changed" if old else "item.created", "item", iid, old=old, new=new)
    return iid


def _save_programme(conn: Connection, actor: Actor, b: dict) -> str:
    name = _s(b.get("name"))
    if not name:
        raise UserError("Enter the programme name.")
    for p in conn.execute("SELECT id, name FROM programmes").fetchall():
        if normalize(p["name"]) == normalize(name) and p["id"] != b.get("id"):
            raise UserError(f"{name} already exists.")
    old = _row(conn, "programmes", b["id"]) if b.get("id") else None
    if b.get("id") and not old:
        raise UserError("Programme not found.", 404)
    pid = old["id"] if old else new_id()
    vals = (name, _s(b.get("description")), _status(b.get("status"), old["status"] if old else "active"))
    if old:
        new = conn.execute("UPDATE programmes SET name=%s, description=%s, status=%s WHERE id=%s RETURNING *", (*vals, pid)).fetchone()
    else:
        new = conn.execute("INSERT INTO programmes (id, name, description, status) VALUES (%s,%s,%s,%s) RETURNING *", (pid, *vals)).fetchone()
    audit(conn, actor.id, "programme.changed" if old else "programme.created", "programme", pid, old=old, new=new)
    return pid


@router.post("/facilities")
def save_facility(body: dict, actor: Actor = Depends(actor_dep)):
    actor.need("master.manage")
    with tx() as conn:
        return {"id": _save_facility(conn, actor, body)}


@router.post("/items")
def save_item(body: dict, actor: Actor = Depends(actor_dep)):
    actor.need("master.manage")
    with tx() as conn:
        return {"id": _save_item(conn, actor, body)}


@router.post("/programmes")
def save_programme(body: dict, actor: Actor = Depends(actor_dep)):
    actor.need("master.manage")
    with tx() as conn:
        return {"id": _save_programme(conn, actor, body)}


@router.post("/master/starter")
def load_starter(body: dict, actor: Actor = Depends(actor_dep)):
    actor.need("master.manage")
    added = {"programmes": 0, "facilities": 0, "items": 0}
    with tx() as conn:
        progs = {normalize(r["name"]) for r in conn.execute("SELECT name FROM programmes").fetchall()}
        for name in body.get("programmes") or []:
            if normalize(name) not in progs:
                _save_programme(conn, actor, {"name": name})
                progs.add(normalize(name))
                added["programmes"] += 1
        facs = {normalize(r["name"]) for r in conn.execute("SELECT name FROM facilities").fetchall()}
        for f in body.get("facilities") or []:
            if normalize(f.get("name")) and normalize(f.get("name")) not in facs:
                _save_facility(conn, actor, {k: v for k, v in f.items() if k != "id"})
                facs.add(normalize(f["name"]))
                added["facilities"] += 1
        codes = {r["code"].lower() for r in conn.execute("SELECT code FROM items").fetchall()}
        for i in body.get("items") or []:
            if i.get("code") and i["code"].lower() not in codes:
                _save_item(conn, actor, {k: v for k, v in i.items() if k != "id"})
                codes.add(i["code"].lower())
                added["items"] += 1
    return {"added": added}


# ------------------------------------------------------------------ aliases
def alias_id(entity_type: str, entity_id: str, n: str) -> str:
    return f"al-{entity_type}-{entity_id}-{re.sub(r'[^a-z0-9]', '', n)[:60]}"


@router.post("/aliases")
def add_alias(body: dict, actor: Actor = Depends(actor_dep)):
    actor.need("alias.approve")
    et, eid, text = body.get("entityType"), body.get("entityId"), _s(body.get("alias"))
    if et not in ("facility", "item"):
        raise UserError("Aliases are for facilities or items.")
    n = normalize(text)
    if not n:
        raise UserError("Enter the alias text.")
    with tx() as conn:
        if not _row(conn, "facilities" if et == "facility" else "items", eid or ""):
            raise UserError(f"Unknown {et}.", 404)
        aid = alias_id(et, eid, n)
        row = conn.execute(
            """INSERT INTO aliases (id, entity_type, entity_id, alias, normalized, occurrences, status, decided_by, decided_at)
               VALUES (%s,%s,%s,%s,%s,0,'approved',%s,now())
               ON CONFLICT (entity_type, entity_id, normalized) DO UPDATE SET status='approved', alias=EXCLUDED.alias, decided_by=EXCLUDED.decided_by, decided_at=now()
               RETURNING *""", (aid, et, eid, text, n, actor.id)).fetchone()
        audit(conn, actor.id, "alias.approved", f"{et}_alias", row["id"], new={"alias": text, "entityId": eid})
        return alias_json(row)


@router.post("/aliases/{aid}/decide")
def decide_alias(aid: str, body: dict, actor: Actor = Depends(actor_dep)):
    actor.need("alias.approve")
    decision = body.get("decision")
    if decision not in ("approved", "rejected"):
        raise UserError("Decision must be approved or rejected.")
    with tx() as conn:
        a = conn.execute("SELECT * FROM aliases WHERE id=%s FOR UPDATE", (aid,)).fetchone()
        if not a:
            raise UserError("Alias candidate not found.", 404)
        if a["status"] != "candidate":
            raise UserError("This alias has already been decided.")
        row = conn.execute("UPDATE aliases SET status=%s, decided_by=%s, decided_at=now() WHERE id=%s RETURNING *", (decision, actor.id, aid)).fetchone()
        audit(conn, actor.id, f"alias.{decision}", f"{a['entity_type']}_alias", aid, new={"alias": a["alias"], "entityId": a["entity_id"]})
        return alias_json(row)


@router.post("/aliases/{aid}/retire")
def retire_alias(aid: str, actor: Actor = Depends(actor_dep)):
    actor.need("alias.approve")
    with tx() as conn:
        a = conn.execute("UPDATE aliases SET status='rejected', decided_by=%s, decided_at=now() WHERE id=%s AND status='approved' RETURNING *", (actor.id, aid)).fetchone()
        if not a:
            raise UserError("Approved alias not found.", 404)
        audit(conn, actor.id, "alias.retired", "alias", aid)
        return alias_json(a)


# ------------------------------------------------------------------ conversions
def _approved_conversions(conn: Connection) -> list[dict]:
    return [conversion_json(r) for r in conn.execute("SELECT * FROM unit_conversions WHERE status='approved'").fetchall()]


def resolve_conversions(conn: Connection) -> int:
    """Conversion resolution (PRD §10.5). The caller's tx must be opened with conversion_resolution=True."""
    convs = _approved_conversions(conn)
    rows = conn.execute(
        """SELECT l.*, i.base_unit AS item_base_unit FROM requisition_lines l
           JOIN requisitions r ON r.id = l.requisition_id JOIN items i ON i.id = l.item_id
           WHERE r.record_status <> 'cancelled' AND l.conversion_status = 'unknown'""").fetchall()
    by_req: dict[str, dict] = {}
    for l in rows:
        c = convert_to_base({"id": l["item_id"], "baseUnit": l["item_base_unit"]}, l["quantity_requested"], l["unit_requested"], convs)
        if c["status"] == "unknown":
            continue
        conn.execute("""UPDATE requisition_lines SET conversion_status=%s, base_quantity_requested=%s, base_unit=%s, conversion_id=%s, updated_at=now()
                        WHERE id=%s""", (c["status"], c["baseQuantity"], c["baseUnit"], c["conversionId"], l["id"]))
        by_req.setdefault(l["requisition_id"], {})[l["id"]] = {"conversionStatus": c["status"], "baseQuantityRequested": c["baseQuantity"],
                                                             "baseUnit": c["baseUnit"], "conversionId": c["conversionId"]}
    for rid, patch in by_req.items():
        audit(conn, None, "line.conversion_resolved", "requisition_line", ",".join(patch), requisition_id=rid, new=patch, system=True)
    return sum(len(p) for p in by_req.values())


def _approve_conversion(conn: Connection, actor: Actor, cid: str) -> dict:
    c = conn.execute("SELECT * FROM unit_conversions WHERE id=%s FOR UPDATE", (cid,)).fetchone()
    if not c:
        raise UserError("Conversion not found.", 404)
    if c["status"] not in ("proposed",):
        raise UserError("Only proposed conversions can be approved.")
    for old in conn.execute("SELECT id FROM unit_conversions WHERE status='approved' AND item_id IS NOT DISTINCT FROM %s AND from_unit=%s",
                            (c["item_id"], c["from_unit"])).fetchall():
        conn.execute("UPDATE unit_conversions SET status='retired', retired_by=%s, retired_at=now() WHERE id=%s", (actor.id, old["id"]))
        audit(conn, actor.id, "conversion.retired", "unit_conversion", old["id"], reason="Replaced by a newer approved conversion")
    row = conn.execute("UPDATE unit_conversions SET status='approved', approved_by=%s, approved_at=now() WHERE id=%s RETURNING *", (actor.id, cid)).fetchone()
    audit(conn, actor.id, "conversion.approved", "unit_conversion", cid, new=conversion_json(row))
    return row


@router.post("/conversions")
def create_conversion(body: dict, actor: Actor = Depends(actor_dep)):
    actor.need("conversion.propose")
    frm = normalize_unit(body.get("fromUnit"))
    incompatible = bool(body.get("incompatible"))
    try:
        factor = 0.0 if incompatible else float(body.get("factor"))
    except (TypeError, ValueError):
        raise UserError("Enter a factor above 0.")
    if not frm:
        raise UserError("Enter the unit to convert from.")
    if not incompatible and not factor > 0:
        raise UserError("Enter a factor above 0.")
    with tx(conversion_resolution=True) as conn:
        item_id = body.get("itemId") or None
        if item_id:
            item = _row(conn, "items", item_id)
            if not item:
                raise UserError("Unknown item.", 404)
            to_unit = normalize_unit(item["base_unit"])
        else:
            to_unit = normalize_unit(body.get("toUnit"))
            if not to_unit:
                raise UserError("For a conversion that applies to all items, enter the base unit it converts to.")
        if frm == to_unit:
            raise UserError("The unit is already the base unit; no conversion is needed.")
        cid = new_id()
        row = conn.execute("""INSERT INTO unit_conversions (id, item_id, from_unit, to_unit, factor, incompatible, status, proposed_by, notes)
                              VALUES (%s,%s,%s,%s,%s,%s,'proposed',%s,%s) RETURNING *""",
                           (cid, item_id, frm, to_unit, factor, incompatible, actor.id, _s(body.get("notes")))).fetchone()
        audit(conn, actor.id, "conversion.proposed", "unit_conversion", cid, new=conversion_json(row))
        resolved = 0
        if actor.can("conversion.approve"):
            row = _approve_conversion(conn, actor, cid)
            resolved = resolve_conversions(conn)
        return {"conversion": conversion_json(row), "resolvedLines": resolved}


@router.post("/conversions/{cid}/approve")
def approve_conversion(cid: str, actor: Actor = Depends(actor_dep)):
    actor.need("conversion.approve")
    with tx(conversion_resolution=True) as conn:
        row = _approve_conversion(conn, actor, cid)
        return {"conversion": conversion_json(row), "resolvedLines": resolve_conversions(conn)}


@router.post("/conversions/{cid}/reject")
def reject_conversion(cid: str, actor: Actor = Depends(actor_dep)):
    actor.need("conversion.approve")
    with tx() as conn:
        row = conn.execute("UPDATE unit_conversions SET status='rejected', retired_by=%s, retired_at=now() WHERE id=%s AND status='proposed' RETURNING *",
                           (actor.id, cid)).fetchone()
        if not row:
            raise UserError("Proposed conversion not found.", 404)
        audit(conn, actor.id, "proposal.rejected", "unit_conversion", cid)
        return {"conversion": conversion_json(row)}


@router.post("/conversions/{cid}/retire")
def retire_conversion(cid: str, actor: Actor = Depends(actor_dep)):
    actor.need("conversion.approve")
    with tx() as conn:
        row = conn.execute("UPDATE unit_conversions SET status='retired', retired_by=%s, retired_at=now() WHERE id=%s AND status='approved' RETURNING *",
                           (actor.id, cid)).fetchone()
        if not row:
            raise UserError("Approved conversion not found.", 404)
        audit(conn, actor.id, "conversion.retired", "unit_conversion", cid)
        return {"conversion": conversion_json(row)}


@router.post("/conversions/resolve")
def resolve(actor: Actor = Depends(actor_dep)):
    actor.need("conversion.approve")
    with tx(conversion_resolution=True) as conn:
        return {"count": resolve_conversions(conn)}


# ------------------------------------------------------------------ equivalences
BASIS = {"strength", "form", "pack_size", "base_unit"}


def _approve_equivalence(conn: Connection, actor: Actor, eid: str) -> dict:
    e = conn.execute("SELECT * FROM substitution_equivalences WHERE id=%s FOR UPDATE", (eid,)).fetchone()
    if not e:
        raise UserError("Equivalence not found.", 404)
    if e["status"] != "proposed":
        raise UserError("Only proposed rules can be approved.")
    for old in conn.execute("SELECT id FROM substitution_equivalences WHERE status='approved' AND requested_item_id=%s AND substitute_item_id=%s",
                            (e["requested_item_id"], e["substitute_item_id"])).fetchall():
        conn.execute("UPDATE substitution_equivalences SET status='retired', retired_by=%s, retired_at=now() WHERE id=%s", (actor.id, old["id"]))
        audit(conn, actor.id, "equivalence.retired", "substitution_equivalence", old["id"], reason="Replaced by a newer approved rule")
    row = conn.execute("UPDATE substitution_equivalences SET status='approved', approved_by=%s, approved_at=now() WHERE id=%s RETURNING *",
                       (actor.id, eid)).fetchone()
    audit(conn, actor.id, "equivalence.approved", "substitution_equivalence", eid, new=equivalence_json(row))
    return row


@router.post("/equivalences")
def create_equivalence(body: dict, actor: Actor = Depends(actor_dep)):
    actor.need("conversion.propose")
    req_id, sub_id = body.get("requestedItemId"), body.get("substituteItemId")
    basis = [b for b in (body.get("basis") or []) if b in BASIS]
    if not req_id or not sub_id or req_id == sub_id:
        raise UserError("Choose two different items.")
    try:
        factor = float(body.get("factor"))
    except (TypeError, ValueError):
        factor = 0
    if not factor > 0:
        raise UserError("Enter a factor above 0.")
    if not basis:
        raise UserError("Choose the basis for the equivalence.")
    just = _s(body.get("justification"))
    if not just:
        raise UserError("Explain why these items are equivalent.")
    with tx() as conn:
        for i in (req_id, sub_id):
            if not _row(conn, "items", i):
                raise UserError("Unknown item.", 404)
        eid = new_id()
        row = conn.execute("""INSERT INTO substitution_equivalences (id, requested_item_id, substitute_item_id, factor, basis, justification, status, proposed_by)
                              VALUES (%s,%s,%s,%s,%s,%s,'proposed',%s) RETURNING *""", (eid, req_id, sub_id, factor, basis, just, actor.id)).fetchone()
        audit(conn, actor.id, "equivalence.proposed", "substitution_equivalence", eid, new=equivalence_json(row))
        if actor.can("conversion.approve"):
            row = _approve_equivalence(conn, actor, eid)
        return {"equivalence": equivalence_json(row)}


@router.post("/equivalences/{eid}/approve")
def approve_equivalence(eid: str, actor: Actor = Depends(actor_dep)):
    actor.need("conversion.approve")
    with tx() as conn:
        return {"equivalence": equivalence_json(_approve_equivalence(conn, actor, eid))}


@router.post("/equivalences/{eid}/reject")
def reject_equivalence(eid: str, actor: Actor = Depends(actor_dep)):
    actor.need("conversion.approve")
    with tx() as conn:
        row = conn.execute("UPDATE substitution_equivalences SET status='rejected', retired_by=%s, retired_at=now() WHERE id=%s AND status='proposed' RETURNING *",
                           (actor.id, eid)).fetchone()
        if not row:
            raise UserError("Proposed rule not found.", 404)
        audit(conn, actor.id, "proposal.rejected", "substitution_equivalence", eid)
        return {"equivalence": equivalence_json(row)}


@router.post("/equivalences/{eid}/retire")
def retire_equivalence(eid: str, actor: Actor = Depends(actor_dep)):
    actor.need("conversion.approve")
    with tx() as conn:
        row = conn.execute("UPDATE substitution_equivalences SET status='retired', retired_by=%s, retired_at=now() WHERE id=%s AND status='approved' RETURNING *",
                           (actor.id, eid)).fetchone()
        if not row:
            raise UserError("Approved rule not found.", 404)
        audit(conn, actor.id, "equivalence.retired", "substitution_equivalence", eid)
        return {"equivalence": equivalence_json(row)}


# ------------------------------------------------------------------ settings
@router.put("/settings")
def save_settings(body: dict, actor: Actor = Depends(actor_dep)):
    actor.need("settings.manage")
    s = {k: body.get(k, v) for k, v in DEFAULT_SETTINGS.items()}
    try:
        s["ofrThresholdPercent"] = float(s["ofrThresholdPercent"])
        s["editWindowHours"] = float(s["editWindowHours"])
        s["editRequestPendingTimeoutDays"] = float(s["editRequestPendingTimeoutDays"])
    except (TypeError, ValueError):
        raise UserError("Settings must be numbers where numbers are expected.")
    if not 0 < s["ofrThresholdPercent"] <= 100:
        raise UserError("The OFR threshold must be between 1 and 100.")
    if s["ofrThresholdStage"] not in ("invoiced", "issued", "delivered"):
        raise UserError("The threshold stage must be invoiced, issued or delivered.")
    if not s["editWindowHours"] > 0:
        raise UserError("The edit window must be above 0 hours.")
    if not s["editRequestPendingTimeoutDays"] > 0:
        raise UserError("The pending edit-request timeout must be above 0 days.")
    if s["defaultTimeBasis"] not in ("received", "requisition", "entry"):
        raise UserError("The time basis must be received, requisition or entry.")
    for k in ("ofrThresholdPercent", "editWindowHours", "editRequestPendingTimeoutDays"):
        if float(s[k]).is_integer():
            s[k] = int(s[k])
    with tx() as conn:
        old = load_settings(conn)
        conn.execute("""INSERT INTO settings (key, value, updated_by) VALUES ('app', %s, %s)
                        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()""", (J(s), actor.id))
        audit(conn, actor.id, "settings.changed", "system_setting", "settings", old=old, new=s)
    return s


# ------------------------------------------------------------------ users
GRANTS = {"requisition.reopen", "edit_request.approve", "documents.download"}


@router.get("/users")
def users(actor: Actor = Depends(actor_dep)):
    actor.need("users.manage")
    with tx() as conn:
        out = load_users(conn)
        grants: dict[str, list[str]] = {}
        for g in conn.execute("SELECT user_id, permission FROM permission_grants WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())").fetchall():
            grants.setdefault(g["user_id"], []).append(g["permission"])
        for u in out:
            u["grants"] = grants.get(u["id"], [])
        return out


@router.post("/users/{uid}/access")
def set_access(uid: str, body: dict, actor: Actor = Depends(actor_dep)):
    actor.need("users.manage")
    status, role = body.get("status"), body.get("role") or None
    grants = sorted(set(body.get("grants") or []))
    if status not in ("active", "inactive", "pending"):
        raise UserError("Status must be active, inactive or pending.")
    if role not in (None, "ra", "supervisor", "admin"):
        raise UserError("Role must be Requisition Assistant, Supervisor or Administrator.")
    if status == "active" and not role:
        raise UserError("Choose a role before activating this account.")
    if any(g not in GRANTS for g in grants):
        raise UserError("Unknown permission grant.")
    if role != "supervisor" and grants:
        raise UserError("Extra grants are only for Supervisors; other roles already have what they need.")
    if uid == actor.id and (status != "active" or role != "admin"):
        raise forbidden("You can't remove your own Administrator access. Ask another Administrator.")
    with tx() as conn:
        u = conn.execute("SELECT * FROM users WHERE id=%s FOR UPDATE", (uid,)).fetchone()
        if not u:
            raise UserError("User not found.", 404)
        old_grants = sorted(r["permission"] for r in conn.execute(
            "SELECT permission FROM permission_grants WHERE user_id=%s AND revoked_at IS NULL", (uid,)).fetchall())
        conn.execute("UPDATE users SET status=%s, role=%s, updated_at=now() WHERE id=%s", (status, role, uid))
        if old_grants != grants:
            conn.execute("UPDATE permission_grants SET revoked_at=now(), revoked_by=%s WHERE user_id=%s AND revoked_at IS NULL", (actor.id, uid))
            for g in grants:
                conn.execute("INSERT INTO permission_grants (id, user_id, permission, granted_by) VALUES (%s,%s,%s,%s)", (new_id(), uid, g, actor.id))
        audit(conn, actor.id, "role.changed", "user", uid, old={"status": u["status"], "role": u["role"], "grants": old_grants},
              new={"status": status, "role": role, "grants": grants})
    forget_cached_actors()
    return {"id": uid, "status": status, "role": role, "grants": grants}

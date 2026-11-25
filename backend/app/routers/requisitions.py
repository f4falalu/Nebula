"""Requisition workflow API (PRD §9–§13, §20). Port of the V1 service layer
(app/src/data/services.ts) with the same rules, messages and audit event types.
Each mutation locks the requisition row, writes its audit rows in the same
transaction, and returns the requisition in the V1 JSON shape."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
from typing import Any, Optional

import fitz  # pymupdf
from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from psycopg import Connection

from ..core import storage
from ..core.auth import Actor, require_actor
from ..core.common import (UserError, audit, format_requisition_number, iso, jsonable, lagos_date, minute, new_id, now,
                           parse_ts)
from ..core.db import J, tx
from ..core.state import doc_json, load_requisition, load_settings
from ..domain import (EDITABLE_STATUSES, HEADER_FIELDS, LINE_FIELDS, can_record_stage, can_supersede, chronology_errors,
                      convert_to_base, edit_covers, effective, normalize, normalize_unit, status_after_edit, validation_issues)
from ..jobs import queue_extraction

router = APIRouter()

ACCEPTED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"}
MAX_FILE_BYTES = 20 * 1024 * 1024
OPERATIONAL = {"finance", "invoicing", "pick_and_pack", "dispatched", "completed"}
FULFILLMENT_STAGES = {"invoiced", "issued", "delivered"}


# ================================================================== helpers
def _lock(conn: Connection, rid: str) -> dict:
    r = conn.execute("SELECT * FROM requisitions WHERE id=%s FOR UPDATE", (rid,)).fetchone()
    if not r:
        raise UserError("Requisition not found.", 404)
    return r


def _resp(conn: Connection, rid: str, **extra: Any) -> dict:
    return {**extra, "requisition": load_requisition(conn, rid)}


def _rows(conn: Connection, table: str, rid: str) -> list[dict]:
    return conn.execute(f"SELECT * FROM {table} WHERE requisition_id=%s", (rid,)).fetchall()


def _settings(conn: Connection) -> dict:
    return load_settings(conn)


def _er_status(er: dict, timeout_days: float, at: dt.datetime | None = None) -> str:
    t = at or now()
    if er["status"] == "approved" and er["approval_expires_at"] and t > er["approval_expires_at"]:
        return "expired"
    if er["status"] == "pending" and t > er["requested_at"] + dt.timedelta(days=timeout_days):
        return "expired"
    return er["status"]


def _active_edit(conn: Connection, rid: str, actor_id: str) -> dict | None:
    timeout = float(_settings(conn)["editRequestPendingTimeoutDays"])
    for er in conn.execute("SELECT * FROM edit_requests WHERE requisition_id=%s AND requested_by=%s ORDER BY requested_at DESC",
                           (rid, actor_id)).fetchall():
        if _er_status(er, timeout) == "approved" and er["used_at"] is None:
            return er
    return None


def _enter_edit_context(conn: Connection, er: dict) -> None:
    conn.execute("SELECT set_config('nebula.edit_request_id', %s, true)", (er["id"],))


def _mark_used(conn: Connection, actor: Actor, rid: str, er: dict) -> None:
    conn.execute("UPDATE edit_requests SET status='used', used_at=now(), closed_at=now(), closure_reason='used' WHERE id=%s", (er["id"],))
    audit(conn, actor.id, "edit_request.used", "edit_request", er["id"], requisition_id=rid, edit_request_id=er["id"])


def _edit_gate(conn: Connection, actor: Actor, r: dict, entity_type: str, entity_id: str | None, fields: list[str]) -> dict | None:
    """Header/line/page changes: allowed while editable, or on Finalized under an approved edit request covering the fields."""
    actor.need("requisition.edit")
    if r["record_status"] in EDITABLE_STATUSES:
        return None
    if r["record_status"] == "finalized":
        er = _active_edit(conn, r["id"], actor.id)
        if er and all(edit_covers(er["requested_changes"], entity_type, entity_id, f) for f in fields):
            _enter_edit_context(conn, er)
            return er
        raise UserError("This requisition is finalized. Submit an edit request for this change, or ask an Administrator to reopen it.")
    raise UserError(f"A {r['record_status'].replace('_', ' ', 1)} requisition can't be edited.")


def _post_close_gate(conn: Connection, actor: Actor, r: dict) -> dict | None:
    if r["fulfillment_status"] != "closed":
        return None
    er = _active_edit(conn, r["id"], actor.id)
    if er and any(c.get("entityType") in ("fulfillment", "lifecycle") for c in er["requested_changes"]):
        return er
    raise UserError("Fulfillment is closed. Reopen fulfillment first." if actor.role == "admin"
                    else "Fulfillment is closed. Submit an edit request to correct it.")


def _status_change_audit(conn: Connection, actor: Actor, rid: str, old: str, new: str, reason: str | None = None) -> None:
    if old != new:
        audit(conn, actor.id, "record_status.changed", "requisition", rid, requisition_id=rid, old=old, new=new, reason=reason)


def _approved_conversions(conn: Connection) -> list[dict]:
    return [{"id": c["id"], "itemId": c["item_id"], "fromUnit": c["from_unit"], "toUnit": c["to_unit"], "factor": float(c["factor"]),
             "incompatible": c["incompatible"], "status": c["status"]}
            for c in conn.execute("SELECT * FROM unit_conversions WHERE status='approved'").fetchall()]


def _item(conn: Connection, item_id: str | None) -> dict | None:
    if not item_id:
        return None
    i = conn.execute("SELECT * FROM items WHERE id=%s", (item_id,)).fetchone()
    if not i:
        return None
    return {"id": i["id"], "baseUnit": i["base_unit"], "name": i["name"], "code": i["code"]}


def _note_alias(conn: Connection, entity_type: str, entity_id: str, text: str | None) -> None:
    n = normalize(text)
    if not n:
        return
    table = "facilities" if entity_type == "facility" else "items"
    target = conn.execute(f"SELECT name FROM {table} WHERE id=%s", (entity_id,)).fetchone()
    if not target or normalize(target["name"]) == n:
        return
    existing = conn.execute("SELECT status FROM aliases WHERE entity_type=%s AND entity_id=%s AND normalized=%s",
                            (entity_type, entity_id, n)).fetchone()
    if existing and existing["status"] != "candidate":
        return
    key = f"al-{entity_type}-{entity_id}-{''.join(c for c in n if c.isalnum())[:60]}"
    conn.execute(
        """INSERT INTO aliases (id, entity_type, entity_id, alias, normalized, occurrences, status)
           VALUES (%s,%s,%s,%s,%s,1,'candidate')
           ON CONFLICT (entity_type, entity_id, normalized) DO UPDATE SET occurrences = aliases.occurrences + 1
           WHERE aliases.status = 'candidate'""",
        (key, entity_type, entity_id, text, n))


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        f = float(str(v).replace(",", ""))
    except ValueError:
        raise UserError("Enter a number for the quantity.")
    return f


def _date(v: Any) -> dt.date | None:
    if v in (None, ""):
        return None
    try:
        return dt.date.fromisoformat(str(v)[:10])
    except ValueError:
        raise UserError("Enter a valid date.")


def _read_upload(f: UploadFile) -> tuple[bytes, str]:
    data = f.file.read()
    mime = (f.content_type or "").split(";")[0].strip().lower()
    name = f.filename or "file"
    if mime not in ACCEPTED_TYPES:
        raise UserError(f"{name}: use a JPEG, PNG, WebP, GIF or PDF file.")
    if len(data) > MAX_FILE_BYTES:
        raise UserError(f"{name} is larger than 20 MB.")
    if not data:
        raise UserError(f"{name} is empty.")
    return data, mime


def _page_count(data: bytes, mime: str) -> int:
    if mime != "application/pdf":
        return 1
    try:
        with fitz.open(stream=data, filetype="pdf") as d:
            return max(1, d.page_count)
    except Exception:
        raise UserError("This PDF couldn't be opened. Check the file and try again.")


def _store_document(conn: Connection, actor: Actor, rid: str, f: UploadFile, category: str, document_type: str,
                    first_page: int, lifecycle_event_id: str | None = None, description: str | None = None,
                    pre: tuple[bytes, str] | None = None) -> dict:
    data, mime = pre or _read_upload(f)
    doc_id = new_id()
    storage.put(doc_id, data)
    row = conn.execute(
        """INSERT INTO documents (id, requisition_id, category, lifecycle_event_id, document_type, file_name, mime_type, storage_key,
               sha256, file_size, page_count, first_page, description, uploaded_by)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
        (doc_id, rid, category, lifecycle_event_id, document_type, f.filename or "file", mime, doc_id,
         hashlib.sha256(data).hexdigest(), len(data), _page_count(data, mime), first_page, description, actor.id)).fetchone()
    return row


def _event_json(e: dict) -> dict:
    return jsonable({k: v for k, v in e.items()})


# ================================================================== requisitions
@router.post("/requisitions")
def create_requisition(receivedAt: str = Form(...), receivedVia: str = Form(""), read: str = Form("false"),
                       files: list[UploadFile] = File(...), actor: Actor = Depends(require_actor)):
    actor.need("requisition.create")
    if not files:
        raise UserError("Attach the original requisition (photo or PDF).")
    received = parse_ts(receivedAt)
    entry_at = now()
    if minute(received) > minute(entry_at):
        raise UserError("Received at can't be in the future.")
    if received > entry_at:
        received = entry_at
    uploads = [(f, _read_upload(f)) for f in files]
    entry_date = lagos_date(entry_at)
    rid = new_id()
    with tx() as conn:
        serial = conn.execute("SELECT next_requisition_serial(%s) AS s", (entry_date,)).fetchone()["s"]
        number = format_requisition_number(entry_date, serial)
        conn.execute(
            """INSERT INTO requisitions (id, requisition_number, entry_date, entry_serial, received_at, received_via, entry_at,
                   record_status, created_by, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,'draft',%s,%s)""",
            (rid, number, entry_date, serial, received, receivedVia or None, entry_at, actor.id, entry_at))
        audit(conn, actor.id, "requisition.created", "requisition", rid, requisition_id=rid,
              new={"number": number, "receivedAt": iso(received), "entryAt": iso(entry_at)})
        page = 1
        for f, pre in uploads:
            d = _store_document(conn, actor, rid, f, "original_requisition", "requisition", page, pre=pre)
            page += d["page_count"]
            audit(conn, actor.id, "document.uploaded", "document", d["id"], requisition_id=rid,
                  new={"fileName": d["file_name"], "sha256": d["sha256"], "category": d["category"]})
        for p in range(1, page):
            conn.execute("INSERT INTO document_pages (requisition_id, page_number) VALUES (%s,%s)", (rid, p))
        if read.lower() == "true":
            queue_extraction(conn, actor.id, rid)
            _status_change_audit(conn, actor, rid, "draft", "processing")
        else:
            conn.execute("UPDATE requisitions SET record_status='validation_pending' WHERE id=%s", (rid,))
            _status_change_audit(conn, actor, rid, "draft", "validation_pending", "Manual entry")
        return _resp(conn, rid, id=rid)


@router.post("/requisitions/{rid}/extract")
def retry_extraction(rid: str, actor: Actor = Depends(require_actor)):
    actor.need("extraction.retry")
    with tx() as conn:
        r = _lock(conn, rid)
        last = conn.execute("SELECT status FROM processing_jobs WHERE requisition_id=%s ORDER BY attempt DESC LIMIT 1", (rid,)).fetchone()
        ok = r["record_status"] in ("draft", "validation_pending") or (r["record_status"] == "processing" and last and last["status"] == "failed")
        if not ok:
            raise UserError("Documents can be read only before validation.")
        if last and last["status"] in ("queued", "processing") and r["record_status"] == "processing":
            raise UserError("The document is already being read.")
        queue_extraction(conn, actor.id, rid)
        _status_change_audit(conn, actor, rid, r["record_status"], "processing")
        return _resp(conn, rid)


@router.patch("/requisitions/{rid}/header")
def update_header(rid: str, patch: dict, actor: Actor = Depends(require_actor)):
    unknown = set(patch) - set(HEADER_FIELDS)
    if unknown:
        raise UserError(f"These fields can't be changed here: {', '.join(sorted(unknown))}.")
    if not patch:
        raise UserError("Nothing to change.")
    with tx() as conn:
        r = _lock(conn, rid)
        er = _edit_gate(conn, actor, r, "header", None, list(patch))
        old, sets, params = {}, [], []
        for k, v in patch.items():
            col = HEADER_FIELDS[k]
            if k == "receivedAt":
                if v in (None, ""):
                    raise UserError("Enter when the requisition was received.")
                v = parse_ts(v)
                if minute(v) > minute(now()):
                    raise UserError("Received at can't be in the future.")
                if v > r["entry_at"]:
                    raise UserError("Received at can't be later than when the requisition was entered.")
            elif k == "requisitionDate":
                v = _date(v)
            elif k == "requisitionDateEstimated":
                v = bool(v)
            elif k in ("facilityId", "primaryProgrammeId"):
                v = v or None
                if v:
                    table = "facilities" if k == "facilityId" else "programmes"
                    if not conn.execute(f"SELECT 1 FROM {table} WHERE id=%s", (v,)).fetchone():
                        raise UserError("That facility doesn't exist." if k == "facilityId" else "That programme doesn't exist.")
            else:
                v = v or None
            old[k] = jsonable(r[col])
            sets.append(f"{col}=%s")
            params.append(v)
        received = patch.get("receivedAt") and parse_ts(patch["receivedAt"]) or r["received_at"]
        req_date = _date(patch["requisitionDate"]) if "requisitionDate" in patch else r["requisition_date"]
        if req_date and req_date > lagos_date(received):
            raise UserError("The requisition date can't be later than the date it was received.")
        status = r["record_status"] if er else status_after_edit(r["record_status"])
        sets.append("record_status=%s")
        params.append(status)
        conn.execute(f"UPDATE requisitions SET {', '.join(sets)} WHERE id=%s", (*params, rid))
        if patch.get("facilityId") and patch["facilityId"] != r["facility_id"] and r["facility_extracted_text"]:
            _note_alias(conn, "facility", patch["facilityId"], r["facility_extracted_text"])
        audit(conn, actor.id, "header.changed", "requisition", rid, requisition_id=rid, old=old, new=patch, edit_request_id=er and er["id"])
        _status_change_audit(conn, actor, rid, r["record_status"], status, "Edited after validation")
        if er:
            _mark_used(conn, actor, rid, er)
        return _resp(conn, rid)


def _apply_line_conversion(conn: Connection, line: dict) -> dict:
    item = _item(conn, line.get("item_id"))
    if not item:
        return {"conversion_status": None, "base_quantity_requested": None, "base_unit": None, "conversion_id": None}
    c = convert_to_base(item, line.get("quantity_requested"), line.get("unit_requested"), _approved_conversions(conn))
    return {"conversion_status": c["status"], "base_quantity_requested": c["baseQuantity"], "base_unit": c["baseUnit"], "conversion_id": c["conversionId"]}


LINE_COLUMNS = ["line_number", "page_number", "raw_extracted_text", "item_extracted_text", "corrected_text", "item_id", "programme_id",
                "programme_overridden", "quantity_requested", "unit_requested", "base_quantity_requested", "base_unit", "conversion_id",
                "conversion_status", "strength", "form", "pack_size", "candidates", "match_method", "match_confirmed_by", "match_confirmed_at"]


def _line_value(k: str, v: Any, conn: Connection) -> Any:
    if k == "quantityRequested":
        q = _num(v)
        if q is not None and q < 0:
            raise UserError("Enter a quantity of 0 or more.")
        return q
    if k == "pageNumber":
        return int(v) if v not in (None, "") else None
    if k == "programmeOverridden":
        return bool(v)
    if k == "itemId":
        if v and not conn.execute("SELECT 1 FROM items WHERE id=%s", (v,)).fetchone():
            raise UserError("That item doesn't exist.")
        return v or None
    if k == "programmeId":
        if v and not conn.execute("SELECT 1 FROM programmes WHERE id=%s", (v,)).fetchone():
            raise UserError("That programme doesn't exist.")
        return v or None
    return v if v not in ("",) else None


@router.post("/requisitions/{rid}/lines")
def upsert_line(rid: str, body: dict, actor: Actor = Depends(require_actor)):
    line_id: Optional[str] = body.get("lineId")
    patch: dict = body.get("patch") or {}
    unknown = set(patch) - set(LINE_FIELDS)
    if unknown:
        raise UserError(f"These line fields can't be changed here: {', '.join(sorted(unknown))}.")
    with tx() as conn:
        r = _lock(conn, rid)
        existing = None
        if line_id:
            existing = conn.execute("SELECT * FROM requisition_lines WHERE id=%s AND requisition_id=%s", (line_id, rid)).fetchone()
            if not existing:
                raise UserError("That line was removed.")
        er = _edit_gate(conn, actor, r, "line", line_id, list(patch) if line_id else ["*"])
        t = now()
        values = {LINE_FIELDS[k]: _line_value(k, v, conn) for k, v in patch.items()}
        if existing:
            base = dict(existing)
        else:
            page = values.get("page_number")
            mx = conn.execute("SELECT COALESCE(MAX(line_number),0) AS m FROM requisition_lines WHERE requisition_id=%s AND page_number IS NOT DISTINCT FROM %s",
                              (rid, page)).fetchone()["m"]
            base = {c: None for c in LINE_COLUMNS}
            base.update({"id": new_id(), "line_number": mx + 1, "candidates": [], "programme_overridden": False})
        nxt = {**base, **values}
        if "item_id" in values and values["item_id"] and values["item_id"] != base.get("item_id"):
            cand = next((c for c in (base.get("candidates") or []) if c.get("targetId") == values["item_id"]), None)
            nxt["match_method"] = cand["method"] if cand else "human"
            nxt["match_confirmed_by"] = actor.id
            nxt["match_confirmed_at"] = t
        if not existing and not nxt.get("programme_id"):
            pg = None
            if nxt.get("page_number"):
                pg = conn.execute("SELECT programme_id FROM document_pages WHERE requisition_id=%s AND page_number=%s",
                                  (rid, nxt["page_number"])).fetchone()
            nxt["programme_id"] = (pg and pg["programme_id"]) or r["primary_programme_id"]
        nxt.update(_apply_line_conversion(conn, nxt))
        cols = LINE_COLUMNS
        vals = [J(nxt[c] or []) if c == "candidates" else nxt.get(c) for c in cols]
        if existing:
            conn.execute(f"UPDATE requisition_lines SET {', '.join(c + '=%s' for c in cols)}, updated_at=now() WHERE id=%s", (*vals, nxt["id"]))
        else:
            conn.execute(f"INSERT INTO requisition_lines (id, requisition_id, {', '.join(cols)}) VALUES (%s,%s,{','.join(['%s'] * len(cols))})",
                         (nxt["id"], rid, *vals))
        status = r["record_status"] if er else status_after_edit(r["record_status"])
        if status != r["record_status"]:
            conn.execute("UPDATE requisitions SET record_status=%s WHERE id=%s", (status, rid))
        else:
            conn.execute("UPDATE requisitions SET updated_at=now() WHERE id=%s", (rid,))
        if values.get("item_id") and values["item_id"] != base.get("item_id") and (base.get("item_extracted_text") or base.get("raw_extracted_text")):
            _note_alias(conn, "item", values["item_id"], base.get("item_extracted_text") or base.get("raw_extracted_text"))
        old = {k: jsonable(existing[LINE_FIELDS[k]]) for k in patch} if existing else None
        audit(conn, actor.id, "line.changed" if existing else "line.added", "requisition_line", nxt["id"], requisition_id=rid,
              old=old, new=patch, edit_request_id=er and er["id"])
        _status_change_audit(conn, actor, rid, r["record_status"], status, "Edited after validation")
        if er:
            _mark_used(conn, actor, rid, er)
        return _resp(conn, rid, lineId=nxt["id"])


@router.delete("/requisitions/{rid}/lines/{line_id}")
def remove_line(rid: str, line_id: str, actor: Actor = Depends(require_actor)):
    with tx() as conn:
        r = _lock(conn, rid)
        line = conn.execute("SELECT * FROM requisition_lines WHERE id=%s AND requisition_id=%s", (line_id, rid)).fetchone()
        if not line:
            raise UserError("That line was removed.")
        er = _edit_gate(conn, actor, r, "line", line_id, ["*"])
        if conn.execute("SELECT 1 FROM fulfillment_records WHERE requisition_line_id=%s LIMIT 1", (line_id,)).fetchone():
            raise UserError("This line has fulfillment records, so it can't be removed.")
        conn.execute("DELETE FROM requisition_lines WHERE id=%s", (line_id,))
        status = r["record_status"] if er else status_after_edit(r["record_status"])
        conn.execute("UPDATE requisitions SET record_status=%s WHERE id=%s", (status, rid))
        audit(conn, actor.id, "line.removed", "requisition_line", line_id, requisition_id=rid, old=jsonable(dict(line)), edit_request_id=er and er["id"])
        _status_change_audit(conn, actor, rid, r["record_status"], status, "Edited after validation")
        if er:
            _mark_used(conn, actor, rid, er)
        return _resp(conn, rid)


@router.post("/requisitions/{rid}/pages")
def set_page_programme(rid: str, body: dict, actor: Actor = Depends(require_actor)):
    page = body.get("page")
    programme_id = body.get("programmeId")
    if not programme_id:
        raise UserError("Choose a programme.")
    with tx() as conn:
        r = _lock(conn, rid)
        er = _edit_gate(conn, actor, r, "page", None if page == "all" else str(page), ["programmeId"])
        if not conn.execute("SELECT 1 FROM programmes WHERE id=%s", (programme_id,)).fetchone():
            raise UserError("That programme doesn't exist.")
        all_pages = [p["page_number"] for p in conn.execute("SELECT page_number FROM document_pages WHERE requisition_id=%s ORDER BY 1", (rid,)).fetchall()]
        pages = all_pages if page == "all" else [int(page)]
        if page != "all" and int(page) not in all_pages:
            raise UserError("That page doesn't exist.")
        conn.execute("UPDATE document_pages SET programme_id=%s, updated_by=%s, updated_at=now() WHERE requisition_id=%s AND page_number = ANY(%s)",
                     (programme_id, actor.id, rid, pages))
        cur = conn.execute("UPDATE requisition_lines SET programme_id=%s, updated_at=now() WHERE requisition_id=%s AND NOT programme_overridden AND page_number = ANY(%s)",
                           (programme_id, rid, pages))
        status = r["record_status"] if er else status_after_edit(r["record_status"])
        conn.execute("UPDATE requisitions SET record_status=%s WHERE id=%s", (status, rid))
        audit(conn, actor.id, "page_programme.changed", "document_page", "all" if page == "all" else str(page), requisition_id=rid,
              new={"programmeId": programme_id, "pages": pages, "linesUpdated": cur.rowcount}, edit_request_id=er and er["id"])
        _status_change_audit(conn, actor, rid, r["record_status"], status, "Edited after validation")
        if er:
            _mark_used(conn, actor, rid, er)
        return _resp(conn, rid)


def _validation_issues(conn: Connection, r: dict) -> list[str]:
    lines = _rows(conn, "requisition_lines", r["id"])
    ids = lambda t: {x["id"] for x in conn.execute(f"SELECT id FROM {t}").fetchall()}  # noqa: E731
    running = bool(conn.execute("SELECT 1 FROM processing_jobs WHERE requisition_id=%s AND status IN ('queued','processing')", (r["id"],)).fetchone())
    return validation_issues(r, lines, ids("facilities"), ids("items"), ids("programmes"), running)


@router.post("/requisitions/{rid}/validate")
def validate(rid: str, actor: Actor = Depends(require_actor)):
    actor.need("requisition.validate")
    with tx() as conn:
        r = _lock(conn, rid)
        if r["record_status"] not in ("validation_pending", "reopened", "draft"):
            raise UserError("Only requisitions awaiting validation can be validated.")
        issues = _validation_issues(conn, r)
        if issues:
            raise UserError("\n".join(issues))
        t = now()
        if r["first_validated_at"]:
            conn.execute("UPDATE requisitions SET record_status='validated', validated_at=%s, validated_by=%s WHERE id=%s", (t, actor.id, rid))
        else:
            conn.execute("UPDATE requisitions SET record_status='validated', validated_at=%s, validated_by=%s, first_validated_at=%s, first_validated_by=%s WHERE id=%s",
                         (t, actor.id, t, actor.id, rid))
        audit(conn, actor.id, "requisition.validated", "requisition", rid, requisition_id=rid, old=r["record_status"], new="validated")
        return _resp(conn, rid)


@router.post("/requisitions/{rid}/finalize")
def finalize(rid: str, actor: Actor = Depends(require_actor)):
    actor.need("requisition.finalize")
    with tx() as conn:
        r = _lock(conn, rid)
        issues: list[str] = []
        if r["record_status"] != "validated":
            issues.append("Validate the requisition first.")
        issues += _validation_issues(conn, r)
        originals = conn.execute("SELECT sha256 FROM documents WHERE requisition_id=%s AND category='original_requisition'", (rid,)).fetchall()
        if not originals or any(not d["sha256"] for d in originals):
            issues.append("Attach the original requisition document.")
        if issues:
            raise UserError("\n".join(dict.fromkeys(issues)))
        conn.execute("UPDATE requisitions SET record_status='finalized', finalized_at=now(), finalized_by=%s WHERE id=%s", (actor.id, rid))
        audit(conn, actor.id, "requisition.finalized", "requisition", rid, requisition_id=rid, old=r["record_status"], new="finalized")
        return _resp(conn, rid)


@router.post("/requisitions/{rid}/cancel")
def cancel(rid: str, body: dict, actor: Actor = Depends(require_actor)):
    reason = (body.get("reason") or "").strip()
    with tx() as conn:
        r = _lock(conn, rid)
        if not reason:
            raise UserError("Give a reason for cancelling.")
        if r["record_status"] == "cancelled":
            raise UserError("Already cancelled.")
        has_fulfillment = bool(effective(_rows(conn, "fulfillment_records", rid)))
        actor.need("requisition.cancel_finalized" if r["record_status"] == "finalized" or has_fulfillment else "requisition.cancel")
        conn.execute("UPDATE requisitions SET record_status='cancelled', cancelled_at=now(), cancelled_by=%s, cancellation_reason=%s WHERE id=%s",
                     (actor.id, reason, rid))
        audit(conn, actor.id, "requisition.cancelled", "requisition", rid, requisition_id=rid, old=r["record_status"], new="cancelled", reason=reason)
        return _resp(conn, rid)


@router.post("/requisitions/{rid}/reopen")
def reopen(rid: str, body: dict, actor: Actor = Depends(require_actor)):
    actor.need("requisition.reopen")
    reason = (body.get("reason") or "").strip()
    with tx() as conn:
        r = _lock(conn, rid)
        if r["record_status"] != "finalized":
            raise UserError("Only finalized requisitions can be reopened.")
        if not reason:
            raise UserError("Give a reason for reopening.")
        conn.execute("UPDATE requisitions SET record_status='reopened', reopened_at=now(), reopened_by=%s, reopen_reason=%s WHERE id=%s",
                     (actor.id, reason, rid))
        audit(conn, actor.id, "requisition.reopened", "requisition", rid, requisition_id=rid, old="finalized", new="reopened", reason=reason)
        return _resp(conn, rid)


# ================================================================== documents
@router.post("/requisitions/{rid}/documents")
def upload_documents(rid: str, files: list[UploadFile] = File(...), documentType: str = Form("other"), description: str = Form(""),
                     category: str = Form(""), lifecycleEventId: str = Form(""), actor: Actor = Depends(require_actor)):
    actor.need("evidence.upload")
    with tx() as conn:
        r = _lock(conn, rid)
        if r["record_status"] == "cancelled":
            raise UserError("This requisition is cancelled.")
        ev = lifecycleEventId or None
        if ev and not conn.execute("SELECT 1 FROM lifecycle_events WHERE id=%s AND requisition_id=%s", (ev, rid)).fetchone():
            raise UserError("That lifecycle event doesn't belong to this requisition.")
        cat = category or ("lifecycle_evidence" if ev else "supporting")
        if cat not in ("supporting", "lifecycle_evidence", "processed"):
            raise UserError("Unknown document category.")
        if cat == "lifecycle_evidence" and not ev:
            raise UserError("Lifecycle evidence must belong to a lifecycle event.")
        out = []
        for f in files:
            d = _store_document(conn, actor, rid, f, cat, documentType or "other", 0, ev, description or None)
            out.append(doc_json(d))
            audit(conn, actor.id, "evidence.uploaded", "document", d["id"], requisition_id=rid,
                  new={"fileName": d["file_name"], "sha256": d["sha256"], "documentType": d["document_type"], "lifecycleEventId": ev})
        return _resp(conn, rid, documents=out)


@router.get("/documents/{doc_id}/url")
def document_url(doc_id: str, download: int = 0, actor: Actor = Depends(require_actor)):
    if download:
        actor.need("documents.download")
    with tx() as conn:
        if not conn.execute("SELECT 1 FROM documents WHERE id=%s", (doc_id,)).fetchone():
            raise UserError("Document not found.", 404)
    return {"url": storage.sign(doc_id, actor.id, ttl=300, download=bool(download))}


# ================================================================== lifecycle
@router.post("/requisitions/{rid}/events")
def record_event(rid: str, data: str = Form(...), files: Optional[list[UploadFile]] = File(None), actor: Actor = Depends(require_actor)):
    actor.need("lifecycle.record")
    try:
        inp = json.loads(data)
    except ValueError:
        raise UserError("The event data couldn't be read.")
    stage, status = inp.get("stage"), inp.get("status", "completed")
    if stage not in OPERATIONAL:
        raise UserError("Unknown lifecycle stage.")
    if status not in ("completed", "not_applicable"):
        raise UserError("Unknown stage status.")
    supersedes = inp.get("supersedesId") or None
    correction_reason = (inp.get("correctionReason") or "").strip() or None
    override = bool(inp.get("override"))
    override_reason = (inp.get("overrideReason") or "").strip() or None
    na_reason = (inp.get("notApplicableReason") or "").strip() or None
    occurred = parse_ts(inp.get("occurredAt"))
    with tx() as conn:
        r = _lock(conn, rid)
        er = _post_close_gate(conn, actor, r)
        events = _rows(conn, "lifecycle_events", rid)
        if not supersedes:
            why = can_record_stage(r, events, stage)
            if why:
                raise UserError(why)
        else:
            if not can_supersede(events, supersedes):
                raise UserError("That event has already been corrected or voided.")
            if next(e for e in events if e["id"] == supersedes)["stage"] != stage:
                raise UserError("A correction must be for the same stage.")
            if not correction_reason:
                raise UserError("Give a reason for the correction.")
        if status == "not_applicable":
            if stage == "completed":
                raise UserError("Completed can't be marked Not Applicable.")
            if not na_reason:
                raise UserError("Give a reason for Not Applicable.")
        if override:
            actor.need("chronology.override")
            if not override_reason:
                raise UserError("Give a reason for the chronology override.")
        hard, soft = chronology_errors(r, events, stage, occurred, ignore_event_id=supersedes, override=override)
        if hard or soft:
            msg = "\n".join(hard + soft)
            if soft and actor.can("chronology.override"):
                msg += "\nAn Administrator can record it with a chronology override."
            raise UserError(msg)
        eid = new_id()
        ev = conn.execute(
            """INSERT INTO lifecycle_events (id, requisition_id, stage, status, not_applicable_reason, occurred_at, recorded_by, notes,
                   chronology_override, override_reason, record_type, supersedes_id, correction_reason, edit_request_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
            (eid, rid, stage, status, na_reason if status == "not_applicable" else None, occurred, actor.id, inp.get("notes") or None,
             override, override_reason if override else None, "correction" if supersedes else "entry", supersedes, correction_reason,
             er and er["id"])).fetchone()
        old = next((e for e in events if e["id"] == supersedes), None)
        audit(conn, actor.id, "lifecycle.corrected" if supersedes else "lifecycle.recorded", "lifecycle_event", eid, requisition_id=rid,
              old=_event_json(old) if old else None, new=_event_json(ev), reason=correction_reason or override_reason, edit_request_id=er and er["id"])
        for f in files or []:
            d = _store_document(conn, actor, rid, f, "lifecycle_evidence", inp.get("documentType") or "other", 0, eid)
            audit(conn, actor.id, "evidence.uploaded", "document", d["id"], requisition_id=rid,
                  new={"fileName": d["file_name"], "sha256": d["sha256"], "documentType": d["document_type"], "lifecycleEventId": eid})
        conn.execute("UPDATE requisitions SET updated_at=now() WHERE id=%s", (rid,))
        if er:
            _mark_used(conn, actor, rid, er)
        return _resp(conn, rid, eventId=eid)


@router.post("/requisitions/{rid}/events/{event_id}/void")
def void_event(rid: str, event_id: str, body: dict, actor: Actor = Depends(require_actor)):
    actor.need("lifecycle.record")
    reason = (body.get("reason") or "").strip()
    with tx() as conn:
        r = _lock(conn, rid)
        er = _post_close_gate(conn, actor, r)
        if not reason:
            raise UserError("Give a reason for voiding.")
        events = _rows(conn, "lifecycle_events", rid)
        if not can_supersede(events, event_id):
            raise UserError("That event has already been corrected or voided.")
        t = next(e for e in events if e["id"] == event_id)
        vid = new_id()
        conn.execute(
            """INSERT INTO lifecycle_events (id, requisition_id, stage, status, not_applicable_reason, occurred_at, recorded_by, record_type,
                   supersedes_id, correction_reason, edit_request_id) VALUES (%s,%s,%s,%s,%s,%s,%s,'void',%s,%s,%s)""",
            (vid, rid, t["stage"], t["status"], t["not_applicable_reason"], t["occurred_at"], actor.id, event_id, reason, er and er["id"]))
        audit(conn, actor.id, "lifecycle.voided", "lifecycle_event", vid, requisition_id=rid, old=_event_json(t), reason=reason, edit_request_id=er and er["id"])
        conn.execute("UPDATE requisitions SET updated_at=now() WHERE id=%s", (rid,))
        if er:
            _mark_used(conn, actor, rid, er)
        return _resp(conn, rid)


# ================================================================== fulfillment
def _build_record(conn: Connection, actor: Actor, r: dict, row: dict) -> dict:
    item = _item(conn, row.get("itemId"))
    if not item:
        raise UserError("Choose the item that was supplied.")
    stage = row.get("stage")
    if stage not in FULFILLMENT_STAGES:
        raise UserError("Unknown fulfillment stage.")
    q = _num(row.get("quantity"))
    if q is None or q < 0:
        raise UserError("Enter a quantity of 0 or more.")
    unit = (row.get("unit") or "").strip()
    if not unit:
        raise UserError("Enter the unit.")
    occurred = parse_ts(row.get("occurredAt"))
    if minute(occurred) > minute(now()):
        raise UserError("The date can't be in the future.")
    if minute(occurred) < minute(r["received_at"]):
        raise UserError("The date can't be earlier than when the requisition was received.")
    line_id = row.get("lineId") or None
    line = None
    if line_id:
        line = conn.execute("SELECT * FROM requisition_lines WHERE id=%s AND requisition_id=%s", (line_id, r["id"])).fetchone()
        if not line:
            raise UserError("That line no longer exists.")
    doc_id = row.get("documentId") or None
    if doc_id and not conn.execute("SELECT 1 FROM documents WHERE id=%s AND requisition_id=%s", (doc_id, r["id"])).fetchone():
        raise UserError("That document doesn't belong to this requisition.")
    c = convert_to_base(item, q, unit, _approved_conversions(conn))
    return {
        "id": new_id(), "requisition_line_id": line_id, "item_id": item["id"], "stage": stage, "quantity": q, "unit": normalize_unit(unit),
        "base_quantity": c["baseQuantity"], "base_unit": c["baseUnit"], "conversion_id": c["conversionId"], "conversion_status": c["status"],
        "substitution": bool(line) and line["item_id"] != item["id"], "additional": not line_id,
        "reference": (row.get("reference") or "").strip() or None, "document_id": doc_id, "occurred_at": occurred,
        "notes": (row.get("notes") or "").strip() or None,
    }


FR_COLUMNS = ["id", "requisition_line_id", "item_id", "stage", "quantity", "unit", "base_quantity", "base_unit", "conversion_id",
              "conversion_status", "substitution", "additional", "reference", "document_id", "occurred_at", "notes", "record_type",
              "supersedes_id", "correction_reason", "edit_request_id"]


def _insert_record(conn: Connection, actor: Actor, rid: str, rec: dict) -> dict:
    cols = FR_COLUMNS
    return conn.execute(
        f"INSERT INTO fulfillment_records (requisition_id, recorded_by, {', '.join(cols)}) VALUES (%s,%s,{','.join(['%s'] * len(cols))}) RETURNING *",
        (rid, actor.id, *[rec.get(c) for c in cols])).fetchone()


@router.post("/requisitions/{rid}/fulfillment")
def record_fulfillment(rid: str, body: dict, actor: Actor = Depends(require_actor)):
    actor.need("fulfillment.record")
    rows = body.get("rows") or []
    with tx() as conn:
        r = _lock(conn, rid)
        if r["record_status"] == "cancelled":
            raise UserError("This requisition is cancelled.")
        if not r["first_validated_at"]:
            raise UserError("Validate the requisition before recording fulfillment.")
        er = _post_close_gate(conn, actor, r)
        if not rows:
            raise UserError("Enter at least one quantity.")
        recs = [{**_build_record(conn, actor, r, row), "record_type": "entry", "edit_request_id": er and er["id"]} for row in rows]
        for rec in recs:
            saved = _insert_record(conn, actor, rid, rec)
            audit(conn, actor.id, "fulfillment.captured", "fulfillment_record", saved["id"], requisition_id=rid, new=jsonable(dict(saved)),
                  edit_request_id=er and er["id"])
        if r["fulfillment_status"] == "open":
            conn.execute("UPDATE requisitions SET fulfillment_status='partial' WHERE id=%s", (rid,))
            audit(conn, actor.id, "fulfillment_status.changed", "requisition", rid, requisition_id=rid, old="open", new="partial", system=True)
        else:
            conn.execute("UPDATE requisitions SET updated_at=now() WHERE id=%s", (rid,))
        if er:
            _mark_used(conn, actor, rid, er)
        return _resp(conn, rid)


@router.post("/requisitions/{rid}/fulfillment/close")
def close_fulfillment(rid: str, body: dict | None = None, actor: Actor = Depends(require_actor)):
    actor.need("fulfillment.close")
    reason = ((body or {}).get("reason") or "").strip() or None
    with tx() as conn:
        r = _lock(conn, rid)
        issues = []
        if r["record_status"] != "finalized":
            issues.append("Finalize the requisition before closing fulfillment.")
        if r["fulfillment_status"] == "closed":
            issues.append("Fulfillment is already closed.")
        completed = any(e["stage"] == "completed" and e["status"] == "completed" for e in effective(_rows(conn, "lifecycle_events", rid)))
        if not completed and not reason:
            issues.append("Record the Completed stage, or give a closure reason (for example “Not supplied: stock-out”).")
        if issues:
            raise UserError("\n".join(issues))
        conn.execute("UPDATE requisitions SET fulfillment_status='closed', fulfillment_closed_at=now(), fulfillment_closed_by=%s, fulfillment_closure_reason=%s WHERE id=%s",
                     (actor.id, reason, rid))
        audit(conn, actor.id, "fulfillment.closed", "requisition", rid, requisition_id=rid, old=r["fulfillment_status"], new="closed", reason=reason)
        return _resp(conn, rid)


@router.post("/requisitions/{rid}/fulfillment/reopen")
def reopen_fulfillment(rid: str, body: dict, actor: Actor = Depends(require_actor)):
    actor.need("fulfillment.reopen")
    reason = (body.get("reason") or "").strip()
    with tx() as conn:
        r = _lock(conn, rid)
        if r["fulfillment_status"] != "closed":
            raise UserError("Fulfillment isn't closed.")
        if not reason:
            raise UserError("Give a reason.")
        conn.execute("UPDATE requisitions SET fulfillment_status='partial', fulfillment_closed_at=NULL, fulfillment_closed_by=NULL, fulfillment_closure_reason=NULL WHERE id=%s", (rid,))
        audit(conn, actor.id, "fulfillment.reopened", "requisition", rid, requisition_id=rid, old="closed", new="partial", reason=reason)
        return _resp(conn, rid)


@router.post("/requisitions/{rid}/fulfillment/{record_id}/correct")
def correct_fulfillment(rid: str, record_id: str, body: dict, actor: Actor = Depends(require_actor)):
    actor.need("fulfillment.record")
    reason = (body.get("reason") or "").strip()
    row = body.get("row")
    with tx() as conn:
        r = _lock(conn, rid)
        er = _post_close_gate(conn, actor, r)
        if not reason:
            raise UserError("Give a reason.")
        recs = _rows(conn, "fulfillment_records", rid)
        if not can_supersede(recs, record_id):
            raise UserError("That record has already been corrected or voided.")
        t = next(x for x in recs if x["id"] == record_id)
        if row:
            if row.get("stage", t["stage"]) != t["stage"]:
                raise UserError("A correction must be for the same fulfillment stage.")
            rec = {**_build_record(conn, actor, r, {**row, "stage": t["stage"]}), "record_type": "correction", "supersedes_id": record_id,
                   "correction_reason": reason, "edit_request_id": er and er["id"]}
        else:
            rec = {c: t[c] for c in FR_COLUMNS}
            rec.update({"id": new_id(), "quantity": None, "base_quantity": None, "notes": None, "record_type": "void", "supersedes_id": record_id,
                        "correction_reason": reason, "edit_request_id": er and er["id"]})
        saved = _insert_record(conn, actor, rid, rec)
        audit(conn, actor.id, "fulfillment.corrected" if row else "fulfillment.voided", "fulfillment_record", saved["id"], requisition_id=rid,
              old=jsonable(dict(t)), new=jsonable(dict(saved)) if row else None, reason=reason, edit_request_id=er and er["id"])
        conn.execute("UPDATE requisitions SET updated_at=now() WHERE id=%s", (rid,))
        if er:
            _mark_used(conn, actor, rid, er)
        return _resp(conn, rid)


# ================================================================== edit requests
@router.post("/requisitions/{rid}/edit-requests")
def submit_edit_request(rid: str, body: dict, actor: Actor = Depends(require_actor)):
    actor.need("edit_request.submit")
    reason = (body.get("reason") or "").strip()
    changes = body.get("changes") or []
    with tx() as conn:
        r = _lock(conn, rid)
        if r["record_status"] != "finalized":
            raise UserError("Edit requests are for finalized requisitions.")
        if not reason:
            raise UserError("Give a reason.")
        if not changes or not isinstance(changes, list):
            raise UserError("List at least one change.")
        for c in changes:
            if c.get("entityType") not in ("header", "line", "page", "fulfillment", "lifecycle") or not c.get("field"):
                raise UserError("Each change needs what to change and which field.")
        timeout = float(_settings(conn)["editRequestPendingTimeoutDays"])
        mine = conn.execute("SELECT * FROM edit_requests WHERE requisition_id=%s AND requested_by=%s", (rid, actor.id)).fetchall()
        if any(_er_status(e, timeout) in ("pending", "approved") and e["used_at"] is None for e in mine):
            raise UserError("You already have an open edit request on this requisition.")
        er_id = new_id()
        conn.execute("INSERT INTO edit_requests (id, requisition_id, requested_by, reason, requested_changes) VALUES (%s,%s,%s,%s,%s)",
                     (er_id, rid, actor.id, reason, J(changes)))
        audit(conn, actor.id, "edit_request.submitted", "edit_request", er_id, requisition_id=rid, new={"reason": reason, "changes": changes},
              edit_request_id=er_id)
        return _resp(conn, rid, editRequestId=er_id)


def _get_er(conn: Connection, rid: str, er_id: str) -> dict:
    er = conn.execute("SELECT * FROM edit_requests WHERE id=%s AND requisition_id=%s FOR UPDATE", (er_id, rid)).fetchone()
    if not er:
        raise UserError("Edit request not found.", 404)
    return er


@router.post("/requisitions/{rid}/edit-requests/{er_id}/decide")
def decide_edit_request(rid: str, er_id: str, body: dict, actor: Actor = Depends(require_actor)):
    actor.need("edit_request.approve")
    decision = body.get("decision")
    rejection = (body.get("rejectionReason") or "").strip() or None
    if decision not in ("approved", "rejected"):
        raise UserError("Choose approve or reject.")
    with tx() as conn:
        _lock(conn, rid)
        er = _get_er(conn, rid, er_id)
        s = _settings(conn)
        if er["requested_by"] == actor.id:
            raise UserError("You can't approve or reject your own edit request.")
        if _er_status(er, float(s["editRequestPendingTimeoutDays"])) != "pending":
            raise UserError("This request has already been decided.")
        if decision == "rejected" and not rejection:
            raise UserError("Give a reason for rejecting.")
        if decision == "approved":
            conn.execute("UPDATE edit_requests SET status='approved', decision='approved', decided_by=%s, decided_at=now(), approval_expires_at=%s WHERE id=%s",
                         (actor.id, now() + dt.timedelta(hours=float(s["editWindowHours"])), er_id))
        else:
            conn.execute("""UPDATE edit_requests SET status='rejected', decision='rejected', decided_by=%s, decided_at=now(), rejection_reason=%s,
                            closed_at=now(), closure_reason='rejected' WHERE id=%s""", (actor.id, rejection, er_id))
        audit(conn, actor.id, f"edit_request.{decision}", "edit_request", er_id, requisition_id=rid, reason=rejection, edit_request_id=er_id)
        return _resp(conn, rid)


@router.post("/requisitions/{rid}/edit-requests/{er_id}/withdraw")
def withdraw_edit_request(rid: str, er_id: str, actor: Actor = Depends(require_actor)):
    with tx() as conn:
        _lock(conn, rid)
        er = _get_er(conn, rid, er_id)
        if er["requested_by"] != actor.id or er["status"] != "pending":
            raise UserError("Only your own pending request can be withdrawn.")
        conn.execute("UPDATE edit_requests SET status='withdrawn', closed_at=now(), closure_reason='withdrawn' WHERE id=%s", (er_id,))
        audit(conn, actor.id, "edit_request.withdrawn", "edit_request", er_id, requisition_id=rid, edit_request_id=er_id)
        return _resp(conn, rid)


@router.post("/requisitions/{rid}/edit-requests/{er_id}/apply")
def apply_edit_request(rid: str, er_id: str, body: dict, actor: Actor = Depends(require_actor)):
    values = {str(k): v for k, v in (body.get("values") or {}).items()}
    with tx() as conn:
        r = _lock(conn, rid)
        er = _get_er(conn, rid, er_id)
        s = _settings(conn)
        if er["requested_by"] != actor.id or _er_status(er, float(s["editRequestPendingTimeoutDays"])) != "approved" or er["used_at"]:
            raise UserError("This edit permission isn't active. It may have expired.")
        _enter_edit_context(conn, er)
        header: dict = {}
        lines: dict[str, dict] = {}
        pages: dict[str, Any] = {}
        for i, c in enumerate(er["requested_changes"]):
            v = values[str(i)] if str(i) in values else c.get("proposedValue")
            if c["entityType"] == "header" and c["field"] in HEADER_FIELDS:
                header[c["field"]] = v
            elif c["entityType"] == "line" and c.get("entityId") and c["field"] in LINE_FIELDS:
                lines.setdefault(c["entityId"], {})[c["field"]] = v
            elif c["entityType"] == "page" and c.get("entityId"):
                pages[str(c["entityId"])] = v
        if header:
            sets, params = [], []
            for k, v in header.items():
                if k == "receivedAt":
                    v = parse_ts(v)
                    if minute(v) > minute(now()) or v > r["entry_at"]:
                        raise UserError("Received at can't be later than when the requisition was entered.")
                elif k == "requisitionDate":
                    v = _date(v)
                elif k == "requisitionDateEstimated":
                    v = bool(v)
                else:
                    v = v or None
                sets.append(f"{HEADER_FIELDS[k]}=%s")
                params.append(v)
            conn.execute(f"UPDATE requisitions SET {', '.join(sets)} WHERE id=%s", (*params, rid))
        for lid, p in lines.items():
            cur = conn.execute("SELECT * FROM requisition_lines WHERE id=%s AND requisition_id=%s", (lid, rid)).fetchone()
            if not cur:
                continue
            vals = {LINE_FIELDS[k]: _line_value(k, v, conn) for k, v in p.items()}
            if "programme_id" in vals:
                vals["programme_overridden"] = True
            nxt = {**cur, **vals}
            vals.update(_apply_line_conversion(conn, nxt))
            conn.execute(f"UPDATE requisition_lines SET {', '.join(k + '=%s' for k in vals)}, updated_at=now() WHERE id=%s", (*vals.values(), lid))
        for pg, prog in pages.items():
            conn.execute("UPDATE document_pages SET programme_id=%s, updated_by=%s, updated_at=now() WHERE requisition_id=%s AND page_number=%s",
                         (prog or None, actor.id, rid, int(pg)))
        conn.execute("UPDATE requisitions SET updated_at=now() WHERE id=%s", (rid,))
        audit(conn, actor.id, "finalized_record.edited", "requisition", rid, requisition_id=rid, new={"header": header, "lines": lines, "pages": pages},
              edit_request_id=er_id, reason=er["reason"])
        _mark_used(conn, actor, rid, er)
        return _resp(conn, rid)


# ================================================================== audit
def _audit_json(a: dict) -> dict:
    return {"id": a["id"], "at": iso(a["created_at"]), "actor": a["actor_user_id"], "actorType": a["actor_type"], "eventType": a["event_type"],
            "entityType": a["entity_type"], "entityId": a["entity_id"], "requisitionId": a["requisition_id"], "oldValue": a["old_value"],
            "newValue": a["new_value"], "reason": a["reason"], "editRequestId": a["edit_request_id"]}


@router.get("/requisitions/{rid}/audit")
def requisition_audit(rid: str, actor: Actor = Depends(require_actor)):
    with tx() as conn:
        if not conn.execute("SELECT 1 FROM requisitions WHERE id=%s", (rid,)).fetchone():
            raise UserError("Requisition not found.", 404)
        rows = conn.execute("SELECT * FROM audit_events WHERE requisition_id=%s ORDER BY created_at DESC, id DESC", (rid,)).fetchall()
    return {"events": [_audit_json(a) for a in rows]}


@router.get("/audit")
def global_audit(limit: int = Query(100, ge=1, le=500), before: Optional[str] = None, requisitionId: Optional[str] = None,
                 eventType: Optional[str] = None, actor: Actor = Depends(require_actor)):
    actor.need("audit.global")
    where, params = [], []
    if before:
        ts, _, bid = before.partition("|")
        where.append("(created_at, id) < (%s, %s)")
        params += [parse_ts(ts), bid or "~"]
    if requisitionId:
        where.append("requisition_id = %s")
        params.append(requisitionId)
    if eventType:
        where.append("event_type = %s")
        params.append(eventType)
    sql = "SELECT * FROM audit_events" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY created_at DESC, id DESC LIMIT %s"
    with tx() as conn:
        rows = conn.execute(sql, (*params, limit + 1)).fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    nxt = f"{iso(rows[-1]['created_at'])}|{rows[-1]['id']}" if more and rows else None
    return {"events": [_audit_json(a) for a in rows], "next": nxt}

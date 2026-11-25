"""Serialize database rows into the JSON shapes of app/src/domain/types.ts, so
the existing React pages render V2 data unchanged."""
from __future__ import annotations

from typing import Any

from psycopg import Connection

from .common import iso, jsonable

DEFAULT_SETTINGS = {
    "ofrThresholdPercent": 80,
    "ofrThresholdStage": "issued",
    "editWindowHours": 24,
    "editRequestPendingTimeoutDays": 7,
    "defaultTimeBasis": "received",
}


def _d(v: Any) -> Any:
    return jsonable(v)


def _clean(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None}


def req_header(r: dict) -> dict:
    return _clean({
        "id": r["id"], "number": r["requisition_number"], "entryDate": _d(r["entry_date"]), "entrySerial": r["entry_serial"],
        "facilityId": r["facility_id"], "facilityExtractedText": r["facility_extracted_text"], "facilityCandidates": r["facility_candidates"] or [],
        "primaryProgrammeId": r["primary_programme_id"], "requisitionDate": _d(r["requisition_date"]),
        "requisitionDateEstimated": r["requisition_date_estimated"], "receivedAt": iso(r["received_at"]), "receivedVia": r["received_via"],
        "entryAt": iso(r["entry_at"]), "recordStatus": r["record_status"],
        "firstValidatedAt": iso(r["first_validated_at"]), "firstValidatedBy": r["first_validated_by"],
        "validatedAt": iso(r["validated_at"]), "validatedBy": r["validated_by"],
        "finalizedAt": iso(r["finalized_at"]), "finalizedBy": r["finalized_by"],
        "fulfillmentStatus": r["fulfillment_status"], "fulfillmentClosedAt": iso(r["fulfillment_closed_at"]),
        "fulfillmentClosedBy": r["fulfillment_closed_by"], "fulfillmentClosureReason": r["fulfillment_closure_reason"],
        "cancelledAt": iso(r["cancelled_at"]), "cancelledBy": r["cancelled_by"], "cancellationReason": r["cancellation_reason"],
        "reopenedAt": iso(r["reopened_at"]), "reopenedBy": r["reopened_by"], "reopenReason": r["reopen_reason"],
        "createdBy": r["created_by"], "createdAt": iso(r["created_at"]), "updatedAt": iso(r["updated_at"]),
    })


def doc_json(d: dict) -> dict:
    return _clean({
        "id": d["id"], "category": d["category"], "lifecycleEventId": d["lifecycle_event_id"], "documentType": d["document_type"],
        "fileName": d["file_name"], "mimeType": d["mime_type"], "assetId": d["id"], "sha256": d["sha256"], "fileSize": d["file_size"],
        "pageCount": d["page_count"], "firstPage": d["first_page"], "description": d["description"],
        "uploadedBy": d["uploaded_by"], "uploadedAt": iso(d["uploaded_at"]),
    })


def line_json(l: dict) -> dict:
    return _clean({
        "id": l["id"], "lineNumber": l["line_number"], "pageNumber": l["page_number"], "rawExtractedText": l["raw_extracted_text"],
        "itemExtractedText": l["item_extracted_text"], "correctedText": l["corrected_text"], "itemId": l["item_id"],
        "programmeId": l["programme_id"], "programmeOverridden": l["programme_overridden"] or None,
        "quantityRequested": _d(l["quantity_requested"]), "unitRequested": l["unit_requested"],
        "baseQuantityRequested": _d(l["base_quantity_requested"]), "baseUnit": l["base_unit"], "conversionId": l["conversion_id"],
        "conversionStatus": l["conversion_status"], "strength": l["strength"], "form": l["form"], "packSize": l["pack_size"],
        "candidates": l["candidates"] or [], "matchMethod": l["match_method"], "matchConfirmedBy": l["match_confirmed_by"],
        "matchConfirmedAt": iso(l["match_confirmed_at"]), "createdAt": iso(l["created_at"]), "updatedAt": iso(l["updated_at"]),
    })


def event_json(e: dict) -> dict:
    return _clean({
        "id": e["id"], "stage": e["stage"], "status": e["status"], "notApplicableReason": e["not_applicable_reason"],
        "occurredAt": iso(e["occurred_at"]), "recordedAt": iso(e["recorded_at"]), "recordedBy": e["recorded_by"], "notes": e["notes"],
        "chronologyOverride": e["chronology_override"] or None, "overrideReason": e["override_reason"], "recordType": e["record_type"],
        "supersedesId": e["supersedes_id"], "correctionReason": e["correction_reason"], "editRequestId": e["edit_request_id"],
    })


def fulfillment_json(f: dict) -> dict:
    out = _clean({
        "id": f["id"], "itemId": f["item_id"], "stage": f["stage"], "unit": f["unit"], "baseUnit": f["base_unit"],
        "conversionId": f["conversion_id"], "conversionStatus": f["conversion_status"], "substitution": f["substitution"],
        "additional": f["additional"], "reference": f["reference"], "documentId": f["document_id"],
        "occurredAt": iso(f["occurred_at"]), "recordedAt": iso(f["recorded_at"]), "recordedBy": f["recorded_by"], "notes": f["notes"],
        "recordType": f["record_type"], "supersedesId": f["supersedes_id"], "correctionReason": f["correction_reason"],
        "editRequestId": f["edit_request_id"],
    })
    out["requisitionLineId"] = f["requisition_line_id"]
    out["quantity"] = _d(f["quantity"])
    out["baseQuantity"] = _d(f["base_quantity"])
    return out


def edit_request_json(e: dict) -> dict:
    return _clean({
        "id": e["id"], "requestedBy": e["requested_by"], "requestedAt": iso(e["requested_at"]), "reason": e["reason"],
        "changes": e["requested_changes"], "status": e["status"], "decidedBy": e["decided_by"], "decidedAt": iso(e["decided_at"]),
        "decision": e["decision"], "rejectionReason": e["rejection_reason"], "approvalExpiresAt": iso(e["approval_expires_at"]),
        "usedAt": iso(e["used_at"]), "closedAt": iso(e["closed_at"]), "closureReason": e["closure_reason"],
    })


def job_json(j: dict | None) -> dict | None:
    if not j:
        return None
    return _clean({
        "status": j["status"], "attempt": j["attempt"], "model": j["model_name"], "queuedAt": iso(j["queued_at"]),
        "startedAt": iso(j["started_at"]), "completedAt": iso(j["completed_at"]), "raw": j["raw_output"], "error": j["error"],
        "by": j["created_by"], "costUsd": _d(j["cost_usd"]),
    })


def load_requisitions(conn: Connection, ids: list[str] | None = None) -> dict[str, dict]:
    where, params = ("WHERE id = ANY(%s)", (ids,)) if ids is not None else ("", None)
    reqs = {r["id"]: {**req_header(r), "documents": {}, "pages": {}, "lines": {}, "events": {}, "fulfillment": {}, "editRequests": {}}
            for r in conn.execute(f"SELECT * FROM requisitions {where}", params).fetchall()}
    if not reqs:
        return {}
    key = list(reqs)
    q = lambda table, order="": conn.execute(f"SELECT * FROM {table} WHERE requisition_id = ANY(%s) {order}", (key,)).fetchall()  # noqa: E731
    for d in q("documents"):
        reqs[d["requisition_id"]]["documents"][d["id"]] = doc_json(d)
    for p in q("document_pages"):
        reqs[p["requisition_id"]]["pages"][str(p["page_number"])] = _clean({"programmeId": p["programme_id"]})
    for l in q("requisition_lines"):
        reqs[l["requisition_id"]]["lines"][l["id"]] = line_json(l)
    for e in q("lifecycle_events"):
        reqs[e["requisition_id"]]["events"][e["id"]] = event_json(e)
    for f in q("fulfillment_records"):
        reqs[f["requisition_id"]]["fulfillment"][f["id"]] = fulfillment_json(f)
    for e in q("edit_requests"):
        reqs[e["requisition_id"]]["editRequests"][e["id"]] = edit_request_json(e)
    for j in q("processing_jobs", "ORDER BY attempt"):
        reqs[j["requisition_id"]]["extraction"] = job_json(j)
    return reqs


def load_requisition(conn: Connection, rid: str) -> dict | None:
    return load_requisitions(conn, [rid]).get(rid)


def load_settings(conn: Connection) -> dict:
    s = dict(DEFAULT_SETTINGS)
    row = conn.execute("SELECT value FROM settings WHERE key='app'").fetchone()
    if row:
        s.update(row["value"])
    return s


def load_master(conn: Connection) -> dict:
    md: dict[str, Any] = {}
    md["facilities"] = {r["id"]: _clean({"id": r["id"], "name": r["name"], "lga": r["lga"], "location": r["location"], "status": r["status"],
                                         "createdAt": iso(r["created_at"]), "updatedAt": iso(r["updated_at"])})
                        for r in conn.execute("SELECT * FROM facilities").fetchall()}
    md["items"] = {r["id"]: _clean({"id": r["id"], "code": r["code"], "name": r["name"], "genericName": r["generic_name"], "strength": r["strength"],
                                    "form": r["form"], "packSize": r["pack_size"], "baseUnit": r["base_unit"], "status": r["status"],
                                    "createdAt": iso(r["created_at"]), "updatedAt": iso(r["updated_at"])})
                   for r in conn.execute("SELECT * FROM items").fetchall()}
    md["programmes"] = {r["id"]: _clean(dict(r)) for r in conn.execute("SELECT * FROM programmes").fetchall()}
    md["aliases"] = {r["id"]: alias_json(r) for r in conn.execute("SELECT * FROM aliases WHERE status <> 'candidate'").fetchall()}
    md["conversions"] = {r["id"]: conversion_json(r) for r in conn.execute("SELECT * FROM unit_conversions WHERE status <> 'proposed'").fetchall()}
    md["equivalences"] = {r["id"]: equivalence_json(r) for r in conn.execute("SELECT * FROM substitution_equivalences WHERE status <> 'proposed'").fetchall()}
    md["settings"] = load_settings(conn)
    return md


def alias_json(r: dict) -> dict:
    return _clean({"id": r["id"], "entityType": r["entity_type"], "entityId": r["entity_id"], "alias": r["alias"], "normalized": r["normalized"],
                   "occurrences": r["occurrences"], "status": r["status"], "decidedBy": r["decided_by"], "decidedAt": iso(r["decided_at"]),
                   "createdAt": iso(r["created_at"])})


def conversion_json(r: dict) -> dict:
    return _clean({"id": r["id"], "itemId": r["item_id"], "fromUnit": r["from_unit"], "toUnit": r["to_unit"], "factor": _d(r["factor"]),
                   "incompatible": r["incompatible"] or None, "status": r["status"], "proposedBy": r["proposed_by"], "proposedAt": iso(r["proposed_at"]),
                   "approvedBy": r["approved_by"], "approvedAt": iso(r["approved_at"]), "retiredBy": r["retired_by"], "retiredAt": iso(r["retired_at"]),
                   "notes": r["notes"]}) | {"itemId": r["item_id"]}


def equivalence_json(r: dict) -> dict:
    return _clean({"id": r["id"], "requestedItemId": r["requested_item_id"], "substituteItemId": r["substitute_item_id"], "factor": _d(r["factor"]),
                   "basis": list(r["basis"]), "justification": r["justification"], "status": r["status"], "proposedBy": r["proposed_by"],
                   "proposedAt": iso(r["proposed_at"]), "approvedBy": r["approved_by"], "approvedAt": iso(r["approved_at"]),
                   "retiredBy": r["retired_by"], "retiredAt": iso(r["retired_at"])})


def load_proposals(conn: Connection) -> dict:
    out: dict[str, dict] = {}
    for r in conn.execute("SELECT * FROM aliases WHERE status = 'candidate'").fetchall():
        out[r["id"]] = {"kind": "alias", **alias_json(r)}
    for r in conn.execute("SELECT * FROM unit_conversions WHERE status = 'proposed'").fetchall():
        out["cv-" + r["id"]] = {"kind": "conversion", **conversion_json(r)}
    for r in conn.execute("SELECT * FROM substitution_equivalences WHERE status = 'proposed'").fetchall():
        out["eq-" + r["id"]] = {"kind": "equivalence", **equivalence_json(r)}
    return out


def load_roles(conn: Connection) -> dict:
    """V1 shape: userId -> {role, grants, updatedBy, updatedAt}; plus a users list for V2 admin."""
    roles: dict[str, dict] = {}
    grants: dict[str, list[str]] = {}
    for g in conn.execute("SELECT user_id, permission FROM permission_grants WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())").fetchall():
        grants.setdefault(g["user_id"], []).append(g["permission"])
    for u in conn.execute("SELECT * FROM users WHERE role IS NOT NULL").fetchall():
        roles[u["id"]] = {"role": u["role"], "grants": grants.get(u["id"], []), "updatedBy": "", "updatedAt": iso(u["updated_at"])}
    return roles


def load_users(conn: Connection) -> list[dict]:
    return [_clean({"id": u["id"], "email": u["email"], "name": u["full_name"], "status": u["status"], "role": u["role"],
                    "createdAt": iso(u["created_at"])}) for u in conn.execute("SELECT * FROM users ORDER BY created_at").fetchall()]

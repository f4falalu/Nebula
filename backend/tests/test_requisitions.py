"""Requisition workflow API tests (task #2)."""
import base64
import datetime as dt
import json
import time

import psycopg
import pytest

from tests.conftest import TEST_DB, as_user

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
U = dt.timezone.utc


def iso(t):
    return t.astimezone(U).isoformat().replace("+00:00", "Z")


@pytest.fixture(scope="module")
def md(client):
    with psycopg.connect(TEST_DB, autocommit=True) as c:
        c.execute("INSERT INTO users (id, email, status, role) VALUES ('rqseed','rqseed@x','active','admin') ON CONFLICT DO NOTHING")
        c.execute("INSERT INTO facilities (id, name) VALUES ('rqf1','RQ Government House Clinic') ON CONFLICT DO NOTHING")
        c.execute("INSERT INTO programmes (id, name) VALUES ('rqp1','RQ-DRF'), ('rqp2','RQ-MNCH') ON CONFLICT DO NOTHING")
        c.execute("""INSERT INTO items (id, code, name, strength, form, base_unit) VALUES
                     ('rqamox500','RQ-AMX500','RQ Amoxicillin','500mg','capsule','capsule'),
                     ('rqamox250','RQ-AMX250','RQ Amoxicillin','250mg','capsule','capsule'),
                     ('rqpcm','RQ-PCM500','RQ Paracetamol','500mg','tablet','tablet') ON CONFLICT DO NOTHING""")
        c.execute("""INSERT INTO unit_conversions (id, item_id, from_unit, to_unit, factor, status, proposed_by)
                     VALUES ('rqc1','rqpcm','carton','tablet',100,'approved','rqseed') ON CONFLICT DO NOTHING""")
    return True


def create(u, read="false", received=None, files=None):
    received = received or dt.datetime.now(U) - dt.timedelta(hours=2)
    r = u.post("/api/requisitions", data={"receivedAt": iso(received), "receivedVia": "WhatsApp", "read": read},
               files=files or [("files", ("req.png", PNG, "image/png"))])
    assert r.status_code == 200, r.text
    return r.json()


def ready_req(u, qty=100, item="rqamox500", unit="capsule"):
    """A requisition with one valid line, header filled."""
    body = create(u)
    rid = body["id"]
    rd = (dt.datetime.now(U) - dt.timedelta(days=3)).date().isoformat()
    assert u.patch(f"/api/requisitions/{rid}/header", json={"facilityId": "rqf1", "requisitionDate": rd}).status_code == 200
    r = u.post(f"/api/requisitions/{rid}/lines", json={"lineId": None, "patch": {"pageNumber": 1, "itemId": item, "programmeId": "rqp1",
                                                                                  "quantityRequested": qty, "unitRequested": unit}})
    assert r.status_code == 200, r.text
    return rid, r.json()["lineId"]


def finalized(u, **kw):
    rid, lid = ready_req(u, **kw)
    assert u.post(f"/api/requisitions/{rid}/validate").status_code == 200
    assert u.post(f"/api/requisitions/{rid}/finalize").status_code == 200
    return rid, lid


def event(u, rid, stage, status="completed", when=None, **extra):
    data = {"stage": stage, "status": status, "occurredAt": iso(when or dt.datetime.now(U)), **extra}
    return u.post(f"/api/requisitions/{rid}/events", data={"data": json.dumps(data)})


def all_stages(u, rid):
    assert event(u, rid, "finance", "not_applicable", notApplicableReason="Free programme").status_code == 200
    for s in ["invoicing", "pick_and_pack", "dispatched", "completed"]:
        r = event(u, rid, s)
        assert r.status_code == 200, r.text


def audit_types(u, rid):
    return [e["eventType"] for e in u.get(f"/api/requisitions/{rid}/audit").json()["events"]]


def test_create_assigns_number_and_document(md, ra):
    body = create(ra)
    req = body["requisition"]
    assert req["number"].startswith("REQ-") and req["number"].endswith("_" + str(req["entrySerial"]).zfill(3))
    assert req["recordStatus"] == "validation_pending"
    doc = next(iter(req["documents"].values()))
    assert doc["category"] == "original_requisition" and len(doc["sha256"]) == 64 and doc["pageCount"] == 1
    assert req["pages"] == {"1": {}}
    second = create(ra)["requisition"]
    assert second["entrySerial"] == req["entrySerial"] + 1
    assert "requisition.created" in audit_types(ra, body["id"])


def test_create_rejects_bad_input(md, ra):
    r = ra.post("/api/requisitions", data={"receivedAt": iso(dt.datetime.now(U)), "read": "false"}, files=[("files", ("x.txt", b"hi", "text/plain"))])
    assert r.status_code == 400 and "JPEG" in r.json()["detail"]
    future = dt.datetime.now(U) + dt.timedelta(hours=2)
    r = ra.post("/api/requisitions", data={"receivedAt": iso(future), "read": "false"}, files=[("files", ("a.png", PNG, "image/png"))])
    assert r.status_code == 400 and "future" in r.json()["detail"]


def test_read_queues_job(md, ra):
    req = create(ra, read="true")["requisition"]
    assert req["recordStatus"] == "processing"
    assert req["extraction"]["status"] == "queued"


def test_happy_path(md, ra):
    rid, lid = ready_req(ra, qty=2, item="rqpcm", unit="ctns")
    req = ra.get("/api/state").json()["reqs"][rid]
    line = req["lines"][lid]
    assert line["conversionStatus"] == "resolved" and line["baseQuantityRequested"] == 200 and line["baseUnit"] == "tablet"
    assert line["programmeId"] == "rqp1"
    r = ra.post(f"/api/requisitions/{rid}/validate")
    assert r.json()["requisition"]["recordStatus"] == "validated"
    first = r.json()["requisition"]["firstValidatedAt"]
    r = ra.post(f"/api/requisitions/{rid}/finalize")
    assert r.json()["requisition"]["recordStatus"] == "finalized"
    all_stages(ra, rid)
    now = iso(dt.datetime.now(U))
    r = ra.post(f"/api/requisitions/{rid}/fulfillment", json={"rows": [{"lineId": lid, "itemId": "rqpcm", "stage": "issued", "quantity": 140, "unit": "tabs", "occurredAt": now, "reference": "PS-1"}]})
    assert r.status_code == 200, r.text
    req = r.json()["requisition"]
    assert req["fulfillmentStatus"] == "partial"
    rec = next(iter(req["fulfillment"].values()))
    assert rec["baseQuantity"] == 140 and rec["unit"] == "tablet" and rec["substitution"] is False and rec["additional"] is False
    r = ra.post(f"/api/requisitions/{rid}/fulfillment/{rec['id']}/correct", json={"row": {"lineId": lid, "itemId": "rqpcm", "quantity": 150, "unit": "tablet", "occurredAt": now}, "reason": "Pick slip re-checked"})
    assert r.status_code == 200, r.text
    recs = r.json()["requisition"]["fulfillment"]
    corr = next(x for x in recs.values() if x["recordType"] == "correction")
    assert corr["supersedesId"] == rec["id"] and corr["baseQuantity"] == 150
    r = ra.post(f"/api/requisitions/{rid}/fulfillment/{rec['id']}/correct", json={"row": None, "reason": "again"})
    assert r.status_code == 400 and "already" in r.json()["detail"]
    r = ra.post(f"/api/requisitions/{rid}/fulfillment/close", json={})
    assert r.status_code == 200, r.text
    req = r.json()["requisition"]
    assert req["fulfillmentStatus"] == "closed" and req["firstValidatedAt"] == first
    types = audit_types(ra, rid)
    for t in ["requisition.validated", "requisition.finalized", "lifecycle.recorded", "fulfillment.captured", "fulfillment.corrected",
              "fulfillment.closed", "fulfillment_status.changed", "line.added", "header.changed"]:
        assert t in types, t


def test_validation_issues_listed(md, ra):
    rid = create(ra)["id"]
    r = ra.post(f"/api/requisitions/{rid}/validate")
    assert r.status_code == 400
    assert "Match the facility" in r.json()["detail"] and "Add at least one requisition line" in r.json()["detail"]


def test_edit_after_validation_returns_to_pending(md, ra):
    rid, lid = ready_req(ra)
    ra.post(f"/api/requisitions/{rid}/validate")
    r = ra.post(f"/api/requisitions/{rid}/lines", json={"lineId": lid, "patch": {"quantityRequested": 50}})
    assert r.json()["requisition"]["recordStatus"] == "validation_pending"


def test_finalized_lock_and_edit_request(md, ra, ra2, admin):
    rid, lid = finalized(ra)
    r = ra.patch(f"/api/requisitions/{rid}/header", json={"requisitionDateEstimated": True})
    assert r.status_code == 400 and "finalized" in r.json()["detail"]
    r = ra.post(f"/api/requisitions/{rid}/edit-requests", json={"reason": "Wrong quantity", "changes": [
        {"entityType": "line", "entityId": lid, "field": "quantityRequested", "currentValue": 100, "proposedValue": 80}]})
    assert r.status_code == 200, r.text
    er_id = r.json()["editRequestId"]
    r = ra.post(f"/api/requisitions/{rid}/edit-requests", json={"reason": "x", "changes": [{"entityType": "header", "field": "facilityId"}]})
    assert r.status_code == 400 and "already" in r.json()["detail"]
    # RA can't approve at all; admin can't approve own (admins don't submit), another approver must.
    assert ra2.post(f"/api/requisitions/{rid}/edit-requests/{er_id}/decide", json={"decision": "approved"}).status_code == 403
    r = admin.post(f"/api/requisitions/{rid}/edit-requests/{er_id}/decide", json={"decision": "approved"})
    assert r.status_code == 200, r.text
    # Only the approved field: header still refused.
    assert ra.patch(f"/api/requisitions/{rid}/header", json={"requisitionDateEstimated": True}).status_code == 400
    r = ra.post(f"/api/requisitions/{rid}/edit-requests/{er_id}/apply", json={"values": {}})
    assert r.status_code == 200, r.text
    req = r.json()["requisition"]
    assert req["lines"][lid]["quantityRequested"] == 80 and req["lines"][lid]["baseQuantityRequested"] == 80
    assert req["editRequests"][er_id]["status"] == "used" and req["recordStatus"] == "finalized"
    r = ra.post(f"/api/requisitions/{rid}/lines", json={"lineId": lid, "patch": {"quantityRequested": 70}})
    assert r.status_code == 400
    types = audit_types(ra, rid)
    assert "edit_request.approved" in types and "edit_request.used" in types and "finalized_record.edited" in types


def test_line_edit_under_edit_request(md, ra, admin):
    rid, lid = finalized(ra)
    er_id = ra.post(f"/api/requisitions/{rid}/edit-requests", json={"reason": "fix", "changes": [
        {"entityType": "line", "entityId": lid, "field": "quantityRequested", "proposedValue": 90}]}).json()["editRequestId"]
    admin.post(f"/api/requisitions/{rid}/edit-requests/{er_id}/decide", json={"decision": "approved"})
    r = ra.post(f"/api/requisitions/{rid}/lines", json={"lineId": lid, "patch": {"quantityRequested": 95}})
    assert r.status_code == 200, r.text
    assert r.json()["requisition"]["editRequests"][er_id]["status"] == "used"
    assert ra.post(f"/api/requisitions/{rid}/lines", json={"lineId": lid, "patch": {"quantityRequested": 96}}).status_code == 400


def test_self_approval_refused(md, client, admin):
    sup = as_user(client, "approver@example.org", "supervisor", grants=["edit_request.approve"])
    ra3 = as_user(client, "ra3@example.org", "ra")
    rid, lid = finalized(ra3)
    er_id = ra3.post(f"/api/requisitions/{rid}/edit-requests", json={"reason": "x", "changes": [{"entityType": "header", "field": "facilityId", "proposedValue": "rqf1"}]}).json()["editRequestId"]
    with psycopg.connect(TEST_DB, autocommit=True) as c:
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute("UPDATE edit_requests SET decided_by=requested_by WHERE id=%s", (er_id,))
    r = sup.post(f"/api/requisitions/{rid}/edit-requests/{er_id}/decide", json={"decision": "rejected"})
    assert r.status_code == 400 and "reason" in r.json()["detail"]
    r = sup.post(f"/api/requisitions/{rid}/edit-requests/{er_id}/decide", json={"decision": "rejected", "rejectionReason": "No evidence"})
    assert r.status_code == 200
    assert r.json()["requisition"]["editRequests"][er_id]["status"] == "rejected"


def test_own_request_cannot_be_decided(md, client):
    # A supervisor with the approve grant can't decide a request they submitted; submit directly in SQL to simulate.
    sup = as_user(client, "approver2@example.org", "supervisor", grants=["edit_request.approve"])
    ra3 = as_user(client, "ra4@example.org", "ra")
    rid, _ = finalized(ra3)
    me = sup.get("/api/me").json()["id"]
    with psycopg.connect(TEST_DB, autocommit=True) as c:
        c.execute("INSERT INTO edit_requests (id, requisition_id, requested_by, reason, requested_changes) VALUES ('selfer',%s,%s,'x','[{\"entityType\":\"header\",\"field\":\"facilityId\"}]')", (rid, me))
    r = sup.post(f"/api/requisitions/{rid}/edit-requests/selfer/decide", json={"decision": "approved"})
    assert r.status_code == 400 and "own" in r.json()["detail"]


def test_supervisor_cannot_mutate(md, ra, supervisor):
    rid, lid = ready_req(ra)
    assert supervisor.post(f"/api/requisitions/{rid}/validate").status_code == 403
    assert supervisor.patch(f"/api/requisitions/{rid}/header", json={"facilityId": "rqf1"}).status_code == 403
    assert supervisor.post("/api/requisitions", data={"receivedAt": iso(dt.datetime.now(U)), "read": "false"}, files=[("files", ("a.png", PNG, "image/png"))]).status_code == 403
    assert supervisor.get(f"/api/documents/{next(iter(ra.get('/api/state').json()['reqs'][rid]['documents']))}/url?download=1").status_code == 403
    assert supervisor.get(f"/api/requisitions/{rid}/audit").status_code == 200


def test_chronology(md, ra, admin):
    rid, lid = finalized(ra)
    r = event(ra, rid, "invoicing")
    assert r.status_code == 400 and "Finance first" in r.json()["detail"]
    r = event(ra, rid, "finance", when=dt.datetime.now(U) + dt.timedelta(days=1))
    assert "future" in r.json()["detail"]
    early = dt.datetime.now(U) - dt.timedelta(days=1)
    r = event(ra, rid, "finance", when=early)
    assert r.status_code == 400 and "earlier" in r.json()["detail"]
    r = event(ra, rid, "finance", when=early, override=True, overrideReason="Backfill")
    assert r.status_code == 403  # RA can't override
    r = event(admin, rid, "finance", when=early, override=True, overrideReason="Registered late")
    assert r.status_code == 200, r.text
    r = event(ra, rid, "invoicing", when=early - dt.timedelta(hours=1))
    assert r.status_code == 400 and "earlier than Finance" in r.json()["detail"]
    r = event(ra, rid, "finance", "not_applicable")
    assert r.status_code == 400


def test_event_correction_void_and_evidence(md, ra):
    rid, lid = finalized(ra)
    data = {"stage": "finance", "status": "completed", "occurredAt": iso(dt.datetime.now(U))}
    r = ra.post(f"/api/requisitions/{rid}/events", data={"data": json.dumps({**data, "documentType": "payment_confirmation"})},
                files=[("files", ("pay.png", PNG, "image/png")), ("files", ("pay2.png", PNG, "image/png"))])
    assert r.status_code == 200, r.text
    eid = r.json()["eventId"]
    docs = [d for d in r.json()["requisition"]["documents"].values() if d.get("lifecycleEventId") == eid]
    assert len(docs) == 2 and docs[0]["category"] == "lifecycle_evidence"
    r = ra.post(f"/api/requisitions/{rid}/events", data={"data": json.dumps({**data, "supersedesId": eid})})
    assert r.status_code == 400 and "reason" in r.json()["detail"]
    r = ra.post(f"/api/requisitions/{rid}/events", data={"data": json.dumps({**data, "supersedesId": eid, "correctionReason": "Wrong time"})})
    assert r.status_code == 200
    r = ra.post(f"/api/requisitions/{rid}/events/{eid}/void", json={"reason": "dup"})
    assert r.status_code == 400 and "already" in r.json()["detail"]
    corr = r and next(e for e in ra.get("/api/state").json()["reqs"][rid]["events"].values() if e["recordType"] == "correction")
    assert ra.post(f"/api/requisitions/{rid}/events/{corr['id']}/void", json={"reason": "Entered on wrong requisition"}).status_code == 200
    assert event(ra, rid, "invoicing").status_code == 400  # finance no longer effective


def test_substitution_and_additional(md, ra):
    rid, lid = finalized(ra)
    now = iso(dt.datetime.now(U))
    r = ra.post(f"/api/requisitions/{rid}/fulfillment", json={"rows": [
        {"lineId": lid, "itemId": "rqamox250", "stage": "issued", "quantity": 40, "unit": "caps", "occurredAt": now},
        {"lineId": None, "itemId": "rqpcm", "stage": "issued", "quantity": 3, "unit": "tin", "occurredAt": now}]})
    assert r.status_code == 200, r.text
    recs = list(r.json()["requisition"]["fulfillment"].values())
    sub = next(x for x in recs if x["itemId"] == "rqamox250")
    add = next(x for x in recs if x["itemId"] == "rqpcm")
    assert sub["substitution"] is True and sub["additional"] is False
    assert add["additional"] is True and add["requisitionLineId"] is None and add["conversionStatus"] == "unknown" and add["baseQuantity"] is None
    with psycopg.connect(TEST_DB, autocommit=True) as c:
        with pytest.raises(psycopg.errors.RaiseException):
            c.execute("UPDATE fulfillment_records SET quantity=1 WHERE id=%s", (sub["id"],))
    r = ra.post(f"/api/requisitions/{rid}/fulfillment", json={"rows": [{"lineId": lid, "itemId": "rqamox500", "stage": "issued", "quantity": -1, "unit": "capsule", "occurredAt": now}]})
    assert r.status_code == 400
    assert ra.delete(f"/api/requisitions/{rid}/lines/{lid}").status_code == 400


def test_post_close_gate_and_reopen_fulfillment(md, ra, admin):
    rid, lid = finalized(ra)
    r = ra.post(f"/api/requisitions/{rid}/fulfillment/close", json={})
    assert r.status_code == 400 and "Completed" in r.json()["detail"]
    assert ra.post(f"/api/requisitions/{rid}/fulfillment/close", json={"reason": "Not supplied: stock-out"}).status_code == 200
    now = iso(dt.datetime.now(U))
    row = {"lineId": lid, "itemId": "rqamox500", "stage": "issued", "quantity": 1, "unit": "capsule", "occurredAt": now}
    r = ra.post(f"/api/requisitions/{rid}/fulfillment", json={"rows": [row]})
    assert r.status_code == 400 and "edit request" in r.json()["detail"]
    r = admin.post(f"/api/requisitions/{rid}/fulfillment", json={"rows": [row]})
    assert "Reopen fulfillment first" in r.json()["detail"]
    er_id = ra.post(f"/api/requisitions/{rid}/edit-requests", json={"reason": "Late pick slip", "changes": [{"entityType": "fulfillment", "field": "*"}]}).json()["editRequestId"]
    admin.post(f"/api/requisitions/{rid}/edit-requests/{er_id}/decide", json={"decision": "approved"})
    r = ra.post(f"/api/requisitions/{rid}/fulfillment", json={"rows": [row]})
    assert r.status_code == 200, r.text
    assert r.json()["requisition"]["editRequests"][er_id]["status"] == "used"
    assert ra.post(f"/api/requisitions/{rid}/fulfillment", json={"rows": [row]}).status_code == 400
    assert ra.post(f"/api/requisitions/{rid}/fulfillment/reopen", json={"reason": "x"}).status_code == 403
    r = admin.post(f"/api/requisitions/{rid}/fulfillment/reopen", json={"reason": "More deliveries"})
    assert r.json()["requisition"]["fulfillmentStatus"] == "partial"


def test_reopen_and_cancel(md, ra, admin):
    rid, lid = finalized(ra)
    assert ra.post(f"/api/requisitions/{rid}/reopen", json={"reason": "x"}).status_code == 403
    r = admin.post(f"/api/requisitions/{rid}/reopen", json={"reason": "Wrong facility"})
    req = r.json()["requisition"]
    assert req["recordStatus"] == "reopened" and req["reopenReason"] == "Wrong facility"
    r = ra.post(f"/api/requisitions/{rid}/lines", json={"lineId": lid, "patch": {"quantityRequested": 10}})
    assert r.status_code == 200 and r.json()["requisition"]["recordStatus"] == "reopened"
    assert ra.post(f"/api/requisitions/{rid}/validate").status_code == 200
    assert ra.post(f"/api/requisitions/{rid}/finalize").status_code == 200
    assert ra.post(f"/api/requisitions/{rid}/cancel", json={"reason": "dup"}).status_code == 403  # finalized: admin only
    rid2 = create(ra)["id"]
    assert ra.post(f"/api/requisitions/{rid2}/cancel", json={}).status_code == 400
    r = ra.post(f"/api/requisitions/{rid2}/cancel", json={"reason": "Duplicate upload"})
    assert r.json()["requisition"]["recordStatus"] == "cancelled"
    assert ra.post(f"/api/requisitions/{rid2}/lines", json={"lineId": None, "patch": {}}).status_code in (400, 409)
    r = admin.post(f"/api/requisitions/{rid}/cancel", json={"reason": "Facility withdrew the request"})
    assert r.status_code == 200


def test_pages_and_programme_defaults(md, ra):
    files = [("files", ("p1.png", PNG, "image/png")), ("files", ("p2.png", PNG, "image/png"))]
    body = create(ra, files=files)
    rid = body["id"]
    assert set(body["requisition"]["pages"]) == {"1", "2"}
    r = ra.post(f"/api/requisitions/{rid}/pages", json={"page": 2, "programmeId": "rqp2"})
    assert r.status_code == 200
    r = ra.post(f"/api/requisitions/{rid}/lines", json={"lineId": None, "patch": {"pageNumber": 2, "itemId": "rqamox500"}})
    lid = r.json()["lineId"]
    assert r.json()["requisition"]["lines"][lid]["programmeId"] == "rqp2"
    ra.post(f"/api/requisitions/{rid}/lines", json={"lineId": lid, "patch": {"programmeId": "rqp1", "programmeOverridden": True}})
    r = ra.post(f"/api/requisitions/{rid}/pages", json={"page": "all", "programmeId": "rqp2"})
    req = r.json()["requisition"]
    assert req["pages"]["1"]["programmeId"] == "rqp2" and req["lines"][lid]["programmeId"] == "rqp1"


def test_alias_candidate_recorded(md, ra):
    rid = create(ra)["id"]
    with psycopg.connect(TEST_DB, autocommit=True) as c:
        c.execute("UPDATE requisitions SET facility_extracted_text='RQ Govt House Clinic Abj' WHERE id=%s", (rid,))
    ra.patch(f"/api/requisitions/{rid}/header", json={"facilityId": "rqf1"})
    with psycopg.connect(TEST_DB) as c:
        row = c.execute("SELECT status, occurrences FROM aliases WHERE entity_type='facility' AND normalized='rq govt house clinic abj'").fetchone()
    assert row and row[0] == "candidate"


def test_signed_urls(md, ra, client, supervisor):
    rid = create(ra)["id"]
    doc_id = next(iter(ra.get("/api/state").json()["reqs"][rid]["documents"]))
    url = supervisor.get(f"/api/documents/{doc_id}/url").json()["url"]
    r = client.get(url)
    assert r.status_code == 200 and r.content == PNG and r.headers["content-type"] == "image/png"
    assert client.get(url.replace("&s=", "&s=0")).status_code == 403
    dl = ra.get(f"/api/documents/{doc_id}/url?download=1").json()["url"]
    r = client.get(dl)
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    assert "document.downloaded" in audit_types(ra, rid)
    from app.core import storage
    expired = storage.sign(doc_id, "x", ttl=-5)
    assert client.get(expired).status_code == 403


def test_global_audit(md, ra, admin, supervisor):
    assert ra.get("/api/audit").status_code == 403
    r = supervisor.get("/api/audit?limit=5")
    assert r.status_code == 200 and len(r.json()["events"]) == 5 and r.json()["next"]
    r2 = supervisor.get(f"/api/audit?limit=5&before={r.json()['next']}")
    ids1 = {e["id"] for e in r.json()["events"]}
    assert not ids1 & {e["id"] for e in r2.json()["events"]}

import psycopg
import pytest

from tests.conftest import TEST_DB, as_user


def _id(u):
    return u.get("/api/me").json()["id"]


def test_master_data_upserts_and_permissions(client, admin, ra):
    r = admin.post("/api/facilities", json={"name": "Government House Clinic", "lga": "Kano Municipal"})
    assert r.status_code == 200, r.text
    fid = r.json()["id"]
    assert admin.post("/api/facilities", json={"id": fid, "name": "Government House Clinic", "lga": "Nassarawa"}).json()["id"] == fid
    assert admin.post("/api/facilities", json={"name": " "}).status_code == 400

    r = admin.post("/api/items", json={"code": "AMX500", "name": "Amoxicillin", "strength": "500mg", "form": "capsule", "baseUnit": "Caps"})
    assert r.status_code == 200
    md = admin.get("/api/state").json()["md"]
    assert md["items"][r.json()["id"]]["baseUnit"] == "capsule"
    dup = admin.post("/api/items", json={"code": "amx500", "name": "Other", "baseUnit": "tablet"})
    assert dup.status_code == 400 and "already used" in dup.json()["detail"]

    assert admin.post("/api/programmes", json={"name": "DRF"}).status_code == 200
    assert admin.post("/api/programmes", json={"name": "drf"}).status_code == 400

    assert ra.post("/api/facilities", json={"name": "X"}).status_code == 403
    assert ra.post("/api/items", json={"code": "Z", "name": "Z", "baseUnit": "tablet"}).status_code == 403

    r = admin.post("/api/master/starter", json={"programmes": ["DRF", "MNCH"], "facilities": [{"name": "government house clinic"}],
                                                "items": [{"code": "AMX500", "name": "x", "baseUnit": "capsule"}, {"code": "PCM500", "name": "Paracetamol", "strength": "500mg", "form": "tablet", "baseUnit": "tablet"}]})
    assert r.json()["added"] == {"programmes": 1, "facilities": 0, "items": 1}

    audit = [e for e in _audit_types()]
    assert "facility.created" in audit and "item.created" in audit and "programme.created" in audit


def _audit_types():
    with psycopg.connect(TEST_DB) as c:
        return [r[0] for r in c.execute("SELECT event_type FROM audit_events").fetchall()]


def test_aliases(client, admin, ra):
    md = admin.get("/api/state").json()["md"]
    fid = next(iter(md["facilities"]))
    a = admin.post("/api/aliases", json={"entityType": "facility", "entityId": fid, "alias": "Govt. House Clinic"})
    assert a.status_code == 200 and a.json()["status"] == "approved"
    assert admin.post(f"/api/aliases/{a.json()['id']}/retire").json()["status"] == "rejected"
    with psycopg.connect(TEST_DB) as c:
        c.execute("INSERT INTO aliases (id, entity_type, entity_id, alias, normalized, occurrences, status) VALUES ('cand1','facility',%s,'GH Clinic','gh clinic',3,'candidate')", (fid,))
    assert ra.post("/api/aliases/cand1/decide", json={"decision": "approved"}).status_code == 403
    assert admin.post("/api/aliases/cand1/decide", json={"decision": "approved"}).json()["status"] == "approved"
    assert admin.post("/api/aliases/cand1/decide", json={"decision": "rejected"}).status_code == 400
    assert "cand1" in admin.get("/api/state").json()["md"]["aliases"]


def _finalized_req_with_unknown_line(item_id, uid, rid="rq-conv"):
    with psycopg.connect(TEST_DB, autocommit=True) as c:
        c.execute("""INSERT INTO requisitions (id, requisition_number, entry_date, entry_serial, received_at, created_by, record_status)
                     VALUES (%s, %s, '2026-11-20', next_requisition_serial('2026-11-20'), now() - interval '2 hours', %s, 'draft')""",
                  (rid, "REQ-" + rid, uid))
        c.execute("""INSERT INTO requisition_lines (id, requisition_id, line_number, item_id, quantity_requested, unit_requested, conversion_status)
                     VALUES (%s, %s, 1, %s, 20, 'ctn', 'unknown')""", (rid + "-l1", rid, item_id))
        c.execute("UPDATE requisitions SET record_status='finalized' WHERE id=%s", (rid,))
    return rid


def test_conversions_and_resolution_on_finalized(client, admin, ra):
    md = admin.get("/api/state").json()["md"]
    pcm = next(i for i in md["items"].values() if i["code"] == "PCM500")
    rid = _finalized_req_with_unknown_line(pcm["id"], _id(admin))

    # RA proposes; nothing is resolved until approved.
    p = ra.post("/api/conversions", json={"itemId": pcm["id"], "fromUnit": "cartons", "factor": 100})
    assert p.status_code == 200 and p.json()["conversion"]["status"] == "proposed" and p.json()["resolvedLines"] == 0
    cid = p.json()["conversion"]["id"]
    assert "cv-" + cid in ra.get("/api/state").json()["proposals"]
    assert ra.post(f"/api/conversions/{cid}/approve").status_code == 403

    a = admin.post(f"/api/conversions/{cid}/approve")
    assert a.status_code == 200 and a.json()["resolvedLines"] == 1
    line = admin.get("/api/state").json()["reqs"][rid]["lines"][rid + "-l1"]
    assert line["conversionStatus"] == "resolved" and line["baseQuantityRequested"] == 2000

    # Other line edits on the finalized requisition stay refused by the database.
    with psycopg.connect(TEST_DB, autocommit=True) as c, pytest.raises(psycopg.errors.RaiseException, match="finalized"):
        c.execute("UPDATE requisition_lines SET quantity_requested=5 WHERE id=%s", (rid + "-l1",))

    # Admin creating a new one for the same item/unit retires the old one.
    b = admin.post("/api/conversions", json={"itemId": pcm["id"], "fromUnit": "carton", "factor": 50})
    assert b.json()["conversion"]["status"] == "approved"
    convs = admin.get("/api/state").json()["md"]["conversions"]
    assert convs[cid]["status"] == "retired"
    assert admin.post(f"/api/conversions/{b.json()['conversion']['id']}/retire").json()["conversion"]["status"] == "retired"

    assert admin.post("/api/conversions", json={"itemId": pcm["id"], "fromUnit": "tablet", "factor": 1}).status_code == 400
    assert admin.post("/api/conversions", json={"itemId": None, "fromUnit": "box", "factor": 10}).status_code == 400
    g = admin.post("/api/conversions", json={"itemId": None, "fromUnit": "box", "toUnit": "tablet", "factor": 10})
    assert g.status_code == 200
    inc = admin.post("/api/conversions", json={"itemId": pcm["id"], "fromUnit": "tin", "incompatible": True})
    assert inc.status_code == 200 and inc.json()["conversion"]["incompatible"] is True
    rej = ra.post("/api/conversions", json={"itemId": pcm["id"], "fromUnit": "pack", "factor": 10}).json()["conversion"]["id"]
    assert admin.post(f"/api/conversions/{rej}/reject").json()["conversion"]["status"] == "rejected"
    assert admin.post("/api/conversions/resolve").json() == {"count": 0}


def test_equivalences(client, admin, ra):
    amx = admin.post("/api/items", json={"code": "AMX250", "name": "Amoxicillin", "strength": "250mg", "form": "capsule", "baseUnit": "capsule"}).json()["id"]
    md = admin.get("/api/state").json()["md"]
    a500 = next(i["id"] for i in md["items"].values() if i["code"] == "AMX500")
    bad = ra.post("/api/equivalences", json={"requestedItemId": a500, "substituteItemId": a500, "factor": 1, "basis": ["strength"], "justification": "x"})
    assert bad.status_code == 400
    assert ra.post("/api/equivalences", json={"requestedItemId": a500, "substituteItemId": amx, "factor": 0.5, "basis": [], "justification": "x"}).status_code == 400
    p = ra.post("/api/equivalences", json={"requestedItemId": a500, "substituteItemId": amx, "factor": 0.5, "basis": ["strength", "form"], "justification": "Two 250mg = one 500mg"})
    eid = p.json()["equivalence"]["id"]
    assert p.json()["equivalence"]["status"] == "proposed"
    assert admin.post(f"/api/equivalences/{eid}/approve").json()["equivalence"]["status"] == "approved"
    e2 = admin.post("/api/equivalences", json={"requestedItemId": a500, "substituteItemId": amx, "factor": 0.5, "basis": ["strength"], "justification": "Re-approved"}).json()["equivalence"]
    eqs = admin.get("/api/state").json()["md"]["equivalences"]
    assert eqs[eid]["status"] == "retired" and eqs[e2["id"]]["status"] == "approved"
    assert admin.post(f"/api/equivalences/{e2['id']}/retire").json()["equivalence"]["status"] == "retired"


def test_settings_validation(client, admin, ra):
    good = {"ofrThresholdPercent": 75, "ofrThresholdStage": "delivered", "editWindowHours": 12, "editRequestPendingTimeoutDays": 3, "defaultTimeBasis": "entry"}
    assert admin.put("/api/settings", json=good).status_code == 200
    assert admin.get("/api/state").json()["md"]["settings"]["ofrThresholdPercent"] == 75
    assert admin.put("/api/settings", json={**good, "ofrThresholdPercent": 0}).status_code == 400
    assert admin.put("/api/settings", json={**good, "ofrThresholdStage": "picked"}).status_code == 400
    assert admin.put("/api/settings", json={**good, "editWindowHours": 0}).status_code == 400
    assert ra.put("/api/settings", json=good).status_code == 403
    admin.put("/api/settings", json={**good, "ofrThresholdPercent": 80, "ofrThresholdStage": "issued", "editWindowHours": 24, "editRequestPendingTimeoutDays": 7, "defaultTimeBasis": "received"})


def test_user_access(client, admin, supervisor):
    sup_id = _id(supervisor)
    me = _id(admin)
    r = admin.post(f"/api/users/{sup_id}/access", json={"status": "active", "role": "supervisor", "grants": ["requisition.reopen"]})
    assert r.status_code == 200 and r.json()["grants"] == ["requisition.reopen"]
    users = {u["id"]: u for u in admin.get("/api/users").json()}
    assert users[sup_id]["grants"] == ["requisition.reopen"]
    assert admin.post(f"/api/users/{sup_id}/access", json={"status": "active", "role": "ra", "grants": ["requisition.reopen"]}).status_code == 400
    assert admin.post(f"/api/users/{sup_id}/access", json={"status": "active", "role": None}).status_code == 400
    assert admin.post(f"/api/users/{me}/access", json={"status": "active", "role": "ra"}).status_code == 403
    assert admin.post(f"/api/users/{me}/access", json={"status": "inactive", "role": "admin"}).status_code == 403
    assert supervisor.get("/api/users").status_code == 403
    admin.post(f"/api/users/{sup_id}/access", json={"status": "active", "role": "supervisor", "grants": []})
    assert "role.changed" in _audit_types()

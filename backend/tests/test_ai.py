import base64
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import psycopg
import pytest

from tests.conftest import TEST_DB, as_user

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
FAKE = {"status": 200, "body": None, "requests": [], "credits": {"data": {"total_credits": 10, "total_usage": 2.5}}}

ANSWER = {
    "facilityName": "Govt House Clinic",
    "requisitionDate": "2026-11-01",
    "pages": [{"page": 1, "programme": "DRF"}],
    "lines": [
        {"page": 1, "line": 1, "text": "Amoxicillin caps 500mg 20 ctn", "itemName": "Amoxicillin caps", "strength": "500mg", "form": "capsule", "quantity": 20, "unit": "ctn"},
        {"page": 1, "line": 2, "text": "Paracetamol tabs 1,000", "itemName": "Paracetamol", "strength": "500mg", "quantity": "1,000", "unit": "tabs"},
    ],
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, FAKE["credits"])

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        FAKE["requests"].append({"auth": self.headers.get("Authorization"), "body": json.loads(self.rfile.read(n))})
        if FAKE["status"] != 200:
            return self._send(FAKE["status"], {"error": {"message": "nope"}})
        body = FAKE["body"] or ANSWER
        self._send(200, {"model": "google/gemini-2.5-flash", "choices": [{"message": {"content": "```json\n" + json.dumps(body) + "\n```"}}],
                         "usage": {"prompt_tokens": 1200, "completion_tokens": 300, "cost": 0.0021}})


@pytest.fixture(scope="module", autouse=True)
def fake_openrouter():
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    os.environ["OPENROUTER_BASE_URL"] = f"http://127.0.0.1:{srv.server_port}"
    yield
    srv.shutdown()


@pytest.fixture(autouse=True)
def reset_fake():
    FAKE.update(status=200, body=None)
    FAKE["requests"].clear()


SETTINGS = {"enabled": True, "model": "google/gemini-2.5-flash", "fallbackModel": None, "maxPagesPerJob": 20, "perUserPagesPerDay": 200,
            "perUserJobsPerHour": 30, "orgMonthlyBudgetUsd": 50, "lowBalanceUsd": 5}


def _setup_master(admin):
    admin.post("/api/master/starter", json={"programmes": ["DRF"], "facilities": [{"name": "Government House Clinic"}],
                                             "items": [{"code": "AMX500", "name": "Amoxicillin", "strength": "500mg", "form": "capsule", "baseUnit": "capsule"},
                                                       {"code": "PCM500", "name": "Paracetamol", "strength": "500mg", "form": "tablet", "baseUnit": "tablet"}]})


def _queue(user, rid):
    """A requisition with one stored PNG page, queued for reading by `user`."""
    from app.core import storage
    from app.core.db import tx
    from app.jobs import queue_extraction

    uid = user.get("/api/me").json()["id"]
    key = "doc-" + rid
    storage.put(key, PNG)
    with tx() as conn:
        conn.execute("""INSERT INTO requisitions (id, requisition_number, entry_date, entry_serial, received_at, created_by)
                        VALUES (%s, %s, '2026-11-20', next_requisition_serial('2026-11-20'), '2026-11-19T10:00:00Z', %s)""", (rid, "REQ-" + rid, uid))
        conn.execute("""INSERT INTO documents (id, requisition_id, category, document_type, file_name, mime_type, storage_key, sha256, file_size, page_count, first_page, uploaded_by)
                        VALUES (%s,%s,'original_requisition','requisition','p1.png','image/png',%s,'x',%s,1,1,%s)""", (key, rid, key, len(PNG), uid))
        return queue_extraction(conn, uid, rid)


def _process():
    from app.worker import process_one

    assert process_one() is True


def _db(sql, *p):
    with psycopg.connect(TEST_DB) as c:
        return c.execute(sql, p).fetchall()


def test_key_is_encrypted_and_never_returned(client, admin, ra):
    assert ra.get("/api/ai/settings").status_code == 403
    assert ra.put("/api/ai/key", json={"key": "sk-or-v1-abcdefghijkl1234"}).status_code == 403
    r = admin.put("/api/ai/key", json={"key": "sk-or-v1-abcdefghijkl1234"})
    assert r.json() == {"keyConfigured": True, "keyHint": "1234", "keySource": "database"}
    cipher = _db("SELECT ciphertext FROM secrets WHERE key='openrouter_api_key'")[0][0]
    assert "sk-or-v1" not in cipher
    s = admin.get("/api/ai/settings").json()
    assert "sk-or" not in json.dumps(s) and s["keyHint"] == "1234"
    audit = _db("SELECT new_value::text FROM audit_events WHERE event_type='ai.key_changed'")
    assert audit and "sk-or" not in audit[0][0]
    assert admin.put("/api/ai/key", json={"key": "short"}).status_code == 400


def test_settings_validation_and_status(client, admin, ra):
    assert admin.put("/api/ai/settings", json={**SETTINGS, "model": "gemini"}).status_code == 400
    assert admin.put("/api/ai/settings", json={**SETTINGS, "orgMonthlyBudgetUsd": -1}).status_code == 400
    assert admin.put("/api/ai/settings", json={**SETTINGS, "enabled": False}).status_code == 200
    st = ra.get("/api/ai/status").json()
    assert st["readyForReading"] is False and "switched off" in st["reason"]
    assert admin.put("/api/ai/settings", json=SETTINGS).json()["enabled"] is True
    assert ra.get("/api/ai/status").json()["readyForReading"] is True
    t = admin.post("/api/ai/test").json()
    assert t["ok"] is True and FAKE["requests"][-1]["auth"] == "Bearer sk-or-v1-abcdefghijkl1234"


def test_worker_happy_path(client, admin, ra):
    _setup_master(admin)
    admin.put("/api/ai/settings", json=SETTINGS)
    _queue(ra, "rq-ai1")
    _process()
    body = FAKE["requests"][-1]["body"]
    assert body["usage"] == {"include": True} and body["messages"][0]["content"][1]["type"] == "image_url"
    req = admin.get("/api/state").json()["reqs"]["rq-ai1"]
    assert req["recordStatus"] == "validation_pending"
    assert req["extraction"]["status"] == "completed" and req["extraction"]["costUsd"] == 0.0021
    lines = sorted(req["lines"].values(), key=lambda l: l["lineNumber"])
    assert len(lines) == 2 and lines[1]["quantityRequested"] == 1000
    md = admin.get("/api/state").json()["md"]
    assert md["items"][lines[0]["candidates"][0]["targetId"]]["code"] == "AMX500"
    assert lines[0]["programmeId"] == next(p["id"] for p in md["programmes"].values() if p["name"] == "DRF")
    assert req["facilityExtractedText"] == "Govt House Clinic" and req["facilityCandidates"]
    assert req["requisitionDate"] == "2026-11-01"
    usage = _db("SELECT outcome, cost_usd, pages, prompt_tokens FROM ai_usage WHERE requisition_id='rq-ai1'")
    assert [(o, float(c), p, t) for o, c, p, t in usage] == [("ok", 0.0021, 1, 1200)]
    assert "processing.completed" in [r[0] for r in _db("SELECT event_type FROM audit_events WHERE requisition_id='rq-ai1'")]


def test_402_gives_clear_message(client, admin):
    u = as_user(client, "ra402@example.org", "ra")
    admin.put("/api/ai/settings", json=SETTINGS)
    FAKE["status"] = 402
    _queue(u, "rq-402")
    _process()
    req = admin.get("/api/state").json()["reqs"]["rq-402"]
    assert req["recordStatus"] == "validation_pending" and req["extraction"]["status"] == "failed"
    assert "credits have run out" in req["extraction"]["error"]
    assert _db("SELECT outcome FROM ai_usage WHERE requisition_id='rq-402'") == [("error",)]


def test_daily_page_limit(client, admin):
    u = as_user(client, "ralimit@example.org", "ra")
    admin.put("/api/ai/settings", json={**SETTINGS, "perUserPagesPerDay": 1})
    _queue(u, "rq-lim1")
    _process()
    _queue(u, "rq-lim2")
    _process()
    req = admin.get("/api/state").json()["reqs"]["rq-lim2"]
    assert req["extraction"]["status"] == "failed" and "today's limit" in req["extraction"]["error"]
    assert req["recordStatus"] == "validation_pending"
    assert _db("SELECT outcome, cost_usd FROM ai_usage WHERE requisition_id='rq-lim2'")[0][0] == "refused_limit"
    admin.put("/api/ai/settings", json=SETTINGS)


def test_monthly_budget_and_usage_report(client, admin):
    u = as_user(client, "rabudget@example.org", "ra")
    admin.put("/api/ai/settings", json={**SETTINGS, "orgMonthlyBudgetUsd": 0.001})
    _queue(u, "rq-bud")
    _process()
    req = admin.get("/api/state").json()["reqs"]["rq-bud"]
    assert "budget" in req["extraction"]["error"] and req["recordStatus"] == "validation_pending"
    assert u.get("/api/ai/status").json()["readyForReading"] is False
    admin.put("/api/ai/settings", json=SETTINGS)

    rep = admin.get("/api/ai/usage").json()
    assert rep["totals"]["jobs"] >= 2 and rep["totals"]["refused"] >= 2 and rep["totals"]["errors"] >= 1
    assert rep["totals"]["costUsd"] == pytest.approx(0.0021 * rep["totals"]["jobs"])
    assert rep["budget"]["monthlyBudgetUsd"] == 50 and rep["openrouter"]["remaining"] == 7.5
    assert any(x["userId"] for x in rep["users"]) and rep["days"]
    assert admin.get("/api/ai/usage?month=2020-01").json()["totals"]["jobs"] == 0
    assert admin.get("/api/ai/usage?month=bad").status_code == 400


def test_disabled_and_ledger_append_only(client, admin):
    u = as_user(client, "raoff@example.org", "ra")
    admin.put("/api/ai/settings", json={**SETTINGS, "enabled": False})
    _queue(u, "rq-off")
    _process()
    assert "switched off" in admin.get("/api/state").json()["reqs"]["rq-off"]["extraction"]["error"]
    admin.put("/api/ai/settings", json=SETTINGS)
    with psycopg.connect(TEST_DB, autocommit=True) as c, pytest.raises(psycopg.errors.RaiseException):
        c.execute("UPDATE ai_usage SET cost_usd=0")

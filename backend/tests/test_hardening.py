"""Security headers, upload content checks and edit-request expiry."""
import datetime as dt

import psycopg

from tests.conftest import TEST_DB
from tests.test_requisitions import PNG


def test_security_headers(client, admin):
    r = admin.get("/api/state")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["cache-control"] == "no-store"
    page = client.get("/")
    assert "frame-ancestors 'none'" in page.headers.get("content-security-policy", "")


def _create(user, files):
    now = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=5)
    return user.post("/api/requisitions", data={"receivedAt": now.isoformat(), "receivedVia": "WhatsApp", "read": "false"}, files=files)


def test_rejects_files_whose_contents_dont_match(ra):
    r = _create(ra, [("files", ("fake.png", b"<html><script>alert(1)</script></html>", "image/png"))])
    assert r.status_code == 400
    assert "contents don't match" in r.json()["detail"]
    r = _create(ra, [("files", ("disguised.pdf", PNG, "application/pdf"))])
    assert r.status_code == 400
    assert _create(ra, [("files", ("ok.png", PNG, "image/png"))]).status_code == 200


def test_signed_file_is_sandboxed(ra):
    r = _create(ra, [("files", ("ok.png", PNG, "image/png"))]).json()
    doc_id = next(iter(r["requisition"]["documents"]))
    url = ra.get(f"/api/documents/{doc_id}/url").json()["url"]
    f = ra.get(url)
    assert f.status_code == 200 and f.content == PNG
    assert f.headers["content-security-policy"].startswith("sandbox")


def test_expired_edit_requests_are_written_back(client, ra):
    from app.worker import expire_edit_requests

    rid = _create(ra, [("files", ("ok.png", PNG, "image/png"))]).json()["id"]
    with psycopg.connect(TEST_DB, autocommit=True) as c:
        uid = c.execute("SELECT id FROM users WHERE email='ra@example.org'").fetchone()[0]
        c.execute("INSERT INTO edit_requests (id, requisition_id, requested_by, requested_at, reason, requested_changes) "
                  "VALUES ('erold', %s, %s, now() - interval '30 days', 'x', '[{\"entityType\":\"header\",\"field\":\"facilityId\"}]')", (rid, uid))
    assert expire_edit_requests() >= 1
    with psycopg.connect(TEST_DB) as c:
        assert c.execute("SELECT status, closure_reason FROM edit_requests WHERE id='erold'").fetchone() == ("expired", "expired")
        assert c.execute("SELECT count(*) FROM audit_events WHERE event_type='edit_request.expired' AND entity_id='erold'").fetchone()[0] == 1

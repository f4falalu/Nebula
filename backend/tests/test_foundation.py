import psycopg
import pytest

from tests.conftest import TEST_DB


def test_health_and_state(client, admin):
    assert client.get("/api/health").json() == {"ok": True}
    r = admin.get("/api/state")
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"reqs", "md", "roles", "proposals"}
    assert body["md"]["settings"]["ofrThresholdPercent"] == 80


def test_requires_sign_in(client):
    assert client.get("/api/state").status_code == 401


def _conn():
    return psycopg.connect(TEST_DB, autocommit=True)


def _seed_req(c, status="draft"):
    c.execute("INSERT INTO users (id, email, status, role) VALUES ('u1','u1@x','active','admin') ON CONFLICT DO NOTHING")
    c.execute("INSERT INTO requisitions (id, requisition_number, entry_date, entry_serial, received_at, created_by, record_status) "
              "VALUES ('r1','REQ-26-11-25_001','2026-11-25', next_requisition_serial('2026-11-25'), now() - interval '1 hour','u1',%s) "
              "ON CONFLICT DO NOTHING", (status,))


def test_counter_increments():
    with _conn() as c:
        a = c.execute("SELECT next_requisition_serial('2030-01-01')").fetchone()[0]
        b = c.execute("SELECT next_requisition_serial('2030-01-01')").fetchone()[0]
        assert b == a + 1


def test_append_only_and_lock(client):
    with _conn() as c:
        _seed_req(c)
        c.execute("INSERT INTO lifecycle_events (id, requisition_id, stage, status, occurred_at, recorded_by) VALUES ('e1','r1','finance','completed', now(),'u1')")
        with pytest.raises(psycopg.errors.RaiseException):
            c.execute("UPDATE lifecycle_events SET notes='x' WHERE id='e1'")
        with pytest.raises(psycopg.errors.RaiseException):
            c.execute("DELETE FROM lifecycle_events WHERE id='e1'")
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute("INSERT INTO lifecycle_events (id, requisition_id, stage, status, occurred_at, recorded_by) VALUES ('e2','r1','finance','not_applicable', now(),'u1')")
        with pytest.raises(psycopg.errors.UniqueViolation):
            c.execute("INSERT INTO lifecycle_events (id, requisition_id, stage, status, occurred_at, recorded_by, record_type, supersedes_id, correction_reason) VALUES ('e3','r1','finance','completed', now(),'u1','void','e1','x')")
            c.execute("INSERT INTO lifecycle_events (id, requisition_id, stage, status, occurred_at, recorded_by, record_type, supersedes_id, correction_reason) VALUES ('e4','r1','finance','completed', now(),'u1','void','e1','y')")
        c.execute("UPDATE requisitions SET record_status='finalized' WHERE id='r1'")
        with pytest.raises(psycopg.errors.RaiseException, match="finalized"):
            c.execute("UPDATE requisitions SET received_at = received_at - interval '1 minute' WHERE id='r1'")
        with pytest.raises(psycopg.errors.RaiseException, match="immutable"):
            c.execute("UPDATE requisitions SET requisition_number='X' WHERE id='r1'")
        with pytest.raises(psycopg.errors.RaiseException, match="finalized"):
            c.execute("INSERT INTO requisition_lines (id, requisition_id, line_number) VALUES ('l1','r1',1)")
        c.execute("UPDATE requisitions SET fulfillment_status='partial' WHERE id='r1'")  # allowed after finalization
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute("INSERT INTO edit_requests (id, requisition_id, requested_by, reason, requested_changes, decided_by) VALUES ('er1','r1','u1','x','[{}]','u1')")

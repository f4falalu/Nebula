"""Test harness: a fresh database per test session, dev auth via headers."""
import os

os.environ.setdefault("NEBULA_ENV", "development")
os.environ.setdefault("NEBULA_SECRET_KEY", "test-secret")
os.environ.setdefault("RUN_WORKER", "0")
TEST_DB = os.environ.get("TEST_DATABASE_URL", "postgresql://nebula@127.0.0.1:5433/nebula_test")
os.environ["DATABASE_URL"] = TEST_DB

import tempfile

os.environ.setdefault("STORAGE_DIR", tempfile.mkdtemp(prefix="nebula-files-"))

import psycopg
import pytest
from fastapi.testclient import TestClient


def _reset_db():
    with psycopg.connect(TEST_DB.rsplit("/", 1)[0] + "/postgres", autocommit=True) as c:
        c.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='nebula_test' AND pid<>pg_backend_pid()")
        c.execute("DROP DATABASE IF EXISTS nebula_test")
        c.execute("CREATE DATABASE nebula_test")


@pytest.fixture(scope="session")
def client():
    _reset_db()
    from app.core import db
    from app.main import app

    db.reset_pool(TEST_DB)
    with TestClient(app) as c:
        yield c
    db.reset_pool()


def as_user(client, email, role="admin", grants=None):
    """Return a callable that makes requests as a dev user with the given role."""
    headers = {"x-dev-user": email, "x-dev-role": role}
    if grants is not None:
        headers["x-dev-grants"] = ",".join(grants)

    class U:
        def __getattr__(self, method):
            def call(url, **kw):
                h = {**headers, **kw.pop("headers", {})}
                return getattr(client, method)(url, headers=h, **kw)
            return call
    return U()


@pytest.fixture()
def admin(client):
    return as_user(client, "admin@example.org", "admin")


@pytest.fixture()
def ra(client):
    return as_user(client, "ra@example.org", "ra")


@pytest.fixture()
def ra2(client):
    return as_user(client, "ra2@example.org", "ra")


@pytest.fixture()
def supervisor(client):
    return as_user(client, "sup@example.org", "supervisor")

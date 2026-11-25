"""Document storage on the server's disk (a Render persistent disk in
production). Files are written once and never overwritten, under a key derived
from the document id. Access goes through short-lived signed URLs (PRD §13.4)."""
from __future__ import annotations

import hashlib
import hmac
import os
import time

from .config import settings


def _path(key: str) -> str:
    safe = "".join(c for c in key if c.isalnum() or c in "-_.")
    return os.path.join(settings.storage_dir, safe[:2], safe)


def put(key: str, data: bytes) -> None:
    p = _path(key)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if os.path.exists(p):
        raise RuntimeError("A stored file is never overwritten.")
    tmp = p + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, p)
    os.chmod(p, 0o444)


def get(key: str) -> bytes:
    with open(_path(key), "rb") as fh:
        return fh.read()


def exists(key: str) -> bool:
    return os.path.exists(_path(key))


def _secret() -> bytes:
    if not settings.secret_key:
        raise RuntimeError("NEBULA_SECRET_KEY is not set.")
    return hashlib.sha256(("files:" + settings.secret_key).encode()).digest()


def sign(doc_id: str, user_id: str, ttl: int = 300, download: bool = False) -> str:
    exp = int(time.time()) + ttl
    msg = f"{doc_id}:{user_id}:{exp}:{int(download)}".encode()
    sig = hmac.new(_secret(), msg, hashlib.sha256).hexdigest()[:32]
    return f"/files/{doc_id}?u={user_id}&e={exp}&d={int(download)}&s={sig}"


def verify(doc_id: str, user_id: str, exp: int, download: int, sig: str) -> bool:
    if exp < time.time():
        return False
    msg = f"{doc_id}:{user_id}:{exp}:{download}".encode()
    good = hmac.new(_secret(), msg, hashlib.sha256).hexdigest()[:32]
    return hmac.compare_digest(good, sig)

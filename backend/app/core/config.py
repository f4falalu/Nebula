"""Configuration from environment variables (set them in Render's dashboard)."""
from __future__ import annotations

import base64
import os
from dataclasses import dataclass, field


def _list(name: str) -> list[str]:
    return [x.strip().lower() for x in os.environ.get(name, "").split(",") if x.strip()]


def clerk_frontend_api(publishable_key: str) -> str | None:
    """pk_live_/pk_test_ keys encode the Clerk Frontend API host in base64."""
    try:
        enc = publishable_key.split("_", 2)[2]
        host = base64.b64decode(enc + "=" * (-len(enc) % 4)).decode().rstrip("$")
        return host or None
    except Exception:
        return None


@dataclass
class Settings:
    env: str = field(default_factory=lambda: os.environ.get("NEBULA_ENV", "production"))
    database_url: str = field(default_factory=lambda: os.environ.get("DATABASE_URL", "postgresql://nebula@127.0.0.1:5433/nebula"))
    secret_key: str = field(default_factory=lambda: os.environ.get("NEBULA_SECRET_KEY", ""))
    clerk_publishable_key: str = field(default_factory=lambda: os.environ.get("CLERK_PUBLISHABLE_KEY", ""))
    clerk_secret_key: str = field(default_factory=lambda: os.environ.get("CLERK_SECRET_KEY", ""))
    clerk_authorized_parties: list[str] = field(default_factory=lambda: _list("CLERK_AUTHORIZED_PARTIES"))
    admin_emails: list[str] = field(default_factory=lambda: _list("ADMIN_EMAILS"))
    storage_dir: str = field(default_factory=lambda: os.environ.get("STORAGE_DIR", "/var/data/nebula"))
    static_dir: str = field(default_factory=lambda: os.environ.get("STATIC_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "..", "app", "dist", "web")))
    run_worker: bool = field(default_factory=lambda: os.environ.get("RUN_WORKER", "1") == "1")
    api_requests_per_minute: int = field(default_factory=lambda: int(os.environ.get("API_REQUESTS_PER_MINUTE", "240")))

    @property
    def dev(self) -> bool:
        return self.env == "development"

    @property
    def clerk_issuer(self) -> str | None:
        host = clerk_frontend_api(self.clerk_publishable_key) if self.clerk_publishable_key else None
        return f"https://{host}" if host else None


settings = Settings()

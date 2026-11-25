"""API rate limiting: a token bucket per signed-in user (in memory, per
server instance). AI document reading has its own durable limits in the
ai_usage ledger (see app/routers/ai.py)."""
from __future__ import annotations

import threading
import time

from .common import UserError


class TokenBucket:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._buckets: dict[str, tuple[float, float]] = {}

    def take(self, key: str, per_minute: int, cost: float = 1.0) -> None:
        if per_minute <= 0:
            return
        rate = per_minute / 60.0
        with self._lock:
            tokens, at = self._buckets.get(key, (float(per_minute), time.monotonic()))
            now = time.monotonic()
            tokens = min(float(per_minute), tokens + (now - at) * rate)
            if tokens < cost:
                retry = int((cost - tokens) / rate) + 1
                self._buckets[key] = (tokens, now)
                raise UserError(f"Too many requests. Wait {retry} seconds and try again.", 429)
            self._buckets[key] = (tokens - cost, now)


api_bucket = TokenBucket()

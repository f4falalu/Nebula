"""OpenRouter client (https://openrouter.ai). The API key never leaves the
server; callers pass it in from the encrypted secrets table."""
from __future__ import annotations

import json
import os
import re
from typing import Any

import httpx


class OpenRouterError(Exception):
    """A failure whose message is safe to show to users."""

    def __init__(self, message: str, status: int | None = None, retry_with_fallback: bool = False):
        super().__init__(message)
        self.status = status
        self.retry_with_fallback = retry_with_fallback


def base_url() -> str:
    return os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")


def _headers(api_key: str) -> dict:
    h = {"Authorization": f"Bearer {api_key}", "X-Title": "Nebula", "Content-Type": "application/json"}
    if os.environ.get("PUBLIC_URL"):
        h["HTTP-Referer"] = os.environ["PUBLIC_URL"]
    return h


def _error(resp: httpx.Response) -> OpenRouterError:
    try:
        detail = resp.json().get("error", {}).get("message") or ""
    except Exception:
        detail = ""
    s = resp.status_code
    if s == 401:
        return OpenRouterError("The OpenRouter API key is invalid. An Administrator needs to update it in Administration → Document reading.", s)
    if s == 402:
        return OpenRouterError("OpenRouter credits have run out. An Administrator needs to top up the OpenRouter account.", s)
    if s == 429:
        return OpenRouterError("OpenRouter is rate-limiting requests. Wait a minute and retry.", s, retry_with_fallback=True)
    if s in (400, 404):
        return OpenRouterError(f"The model refused the request{': ' + detail if detail else ''}.", s, retry_with_fallback=True)
    return OpenRouterError(f"OpenRouter failed ({s}){': ' + detail if detail else ''}. Retry, or enter the lines by hand.", s, retry_with_fallback=True)


def image_part(data: bytes, mime: str = "image/png") -> dict:
    import base64

    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"}}


def chat(model: str, messages: list[dict], *, api_key: str, timeout: float = 120, json_mode: bool = True) -> dict:
    body: dict[str, Any] = {"model": model, "messages": messages, "usage": {"include": True}}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    try:
        resp = httpx.post(f"{base_url()}/chat/completions", headers=_headers(api_key), json=body, timeout=timeout)
    except httpx.TimeoutException:
        raise OpenRouterError("OpenRouter took too long to answer. Retry, or enter the lines by hand.", retry_with_fallback=True)
    except httpx.HTTPError as e:
        raise OpenRouterError(f"Couldn't reach OpenRouter ({type(e).__name__}). Retry later.", retry_with_fallback=True)
    if resp.status_code >= 400:
        raise _error(resp)
    data = resp.json()
    if isinstance(data, dict) and data.get("error"):
        msg = data["error"].get("message") if isinstance(data["error"], dict) else str(data["error"])
        raise OpenRouterError(f"The model returned an error: {msg}", retry_with_fallback=True)
    try:
        text = data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        raise OpenRouterError("OpenRouter returned an unexpected answer.", retry_with_fallback=True)
    if isinstance(text, list):  # some providers return content parts
        text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    usage = data.get("usage") or {}
    return {
        "text": text,
        "model": data.get("model") or model,
        "usage": {"prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": usage.get("completion_tokens"), "cost": float(usage.get("cost") or 0)},
    }


def credits(api_key: str) -> dict:
    resp = httpx.get(f"{base_url()}/credits", headers=_headers(api_key), timeout=15)
    if resp.status_code >= 400:
        raise _error(resp)
    d = resp.json().get("data", {})
    total, used = float(d.get("total_credits") or 0), float(d.get("total_usage") or 0)
    return {"total_credits": total, "total_usage": used, "remaining": round(total - used, 6)}


def parse_json(text: str) -> Any:
    """Whole text as JSON; else a fenced block; else first { .. last }."""
    t = (text or "").strip()
    try:
        return json.loads(t)
    except ValueError:
        pass
    m = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    if m:
        try:
            return json.loads(m.group(1))
        except ValueError:
            pass
    a, b = t.find("{"), t.rfind("}")
    if a != -1 and b > a:
        try:
            return json.loads(t[a:b + 1])
        except ValueError:
            pass
    raise OpenRouterError("The model's answer couldn't be read as a list of lines. Retry, or enter the lines by hand.")

"""Background worker: reads queued requisition documents with OpenRouter and
turns the answer into suggested lines (PRD §14). Suggestions only: the RA
confirms every match."""
from __future__ import annotations

import logging
import threading
import time
from typing import Any

from .core import storage
from .core.common import audit, lagos_date, new_id
from .core.db import J, tx
from .core.state import load_master
from .domain import match_facility, match_item, normalize
from . import openrouter
from .routers.ai import ai_settings, api_key, limit_reason, record_usage

log = logging.getLogger("nebula.worker")
BATCH = 8
_started = False


def prompt(first_page: int, count: int, programmes: list[str]) -> str:
    # Same instructions as the V1 reader (app/src/data/extraction.ts).
    return f"""You are reading scanned or photographed pages of a healthcare facility requisition (an order for medicines and supplies) from a facility in Nigeria. The {count} attached image(s) are pages {first_page} to {first_page + count - 1} of the requisition, in order.

Transcribe what is written. Do not guess missing values: use null or leave the field out. Keep item text as written.

Known programmes: {", ".join(programmes) or "(none)"}. If a page header names one of these programmes, give that name exactly; otherwise leave it out.

Reply with only one JSON object in this shape:
{{"facilityName": string|null, "requisitionDate": "YYYY-MM-DD"|null,
 "pages": [{{"page": number, "programme": string|null}}],
 "lines": [{{"page": number, "line": number, "text": "the full row as written", "itemName": string, "strength": string|null, "form": string|null, "packSize": string|null, "quantity": number|null, "unit": string|null}}]}}

Use the requested/ordered quantity column for "quantity" (not stock on hand or quantity issued). "unit" is the unit the quantity is expressed in (tablet, capsule, bottle, carton, vial, pack...). Number "line" from 1 on each page. Skip blank rows, totals and signatures."""


# ------------------------------------------------------------------ page images
def render_pages(docs: list[dict], max_pages: int) -> list[tuple[bytes, str]]:
    import fitz  # pymupdf

    out: list[tuple[bytes, str]] = []
    for d in docs:
        if len(out) >= max_pages:
            break
        data = storage.get(d["storage_key"])
        mime = d["mime_type"]
        if mime == "application/pdf":
            with fitz.open(stream=data, filetype="pdf") as pdf:
                for page in pdf:
                    if len(out) >= max_pages:
                        break
                    out.append((page.get_pixmap(matrix=fitz.Matrix(1.6, 1.6)).tobytes("png"), "image/png"))
        elif mime in ("image/png", "image/jpeg", "image/webp") and len(data) <= 3_500_000:
            out.append((data, mime))
        else:
            # Large or unusual images: re-render to a PNG no wider than ~2000px.
            with fitz.open(stream=data, filetype=mime.split("/")[-1]) as img:
                page = img[0]
                scale = min(1.0, 2000 / max(page.rect.width, page.rect.height, 1))
                out.append((page.get_pixmap(matrix=fitz.Matrix(scale, scale)).tobytes("png"), "image/png"))
    return out


# ------------------------------------------------------------------ reading
def _num(v: Any) -> float | None:
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def read_pages(images: list[tuple[bytes, str]], programmes: list[str], s: dict, key: str) -> tuple[dict, str, dict, str]:
    """Returns (merged result, raw text, usage totals, model used)."""
    merged: dict = {"facilityName": None, "requisitionDate": None, "pages": [], "lines": []}
    raws: list[str] = []
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0}
    used_model = s["model"]
    for i in range(0, len(images), BATCH):
        batch = images[i:i + BATCH]
        content: list[dict] = [{"type": "text", "text": prompt(i + 1, len(batch), programmes)}]
        content += [openrouter.image_part(b, m) for b, m in batch]
        messages = [{"role": "user", "content": content}]
        try:
            r = openrouter.chat(s["model"], messages, api_key=key)
        except openrouter.OpenRouterError as e:
            if not (e.retry_with_fallback and s.get("fallbackModel")):
                raise
            r = openrouter.chat(s["fallbackModel"], messages, api_key=key)
        used_model = r["model"]
        for k in usage:
            usage[k] += r["usage"].get(k) or 0
        raws.append(r["text"])
        parsed = openrouter.parse_json(r["text"])
        if not isinstance(parsed, dict):
            raise openrouter.OpenRouterError("The model's answer wasn't a JSON object. Retry, or enter the lines by hand.")
        if not merged["facilityName"] and parsed.get("facilityName"):
            merged["facilityName"] = str(parsed["facilityName"])
        rd = parsed.get("requisitionDate")
        if not merged["requisitionDate"] and isinstance(rd, str) and len(rd) == 10 and rd[4] == "-" and rd[7] == "-":
            merged["requisitionDate"] = rd
        for p in parsed.get("pages") or []:
            if isinstance(p, dict):
                merged["pages"].append({"page": int(_num(p.get("page")) or i + 1), "programme": p.get("programme")})
        for l in parsed.get("lines") or []:
            if not isinstance(l, dict):
                continue
            merged["lines"].append({
                "page": int(_num(l.get("page")) or i + 1),
                "line": int(_num(l.get("line")) or len(merged["lines"]) + 1),
                "text": str(l.get("text") or l.get("itemName") or ""),
                "itemName": str(l["itemName"]) if l.get("itemName") else None,
                "strength": str(l["strength"]) if l.get("strength") else None,
                "form": str(l["form"]) if l.get("form") else None,
                "packSize": str(l["packSize"]) if l.get("packSize") else None,
                "quantity": _num(l.get("quantity")),
                "unit": str(l["unit"]) if l.get("unit") else None,
            })
    raw = raws[0] if len(raws) == 1 else "[" + ",".join(raws) + "]"
    return merged, raw, usage, used_model


def apply_extraction(conn, req: dict, res: dict) -> int:
    """Port of services.ts applyExtraction. Returns the number of lines added."""
    rid = req["id"]
    md = load_master(conn)
    item_aliases = [a for a in md["aliases"].values() if a["status"] == "approved" and a["entityType"] == "item"]
    fac_aliases = [a for a in md["aliases"].values() if a["status"] == "approved" and a["entityType"] == "facility"]
    prog_by_name = {normalize(p["name"]): p["id"] for p in md["programmes"].values()}
    pages = {r["page_number"]: r["programme_id"] for r in conn.execute("SELECT page_number, programme_id FROM document_pages WHERE requisition_id=%s", (rid,)).fetchall()}
    for p in res["pages"]:
        pid = prog_by_name.get(normalize(p.get("programme"))) if p.get("programme") else None
        if pid:
            pages[p["page"]] = pid
            conn.execute("""INSERT INTO document_pages (requisition_id, page_number, programme_id) VALUES (%s,%s,%s)
                            ON CONFLICT (requisition_id, page_number) DO UPDATE SET programme_id=EXCLUDED.programme_id, updated_at=now()""",
                         (rid, p["page"], pid))
    # Replace earlier suggested lines nobody has confirmed (never lines with fulfillment).
    conn.execute("""DELETE FROM requisition_lines l WHERE requisition_id=%s AND match_confirmed_by IS NULL
                    AND NOT EXISTS (SELECT 1 FROM fulfillment_records f WHERE f.requisition_line_id = l.id)""", (rid,))
    for x in res["lines"]:
        cands = match_item({"text": x.get("itemName") or x["text"], "strength": x.get("strength"), "form": x.get("form"), "packSize": x.get("packSize")},
                           md["items"].values(), item_aliases)
        conn.execute(
            """INSERT INTO requisition_lines (id, requisition_id, line_number, page_number, raw_extracted_text, item_extracted_text,
                   strength, form, pack_size, quantity_requested, unit_requested, programme_id, candidates)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (new_id(), rid, x["line"], x["page"], x["text"], x.get("itemName") or x["text"], x.get("strength"), x.get("form"), x.get("packSize"),
             x["quantity"] if x.get("quantity") is not None and x["quantity"] >= 0 else None, x.get("unit"),
             pages.get(x["page"]) or req["primary_programme_id"], J(cands)),
        )
    history = [{"facilityId": r["facility_id"], "facilityExtractedText": r["facility_extracted_text"]}
               for r in conn.execute("SELECT facility_id, facility_extracted_text FROM requisitions WHERE record_status='finalized' AND facility_id IS NOT NULL").fetchall()]
    fac_text = res.get("facilityName") or req["facility_extracted_text"]
    fac_cands = match_facility(fac_text, md["facilities"].values(), fac_aliases, history)
    req_date = req["requisition_date"]
    if not req_date and res.get("requisitionDate"):
        try:
            import datetime as dt

            d = dt.date.fromisoformat(res["requisitionDate"])
            if d <= lagos_date(req["received_at"]):
                req_date = d
        except ValueError:
            pass
    conn.execute("UPDATE requisitions SET facility_extracted_text=%s, facility_candidates=%s, requisition_date=%s WHERE id=%s",
                 (fac_text, J(fac_cands), req_date, rid))
    return len(res["lines"])


def _finish_failed(job: dict, message: str, *, outcome: str, pages: int, model: str, cost: float = 0.0) -> None:
    with tx() as conn:
        req = conn.execute("SELECT record_status FROM requisitions WHERE id=%s FOR UPDATE", (job["requisition_id"],)).fetchone()
        conn.execute("UPDATE processing_jobs SET status='failed', completed_at=now(), error=%s, cost_usd=%s, model_name=%s, pages=%s WHERE id=%s",
                     (message, cost, model, pages, job["id"]))
        record_usage(conn, user_id=job["created_by"], requisition_id=job["requisition_id"], job_id=job["id"], model=model, pages=pages,
                     outcome=outcome, cost=cost, detail=message[:500])
        if req and req["record_status"] == "processing":
            conn.execute("UPDATE requisitions SET record_status='validation_pending' WHERE id=%s", (job["requisition_id"],))
            audit(conn, None, "record_status.changed", "requisition", job["requisition_id"], requisition_id=job["requisition_id"],
                  old="processing", new="validation_pending", system=True)
        audit(conn, None, "processing.failed", "processing_job", job["id"], requisition_id=job["requisition_id"],
              new={"error": message, "attempt": job["attempt"], "outcome": outcome}, system=True)


def process_one() -> bool:
    """Claim and process the oldest queued job. Returns False when the queue is empty."""
    with tx() as conn:
        job = conn.execute("SELECT * FROM processing_jobs WHERE status='queued' ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1").fetchone()
        if not job:
            return False
        conn.execute("UPDATE processing_jobs SET status='processing', started_at=now() WHERE id=%s", (job["id"],))
        s = ai_settings(conn)
        key, _ = api_key(conn)
        docs = conn.execute("SELECT * FROM documents WHERE requisition_id=%s AND category='original_requisition' ORDER BY first_page, uploaded_at",
                            (job["requisition_id"],)).fetchall()
        programmes = [p["name"] for p in conn.execute("SELECT name FROM programmes WHERE status='active' ORDER BY name").fetchall()]
    model = s["model"]
    try:
        images = render_pages(docs, int(s["maxPagesPerJob"]))
    except Exception as e:  # unreadable file
        log.exception("render failed")
        _finish_failed(job, f"The document couldn't be opened for reading ({type(e).__name__}). Enter the lines by hand.", outcome="error", pages=0, model=model)
        return True
    if not images:
        _finish_failed(job, "There are no original requisition pages to read.", outcome="error", pages=0, model=model)
        return True
    with tx() as conn:
        reason = limit_reason(conn, job["created_by"], len(images), s)
    if reason:
        _finish_failed(job, reason, outcome="refused_limit", pages=0, model=model)
        return True
    try:
        res, raw, usage, used_model = read_pages(images, programmes, s, key or "")
    except openrouter.OpenRouterError as e:
        _finish_failed(job, str(e), outcome="error", pages=len(images), model=model)
        return True
    except Exception as e:
        log.exception("reading failed")
        _finish_failed(job, f"Reading the document failed ({type(e).__name__}). Retry, or enter the lines by hand.", outcome="error", pages=len(images), model=model)
        return True
    cost = float(usage["cost"] or 0)
    try:
        with tx() as conn:
            req = conn.execute("SELECT * FROM requisitions WHERE id=%s FOR UPDATE", (job["requisition_id"],)).fetchone()
            if req["record_status"] != "processing":
                raise RuntimeError(f"The requisition changed while it was being read (now {req['record_status'].replace('_', ' ')}).")
            n = apply_extraction(conn, req, res)
            conn.execute("UPDATE processing_jobs SET status='completed', completed_at=now(), raw_output=%s, cost_usd=%s, model_name=%s, pages=%s WHERE id=%s",
                         (raw, cost, used_model, len(images), job["id"]))
            record_usage(conn, user_id=job["created_by"], requisition_id=job["requisition_id"], job_id=job["id"], model=used_model,
                         pages=len(images), outcome="ok", cost=cost, prompt_tokens=usage["prompt_tokens"] or None,
                         completion_tokens=usage["completion_tokens"] or None)
            conn.execute("UPDATE requisitions SET record_status='validation_pending' WHERE id=%s", (job["requisition_id"],))
            audit(conn, None, "processing.completed", "processing_job", job["id"], requisition_id=job["requisition_id"],
                  new={"lines": n, "attempt": job["attempt"], "model": used_model, "pages": len(images), "costUsd": cost}, system=True)
            audit(conn, None, "record_status.changed", "requisition", job["requisition_id"], requisition_id=job["requisition_id"],
                  old="processing", new="validation_pending", system=True)
    except Exception as e:
        log.warning("applying extraction failed: %s", e)
        msg = str(e) if isinstance(e, RuntimeError) else f"The suggested lines couldn't be saved ({type(e).__name__}). Enter the lines by hand."
        _finish_failed(job, msg, outcome="error", pages=len(images), model=used_model, cost=cost)
    return True


def _loop() -> None:
    while True:
        try:
            while process_one():
                pass
        except Exception:
            log.exception("worker iteration failed")
        time.sleep(2)


def start_worker() -> None:
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, name="nebula-worker", daemon=True).start()

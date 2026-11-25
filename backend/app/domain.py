"""Business rules shared by the API, ported from app/src/domain/*.ts (V1).
Keep the two in step: the frontend uses the TypeScript versions for display
and analytics, the API uses these to decide what is allowed."""
from __future__ import annotations

import datetime as dt
import re
import unicodedata
from typing import Any, Iterable

from .core.common import lagos_date, minute

# ------------------------------------------------------------------ text & matching
_STOP = {"the", "of", "and", "&"}


def normalize(s: str | None) -> str:
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"(\d)\s*(mg|mcg|g|ml|iu|%)\b", r"\1\2", s)
    s = re.sub(r"[^a-z0-9%.\s]", " ", s)
    return " ".join(w for w in s.split() if w and w not in _STOP)


def _trigrams(s: str) -> set[str]:
    out: set[str] = set()
    for word in s.split(" "):
        w = f"  {word} "
        out.update(w[i:i + 3] for i in range(len(w) - 2))
    return out


def similarity(a: str | None, b: str | None) -> float:
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ta, tb = _trigrams(na), _trigrams(nb)
    inter = len(ta & tb)
    return inter / (len(ta) + len(tb) - inter)


_RANK = {"exact": 6, "alias": 5, "normalized": 4, "historical": 3, "attribute": 2, "fuzzy": 1}


def _push(out: dict, target: str, score: float, method: str) -> None:
    prev = out.get(target)
    if not prev or _RANK[method] > _RANK[prev["method"]] or (_RANK[method] == _RANK[prev["method"]] and score > prev["score"]):
        out[target] = {"targetId": target, "score": score, "method": method}


def _finish(out: dict, limit: int = 5) -> list[dict]:
    rows = sorted(out.values(), key=lambda c: (-_RANK[c["method"]], -c["score"]))[:limit]
    return [{**c, "score": round(c["score"], 2)} for c in rows]


def match_facility(text: str | None, facilities: Iterable[dict], aliases: Iterable[dict], history: Iterable[dict] = ()) -> list[dict]:
    """facilities: {id,name,status}; aliases: approved {entityId,normalized,alias}; history: {facilityId, facilityExtractedText}."""
    n = normalize(text)
    if not n:
        return []
    out: dict = {}
    facs = [f for f in facilities if f.get("status", "active") == "active"]
    raw = (text or "").strip().lower()
    for f in facs:
        if f["name"].strip().lower() == raw:
            _push(out, f["id"], 1, "exact")
        elif normalize(f["name"]) == n:
            _push(out, f["id"], 1, "normalized")
    al = list(aliases)
    for a in al:
        if a["normalized"] == n:
            _push(out, a["entityId"], 1, "alias")
    for h in history:
        if h.get("facilityId") and normalize(h.get("facilityExtractedText")) == n:
            _push(out, h["facilityId"], 0.95, "historical")
    for f in facs:
        s = max([similarity(n, f["name"])] + [similarity(n, a["alias"]) for a in al if a["entityId"] == f["id"]])
        if s >= 0.3:
            _push(out, f["id"], s, "fuzzy")
    return _finish(out)


def _attr_score(item: dict, hint: dict) -> float:
    hits = checks = 0
    for k in ("strength", "form", "packSize"):
        a, b = item.get(k), hint.get(k)
        if a and b:
            checks += 1
            if normalize(a).replace(" ", "") == normalize(b).replace(" ", ""):
                hits += 1
    return hits / checks if checks else 0.0


def match_item(hint: dict, items: Iterable[dict], aliases: Iterable[dict]) -> list[dict]:
    """hint: {text, strength, form, packSize}; items in the md JSON shape."""
    text = hint.get("text")
    n = normalize(text)
    if not n:
        return []
    raw = (text or "").strip().lower()
    out: dict = {}
    its = [i for i in items if i.get("status", "active") == "active"]
    al = list(aliases)
    for i in its:
        full = " ".join(x for x in [i["name"], i.get("strength"), i.get("form")] if x)
        if i.get("code") and i["code"].lower() == raw:
            _push(out, i["id"], 1, "exact")
        if i["name"].strip().lower() == raw or full.lower() == raw:
            _push(out, i["id"], 1, "exact")
        elif normalize(i["name"]) == n or normalize(full) == n:
            _push(out, i["id"], 1, "normalized")
    for a in al:
        if a["normalized"] == n:
            _push(out, a["entityId"], 1, "alias")
    for i in its:
        full = " ".join(x for x in [i["name"], i.get("genericName"), i.get("strength"), i.get("form")] if x)
        t = max([similarity(n, full), similarity(n, i["name"]), similarity(n, i.get("genericName")) if i.get("genericName") else 0.0]
                + [similarity(n, a["alias"]) for a in al if a["entityId"] == i["id"]])
        attr = _attr_score(i, hint)
        if t >= 0.35 and attr >= 0.99:
            _push(out, i["id"], min(1.0, 0.6 * t + 0.4 * attr), "attribute")
        elif t >= 0.25:
            _push(out, i["id"], 0.8 * t + 0.2 * attr, "fuzzy")
    return _finish(out)


# ------------------------------------------------------------------ units
_SYN = {
    "tab": "tablet", "tabs": "tablet", "tablet": "tablet", "tablets": "tablet", "tb": "tablet",
    "cap": "capsule", "caps": "capsule", "capsule": "capsule", "capsules": "capsule",
    "amp": "ampoule", "amps": "ampoule", "ampoule": "ampoule", "ampoules": "ampoule", "ampule": "ampoule",
    "vial": "vial", "vials": "vial", "bottle": "bottle", "bottles": "bottle", "btl": "bottle", "btls": "bottle",
    "sachet": "sachet", "sachets": "sachet", "sach": "sachet",
    "pc": "piece", "pcs": "piece", "piece": "piece", "pieces": "piece", "unit": "piece", "units": "piece", "each": "piece",
    "ctn": "carton", "ctns": "carton", "carton": "carton", "cartons": "carton",
    "pkt": "pack", "pkts": "pack", "pack": "pack", "packs": "pack", "packet": "packet", "packets": "packet",
    "box": "box", "boxes": "box", "bx": "box", "tin": "tin", "tins": "tin", "tube": "tube", "tubes": "tube",
    "roll": "roll", "rolls": "roll", "pair": "pair", "pairs": "pair", "kit": "kit", "kits": "kit",
    "strip": "strip", "strips": "strip", "dose": "dose", "doses": "dose", "ml": "ml", "l": "litre", "litre": "litre", "litres": "litre",
}


def normalize_unit(u: str | None) -> str:
    s = re.sub(r"[^a-z]", "", (u or "").strip().lower())
    return _SYN.get(s, s)


def convert_to_base(item: dict | None, quantity: Any, unit: str | None, conversions: Iterable[dict]) -> dict:
    """conversions: approved rows as dicts {id,itemId,fromUnit,toUnit,factor,incompatible,status}."""
    base_unit = normalize_unit(item.get("baseUnit") if item else None)
    if not item or quantity is None or unit in (None, ""):
        return {"status": "unknown", "baseQuantity": None, "baseUnit": base_unit, "conversionId": None}
    q = float(quantity)
    frm = normalize_unit(unit)
    if frm == base_unit:
        return {"status": "resolved", "baseQuantity": q, "baseUnit": base_unit, "conversionId": None}
    approved = [c for c in conversions if c["status"] == "approved" and normalize_unit(c["fromUnit"]) == frm]
    conv = next((c for c in approved if c.get("itemId") == item["id"]), None) or \
        next((c for c in approved if not c.get("itemId") and normalize_unit(c["toUnit"]) == base_unit), None)
    if not conv:
        return {"status": "unknown", "baseQuantity": None, "baseUnit": base_unit, "conversionId": None}
    if conv.get("incompatible"):
        return {"status": "incompatible", "baseQuantity": None, "baseUnit": base_unit, "conversionId": conv["id"]}
    return {"status": "resolved", "baseQuantity": round(q * float(conv["factor"]), 6), "baseUnit": base_unit, "conversionId": conv["id"]}


# ------------------------------------------------------------------ lifecycle
OPERATIONAL = ["finance", "invoicing", "pick_and_pack", "dispatched", "completed"]
STAGE_LABEL = {"received": "Received", "entered": "Entered", "validated": "Validated", "finance": "Finance", "invoicing": "Invoicing",
               "pick_and_pack": "Pick & Pack", "dispatched": "Dispatched", "completed": "Completed"}


def effective(records: Iterable[dict]) -> list[dict]:
    """Rows with record_type/supersedes_id (snake_case DB rows)."""
    rows = list(records)
    superseded = {r["supersedes_id"] for r in rows if r.get("supersedes_id")}
    return [r for r in rows if r["record_type"] != "void" and r["id"] not in superseded]


def can_supersede(records: Iterable[dict], target_id: str) -> bool:
    rows = list(records)
    t = next((r for r in rows if r["id"] == target_id), None)
    if not t or t["record_type"] == "void":
        return False
    return not any(r.get("supersedes_id") == target_id for r in rows)


def stage_occurrence(events: Iterable[dict], stage: str) -> dt.datetime | None:
    done = [e["occurred_at"] for e in effective(events) if e["stage"] == stage and e["status"] == "completed"]
    return min(done) if done else None


def can_record_stage(req: dict, events: list[dict], stage: str) -> str | None:
    if req["record_status"] == "cancelled":
        return "This requisition is cancelled."
    if not req["first_validated_at"]:
        return "Validate the requisition before recording operational stages."
    eff = effective(events)
    for prev in OPERATIONAL[: OPERATIONAL.index(stage)]:
        if not any(e["stage"] == prev for e in eff):
            return f"Record {STAGE_LABEL[prev]} first (Completed or Not Applicable)."
    if stage == "completed" and any(e["stage"] == "completed" for e in eff):
        return "Completed is already recorded. Correct the existing event instead."
    return None


def chronology_errors(req: dict, events: list[dict], stage: str, occurred_at: dt.datetime, *, ignore_event_id: str | None = None,
                      override: bool = False, now: dt.datetime | None = None) -> tuple[list[str], list[str]]:
    """(hard errors, overridable errors), compared at minute precision (PRD §12.7)."""
    hard: list[str] = []
    soft: list[str] = []
    t = minute(occurred_at)
    if t > minute(now or dt.datetime.now(dt.timezone.utc)):
        hard.append("The date can't be in the future.")
    if t < minute(req["received_at"]):
        soft.append("It's earlier than when the requisition was received.")
    elif t < minute(req["entry_at"]):
        soft.append("It's earlier than when the requisition was entered in Nebula.")
    elif req["first_validated_at"] and t < minute(req["first_validated_at"]):
        soft.append("It's earlier than when the requisition was first validated.")
    masked = [e for e in events if e["id"] != ignore_event_id] if ignore_event_id else events
    idx = OPERATIONAL.index(stage)
    for i, s in enumerate(OPERATIONAL):
        if i == idx:
            continue
        occ = stage_occurrence(masked, s)
        if not occ:
            continue
        if i < idx and t < minute(occ):
            hard.append(f"It's earlier than {STAGE_LABEL[s]}, which is already recorded.")
        if i > idx and t > minute(occ):
            hard.append(f"It's later than {STAGE_LABEL[s]}, which is already recorded.")
    return hard, ([] if override else soft)


# ------------------------------------------------------------------ records
EDITABLE_STATUSES = {"draft", "validation_pending", "validated", "reopened"}
HEADER_FIELDS = {
    "facilityId": "facility_id", "facilityExtractedText": "facility_extracted_text", "primaryProgrammeId": "primary_programme_id",
    "requisitionDate": "requisition_date", "requisitionDateEstimated": "requisition_date_estimated", "receivedAt": "received_at",
    "receivedVia": "received_via",
}
LINE_FIELDS = {
    "itemId": "item_id", "programmeId": "programme_id", "quantityRequested": "quantity_requested", "unitRequested": "unit_requested",
    "strength": "strength", "form": "form", "packSize": "pack_size", "correctedText": "corrected_text",
    "itemExtractedText": "item_extracted_text", "pageNumber": "page_number", "programmeOverridden": "programme_overridden",
}


def status_after_edit(s: str) -> str:
    return "validation_pending" if s == "validated" else s


def validation_issues(req: dict, lines: list[dict], facility_ids: set[str], item_ids: set[str], programme_ids: set[str],
                      job_running: bool, now: dt.datetime | None = None) -> list[str]:
    """req and lines are DB rows (snake_case)."""
    out: list[str] = []
    nw = now or dt.datetime.now(dt.timezone.utc)
    if not req["facility_id"] or req["facility_id"] not in facility_ids:
        out.append("Match the facility to the Facility master.")
    if not req["requisition_date"]:
        out.append("Enter the requisition date (mark it as estimated if it isn't on the document).")
    if minute(req["received_at"]) > minute(nw):
        out.append("Received at can't be in the future.")
    if req["received_at"] > req["entry_at"]:
        out.append("Received at can't be later than when the requisition was entered.")
    if req["requisition_date"] and req["requisition_date"] > lagos_date(req["received_at"]):
        out.append("The requisition date can't be later than the date it was received.")
    if not lines:
        out.append("Add at least one requisition line.")
    for l in sorted(lines, key=lambda x: ((x["page_number"] or 0), x["line_number"])):
        tag = f"Line {l['line_number']}" + (f" (page {l['page_number']})" if l["page_number"] else "")
        if not l["item_id"] or l["item_id"] not in item_ids:
            out.append(f"{tag}: match the item.")
        if not l["programme_id"] or l["programme_id"] not in programme_ids:
            out.append(f"{tag}: choose a programme.")
        if l["quantity_requested"] is None or float(l["quantity_requested"]) <= 0:
            out.append(f"{tag}: enter a requested quantity above 0.")
        if not l["unit_requested"]:
            out.append(f"{tag}: enter the unit as written.")
        if not l["conversion_status"]:
            out.append(f"{tag}: unit conversion not checked.")
    if job_running:
        out.append("Wait for document reading to finish.")
    return out


def edit_covers(changes: list[dict], entity_type: str, entity_id: str | None, field: str) -> bool:
    return any(c.get("entityType") == entity_type and (c.get("field") in (field, "*")) and (c.get("entityId") or "") == (entity_id or "")
               for c in changes)

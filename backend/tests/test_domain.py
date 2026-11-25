import datetime as dt

from app.domain import chronology_errors, convert_to_base, match_facility, match_item, normalize, normalize_unit, similarity

U = dt.timezone.utc


def test_normalize_and_similarity_match_v1():
    assert normalize("Amoxicillin 500 mg Caps") == "amoxicillin 500mg caps"
    assert similarity("Paracetamol", "paracetamol") == 1
    assert normalize_unit("Tabs") == "tablet"


def test_conversion_requires_approval():
    item = {"id": "pcm", "baseUnit": "tablet"}
    conv = [{"id": "c1", "itemId": "pcm", "fromUnit": "carton", "toUnit": "tablet", "factor": 100, "status": "approved"}]
    assert convert_to_base(item, 20, "ctns", conv)["baseQuantity"] == 2000
    assert convert_to_base(item, 3, "tin", conv)["status"] == "unknown"
    assert convert_to_base(item, 20, "carton", [{**conv[0], "status": "proposed"}])["status"] == "unknown"


def test_matching():
    facs = [{"id": "f1", "name": "Government House Clinic", "status": "active"}]
    assert match_facility("Govt House Clinic", facs, [])[0]["targetId"] == "f1"
    items = [{"id": "a", "code": "AMX500", "name": "Amoxicillin", "strength": "500mg", "form": "capsule", "status": "active"}]
    assert match_item({"text": "amoxicillin caps 500 mg", "strength": "500mg"}, items, [])[0]["targetId"] == "a"


def test_chronology_minute_precision():
    req = {"received_at": dt.datetime(2026, 11, 1, 8, tzinfo=U), "entry_at": dt.datetime(2026, 11, 1, 9, 0, 30, tzinfo=U),
           "first_validated_at": dt.datetime(2026, 11, 1, 9, 5, 40, tzinfo=U)}
    now = dt.datetime(2026, 11, 5, tzinfo=U)
    hard, soft = chronology_errors(req, [], "finance", dt.datetime(2026, 11, 1, 9, 5, tzinfo=U), now=now)
    assert hard == [] and soft == []
    hard, soft = chronology_errors(req, [], "finance", dt.datetime(2026, 12, 1, tzinfo=U), now=now)
    assert "future" in hard[0]
    hard, soft = chronology_errors(req, [], "finance", dt.datetime(2026, 11, 1, 7, tzinfo=U), now=now)
    assert soft and not hard
    assert chronology_errors(req, [], "finance", dt.datetime(2026, 11, 1, 7, tzinfo=U), now=now, override=True)[1] == []

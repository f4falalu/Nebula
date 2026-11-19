import { describe, expect, it } from "vitest";
import { aggregate, collectLines, dropOff, lineMetrics, requisitionAggregate } from "../src/domain/ofr";
import { canRecordStage, chronologyErrors, currentStage, effective, stageViews } from "../src/domain/lifecycle";
import { closeFulfillmentIssues, validationIssues, canDecideEditRequest, effectiveEditStatus } from "../src/domain/records";
import { formatRequisitionNumber, similarity } from "../src/domain/text";
import { convertToBase, normalizeUnit } from "../src/domain/units";
import { lagosDate, fromLagosLocal, bucketKey } from "../src/domain/time";
import { matchFacility, matchItem } from "../src/domain/matching";
import { can, resolveActor } from "../src/domain/permissions";
import { DEFAULT_SETTINGS, type FulfillmentRecord, type MasterData, type Requisition, type RequisitionLine } from "../src/domain/types";

const T = "2026-11-01T09:00:00.000Z";

function md(extra: Partial<MasterData> = {}): MasterData {
  return {
    facilities: { f1: { id: "f1", name: "Government House Clinic", status: "active", createdAt: T, updatedAt: T } },
    items: {
      amox500: { id: "amox500", code: "AMX500", name: "Amoxicillin", strength: "500mg", form: "capsule", baseUnit: "capsule", status: "active", createdAt: T, updatedAt: T },
      amox250: { id: "amox250", code: "AMX250", name: "Amoxicillin", strength: "250mg", form: "capsule", baseUnit: "capsule", status: "active", createdAt: T, updatedAt: T },
      pcm: { id: "pcm", code: "PCM500", name: "Paracetamol", strength: "500mg", form: "tablet", baseUnit: "tablet", status: "active", createdAt: T, updatedAt: T },
    },
    programmes: { p1: { id: "p1", name: "DRF", status: "active" } },
    conversions: {
      c1: { id: "c1", itemId: "pcm", fromUnit: "carton", toUnit: "tablet", factor: 100, status: "approved", proposedBy: "u", proposedAt: T },
    },
    equivalences: {},
    aliases: {},
    settings: DEFAULT_SETTINGS,
    ...extra,
  };
}

function line(id: string, itemId: string, base: number | null, extra: Partial<RequisitionLine> = {}): RequisitionLine {
  return {
    id, lineNumber: 1, itemId, programmeId: "p1", quantityRequested: base ?? 5, unitRequested: "capsule",
    baseQuantityRequested: base, baseUnit: "capsule", conversionStatus: base == null ? "unknown" : "resolved",
    createdAt: T, updatedAt: T, ...extra,
  };
}

let n = 0;
function rec(lineId: string | null, itemId: string, stage: FulfillmentRecord["stage"], base: number | null, extra: Partial<FulfillmentRecord> = {}): FulfillmentRecord {
  n++;
  return {
    id: `r${n}`, requisitionLineId: lineId, itemId, stage, quantity: base, unit: "capsule", baseQuantity: base, baseUnit: "capsule",
    conversionStatus: base == null ? "unknown" : "resolved", substitution: false, additional: lineId == null,
    occurredAt: T, recordedAt: T, recordedBy: "u", recordType: "entry", ...extra,
  };
}

function req(lines: RequisitionLine[], recs: FulfillmentRecord[], extra: Partial<Requisition> = {}): Requisition {
  return {
    id: "q1", number: "REQ-26-11-01_001", entryDate: "2026-11-01", entrySerial: 1, facilityId: "f1", requisitionDate: "2026-10-30",
    receivedAt: "2026-11-01T08:00:00.000Z", entryAt: T, recordStatus: "finalized", fulfillmentStatus: "closed",
    createdBy: "u", createdAt: T, updatedAt: T,
    documents: {}, pages: {}, lines: Object.fromEntries(lines.map((l) => [l.id, l])),
    events: {}, fulfillment: Object.fromEntries(recs.map((r) => [r.id, r])), editRequests: {},
    firstValidatedAt: "2026-11-01T10:00:00.000Z",
    ...extra,
  };
}

describe("OFR", () => {
  it("caps per line before aggregation (PRD §21.11)", () => {
    const r = req([line("A", "amox500", 600), line("B", "pcm", 400, { baseUnit: "tablet" })], [
      rec("A", "amox500", "issued", 700),
      rec("B", "pcm", "issued", 200),
    ]);
    const a = requisitionAggregate(r, md());
    expect(a.issued.ofr).toBe(80); // not 90
    expect(a.issued.over).toBe(100);
    expect(a.issued.overLines).toBe(1);
    expect(a.issued.skuRate).toBe(50);
  });

  it("excludes lines with unknown conversion and reports coverage", () => {
    const r = req([line("A", "amox500", 100), line("B", "amox500", null)], [rec("A", "amox500", "issued", 50)]);
    const a = requisitionAggregate(r, md());
    expect(a.issued.ofr).toBe(50);
    expect(a.issued.coverage).toBe(50);
    expect(a.issued.exclusions.request_conversion_unknown).toBe(1);
  });

  it("excludes a stage when a fulfillment record's conversion is unresolved (not zero)", () => {
    const r = req([line("A", "amox500", 100)], [rec("A", "amox500", "issued", null)]);
    const a = requisitionAggregate(r, md());
    expect(a.issued.eligibleLines).toBe(0);
    expect(a.issued.exclusions.fulfillment_conversion_unresolved).toBe(1);
    expect(a.invoiced.eligibleLines).toBe(1);
  });

  it("does not credit substitutions without an approved equivalence", () => {
    const r = req([line("A", "amox500", 20)], [rec("A", "amox250", "issued", 40, { substitution: true })]);
    const a = requisitionAggregate(r, md());
    expect(a.issued.ofr).toBe(0);
    expect(a.issued.uncreditedSubstitutionLines).toBe(1);
  });

  it("credits substitutions through an approved equivalence factor", () => {
    const m = md({
      equivalences: { e1: { id: "e1", requestedItemId: "amox500", substituteItemId: "amox250", factor: 0.5, basis: ["strength"], justification: "", status: "approved", proposedBy: "u", proposedAt: T } },
    });
    const r = req([line("A", "amox500", 20)], [rec("A", "amox250", "issued", 40, { substitution: true })]);
    expect(requisitionAggregate(r, m).issued.ofr).toBe(100);
  });

  it("excludes additional items from numerator and denominator", () => {
    const r = req([line("A", "amox500", 100)], [rec("A", "amox500", "issued", 50), rec(null, "pcm", "issued", 1000)]);
    const a = requisitionAggregate(r, md());
    expect(a.issued.ofr).toBe(50);
    expect(a.issued.requested).toBe(100);
  });

  it("counts only effective records after a correction (no double counting)", () => {
    const first = rec("A", "amox500", "issued", 50);
    const corr = rec("A", "amox500", "issued", 40, { recordType: "correction", supersedesId: first.id, correctionReason: "typo" });
    const r = req([line("A", "amox500", 100)], [first, corr]);
    expect(requisitionAggregate(r, md()).issued.credited).toBe(40);
  });

  it("void removes a record from the effective set", () => {
    const first = rec("A", "amox500", "issued", 50);
    const v = rec("A", "amox500", "issued", null, { recordType: "void", supersedesId: first.id, quantity: null });
    const r = req([line("A", "amox500", 100)], [first, v]);
    expect(effective(r.fulfillment)).toHaveLength(0);
    expect(requisitionAggregate(r, md()).issued.ofr).toBe(0);
  });

  it("sums split deliveries", () => {
    const r = req([line("A", "amox500", 100)], [rec("A", "amox500", "delivered", 40), rec("A", "amox500", "delivered", 30), rec("A", "amox500", "delivered", 30)]);
    expect(requisitionAggregate(r, md()).delivered.ofr).toBe(100);
  });

  it("official scope requires Finalized + Closed", () => {
    const open = req([line("A", "amox500", 100)], [rec("A", "amox500", "issued", 50)], { fulfillmentStatus: "partial" });
    expect(collectLines([open], md(), { scope: "official", basis: "received" })).toHaveLength(0);
    expect(collectLines([open], md(), { scope: "in_progress", basis: "received" })).toHaveLength(1);
    const reopened = { ...open, recordStatus: "reopened" as const, fulfillmentStatus: "closed" as const };
    expect(collectLines([reopened], md(), { scope: "in_progress", basis: "received" })).toHaveLength(0);
  });

  it("aggregates by summed quantity, never by averaging percentages", () => {
    const r1 = req([line("A", "amox500", 1000)], [rec("A", "amox500", "issued", 1000)]);
    const r2 = req([line("B", "amox500", 10)], [rec("B", "amox500", "issued", 0)], { id: "q2" });
    const lines = collectLines([r1, r2], md(), { scope: "official", basis: "received" });
    expect(aggregate(lines).issued.ofr).toBeCloseTo((1000 / 1010) * 100);
  });

  it("drop-off uses lines eligible at all stages", () => {
    const r = req([line("A", "amox500", 1000)], [rec("A", "amox500", "invoiced", 950), rec("A", "amox500", "issued", 900), rec("A", "amox500", "delivered", 875)]);
    const d = dropOff([lineMetrics(r, r.lines.A!, md())]);
    expect(d.delivered.pct).toBe(87.5);
  });
});

describe("units", () => {
  it("normalizes synonyms and converts with approved conversions only", () => {
    const m = md();
    expect(normalizeUnit("Tabs")).toBe("tablet");
    expect(convertToBase(m.items.pcm, 20, "ctns", m.conversions)).toMatchObject({ status: "resolved", baseQuantity: 2000 });
    expect(convertToBase(m.items.pcm, 3, "tin", m.conversions)).toMatchObject({ status: "unknown", baseQuantity: null });
    const proposed = { ...m.conversions, c1: { ...m.conversions.c1, status: "proposed" as const } };
    expect(convertToBase(m.items.pcm, 20, "carton", proposed).status).toBe("unknown");
  });
});

describe("lifecycle", () => {
  const base = req([line("A", "amox500", 10)], []);
  it("derives foundational stages from authoritative timestamps", () => {
    const v = stageViews(base);
    expect(v[0]).toMatchObject({ stage: "received", status: "completed", occurredAt: base.receivedAt });
    expect(v[1]).toMatchObject({ stage: "entered", occurredAt: base.entryAt });
    expect(currentStage(base)).toBe("validated");
  });
  it("requires earlier operational stages first", () => {
    expect(canRecordStage(base, "invoicing")).toMatch(/Finance/);
    expect(canRecordStage(base, "finance")).toBeNull();
  });
  it("rejects future dates and out-of-order dates; overridable pre-entry dates", () => {
    const now = "2026-11-05T00:00:00.000Z";
    expect(chronologyErrors(base, "finance", "2026-12-01T00:00:00.000Z", { now }).hard[0]).toMatch(/future/);
    expect(chronologyErrors(base, "finance", "2026-11-01T07:00:00.000Z", { now }).overridable.length).toBe(1);
    expect(chronologyErrors(base, "finance", "2026-11-01T07:00:00.000Z", { now, override: true }).overridable.length).toBe(0);
    const withFinance = { ...base, events: { e1: { id: "e1", stage: "finance" as const, status: "completed" as const, occurredAt: "2026-11-03T00:00:00.000Z", recordedAt: now, recordedBy: "u", recordType: "entry" as const } } };
    expect(chronologyErrors(withFinance, "invoicing", "2026-11-02T00:00:00.000Z", { now }).hard.length).toBe(1);
  });
});

describe("records", () => {
  it("closing fulfillment needs Completed or a reason", () => {
    const r = req([line("A", "amox500", 10)], [], { fulfillmentStatus: "partial" });
    expect(closeFulfillmentIssues(r)).toHaveLength(1);
    expect(closeFulfillmentIssues(r, "Not supplied: stock-out")).toHaveLength(0);
  });
  it("validation catches missing programme and future received", () => {
    const r = req([line("A", "amox500", 10, { programmeId: undefined })], [], { receivedAt: "2099-01-01T00:00:00.000Z" });
    const issues = validationIssues(r, md());
    expect(issues.some((i) => i.includes("programme"))).toBe(true);
    expect(issues.some((i) => i.includes("future"))).toBe(true);
  });
  it("blocks self-approval and expires approvals", () => {
    const er = { id: "e", requestedBy: "u1", requestedAt: T, reason: "x", changes: [], status: "approved" as const, approvalExpiresAt: "2026-11-02T00:00:00.000Z" };
    expect(canDecideEditRequest({ ...er, status: "pending" }, "u1")).toMatch(/own/);
    expect(effectiveEditStatus(er, 7, "2026-11-03T00:00:00.000Z")).toBe("expired");
  });
});

describe("misc", () => {
  it("formats requisition numbers without a 99 cap", () => {
    expect(formatRequisitionNumber("2026-11-19", 1)).toBe("REQ-26-11-19_001");
    expect(formatRequisitionNumber("2026-11-19", 1000)).toBe("REQ-26-11-19_1000");
  });
  it("uses Lagos dates", () => {
    expect(lagosDate("2026-11-18T23:30:00.000Z")).toBe("2026-11-19");
    expect(fromLagosLocal("2026-11-19T00:30")).toBe("2026-11-18T23:30:00.000Z");
    expect(bucketKey("2026-11-19", "quarter")).toBe("2026-Q4");
  });
  it("matches facilities and items", () => {
    expect(matchFacility("Govt House Clinic", md())[0].targetId).toBe("f1");
    expect(matchItem({ text: "amoxicillin caps 500 mg", strength: "500mg" }, md())[0].targetId).toBe("amox500");
    expect(similarity("Paracetamol", "paracetamol")).toBe(1);
  });
  it("applies role ceilings and grants", () => {
    const sup = resolveActor("s", "supervisor");
    expect(can(sup, "lifecycle.record")).toBe(false);
    const ra = resolveActor("r", "ra", { role: "supervisor", grants: ["requisition.reopen"], updatedBy: "a", updatedAt: T });
    expect(ra.role).toBe("supervisor");
    expect(can(ra, "requisition.reopen")).toBe(true);
    expect(can(resolveActor("a", "admin"), "edit_request.approve")).toBe(true);
    expect(can(resolveActor("r2", "ra"), "edit_request.approve")).toBe(false);
  });
});

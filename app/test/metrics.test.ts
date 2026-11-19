import { describe, expect, it } from "vitest";
import { bottlenecks, facilityRanking, frequency, isDeclining, itemPerformance, ofrTrend, processingTimes, recordingLatency, substitutions } from "../src/domain/metrics";
import { collectLines } from "../src/domain/ofr";
import { DEFAULT_SETTINGS, type FulfillmentRecord, type LifecycleEvent, type MasterData, type Requisition, type RequisitionLine } from "../src/domain/types";

const T = "2026-11-01T09:00:00.000Z";

function md(): MasterData {
  return {
    facilities: { f1: { id: "f1", name: "Government House Clinic", status: "active", createdAt: T, updatedAt: T } },
    items: {
      a: { id: "a", code: "A", name: "Amoxicillin", strength: "500mg", baseUnit: "capsule", status: "active", createdAt: T, updatedAt: T },
      b: { id: "b", code: "B", name: "Amoxicillin", strength: "250mg", baseUnit: "capsule", status: "active", createdAt: T, updatedAt: T },
    },
    programmes: { p1: { id: "p1", name: "DRF", status: "active" } },
    conversions: {},
    equivalences: {},
    aliases: {},
    settings: DEFAULT_SETTINGS,
  };
}

function line(id: string, itemId: string, base: number): RequisitionLine {
  return { id, lineNumber: 1, itemId, programmeId: "p1", quantityRequested: base, unitRequested: "capsule", baseQuantityRequested: base, baseUnit: "capsule", conversionStatus: "resolved", createdAt: T, updatedAt: T };
}
let n = 0;
function rec(lineId: string, itemId: string, stage: FulfillmentRecord["stage"], base: number, extra: Partial<FulfillmentRecord> = {}): FulfillmentRecord {
  n++;
  return { id: `r${n}`, requisitionLineId: lineId, itemId, stage, quantity: base, unit: "capsule", baseQuantity: base, baseUnit: "capsule", conversionStatus: "resolved", substitution: false, additional: false, occurredAt: T, recordedAt: T, recordedBy: "u", recordType: "entry", ...extra };
}
function ev(stage: LifecycleEvent["stage"], occurredAt: string, extra: Partial<LifecycleEvent> = {}): LifecycleEvent {
  n++;
  return { id: `e${n}`, stage, status: "completed", occurredAt, recordedAt: occurredAt, recordedBy: "u", recordType: "entry", ...extra };
}
function req(id: string, extra: Partial<Requisition> = {}): Requisition {
  return {
    id, number: id, entryDate: "2026-11-01", entrySerial: 1, facilityId: "f1", requisitionDate: "2026-10-30",
    receivedAt: "2026-11-01T07:00:00.000Z", entryAt: "2026-11-01T09:00:00.000Z", firstValidatedAt: "2026-11-01T10:00:00.000Z",
    recordStatus: "finalized", fulfillmentStatus: "closed", createdBy: "u", createdAt: T, updatedAt: T,
    documents: {}, pages: {}, lines: {}, events: {}, fulfillment: {}, editRequests: {}, ...extra,
  };
}
const byId = <X extends { id: string }>(xs: X[]) => Object.fromEntries(xs.map((x) => [x.id, x]));

describe("processing times", () => {
  it("computes the §22.1 metrics and excludes estimated dates", () => {
    const r1 = req("q1", { events: byId([ev("finance", "2026-11-02T00:00:00.000Z"), ev("invoicing", "2026-11-02T01:00:00.000Z"), ev("pick_and_pack", "2026-11-02T02:00:00.000Z"), ev("dispatched", "2026-11-02T03:00:00.000Z"), ev("completed", "2026-11-03T00:00:00.000Z")]) });
    const r2 = req("q2", { requisitionDateEstimated: true });
    const p = processingTimes([r1, r2]);
    expect(p.raProcessingHours.avg).toBe(2);
    expect(p.reqToEntryDays).toEqual({ avg: 2, count: 1 });
    expect(p.facilityToReceiptDays.avg).toBe(2);
    expect(p.reqToCompletionDays.avg).toBe(4);
    expect(p.excludedEstimated).toBe(1);
  });
});

describe("bottlenecks", () => {
  it("measures across Not Applicable stages and excludes overrides", () => {
    const r = req("q", {
      events: byId([
        ev("finance", "2026-11-01T11:00:00.000Z", { status: "not_applicable", notApplicableReason: "Free programme" }),
        ev("invoicing", "2026-11-01T14:00:00.000Z"),
      ]),
    });
    const rows = bottlenecks([r]);
    const fin = rows.find((x) => x.to === "finance")!;
    const inv = rows.find((x) => x.to === "invoicing")!;
    expect(fin.count).toBe(0);
    expect(inv.avgHours).toBe(4); // from Validated (10:00)
    const o = req("o", { events: byId([ev("finance", "2026-11-01T08:00:00.000Z", { chronologyOverride: true, overrideReason: "backfill" })]) });
    const fo = bottlenecks([o]).find((x) => x.to === "finance")!;
    expect(fo.excludedOverride).toBe(1);
    expect(fo.count).toBe(0);
  });
  it("ignores superseded events", () => {
    const e1 = ev("finance", "2026-11-01T20:00:00.000Z");
    const e2 = ev("finance", "2026-11-01T12:00:00.000Z", { recordType: "correction", supersedesId: e1.id, correctionReason: "x" });
    expect(bottlenecks([req("q", { events: byId([e1, e2]) })]).find((x) => x.to === "finance")!.avgHours).toBe(2);
  });
});

describe("latency and frequency", () => {
  it("recording latency by stage and user", () => {
    const r = req("q", { events: byId([ev("finance", "2026-11-01T11:00:00.000Z", { recordedAt: "2026-11-01T15:00:00.000Z", recordedBy: "ra1" })]) });
    const l = recordingLatency([r]);
    expect(l.byStage[0]).toMatchObject({ label: "Finance event", avgHours: 4 });
    expect(l.byUser[0]).toMatchObject({ key: "ra1", avgHours: 4 });
  });
  it("frequency averages days between requisitions", () => {
    const f = frequency([req("a", { receivedAt: "2026-11-01T07:00:00.000Z" }), req("b", { receivedAt: "2026-11-11T07:00:00.000Z" })]);
    expect(f.avgDaysBetween).toBe(10);
    expect(f.requisitions).toBe(2);
  });
});

describe("trends and rankings", () => {
  const filter = { scope: "official" as const, basis: "received" as const };
  const oct = req("oct", { receivedAt: "2026-10-05T07:00:00.000Z", entryAt: "2026-10-05T09:00:00.000Z", entryDate: "2026-10-05", requisitionDate: "2026-10-04", lines: byId([line("l1", "a", 100)]), fulfillment: byId([rec("l1", "a", "issued", 90)]) });
  const nov = req("nov", { lines: byId([line("l2", "a", 100)]), fulfillment: byId([rec("l2", "b", "issued", 50, { substitution: true })]) });
  it("trend buckets by month and detects decline", () => {
    const t = ofrTrend(collectLines([oct, nov], md(), filter), "received", "month");
    expect(t.map((p) => p.key)).toEqual(["2026-10", "2026-11"]);
    expect(t[0].agg.issued.ofr).toBe(90);
    expect(t[1].agg.issued.ofr).toBe(0);
    expect(isDeclining(t, "issued")).toBe(true);
  });
  it("facility and item rows", () => {
    const f = facilityRanking([oct, nov], md(), filter);
    expect(f[0]).toMatchObject({ facilityId: "f1", requisitions: 2, shortfall: 110, declining: true });
    const i = itemPerformance([oct, nov], md(), filter);
    expect(i[0]).toMatchObject({ itemId: "a", lines: 2, uncreditedLines: 1 });
    const s = substitutions([oct, nov], md());
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ requestedItemId: "a", suppliedItemId: "b", credited: false });
  });
});

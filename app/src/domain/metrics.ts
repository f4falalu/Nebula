// Processing time, lifecycle bottlenecks, recording latency, frequency,
// trends and rankings (PRD §22, §23, §24, §25, §27). Pure functions.
import {
  FULFILLMENT_STAGES,
  LIFECYCLE_STAGES,
  type FulfillmentStage,
  type LifecycleStage,
  type MasterData,
  type Requisition,
  type TimeBasis,
  type DateStr,
} from "./types";
import { effective, stageViews, STAGE_LABEL } from "./lifecycle";
import { aggregate, basisDate, collectLines, inRange, inScope, type Aggregate, type LineFilter, type LineMetrics, type Scope } from "./ofr";
import { activeLines } from "./records";
import { bucketKey, daysBetween, hoursBetween, lagosDate, type Bucket } from "./time";

export interface Avg {
  avg: number | null;
  count: number;
}

function avgOf(xs: number[]): Avg {
  return { avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, count: xs.length };
}

export function completedAt(req: Requisition): string | undefined {
  return stageViews(req).find((v) => v.stage === "completed" && v.status === "completed")?.occurredAt;
}

/** Requisitions matching scope + period (on the chosen basis) + optional facility. */
export function filterReqs(reqs: Requisition[], f: Omit<Pick<LineFilter, "basis" | "from" | "to" | "facilityId">, never> & { scope: Scope | "all" }): Requisition[] {
  return reqs.filter(
    (r) =>
      r.recordStatus !== "cancelled" &&
      (f.scope === "all" || inScope(r, f.scope)) &&
      (!f.facilityId || r.facilityId === f.facilityId) &&
      inRange(basisDate(r, f.basis), f.from, f.to),
  );
}

export interface ProcessingTimes {
  facilityToReceiptDays: Avg;
  raProcessingHours: Avg;
  reqToEntryDays: Avg;
  reqToCompletionDays: Avg;
  receiptToCompletionHours: Avg;
  excludedEstimated: number; // requisitions left out of requisition-date metrics
}

/** §22.1. Requisition-date metrics exclude estimated dates. */
export function processingTimes(reqs: Requisition[]): ProcessingTimes {
  const f2r: number[] = [], ra: number[] = [], r2e: number[] = [], r2c: number[] = [], rc2: number[] = [];
  let excluded = 0;
  for (const r of reqs) {
    ra.push(hoursBetween(r.receivedAt, r.entryAt));
    const done = completedAt(r);
    if (done) rc2.push(hoursBetween(r.receivedAt, done));
    if (!r.requisitionDate) continue;
    if (r.requisitionDateEstimated) {
      excluded++;
      continue;
    }
    f2r.push(daysBetween(r.requisitionDate, lagosDate(r.receivedAt)));
    r2e.push(daysBetween(r.requisitionDate, r.entryDate));
    if (done) r2c.push(daysBetween(r.requisitionDate, lagosDate(done)));
  }
  return {
    facilityToReceiptDays: avgOf(f2r),
    raProcessingHours: avgOf(ra),
    reqToEntryDays: avgOf(r2e),
    reqToCompletionDays: avgOf(r2c),
    receiptToCompletionHours: avgOf(rc2),
    excludedEstimated: excluded,
  };
}

export interface BottleneckRow {
  from: LifecycleStage;
  to: LifecycleStage;
  label: string;
  avgHours: number | null;
  count: number;
  excludedOverride: number;
}

/**
 * §22.3. For each stage, the interval from the most recent earlier Completed
 * stage to its earliest effective Completed event. Not Applicable stages have
 * no interval of their own. Intervals touching a chronology-override event are
 * excluded and counted.
 */
export function bottlenecks(reqs: Requisition[]): BottleneckRow[] {
  const acc = new Map<LifecycleStage, { xs: number[]; excl: number }>();
  for (const s of LIFECYCLE_STAGES.slice(1)) acc.set(s, { xs: [], excl: 0 });
  for (const r of reqs) {
    const views = stageViews(r);
    const overridden = new Set<LifecycleStage>();
    for (const e of effective(r.events)) if (e.chronologyOverride) overridden.add(e.stage);
    let prev: { stage: LifecycleStage; at: string } | null = null;
    for (const v of views) {
      if (v.status !== "completed" || !v.occurredAt) continue;
      if (prev) {
        const a = acc.get(v.stage)!;
        if (overridden.has(v.stage) || overridden.has(prev.stage)) a.excl++;
        else a.xs.push(hoursBetween(prev.at, v.occurredAt));
      }
      prev = { stage: v.stage, at: v.occurredAt };
    }
  }
  return LIFECYCLE_STAGES.slice(1).map((to, i) => {
    const from = LIFECYCLE_STAGES[i];
    const a = acc.get(to)!;
    const m = avgOf(a.xs);
    return { from, to, label: `${STAGE_LABEL[from]} → ${STAGE_LABEL[to]}`, avgHours: m.avg, count: m.count, excludedOverride: a.excl };
  });
}

export interface LatencyRow {
  key: string;
  label: string;
  avgHours: number | null;
  count: number;
}

/** §22.4. recordedAt − occurredAt for effective lifecycle events and fulfillment records. */
export function recordingLatency(reqs: Requisition[]): { byStage: LatencyRow[]; byUser: LatencyRow[] } {
  const stage = new Map<string, number[]>();
  const user = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, v: number) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  for (const r of reqs) {
    for (const e of effective(r.events)) {
      if (e.status !== "completed") continue;
      const h = hoursBetween(e.occurredAt, e.recordedAt);
      push(stage, `event:${e.stage}`, h);
      push(user, e.recordedBy, h);
    }
    for (const f of effective(r.fulfillment)) {
      const h = hoursBetween(f.occurredAt, f.recordedAt);
      push(stage, `fulfillment:${f.stage}`, h);
      push(user, f.recordedBy, h);
    }
  }
  const FL: Record<FulfillmentStage, string> = { invoiced: "Invoiced quantities", issued: "Issued quantities", delivered: "Delivered quantities" };
  const label = (k: string) => {
    const [kind, s] = k.split(":");
    return kind === "event" ? `${STAGE_LABEL[s as LifecycleStage]} event` : FL[s as FulfillmentStage];
  };
  const order = [...LIFECYCLE_STAGES.map((s) => `event:${s}`), ...FULFILLMENT_STAGES.map((s) => `fulfillment:${s}`)];
  const byStage = order.filter((k) => stage.has(k)).map((k) => ({ key: k, label: label(k), ...toRow(stage.get(k)!) }));
  const byUser = [...user.entries()].map(([k, xs]) => ({ key: k, label: k, ...toRow(xs) })).sort((a, b) => (b.avgHours ?? 0) - (a.avgHours ?? 0));
  return { byStage, byUser };
}

function toRow(xs: number[]) {
  const a = avgOf(xs);
  return { avgHours: a.avg, count: a.count };
}

export interface Frequency {
  requisitions: number;
  months: number;
  perMonth: number | null;
  avgDaysBetween: number | null;
}

/** Requisition frequency by received date. `months` spans from first to last (min 1), or the given range. */
export function frequency(reqs: Requisition[], range?: { from?: DateStr; to?: DateStr }): Frequency {
  const dates = reqs.map((r) => lagosDate(r.receivedAt)).sort();
  if (!dates.length) return { requisitions: 0, months: 0, perMonth: null, avgDaysBetween: null };
  const from = range?.from ?? dates[0];
  const to = range?.to ?? dates[dates.length - 1];
  const months = Math.max(1, (daysBetween(from, to) + 1) / 30.44);
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
  return { requisitions: dates.length, months, perMonth: dates.length / months, avgDaysBetween: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null };
}

export interface TrendPoint {
  key: string;
  agg: Aggregate;
}

/** OFR per time bucket (by the filter's basis), ascending. */
export function ofrTrend(lines: LineMetrics[], basis: TimeBasis, bucket: Bucket): TrendPoint[] {
  const groups = new Map<string, LineMetrics[]>();
  for (const lm of lines) {
    const d = basisDate(lm.req, basis);
    if (!d) continue;
    const k = bucketKey(d, bucket);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(lm);
  }
  return [...groups.keys()].sort().map((key) => ({ key, agg: aggregate(groups.get(key)!) }));
}

export function groupLines(lines: LineMetrics[], key: (lm: LineMetrics) => string | undefined): Map<string, LineMetrics[]> {
  const m = new Map<string, LineMetrics[]>();
  for (const lm of lines) {
    const k = key(lm);
    if (!k) continue;
    (m.get(k) ?? m.set(k, []).get(k)!).push(lm);
  }
  return m;
}

export interface FacilityRow {
  facilityId: string;
  requisitions: number;
  agg: Aggregate;
  reqToCompletionDays: number | null;
  perMonth: number | null;
  avgDaysBetween: number | null;
  shortfall: number; // requested − credited issued (base units)
  lastReceived?: string;
  declining: boolean;
}

export function facilityRanking(reqs: Requisition[], md: MasterData, f: LineFilter, bucket: Bucket = "month"): FacilityRow[] {
  const lines = collectLines(reqs, md, f);
  const byFac = groupLines(lines, (lm) => lm.req.facilityId);
  const scoped = filterReqs(reqs, f);
  const out: FacilityRow[] = [];
  for (const [facilityId, ls] of byFac) {
    const freqs = scoped.filter((r) => r.facilityId === facilityId);
    const agg = aggregate(ls);
    const pt = processingTimes(freqs);
    const fr = frequency(freqs, f.from || f.to ? { from: f.from, to: f.to } : undefined);
    out.push({
      facilityId,
      requisitions: freqs.length,
      agg,
      reqToCompletionDays: pt.reqToCompletionDays.avg,
      perMonth: fr.perMonth,
      avgDaysBetween: fr.avgDaysBetween,
      shortfall: agg.issued.requested - agg.issued.credited,
      lastReceived: freqs.map((r) => r.receivedAt).sort().pop(),
      declining: isDeclining(ofrTrend(ls, f.basis, bucket), "issued"),
    });
  }
  return out;
}

/** Last bucket's OFR below the previous bucket's. */
export function isDeclining(trend: TrendPoint[], stage: FulfillmentStage): boolean {
  const pts = trend.filter((p) => p.agg[stage].ofr != null);
  if (pts.length < 2) return false;
  return (pts[pts.length - 1].agg[stage].ofr as number) < (pts[pts.length - 2].agg[stage].ofr as number);
}

export interface ItemRow {
  itemId: string;
  lines: number;
  requisitions: number;
  agg: Aggregate;
  substitutedLines: number; // lines where another item was supplied
  uncreditedLines: number;
  declining: boolean;
}

export function itemPerformance(reqs: Requisition[], md: MasterData, f: LineFilter, bucket: Bucket = "month"): ItemRow[] {
  const lines = collectLines(reqs, md, f);
  const out: ItemRow[] = [];
  for (const [itemId, ls] of groupLines(lines, (lm) => lm.line.itemId)) {
    const agg = aggregate(ls);
    out.push({
      itemId,
      lines: ls.length,
      requisitions: new Set(ls.map((l) => l.req.id)).size,
      agg,
      substitutedLines: ls.filter((lm) => FULFILLMENT_STAGES.some((s) => lm.stages[s].uncreditedSubstitution || lm.stages[s].substituteCredited)).length,
      uncreditedLines: ls.filter((lm) => FULFILLMENT_STAGES.some((s) => lm.stages[s].uncreditedSubstitution)).length,
      declining: isDeclining(ofrTrend(ls, f.basis, bucket), "issued"),
    });
  }
  return out;
}

export interface SubstitutionRow {
  req: Requisition;
  lineId: string;
  requestedItemId: string;
  suppliedItemId: string;
  stage: FulfillmentStage;
  quantity: number | null;
  unit: string | null;
  credited: boolean;
}

/** Effective substitution records, with whether an approved equivalence credits them. */
export function substitutions(reqs: Requisition[], md: Pick<MasterData, "equivalences">): SubstitutionRow[] {
  const out: SubstitutionRow[] = [];
  for (const r of reqs) {
    for (const f of effective(r.fulfillment)) {
      if (!f.substitution || !f.requisitionLineId) continue;
      const line = r.lines[f.requisitionLineId];
      if (!line?.itemId) continue;
      const credited = Object.values(md.equivalences).some(
        (e) => e.status === "approved" && e.requestedItemId === line.itemId && e.substituteItemId === f.itemId,
      );
      out.push({ req: r, lineId: line.id, requestedItemId: line.itemId, suppliedItemId: f.itemId, stage: f.stage, quantity: f.quantity, unit: f.unit, credited });
    }
  }
  return out;
}

/** Most recent occurredAt of an effective fulfillment record at a stage. */
export function lastFulfillment(reqs: Requisition[], stage: FulfillmentStage): string | undefined {
  let best: string | undefined;
  for (const r of reqs) for (const f of effective(r.fulfillment)) if (f.stage === stage && (!best || f.occurredAt > best)) best = f.occurredAt;
  return best;
}

/** Number of requested lines in a set of requisitions. */
export function lineCount(reqs: Requisition[]): number {
  return reqs.reduce((s, r) => s + activeLines(r).length, 0);
}

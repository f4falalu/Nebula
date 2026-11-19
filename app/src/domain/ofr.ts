// Order Fulfillment Rate (PRD §21): line eligibility, per-line cap,
// coverage, SKU rates, over-fulfillment and aggregation by summed quantities.
import {
  FULFILLMENT_STAGES,
  type FulfillmentStage,
  type MasterData,
  type Requisition,
  type RequisitionLine,
  type DateStr,
  type TimeBasis,
} from "./types";
import { effectiveFulfillment } from "./lifecycle";
import { activeLines, inOfficialScope, inProgressScope } from "./records";
import { findEquivalence, round } from "./units";
import { lagosDate } from "./time";

export type ExclusionReason =
  | "request_conversion_unknown"
  | "request_conversion_incompatible"
  | "fulfillment_conversion_unresolved";

export const EXCLUSION_LABEL: Record<ExclusionReason, string> = {
  request_conversion_unknown: "Requested quantity: conversion unknown",
  request_conversion_incompatible: "Requested quantity: conversion incompatible",
  fulfillment_conversion_unresolved: "Fulfillment record: conversion unknown or incompatible",
};

export interface LineStageMetric {
  eligible: boolean;
  exclusion?: ExclusionReason;
  requested: number; // base qty (0 when ineligible)
  fulfilled: number; // uncapped credited-eligible quantity in requested base units
  credited: number; // MIN(fulfilled, requested)
  over: number;
  full: boolean;
  partial: boolean;
  none: boolean;
  uncreditedSubstitution: boolean;
  substituteCredited: boolean;
}

export interface LineMetrics {
  line: RequisitionLine;
  req: Requisition;
  stages: Record<FulfillmentStage, LineStageMetric>;
}

/** Metrics for one requested line at every fulfillment stage. */
export function lineMetrics(req: Requisition, line: RequisitionLine, md: Pick<MasterData, "equivalences">): LineMetrics {
  const recs = effectiveFulfillment(req).filter((r) => r.requisitionLineId === line.id && !r.additional);
  const stages = {} as Record<FulfillmentStage, LineStageMetric>;
  for (const stage of FULFILLMENT_STAGES) {
    const base: LineStageMetric = {
      eligible: false, requested: 0, fulfilled: 0, credited: 0, over: 0,
      full: false, partial: false, none: false, uncreditedSubstitution: false, substituteCredited: false,
    };
    const atStage = recs.filter((r) => r.stage === stage);
    // Substitutions without an approved equivalence are flagged but never credited.
    let uncredited = false;
    let subCredited = false;
    const credited: Array<{ qty: number | null }> = [];
    for (const r of atStage) {
      if (r.itemId === line.itemId) credited.push({ qty: r.baseQuantity });
      else {
        const eq = line.itemId ? findEquivalence(md, line.itemId, r.itemId) : undefined;
        if (eq) {
          subCredited = true;
          credited.push({ qty: r.baseQuantity == null ? null : r.baseQuantity * eq.factor });
        } else uncredited = true;
      }
    }
    base.uncreditedSubstitution = uncredited;
    base.substituteCredited = subCredited;

    if (line.conversionStatus !== "resolved" || !(line.baseQuantityRequested && line.baseQuantityRequested > 0)) {
      base.exclusion = line.conversionStatus === "incompatible" ? "request_conversion_incompatible" : "request_conversion_unknown";
      stages[stage] = base;
      continue;
    }
    if (credited.some((c) => c.qty == null)) {
      base.exclusion = "fulfillment_conversion_unresolved";
      stages[stage] = base;
      continue;
    }
    const requested = line.baseQuantityRequested;
    const fulfilled = round(credited.reduce((s, c) => s + (c.qty as number), 0));
    const creditedQty = Math.min(fulfilled, requested);
    stages[stage] = {
      ...base,
      eligible: true,
      requested,
      fulfilled,
      credited: creditedQty,
      over: Math.max(fulfilled - requested, 0),
      full: fulfilled >= requested,
      partial: creditedQty > 0 && creditedQty < requested,
      none: creditedQty === 0,
    };
  }
  return { line, req, stages };
}

export interface StageAggregate {
  requestedLines: number;
  eligibleLines: number;
  requested: number;
  credited: number;
  fulfilledUncapped: number;
  over: number;
  overLines: number;
  fullLines: number;
  partialLines: number;
  noneLines: number;
  uncreditedSubstitutionLines: number;
  exclusions: Record<ExclusionReason, number>;
  ofr: number | null; // %
  skuRate: number | null; // %
  coverage: number | null; // %
}

export type Aggregate = Record<FulfillmentStage, StageAggregate>;

function emptyStage(): StageAggregate {
  return {
    requestedLines: 0, eligibleLines: 0, requested: 0, credited: 0, fulfilledUncapped: 0, over: 0, overLines: 0,
    fullLines: 0, partialLines: 0, noneLines: 0, uncreditedSubstitutionLines: 0,
    exclusions: { request_conversion_unknown: 0, request_conversion_incompatible: 0, fulfillment_conversion_unresolved: 0 },
    ofr: null, skuRate: null, coverage: null,
  };
}

/** Aggregate line metrics. OFR = Σ credited ÷ Σ requested over eligible lines; never an average of percentages. */
export function aggregate(lines: LineMetrics[]): Aggregate {
  const out = {} as Aggregate;
  for (const stage of FULFILLMENT_STAGES) {
    const a = emptyStage();
    for (const lm of lines) {
      const m = lm.stages[stage];
      a.requestedLines++;
      if (m.uncreditedSubstitution) a.uncreditedSubstitutionLines++;
      if (!m.eligible) {
        if (m.exclusion) a.exclusions[m.exclusion]++;
        continue;
      }
      a.eligibleLines++;
      a.requested += m.requested;
      a.credited += m.credited;
      a.fulfilledUncapped += m.fulfilled;
      a.over += m.over;
      if (m.over > 0) a.overLines++;
      if (m.full) a.fullLines++;
      else if (m.partial) a.partialLines++;
      else a.noneLines++;
    }
    a.requested = round(a.requested);
    a.credited = round(a.credited);
    a.ofr = a.requested > 0 ? (a.credited / a.requested) * 100 : null;
    a.skuRate = a.eligibleLines > 0 ? (a.fullLines / a.eligibleLines) * 100 : null;
    a.coverage = a.requestedLines > 0 ? (a.eligibleLines / a.requestedLines) * 100 : null;
    out[stage] = a;
  }
  return out;
}

/** Drop-off on lines eligible at all three stages (§21.12). */
export function dropOff(lines: LineMetrics[]) {
  const common = lines.filter((lm) => FULFILLMENT_STAGES.every((s) => lm.stages[s].eligible));
  const requested = round(common.reduce((s, lm) => s + lm.stages.issued.requested, 0));
  const row = (stage: FulfillmentStage) => {
    const credited = round(common.reduce((s, lm) => s + lm.stages[stage].credited, 0));
    return { stage, credited, pct: requested > 0 ? (credited / requested) * 100 : null };
  };
  return { lines: common.length, requested, invoiced: row("invoiced"), issued: row("issued"), delivered: row("delivered") };
}

/** Variances (§21.13). Shortfalls use credited quantities; stage-to-stage uses uncapped. */
export function variances(lines: LineMetrics[]) {
  const sum = (f: (lm: LineMetrics) => number | null) => round(lines.reduce((s, lm) => s + (f(lm) ?? 0), 0));
  const both = (a: FulfillmentStage, b: FulfillmentStage) => (lm: LineMetrics) =>
    lm.stages[a].eligible && lm.stages[b].eligible ? lm.stages[a].fulfilled - lm.stages[b].fulfilled : null;
  const short = (s: FulfillmentStage) => (lm: LineMetrics) => (lm.stages[s].eligible ? lm.stages[s].requested - lm.stages[s].credited : null);
  return {
    requestedMinusInvoiced: sum(short("invoiced")),
    requestedMinusIssued: sum(short("issued")),
    requestedMinusDelivered: sum(short("delivered")),
    invoicedMinusIssued: sum(both("invoiced", "issued")),
    issuedMinusDelivered: sum(both("issued", "delivered")),
  };
}

// ---------- scope and filtering ----------

export type Scope = "official" | "in_progress";

export function inScope(req: Requisition, scope: Scope): boolean {
  return scope === "official" ? inOfficialScope(req) : inProgressScope(req);
}

export function basisDate(req: Requisition, basis: TimeBasis): DateStr | undefined {
  if (basis === "requisition") return req.requisitionDate;
  if (basis === "entry") return req.entryDate;
  return lagosDate(req.receivedAt);
}

export interface LineFilter {
  scope: Scope;
  basis: TimeBasis;
  from?: DateStr;
  to?: DateStr;
  facilityId?: string;
  programmeId?: string;
  itemId?: string;
}

export function inRange(d: DateStr | undefined, from?: DateStr, to?: DateStr): boolean {
  if (!from && !to) return true;
  if (!d) return false;
  return (!from || d >= from) && (!to || d <= to);
}

/** All requested-line metrics for requisitions and lines matching the filter. */
export function collectLines(reqs: Requisition[], md: MasterData, f: LineFilter): LineMetrics[] {
  const out: LineMetrics[] = [];
  for (const r of reqs) {
    if (!inScope(r, f.scope)) continue;
    if (f.facilityId && r.facilityId !== f.facilityId) continue;
    if (!inRange(basisDate(r, f.basis), f.from, f.to)) continue;
    for (const l of activeLines(r)) {
      if (f.programmeId && l.programmeId !== f.programmeId) continue;
      if (f.itemId && l.itemId !== f.itemId) continue;
      out.push(lineMetrics(r, l, md));
    }
  }
  return out;
}

/** Requisition-level aggregate across all its lines. */
export function requisitionAggregate(req: Requisition, md: MasterData): Aggregate {
  return aggregate(activeLines(req).map((l) => lineMetrics(req, l, md)));
}

/** Additional (unrequested) items supplied, by item, at a stage. */
export function additionalItems(reqs: Requisition[]) {
  const out: Array<{ req: Requisition; itemId: string; stage: FulfillmentStage; quantity: number | null; unit: string | null; baseQuantity: number | null; baseUnit: string | null }> = [];
  for (const r of reqs) for (const f of effectiveFulfillment(r)) if (f.additional) out.push({ req: r, itemId: f.itemId, stage: f.stage, quantity: f.quantity, unit: f.unit, baseQuantity: f.baseQuantity, baseUnit: f.baseUnit });
  return out;
}

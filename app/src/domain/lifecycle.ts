// Lifecycle stages, append-only effective sets, chronology rules (PRD §12, §20.8).
import {
  LIFECYCLE_STAGES,
  OPERATIONAL_STAGES,
  type FulfillmentRecord,
  type ISO,
  type LifecycleEvent,
  type LifecycleStage,
  type OperationalStage,
  type Requisition,
} from "./types";

export const STAGE_LABEL: Record<LifecycleStage, string> = {
  received: "Received",
  entered: "Entered",
  validated: "Validated",
  finance: "Finance",
  invoicing: "Invoicing",
  pick_and_pack: "Pick & Pack",
  dispatched: "Dispatched",
  completed: "Completed",
};

/** Records that are entries/corrections and not superseded by any other record. */
export function effective<T extends { id: string; recordType: string; supersedesId?: string }>(records: Record<string, T> | T[]): T[] {
  const list = Array.isArray(records) ? records : Object.values(records);
  const superseded = new Set(list.map((r) => r.supersedesId).filter(Boolean) as string[]);
  return list.filter((r) => r.recordType !== "void" && !superseded.has(r.id));
}

/** Whether a record may still be superseded (effective and not already superseded). */
export function canSupersede<T extends { id: string; recordType: string; supersedesId?: string }>(records: Record<string, T>, id: string): boolean {
  const target = records[id];
  if (!target || target.recordType === "void") return false;
  return !Object.values(records).some((r) => r.supersedesId === id);
}

export function effectiveEvents(req: Requisition, stage?: OperationalStage): LifecycleEvent[] {
  return effective(req.events).filter((e) => !stage || e.stage === stage);
}

export function effectiveFulfillment(req: Requisition): FulfillmentRecord[] {
  return effective(req.fulfillment);
}

export type StageStatus = "completed" | "not_applicable" | "pending";

export interface StageView {
  stage: LifecycleStage;
  status: StageStatus;
  occurredAt?: ISO; // stage occurrence time: earliest effective Completed event
  recordedAt?: ISO;
  recordedBy?: string;
  events: LifecycleEvent[]; // effective events
  history: LifecycleEvent[]; // all events incl. superseded/void
  derived: boolean;
}

export function stageViews(req: Requisition): StageView[] {
  return LIFECYCLE_STAGES.map((stage): StageView => {
    if (stage === "received") {
      return { stage, status: "completed", occurredAt: req.receivedAt, recordedAt: req.entryAt, recordedBy: req.createdBy, events: [], history: [], derived: true };
    }
    if (stage === "entered") {
      return { stage, status: "completed", occurredAt: req.entryAt, recordedAt: req.entryAt, recordedBy: req.createdBy, events: [], history: [], derived: true };
    }
    if (stage === "validated") {
      return req.firstValidatedAt
        ? { stage, status: "completed", occurredAt: req.firstValidatedAt, recordedAt: req.firstValidatedAt, recordedBy: req.firstValidatedBy, events: [], history: [], derived: true }
        : { stage, status: "pending", events: [], history: [], derived: true };
    }
    const evs = effectiveEvents(req, stage);
    const history = Object.values(req.events).filter((e) => e.stage === stage).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    const done = evs.filter((e) => e.status === "completed").sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    if (done.length) {
      return { stage, status: "completed", occurredAt: done[0].occurredAt, recordedAt: done[0].recordedAt, recordedBy: done[0].recordedBy, events: evs, history, derived: false };
    }
    if (evs.some((e) => e.status === "not_applicable")) return { stage, status: "not_applicable", events: evs, history, derived: false };
    return { stage, status: "pending", events: evs, history, derived: false };
  });
}

/** Latest stage in sequence with status Completed (NA skipped). */
export function currentStage(req: Requisition): LifecycleStage {
  const views = stageViews(req);
  let cur: LifecycleStage = "received";
  for (const v of views) if (v.status === "completed") cur = v.stage;
  return cur;
}

export function nextStage(req: Requisition): LifecycleStage | null {
  return stageViews(req).find((v) => v.status === "pending")?.stage ?? null;
}

export function stageOccurrence(req: Requisition, stage: LifecycleStage): ISO | undefined {
  return stageViews(req).find((v) => v.stage === stage && v.status === "completed")?.occurredAt;
}

/** Can an operational stage be recorded now? (§12.3) Returns a reason when not. */
export function canRecordStage(req: Requisition, stage: OperationalStage): string | null {
  if (req.recordStatus === "cancelled") return "This requisition is cancelled.";
  if (!req.firstValidatedAt) return "Validate the requisition before recording operational stages.";
  const idx = OPERATIONAL_STAGES.indexOf(stage);
  for (const prev of OPERATIONAL_STAGES.slice(0, idx)) {
    if (!effectiveEvents(req, prev).length) return `Record ${STAGE_LABEL[prev]} first (Completed or Not Applicable).`;
  }
  if (stage === "completed" && effectiveEvents(req, "completed").length) return "Completed is already recorded. Correct the existing event instead.";
  return null;
}

/**
 * Chronology rules for an operational event's occurred_at (§12.7).
 * `ignoreEventId` excludes the event being corrected.
 */
export function chronologyErrors(
  req: Requisition,
  stage: OperationalStage,
  occurredAt: ISO,
  opts: { ignoreEventId?: string; override?: boolean; now?: ISO } = {},
): { hard: string[]; overridable: string[] } {
  const hard: string[] = [];
  const overridable: string[] = [];
  // Times are entered to the minute, so compare at minute precision.
  const min = (x: string | number) => Math.floor((typeof x === "number" ? x : Date.parse(x)) / 60000);
  const t = Date.parse(occurredAt);
  const now = Date.parse(opts.now ?? new Date().toISOString());
  if (!isFinite(t)) return { hard: ["Enter a valid date and time."], overridable };
  if (min(t) > min(now)) hard.push("The date can't be in the future.");
  if (min(t) < min(req.receivedAt)) overridable.push("It's earlier than when the requisition was received.");
  else if (min(t) < min(req.entryAt)) overridable.push("It's earlier than when the requisition was entered in Nebula.");
  else if (req.firstValidatedAt && min(t) < min(req.firstValidatedAt)) overridable.push("It's earlier than when the requisition was first validated.");

  const masked: Requisition = opts.ignoreEventId
    ? { ...req, events: Object.fromEntries(Object.entries(req.events).filter(([id]) => id !== opts.ignoreEventId)) }
    : req;
  const idx = OPERATIONAL_STAGES.indexOf(stage);
  OPERATIONAL_STAGES.forEach((s, i) => {
    if (i === idx) return;
    const occ = stageOccurrence(masked, s);
    if (!occ) return;
    if (i < idx && min(t) < min(occ)) hard.push(`It's earlier than ${STAGE_LABEL[s]} (${occ.slice(0, 16).replace("T", " ")} UTC).`);
    if (i > idx && min(t) > min(occ)) hard.push(`It's later than ${STAGE_LABEL[s]}, which is already recorded.`);
  });
  return { hard, overridable: opts.override ? [] : overridable };
}

/** A requisition has an override somewhere in its effective events. */
export function hasChronologyOverride(req: Requisition): boolean {
  return effective(req.events).some((e) => e.chronologyOverride);
}

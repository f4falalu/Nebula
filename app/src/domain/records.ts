// Record status model, validation/finalization checks, lock rules,
// fulfillment status and edit-request rules (PRD §10, §11, §20.9).
import type {
  EditRequest,
  FulfillmentStatus,
  MasterData,
  RecordStatus,
  Requisition,
  RequisitionLine,
  ISO,
} from "./types";
import { effectiveEvents, effectiveFulfillment } from "./lifecycle";
import { lagosDate } from "./time";

export const RECORD_STATUS_LABEL: Record<RecordStatus, string> = {
  draft: "Draft",
  processing: "Processing",
  validation_pending: "Validation Pending",
  validated: "Validated",
  finalized: "Finalized",
  reopened: "Reopened",
  cancelled: "Cancelled",
};

export const FULFILLMENT_STATUS_LABEL: Record<FulfillmentStatus, string> = {
  open: "Open",
  partial: "Partial",
  closed: "Closed",
};

export function activeLines(req: Requisition): RequisitionLine[] {
  return Object.values(req.lines)
    .filter((l): l is RequisitionLine => !!l)
    .sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0) || a.lineNumber - b.lineNumber);
}

/** Header and lines can be edited directly (no edit request needed). */
export function isEditable(req: Requisition): boolean {
  return req.recordStatus === "draft" || req.recordStatus === "validation_pending" || req.recordStatus === "validated" || req.recordStatus === "reopened";
}

/** Validation checks (§10.3). Empty list = passes. */
export function validationIssues(req: Requisition, md: MasterData, now: ISO = new Date().toISOString()): string[] {
  const out: string[] = [];
  if (!req.facilityId || !md.facilities[req.facilityId]) out.push("Match the facility to the Facility master.");
  if (!req.requisitionDate) out.push("Enter the requisition date (mark it as estimated if it isn't on the document).");
  if (!req.receivedAt) out.push("Enter when the requisition was received.");
  else {
    if (Date.parse(req.receivedAt) > Date.parse(now) + 60_000) out.push("Received at can't be in the future.");
    if (Date.parse(req.receivedAt) > Date.parse(req.entryAt)) out.push("Received at can't be later than when the requisition was entered.");
    if (req.requisitionDate && req.requisitionDate > lagosDate(req.receivedAt)) out.push("The requisition date can't be later than the date it was received.");
  }
  const lines = activeLines(req);
  if (!lines.length) out.push("Add at least one requisition line.");
  lines.forEach((l) => {
    const tag = `Line ${l.lineNumber}${l.pageNumber ? ` (page ${l.pageNumber})` : ""}`;
    if (!l.itemId || !md.items[l.itemId]) out.push(`${tag}: match the item.`);
    if (!l.programmeId || !md.programmes[l.programmeId]) out.push(`${tag}: choose a programme.`);
    if (!(typeof l.quantityRequested === "number" && l.quantityRequested > 0)) out.push(`${tag}: enter a requested quantity above 0.`);
    if (!l.unitRequested) out.push(`${tag}: enter the unit as written.`);
    if (!l.conversionStatus) out.push(`${tag}: unit conversion not checked.`);
  });
  if (req.extraction && (req.extraction.status === "queued" || req.extraction.status === "processing")) out.push("Wait for document reading to finish.");
  return out;
}

export function finalizationIssues(req: Requisition, md: MasterData): string[] {
  const out: string[] = [];
  if (req.recordStatus !== "validated") out.push("Validate the requisition first.");
  out.push(...validationIssues(req, md));
  const originals = Object.values(req.documents).filter((d) => d && d.category === "original_requisition");
  if (!originals.length || originals.some((d) => !d!.sha256)) out.push("Attach the original requisition document.");
  return [...new Set(out)];
}

/** Statuses from which an action is allowed. */
export const CAN_CANCEL: RecordStatus[] = ["draft", "processing", "validation_pending", "validated", "finalized", "reopened"];

/** Status after an edit to header/lines. */
export function statusAfterEdit(s: RecordStatus): RecordStatus {
  return s === "validated" ? "validation_pending" : s;
}

/** Open -> Partial is automatic once any effective record exists. */
export function derivedFulfillmentStatus(req: Requisition): FulfillmentStatus {
  if (req.fulfillmentStatus === "closed") return "closed";
  return effectiveFulfillment(req).length ? "partial" : "open";
}

export function closeFulfillmentIssues(req: Requisition, reason?: string): string[] {
  const out: string[] = [];
  if (req.recordStatus !== "finalized") out.push("Finalize the requisition before closing fulfillment.");
  if (req.fulfillmentStatus === "closed") out.push("Fulfillment is already closed.");
  const completed = effectiveEvents(req, "completed").some((e) => e.status === "completed");
  if (!completed && !reason?.trim()) out.push("Record the Completed stage, or give a closure reason (for example “Not supplied: stock-out”).");
  return out;
}

/** In official reporting scope (§21.9). */
export function inOfficialScope(req: Requisition): boolean {
  return req.recordStatus === "finalized" && req.fulfillmentStatus === "closed";
}

/** In the provisional in-progress view. */
export function inProgressScope(req: Requisition): boolean {
  return req.recordStatus === "finalized";
}

// ---------- edit requests ----------

export function effectiveEditStatus(er: EditRequest, settingsTimeoutDays: number, now: ISO = new Date().toISOString()): EditRequest["status"] {
  if (er.status === "approved" && er.approvalExpiresAt && now > er.approvalExpiresAt) return "expired";
  if (er.status === "pending" && now > new Date(Date.parse(er.requestedAt) + settingsTimeoutDays * 86400000).toISOString()) return "expired";
  return er.status;
}

/** The active approved edit request for this user on this requisition, if any. */
export function activeEditPermission(req: Requisition, userId: string, timeoutDays: number, now?: ISO): EditRequest | undefined {
  return Object.values(req.editRequests).find(
    (er) => er.requestedBy === userId && effectiveEditStatus(er, timeoutDays, now) === "approved",
  );
}

/** Whether an approved edit request covers changing `entityType/entityId/field`. */
export function editCovers(er: EditRequest | undefined, entityType: string, entityId: string | undefined, field: string): boolean {
  if (!er) return false;
  return er.changes.some(
    (c) =>
      c.entityType === entityType &&
      (c.field === field || c.field === "*") &&
      (c.entityId ?? "") === (entityId ?? "") ,
  );
}

export function canDecideEditRequest(er: EditRequest, deciderId: string): string | null {
  if (er.requestedBy === deciderId) return "You can't approve or reject your own edit request.";
  if (er.status !== "pending") return "This request has already been decided.";
  return null;
}

export const HEADER_FIELDS: Record<string, string> = {
  facilityId: "Facility",
  facilityExtractedText: "Facility (as written)",
  primaryProgrammeId: "Primary programme",
  requisitionDate: "Requisition date",
  requisitionDateEstimated: "Requisition date is estimated",
  receivedAt: "Received at",
};

export const LINE_FIELDS: Record<string, string> = {
  itemId: "Item",
  programmeId: "Programme",
  quantityRequested: "Requested quantity",
  unitRequested: "Requested unit",
  strength: "Strength",
  form: "Form",
  packSize: "Pack size",
  correctedText: "Corrected text",
};

// Domain types for Nebula V1. Mirrors PRD v2.0 §31, adapted to a document
// store: one document per requisition holds its header, pages, lines,
// documents, lifecycle events, fulfillment records and edit requests as maps
// keyed by id, so concurrent writers merge instead of overwriting.

export type ISO = string; // UTC ISO-8601 timestamp
export type DateStr = string; // YYYY-MM-DD (Africa/Lagos business date)

export type RoleCode = "ra" | "supervisor" | "admin";
export type Grant = "requisition.reopen" | "edit_request.approve" | "documents.download";

export type RecordStatus =
  | "draft"
  | "processing"
  | "validation_pending"
  | "validated"
  | "finalized"
  | "reopened"
  | "cancelled";

export const LIFECYCLE_STAGES = [
  "received",
  "entered",
  "validated",
  "finance",
  "invoicing",
  "pick_and_pack",
  "dispatched",
  "completed",
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const OPERATIONAL_STAGES = ["finance", "invoicing", "pick_and_pack", "dispatched", "completed"] as const;
export type OperationalStage = (typeof OPERATIONAL_STAGES)[number];

export type FulfillmentStatus = "open" | "partial" | "closed";
export const FULFILLMENT_STAGES = ["invoiced", "issued", "delivered"] as const;
export type FulfillmentStage = (typeof FULFILLMENT_STAGES)[number];

export type RecordType = "entry" | "correction" | "void";
export type ConversionStatus = "resolved" | "unknown" | "incompatible";
export type ApprovalStatus = "proposed" | "approved" | "rejected" | "retired";
export type EditRequestStatus = "pending" | "approved" | "rejected" | "used" | "expired" | "withdrawn";
export type DocumentCategory = "original_requisition" | "processed" | "lifecycle_evidence" | "supporting";

// ---------- master data ----------
export interface Facility {
  id: string;
  name: string;
  lga?: string;
  location?: string;
  status: "active" | "inactive";
  createdAt: ISO;
  updatedAt: ISO;
}

export interface Item {
  id: string;
  code: string;
  name: string;
  genericName?: string;
  strength?: string;
  form?: string;
  packSize?: string;
  baseUnit: string;
  status: "active" | "inactive";
  createdAt: ISO;
  updatedAt: ISO;
}

export interface Programme {
  id: string;
  name: string;
  description?: string;
  status: "active" | "inactive";
}

export interface Alias {
  id: string;
  entityType: "facility" | "item";
  entityId: string;
  alias: string;
  normalized: string;
  occurrences: number;
  status: "candidate" | "approved" | "rejected";
  decidedBy?: string;
  decidedAt?: ISO;
  createdAt: ISO;
}

export interface UnitConversion {
  id: string;
  itemId: string | null; // null = generic
  fromUnit: string; // normalized unit
  toUnit: string; // base unit
  factor: number; // 1 fromUnit = factor toUnit
  incompatible?: boolean; // approved statement that fromUnit cannot convert for this item
  status: ApprovalStatus;
  proposedBy: string;
  proposedAt: ISO;
  approvedBy?: string;
  approvedAt?: ISO;
  retiredBy?: string;
  retiredAt?: ISO;
  notes?: string;
}

export interface SubstitutionEquivalence {
  id: string;
  requestedItemId: string;
  substituteItemId: string;
  factor: number; // substitute base units -> requested base units
  basis: Array<"strength" | "form" | "pack_size" | "base_unit">;
  justification: string;
  status: ApprovalStatus;
  proposedBy: string;
  proposedAt: ISO;
  approvedBy?: string;
  approvedAt?: ISO;
  retiredBy?: string;
  retiredAt?: ISO;
}

export interface Settings {
  ofrThresholdPercent: number;
  ofrThresholdStage: FulfillmentStage;
  editWindowHours: number;
  editRequestPendingTimeoutDays: number;
  defaultTimeBasis: TimeBasis;
}
export type TimeBasis = "received" | "requisition" | "entry";

export const DEFAULT_SETTINGS: Settings = {
  ofrThresholdPercent: 80,
  ofrThresholdStage: "issued",
  editWindowHours: 24,
  editRequestPendingTimeoutDays: 7,
  defaultTimeBasis: "received",
};

export interface RoleAssignment {
  role: RoleCode; // can only lower what the share level allows
  grants: Grant[];
  updatedBy: string;
  updatedAt: ISO;
}

// ---------- requisition ----------
export interface ReqDocument {
  id: string;
  category: DocumentCategory;
  lifecycleEventId?: string;
  documentType: string; // requisition, invoice, pick_slip, waybill, pod, payment_confirmation, whatsapp_screenshot, other
  fileName: string;
  mimeType: string;
  assetId: string;
  sha256: string;
  fileSize: number;
  pageCount: number;
  firstPage: number; // global page number of this file's first page in the requisition
  description?: string;
  uploadedBy: string;
  uploadedAt: ISO;
}

export interface PageAssignment {
  programmeId?: string;
}

export interface MatchCandidate {
  targetId: string;
  score: number; // 0..1
  method: "exact" | "alias" | "normalized" | "historical" | "attribute" | "fuzzy";
}

export interface RequisitionLine {
  id: string;
  lineNumber: number;
  pageNumber?: number;
  rawExtractedText?: string;
  itemExtractedText?: string;
  correctedText?: string;
  itemId?: string;
  programmeId?: string;
  programmeOverridden?: boolean;
  quantityRequested?: number;
  unitRequested?: string;
  baseQuantityRequested?: number | null;
  baseUnit?: string;
  conversionId?: string;
  conversionStatus?: ConversionStatus;
  strength?: string;
  form?: string;
  packSize?: string;
  candidates?: MatchCandidate[];
  matchMethod?: MatchCandidate["method"] | "human";
  matchConfirmedBy?: string;
  matchConfirmedAt?: ISO;
  createdAt: ISO;
  updatedAt: ISO;
}

export interface LifecycleEvent {
  id: string;
  stage: OperationalStage;
  status: "completed" | "not_applicable";
  notApplicableReason?: string;
  occurredAt: ISO;
  recordedAt: ISO;
  recordedBy: string;
  notes?: string;
  chronologyOverride?: boolean;
  overrideReason?: string;
  recordType: RecordType;
  supersedesId?: string;
  correctionReason?: string;
  editRequestId?: string;
}

export interface FulfillmentRecord {
  id: string;
  requisitionLineId: string | null;
  itemId: string;
  stage: FulfillmentStage;
  quantity: number | null;
  unit: string | null;
  baseQuantity: number | null;
  baseUnit: string | null;
  conversionId?: string;
  conversionStatus: ConversionStatus;
  substitution: boolean;
  additional: boolean;
  reference?: string;
  documentId?: string;
  occurredAt: ISO;
  recordedAt: ISO;
  recordedBy: string;
  notes?: string;
  recordType: RecordType;
  supersedesId?: string;
  correctionReason?: string;
  editRequestId?: string;
}

export type EditEntity = "header" | "line" | "page" | "fulfillment" | "lifecycle";

export interface RequestedChange {
  entityType: EditEntity;
  entityId?: string; // line id / page number; blank for header or new line
  field: string; // e.g. facilityId, quantityRequested, "*" for fulfillment/lifecycle corrections
  currentValue?: unknown;
  proposedValue?: unknown;
}

export interface EditRequest {
  id: string;
  requestedBy: string;
  requestedAt: ISO;
  reason: string;
  changes: RequestedChange[];
  status: EditRequestStatus;
  decidedBy?: string;
  decidedAt?: ISO;
  decision?: "approved" | "rejected";
  rejectionReason?: string;
  approvalExpiresAt?: ISO;
  usedAt?: ISO;
  closedAt?: ISO;
  closureReason?: "used" | "expired" | "withdrawn" | "rejected";
}

export interface Extraction {
  status: "queued" | "processing" | "completed" | "failed" | "skipped";
  attempt: number;
  model?: string;
  queuedAt?: ISO;
  startedAt?: ISO;
  completedAt?: ISO;
  raw?: string;
  error?: string;
  by?: string;
}

export interface Requisition {
  id: string;
  number: string;
  entryDate: DateStr;
  entrySerial: number;
  facilityId?: string;
  facilityExtractedText?: string;
  facilityCandidates?: MatchCandidate[];
  primaryProgrammeId?: string;
  requisitionDate?: DateStr;
  requisitionDateEstimated?: boolean;
  receivedAt: ISO;
  receivedVia?: string;
  entryAt: ISO;
  recordStatus: RecordStatus;
  firstValidatedAt?: ISO;
  firstValidatedBy?: string;
  validatedAt?: ISO;
  validatedBy?: string;
  finalizedAt?: ISO;
  finalizedBy?: string;
  fulfillmentStatus: FulfillmentStatus;
  fulfillmentClosedAt?: ISO;
  fulfillmentClosedBy?: string;
  fulfillmentClosureReason?: string;
  cancelledAt?: ISO;
  cancelledBy?: string;
  cancellationReason?: string;
  reopenedAt?: ISO;
  reopenedBy?: string;
  reopenReason?: string;
  createdBy: string;
  createdAt: ISO;
  updatedAt: ISO;
  documents: Record<string, ReqDocument | null>;
  pages: Record<string, PageAssignment>;
  lines: Record<string, RequisitionLine | null>; // null = removed before finalization
  events: Record<string, LifecycleEvent>;
  fulfillment: Record<string, FulfillmentRecord>;
  editRequests: Record<string, EditRequest>;
  extraction?: Extraction;
}

export interface AuditEvent {
  id: string;
  at: ISO;
  actor: string | null; // user id, null = system
  actorType: "user" | "system";
  eventType: string;
  entityType: string;
  entityId?: string;
  requisitionId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string;
  editRequestId?: string;
}

// Everything the calculations need besides the requisitions themselves.
export interface MasterData {
  facilities: Record<string, Facility>;
  items: Record<string, Item>;
  programmes: Record<string, Programme>;
  conversions: Record<string, UnitConversion>;
  equivalences: Record<string, SubstitutionEquivalence>;
  aliases: Record<string, Alias>;
  settings: Settings;
}

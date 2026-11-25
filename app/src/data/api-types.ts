// The contract between the pages and whatever stores Nebula's data.
// V1 (claude.ai artifact): Services in services.ts, over the artifact database.
// V2 (web, Render): ApiServices in api.ts, over the FastAPI backend.
import type {
  Alias, AuditEvent, DocumentCategory, Facility, FulfillmentStage, Grant, ISO, Item, MasterData, OperationalStage, Programme,
  ReqDocument, RequestedChange, Requisition, RequisitionLine, RoleAssignment, RoleCode, Settings, SubstitutionEquivalence, UnitConversion,
} from "../domain/types";

/** A rule the user broke; the message is shown to them as-is. */
export class UserError extends Error {}

export type Proposal =
  | ({ kind: "alias" } & Alias)
  | ({ kind: "conversion" } & UnitConversion)
  | ({ kind: "equivalence" } & SubstitutionEquivalence);

/** A Nebula user as the V2 backend lists them (admins only). */
export interface WebUser {
  id: string;
  email?: string;
  name?: string;
  status: "pending" | "active" | "inactive";
  role?: RoleCode | null;
  createdAt?: ISO;
}

export interface AppState {
  reqs: Record<string, Requisition>;
  md: MasterData;
  roles: Record<string, RoleAssignment>;
  proposals: Record<string, Proposal>;
  users?: WebUser[];
}

export interface FulfillmentRowInput {
  lineId: string | null;
  itemId: string;
  stage: FulfillmentStage;
  quantity: number;
  unit: string;
  reference?: string;
  documentId?: string;
  occurredAt: ISO;
  notes?: string;
}

export interface RecordEventInput {
  stage: OperationalStage;
  status: "completed" | "not_applicable";
  occurredAt: ISO;
  notes?: string;
  notApplicableReason?: string;
  override?: boolean;
  overrideReason?: string;
  files?: File[];
  documentType?: string;
}

export type HeaderPatch = Partial<Pick<Requisition, "facilityId" | "facilityExtractedText" | "primaryProgrammeId" | "requisitionDate" | "requisitionDateEstimated" | "receivedAt" | "receivedVia">>;

export interface AuditPageResult {
  events: AuditEvent[];
  next: string | null;
}

export interface NebulaServices {
  // requisitions
  createRequisition(input: { receivedAt: ISO; receivedVia?: string; files: File[]; read: boolean }): Promise<string>;
  runExtraction(id: string): Promise<unknown>;
  updateHeader(id: string, patch: HeaderPatch): Promise<unknown>;
  upsertLine(id: string, lineId: string | null, patch: Partial<RequisitionLine>): Promise<string>;
  removeLine(id: string, lineId: string): Promise<unknown>;
  setPageProgramme(id: string, page: number | "all", programmeId: string): Promise<unknown>;
  validate(id: string): Promise<unknown>;
  finalize(id: string): Promise<unknown>;
  cancel(id: string, reason: string): Promise<unknown>;
  reopen(id: string, reason: string): Promise<unknown>;
  // documents
  uploadEvidence(id: string, files: File[], opts: { lifecycleEventId?: string; documentType: string; description?: string; category?: DocumentCategory }): Promise<ReqDocument[]>;
  logDownload(id: string, docId: string): Promise<unknown>;
  /** A URL the browser can load for this document (V2: short-lived signed URL). */
  documentUrl(doc: ReqDocument, download?: boolean): Promise<string>;
  /** Save the document to the viewer's device (audited). */
  downloadDocument(requisitionId: string, doc: ReqDocument): Promise<unknown>;
  /** Offer a generated file (e.g. CSV) to the viewer. */
  saveFile(filename: string, data: string): Promise<unknown>;
  // lifecycle
  recordEvent(id: string, input: RecordEventInput, supersedesId?: string, correctionReason?: string): Promise<unknown>;
  voidEvent(id: string, eventId: string, reason: string): Promise<unknown>;
  // fulfillment
  recordFulfillment(id: string, rows: FulfillmentRowInput[]): Promise<unknown>;
  correctFulfillment(id: string, targetId: string, row: FulfillmentRowInput | null, reason: string): Promise<unknown>;
  closeFulfillment(id: string, reason?: string): Promise<unknown>;
  reopenFulfillment(id: string, reason: string): Promise<unknown>;
  // edit requests
  submitEditRequest(id: string, reason: string, changes: RequestedChange[]): Promise<unknown>;
  decideEditRequest(id: string, erId: string, decision: "approved" | "rejected", rejectionReason?: string): Promise<unknown>;
  withdrawEditRequest(id: string, erId: string): Promise<unknown>;
  applyApprovedEdit(id: string, erId: string, values: Record<number, unknown>): Promise<unknown>;
  // audit
  requisitionAudit(id: string): Promise<AuditEvent[]>;
  // aliases, conversions, equivalences
  decideAlias(key: string, decision: "approved" | "rejected"): Promise<unknown>;
  addAlias(entityType: "facility" | "item", entityId: string, alias: string): Promise<unknown>;
  retireAlias(id: string): Promise<unknown>;
  proposeConversion(c: { itemId: string | null; fromUnit: string; factor: number; incompatible?: boolean; notes?: string; toUnit?: string }): Promise<unknown>;
  approveConversion(c: UnitConversion, proposalKey?: string): Promise<unknown>;
  rejectProposal(key: string): Promise<unknown>;
  retireConversion(id: string): Promise<unknown>;
  resolveConversions(): Promise<number>;
  proposeEquivalence(e: { requestedItemId: string; substituteItemId: string; factor: number; basis: SubstitutionEquivalence["basis"]; justification: string }): Promise<unknown>;
  approveEquivalence(e: SubstitutionEquivalence, proposalKey?: string): Promise<unknown>;
  retireEquivalence(id: string): Promise<unknown>;
  // master data & settings
  saveFacility(f: Partial<Facility> & { name: string }): Promise<unknown>;
  saveItem(i: Partial<Item> & { name: string; code: string; baseUnit: string }): Promise<unknown>;
  saveProgramme(p: Partial<Programme> & { name: string }): Promise<unknown>;
  saveSettings(s: Settings): Promise<unknown>;
  saveRole(userId: string, role: RoleCode, grants: Grant[]): Promise<unknown>;
  loadStarterMasterData(data: { programmes: string[]; facilities: Array<Partial<Facility> & { name: string }>; items: Array<Partial<Item> & { name: string; code: string; baseUnit: string }> }): Promise<unknown>;
}

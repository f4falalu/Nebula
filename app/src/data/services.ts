// Every state change in Nebula goes through this layer. It checks role and
// record rules (PRD §6, §10–§12, §20), writes append-only records, and writes
// the audit trail. V1 enforces these rules in the app; V2 moves the
// structural ones into PostgreSQL constraints and triggers (PRD §31.8).
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Store } from "./store";
import type { Platform } from "./platform";
import { ACCEPTED_TYPES, MAX_FILE_BYTES, imagesForAsset, pdfPageCount, rememberLocal, sha256Hex } from "./files";
import { extractWithClaude, type ExtractionResult } from "./extraction";
import {
  DEFAULT_SETTINGS,
  type Alias, type AuditEvent, type DocumentCategory, type EditRequest, type Facility, type FulfillmentRecord, type FulfillmentStage,
  type Grant, type ISO, type Item, type LifecycleEvent, type MasterData, type OperationalStage, type Programme, type ReqDocument,
  type RequestedChange, type Requisition, type RequisitionLine, type RoleAssignment, type RoleCode, type Settings,
  type SubstitutionEquivalence, type UnitConversion,
} from "../domain/types";
import { can, type Action, type Actor } from "../domain/permissions";
import { formatRequisitionNumber, newId, normalize } from "../domain/text";
import { lagosDate, nowISO } from "../domain/time";
import { convertToBase, normalizeUnit } from "../domain/units";
import { matchFacility, matchItem } from "../domain/matching";
import { canRecordStage, canSupersede, chronologyErrors, effectiveFulfillment, STAGE_LABEL } from "../domain/lifecycle";
import {
  activeEditPermission, activeLines, canDecideEditRequest, closeFulfillmentIssues, editCovers, effectiveEditStatus,
  finalizationIssues, isEditable, statusAfterEdit, validationIssues,
} from "../domain/records";

export class UserError extends Error {}

export interface AppState {
  reqs: Record<string, Requisition>;
  md: MasterData;
  roles: Record<string, RoleAssignment>;
  proposals: Record<string, Proposal>;
}

export type Proposal =
  | ({ kind: "alias" } & Alias)
  | ({ kind: "conversion" } & UnitConversion)
  | ({ kind: "equivalence" } & SubstitutionEquivalence);

type Patch = Record<string, any>;

export class Services {
  constructor(
    private store: Store,
    private platform: Platform,
    private actor: Actor,
    private state: () => AppState,
  ) {}

  // ---------- helpers ----------
  private need(action: Action) {
    if (!can(this.actor, action)) throw new UserError("Your role doesn't allow this action.");
  }
  private req(id: string): Requisition {
    const r = this.state().reqs[id];
    if (!r) throw new UserError("Requisition not found. It may still be loading.");
    return r;
  }
  private get me() {
    return this.actor.id;
  }
  private get md() {
    return this.state().md;
  }
  private settings(): Settings {
    return this.md.settings ?? DEFAULT_SETTINGS;
  }

  async audit(e: Omit<AuditEvent, "id" | "at" | "actor" | "actorType"> & { actorType?: "user" | "system" }) {
    const ev: AuditEvent = { id: newId(), at: nowISO(), actor: e.actorType === "system" ? null : this.me, actorType: e.actorType ?? "user", ...e };
    const clean = JSON.parse(JSON.stringify(ev));
    if (ev.requisitionId) {
      await this.store.update(`audit/${ev.requisitionId}`, { entries: { [ev.id]: clean } }).catch(async () => {
        await this.store.set(`audit/${ev.requisitionId}`, { requisitionId: ev.requisitionId, entries: { [ev.id]: clean } });
      });
    } else {
      const path = `audit/sys-${ev.at.slice(0, 7)}`;
      try {
        await this.store.update(path, { entries: { [ev.id]: clean } });
      } catch {
        const cur = await this.store.get(path);
        await this.store.set(path, { requisitionId: null, entries: { ...((cur?.entries as object) ?? {}), [ev.id]: clean } });
      }
    }
  }

  private async patchReq(id: string, patch: Patch) {
    await this.store.update(`reqs/${id}`, { ...patch, updatedAt: nowISO() });
  }

  /** Header/line changes: allowed while editable, or on Finalized under an approved edit request covering the field. */
  private editGate(r: Requisition, entityType: "header" | "line" | "page", entityId: string | undefined, fields: string[]): EditRequest | undefined {
    this.need("requisition.edit");
    if (isEditable(r)) return undefined;
    if (r.recordStatus === "finalized") {
      const er = activeEditPermission(r, this.me, this.settings().editRequestPendingTimeoutDays);
      if (er && fields.every((f) => editCovers(er, entityType, entityId, f))) return er;
      throw new UserError("This requisition is finalized. Submit an edit request for this change, or ask an Administrator to reopen it.");
    }
    throw new UserError(`A ${r.recordStatus.replace("_", " ")} requisition can't be edited.`);
  }

  // ---------- requisitions ----------
  async createRequisition(input: { receivedAt: ISO; receivedVia?: string; files: File[]; read: boolean }): Promise<string> {
    this.need("requisition.create");
    if (!input.files.length) throw new UserError("Attach the original requisition (photo or PDF).");
    if (Date.parse(input.receivedAt) > Date.now() + 60_000) throw new UserError("Received at can't be in the future.");
    for (const f of input.files) {
      if (!ACCEPTED_TYPES.includes(f.type)) throw new UserError(`${f.name}: use a JPEG, PNG, WebP, GIF or PDF file.`);
      if (f.size > MAX_FILE_BYTES) throw new UserError(`${f.name} is larger than 20 MB.`);
    }
    const entryAt = nowISO();
    if (Date.parse(input.receivedAt) > Date.parse(entryAt)) throw new UserError("Received at can't be later than now.");
    const entryDate = lagosDate(entryAt);
    const serial = await this.store.nextSerial(entryDate);
    const id = newId();
    const number = formatRequisitionNumber(entryDate, serial);
    const docs: Record<string, ReqDocument> = {};
    let page = 1;
    for (const f of input.files) {
      const d = await this.uploadFile(f, "original_requisition", "requisition", page);
      docs[d.id] = d;
      page += d.pageCount;
    }
    const r: Requisition = {
      id, number, entryDate, entrySerial: serial, receivedAt: input.receivedAt, receivedVia: input.receivedVia || undefined,
      entryAt, recordStatus: "draft", fulfillmentStatus: "open", createdBy: this.me, createdAt: entryAt, updatedAt: entryAt,
      documents: docs, pages: Object.fromEntries(Array.from({ length: page - 1 }, (_, i) => [String(i + 1), {}])),
      lines: {}, events: {}, fulfillment: {}, editRequests: {},
    };
    await this.store.set(`reqs/${id}`, JSON.parse(JSON.stringify(r)));
    await this.store.set(`audit/${id}`, { requisitionId: id, entries: {} });
    await this.audit({ requisitionId: id, eventType: "requisition.created", entityType: "requisition", entityId: id, newValue: { number, receivedAt: r.receivedAt, entryAt } });
    for (const d of Object.values(docs)) {
      await this.audit({ requisitionId: id, eventType: "document.uploaded", entityType: "document", entityId: d.id, newValue: { fileName: d.fileName, sha256: d.sha256, category: d.category } });
    }
    if (input.read && this.platform.sample && this.platform.imageLimits) {
      this.state().reqs[id] = r; // make it visible to runExtraction before the snapshot arrives
      void this.runExtraction(id, Object.fromEntries(input.files.map((f, i) => [Object.keys(docs)[i], f])));
    } else {
      await this.patchReq(id, { recordStatus: "validation_pending", extraction: { status: "skipped", attempt: 0 } });
      await this.audit({ requisitionId: id, eventType: "record_status.changed", entityType: "requisition", entityId: id, oldValue: "draft", newValue: "validation_pending", reason: "Manual entry" });
    }
    return id;
  }

  private async uploadFile(f: File, category: DocumentCategory, documentType: string, firstPage: number, lifecycleEventId?: string, description?: string): Promise<ReqDocument> {
    const sha256 = await sha256Hex(f);
    const pageCount = f.type === "application/pdf" ? await pdfPageCount(f) : 1;
    let assetId: string;
    if (this.platform.assets) {
      try {
        const res = await this.platform.assets.upload(f, { type: f.type });
        assetId = res.id;
      } catch (e: any) {
        throw new UserError(
          e?.code === "too_large" ? `${f.name} is too large.` : e?.code === "quota_or_state" ? "The artifact's file storage is full." : `Uploading ${f.name} failed (${e?.code ?? "error"}). Try again.`,
        );
      }
    } else if (!this.store.live) {
      assetId = "local:" + newId();
      rememberLocal(assetId, f);
    } else {
      throw new UserError("File uploads aren't available at your access level. Ask the artifact owner to make you an Editor, or to enable uploads for Contributors.");
    }
    return {
      id: newId(), category, lifecycleEventId, documentType, fileName: f.name, mimeType: f.type, assetId, sha256, fileSize: f.size,
      pageCount, firstPage, description, uploadedBy: this.me, uploadedAt: nowISO(),
    };
  }

  async runExtraction(id: string, local?: Record<string, Blob>) {
    this.need("extraction.retry");
    const r = this.req(id);
    if (!this.platform.sample) throw new UserError("Claude isn't available in this view. Enter the lines by hand.");
    if (r.recordStatus !== "draft" && r.recordStatus !== "validation_pending" && r.recordStatus !== "processing") {
      throw new UserError("Documents can be read only before validation.");
    }
    const attempt = (r.extraction?.attempt ?? 0) + 1;
    const startedAt = nowISO();
    await this.patchReq(id, { recordStatus: "processing", extraction: { status: "processing", attempt, queuedAt: startedAt, startedAt, by: this.me, model: "Claude (default tier)", error: null } });
    if (r.recordStatus !== "processing") {
      await this.audit({ requisitionId: id, eventType: "record_status.changed", entityType: "requisition", entityId: id, oldValue: r.recordStatus, newValue: "processing" });
    }
    try {
      const originals = Object.values(r.documents).filter((d): d is ReqDocument => !!d && d.category === "original_requisition").sort((a, b) => a.firstPage - b.firstPage);
      const images: Blob[] = [];
      for (const d of originals) images.push(...(await imagesForAsset(d.assetId, d.mimeType, local?.[d.id])));
      const programmes = Object.values(this.md.programmes).filter((p) => p.status === "active").map((p) => p.name);
      const { result, raw } = await extractWithClaude(this.platform.sample, images, programmes, this.platform.imageLimits?.maxCount ?? 5);
      await this.applyExtraction(id, result);
      await this.patchReq(id, { recordStatus: "validation_pending", extraction: { status: "completed", completedAt: nowISO(), raw } });
      await this.audit({ requisitionId: id, eventType: "processing.completed", entityType: "processing_job", entityId: `${id}-${attempt}`, newValue: { lines: result.lines.length, attempt } });
      await this.audit({ requisitionId: id, eventType: "record_status.changed", entityType: "requisition", entityId: id, oldValue: "processing", newValue: "validation_pending" });
    } catch (e: any) {
      await this.patchReq(id, { recordStatus: "validation_pending", extraction: { status: "failed", completedAt: nowISO(), error: e?.message ?? String(e), raw: e?.raw ?? null } });
      await this.audit({ requisitionId: id, eventType: "processing.failed", entityType: "processing_job", entityId: `${id}-${attempt}`, newValue: { error: e?.message ?? String(e), attempt } });
    }
  }

  private async applyExtraction(id: string, res: ExtractionResult) {
    const r = this.req(id);
    const md = this.md;
    const history = Object.values(this.state().reqs);
    const progByName = (name?: string) => (name ? Object.values(md.programmes).find((p) => normalize(p.name) === normalize(name))?.id : undefined);
    const pages: Record<string, { programmeId?: string }> = { ...r.pages };
    for (const p of res.pages) {
      const pid = progByName(p.programme);
      if (pid) pages[String(p.page)] = { programmeId: pid };
    }
    const now = nowISO();
    const lines: Record<string, RequisitionLine> = {};
    // Replace earlier extracted lines that nobody has confirmed yet.
    for (const l of activeLines(r)) if (l.matchConfirmedBy) lines[l.id] = l;
    const removed = Object.fromEntries(activeLines(r).filter((l) => !l.matchConfirmedBy).map((l) => [l.id, null]));
    res.lines.forEach((x, i) => {
      const lid = newId() + i;
      lines[lid] = {
        id: lid, lineNumber: x.line, pageNumber: x.page, rawExtractedText: x.text, itemExtractedText: x.itemName ?? x.text,
        strength: x.strength, form: x.form, packSize: x.packSize, quantityRequested: x.quantity ?? undefined, unitRequested: x.unit,
        programmeId: pages[String(x.page)]?.programmeId ?? r.primaryProgrammeId,
        candidates: matchItem({ text: x.itemName ?? x.text, strength: x.strength, form: x.form, packSize: x.packSize }, md),
        createdAt: now, updatedAt: now,
      };
    });
    const facilityCandidates = matchFacility(res.facilityName, md, history);
    await this.patchReq(id, JSON.parse(JSON.stringify({
      facilityExtractedText: res.facilityName ?? r.facilityExtractedText ?? null,
      facilityCandidates,
      requisitionDate: r.requisitionDate ?? res.requisitionDate ?? null,
      pages,
      lines: { ...removed, ...lines },
    })));
  }

  async updateHeader(id: string, patch: Partial<Pick<Requisition, "facilityId" | "facilityExtractedText" | "primaryProgrammeId" | "requisitionDate" | "requisitionDateEstimated" | "receivedAt" | "receivedVia">>) {
    const r = this.req(id);
    const er = this.editGate(r, "header", undefined, Object.keys(patch));
    if (patch.receivedAt) {
      if (Date.parse(patch.receivedAt) > Date.now() + 60_000) throw new UserError("Received at can't be in the future.");
      if (Date.parse(patch.receivedAt) > Date.parse(r.entryAt)) throw new UserError("Received at can't be later than when the requisition was entered.");
    }
    const old = Object.fromEntries(Object.keys(patch).map((k) => [k, (r as any)[k] ?? null]));
    const status = er ? r.recordStatus : statusAfterEdit(r.recordStatus);
    await this.patchReq(id, { ...JSON.parse(JSON.stringify(patch)), recordStatus: status });
    if (patch.facilityId && patch.facilityId !== r.facilityId && r.facilityExtractedText) {
      await this.noteAlias("facility", patch.facilityId, r.facilityExtractedText);
    }
    await this.audit({ requisitionId: id, eventType: "header.changed", entityType: "requisition", entityId: id, oldValue: old, newValue: patch, editRequestId: er?.id });
    if (status !== r.recordStatus) await this.audit({ requisitionId: id, eventType: "record_status.changed", entityType: "requisition", entityId: id, oldValue: r.recordStatus, newValue: status, reason: "Edited after validation" });
    if (er) await this.markEditUsed(id, er);
  }

  private computeLine(l: RequisitionLine): Partial<RequisitionLine> {
    const item = l.itemId ? this.md.items[l.itemId] : undefined;
    if (!item) return { conversionStatus: undefined, baseQuantityRequested: null, baseUnit: undefined, conversionId: undefined };
    const c = convertToBase(item, l.quantityRequested, l.unitRequested, this.md.conversions);
    return { conversionStatus: c.status, baseQuantityRequested: c.baseQuantity, baseUnit: c.baseUnit, conversionId: c.conversionId ?? undefined };
  }

  async upsertLine(id: string, lineId: string | null, patch: Partial<RequisitionLine>) {
    const r = this.req(id);
    const existing = lineId ? r.lines[lineId] : null;
    if (lineId && !existing) throw new UserError("That line was removed.");
    const er = this.editGate(r, "line", lineId ?? undefined, lineId ? Object.keys(patch) : ["*"]);
    const now = nowISO();
    const lines = activeLines(r);
    const base: RequisitionLine = existing ?? {
      id: newId(), lineNumber: Math.max(0, ...lines.filter((l) => l.pageNumber === patch.pageNumber).map((l) => l.lineNumber)) + 1,
      createdAt: now, updatedAt: now,
    };
    const next: RequisitionLine = { ...base, ...patch, updatedAt: now };
    if (patch.itemId && patch.itemId !== base.itemId) {
      next.matchMethod = next.candidates?.find((c) => c.targetId === patch.itemId)?.method ?? "human";
      next.matchConfirmedBy = this.me;
      next.matchConfirmedAt = now;
    }
    if (!existing && !next.programmeId) next.programmeId = (next.pageNumber && r.pages[String(next.pageNumber)]?.programmeId) || r.primaryProgrammeId;
    Object.assign(next, this.computeLine(next));
    const status = er ? r.recordStatus : statusAfterEdit(r.recordStatus);
    await this.patchReq(id, { lines: { [next.id]: JSON.parse(JSON.stringify(next)) }, recordStatus: status });
    if (patch.itemId && patch.itemId !== base.itemId && (base.itemExtractedText || base.rawExtractedText)) {
      await this.noteAlias("item", patch.itemId, (base.itemExtractedText || base.rawExtractedText)!);
    }
    const old = existing ? Object.fromEntries(Object.keys(patch).map((k) => [k, (existing as any)[k] ?? null])) : null;
    await this.audit({ requisitionId: id, eventType: existing ? "line.changed" : "line.added", entityType: "requisition_line", entityId: next.id, oldValue: old, newValue: patch, editRequestId: er?.id });
    if (status !== r.recordStatus) await this.audit({ requisitionId: id, eventType: "record_status.changed", entityType: "requisition", entityId: id, oldValue: r.recordStatus, newValue: status, reason: "Edited after validation" });
    if (er) await this.markEditUsed(id, er);
    return next.id;
  }

  async removeLine(id: string, lineId: string) {
    const r = this.req(id);
    const er = this.editGate(r, "line", lineId, ["*"]);
    if (Object.values(r.fulfillment).some((f) => f.requisitionLineId === lineId)) throw new UserError("This line has fulfillment records, so it can't be removed.");
    const status = er ? r.recordStatus : statusAfterEdit(r.recordStatus);
    await this.patchReq(id, { lines: { [lineId]: null }, recordStatus: status });
    await this.audit({ requisitionId: id, eventType: "line.removed", entityType: "requisition_line", entityId: lineId, oldValue: r.lines[lineId], editRequestId: er?.id });
    if (er) await this.markEditUsed(id, er);
  }

  async setPageProgramme(id: string, page: number | "all", programmeId: string) {
    const r = this.req(id);
    const er = this.editGate(r, "page", page === "all" ? undefined : String(page), ["programmeId"]);
    const pages = page === "all" ? Object.keys(r.pages) : [String(page)];
    const pagePatch = Object.fromEntries(pages.map((p) => [p, { programmeId }]));
    const linePatch: Record<string, Partial<RequisitionLine>> = {};
    for (const l of activeLines(r)) {
      if (!l.programmeOverridden && pages.includes(String(l.pageNumber ?? ""))) linePatch[l.id] = { programmeId, updatedAt: nowISO() };
    }
    const status = er ? r.recordStatus : statusAfterEdit(r.recordStatus);
    await this.patchReq(id, { pages: pagePatch, lines: linePatch, recordStatus: status });
    await this.audit({ requisitionId: id, eventType: "page_programme.changed", entityType: "document_page", entityId: page === "all" ? "all" : String(page), newValue: { programmeId, pages, linesUpdated: Object.keys(linePatch).length }, editRequestId: er?.id });
    if (er) await this.markEditUsed(id, er);
  }

  async validate(id: string) {
    this.need("requisition.validate");
    const r = this.req(id);
    if (!["validation_pending", "reopened", "draft"].includes(r.recordStatus)) throw new UserError("Only requisitions awaiting validation can be validated.");
    const issues = validationIssues(r, this.md);
    if (issues.length) throw new UserError(issues.join("\n"));
    const now = nowISO();
    await this.patchReq(id, {
      recordStatus: "validated", validatedAt: now, validatedBy: this.me,
      ...(r.firstValidatedAt ? {} : { firstValidatedAt: now, firstValidatedBy: this.me }),
    });
    await this.audit({ requisitionId: id, eventType: "requisition.validated", entityType: "requisition", entityId: id, oldValue: r.recordStatus, newValue: "validated" });
  }

  async finalize(id: string) {
    this.need("requisition.finalize");
    const r = this.req(id);
    const issues = finalizationIssues(r, this.md);
    if (issues.length) throw new UserError(issues.join("\n"));
    const now = nowISO();
    await this.patchReq(id, { recordStatus: "finalized", finalizedAt: now, finalizedBy: this.me });
    await this.audit({ requisitionId: id, eventType: "requisition.finalized", entityType: "requisition", entityId: id, oldValue: r.recordStatus, newValue: "finalized" });
  }

  async cancel(id: string, reason: string) {
    const r = this.req(id);
    if (!reason.trim()) throw new UserError("Give a reason for cancelling.");
    if (r.recordStatus === "cancelled") throw new UserError("Already cancelled.");
    const hasFulfillment = effectiveFulfillment(r).length > 0;
    this.need(r.recordStatus === "finalized" || hasFulfillment ? "requisition.cancel_finalized" : "requisition.cancel");
    const now = nowISO();
    await this.patchReq(id, { recordStatus: "cancelled", cancelledAt: now, cancelledBy: this.me, cancellationReason: reason });
    await this.audit({ requisitionId: id, eventType: "requisition.cancelled", entityType: "requisition", entityId: id, oldValue: r.recordStatus, newValue: "cancelled", reason });
  }

  async reopen(id: string, reason: string) {
    this.need("requisition.reopen");
    const r = this.req(id);
    if (r.recordStatus !== "finalized") throw new UserError("Only finalized requisitions can be reopened.");
    if (!reason.trim()) throw new UserError("Give a reason for reopening.");
    const now = nowISO();
    await this.patchReq(id, { recordStatus: "reopened", reopenedAt: now, reopenedBy: this.me, reopenReason: reason });
    await this.audit({ requisitionId: id, eventType: "requisition.reopened", entityType: "requisition", entityId: id, oldValue: "finalized", newValue: "reopened", reason });
  }

  // ---------- documents ----------
  async uploadEvidence(id: string, files: File[], opts: { lifecycleEventId?: string; documentType: string; description?: string; category?: DocumentCategory }) {
    this.need("evidence.upload");
    const r = this.req(id);
    if (r.recordStatus === "cancelled") throw new UserError("This requisition is cancelled.");
    const out: ReqDocument[] = [];
    for (const f of files) {
      if (!ACCEPTED_TYPES.includes(f.type)) throw new UserError(`${f.name}: use a JPEG, PNG, WebP, GIF or PDF file.`);
      if (f.size > MAX_FILE_BYTES) throw new UserError(`${f.name} is larger than 20 MB.`);
      const d = await this.uploadFile(f, opts.category ?? (opts.lifecycleEventId ? "lifecycle_evidence" : "supporting"), opts.documentType, 0, opts.lifecycleEventId, opts.description);
      out.push(d);
      await this.patchReq(id, { documents: { [d.id]: JSON.parse(JSON.stringify(d)) } });
      await this.audit({ requisitionId: id, eventType: "evidence.uploaded", entityType: "document", entityId: d.id, newValue: { fileName: d.fileName, sha256: d.sha256, documentType: d.documentType, lifecycleEventId: d.lifecycleEventId ?? null } });
    }
    return out;
  }

  async logDownload(id: string, docId: string) {
    this.need("documents.download");
    await this.audit({ requisitionId: id, eventType: "document.downloaded", entityType: "document", entityId: docId });
  }

  // ---------- lifecycle ----------
  private postCloseGate(r: Requisition): EditRequest | undefined {
    if (r.fulfillmentStatus !== "closed") return undefined;
    const er = activeEditPermission(r, this.me, this.settings().editRequestPendingTimeoutDays);
    if (er && er.changes.some((c) => c.entityType === "fulfillment" || c.entityType === "lifecycle")) return er;
    throw new UserError(
      this.actor.role === "admin"
        ? "Fulfillment is closed. Reopen fulfillment first."
        : "Fulfillment is closed. Submit an edit request to correct it.",
    );
  }

  async recordEvent(id: string, input: {
    stage: OperationalStage; status: "completed" | "not_applicable"; occurredAt: ISO; notes?: string; notApplicableReason?: string;
    override?: boolean; overrideReason?: string; files?: File[]; documentType?: string;
  }, supersedesId?: string, correctionReason?: string) {
    this.need("lifecycle.record");
    const r = this.req(id);
    const er = this.postCloseGate(r);
    if (!supersedesId) {
      const why = canRecordStage(r, input.stage);
      if (why) throw new UserError(why);
    } else {
      if (!canSupersede(r.events, supersedesId)) throw new UserError("That event has already been corrected or voided.");
      if (r.events[supersedesId].stage !== input.stage) throw new UserError("A correction must be for the same stage.");
      if (!correctionReason?.trim()) throw new UserError("Give a reason for the correction.");
    }
    if (input.status === "not_applicable") {
      if (input.stage === "completed") throw new UserError("Completed can't be marked Not Applicable.");
      if (!input.notApplicableReason?.trim()) throw new UserError("Give a reason for Not Applicable.");
    }
    if (input.override) {
      this.need("chronology.override");
      if (!input.overrideReason?.trim()) throw new UserError("Give a reason for the chronology override.");
    }
    const { hard, overridable } = chronologyErrors(r, input.stage, input.occurredAt, { ignoreEventId: supersedesId, override: input.override });
    if (hard.length || overridable.length) {
      throw new UserError([...hard, ...overridable].join("\n") + (overridable.length && can(this.actor, "chronology.override") ? "\nAn Administrator can record it with a chronology override." : ""));
    }
    const ev: LifecycleEvent = {
      id: newId(), stage: input.stage, status: input.status, occurredAt: input.occurredAt, recordedAt: nowISO(), recordedBy: this.me,
      notes: input.notes || undefined, notApplicableReason: input.status === "not_applicable" ? input.notApplicableReason : undefined,
      chronologyOverride: input.override || undefined, overrideReason: input.override ? input.overrideReason : undefined,
      recordType: supersedesId ? "correction" : "entry", supersedesId, correctionReason, editRequestId: er?.id,
    };
    await this.patchReq(id, { events: { [ev.id]: JSON.parse(JSON.stringify(ev)) } });
    await this.audit({
      requisitionId: id, eventType: supersedesId ? "lifecycle.corrected" : "lifecycle.recorded", entityType: "lifecycle_event", entityId: ev.id,
      oldValue: supersedesId ? r.events[supersedesId] : undefined, newValue: ev, reason: correctionReason ?? input.overrideReason, editRequestId: er?.id,
    });
    if (input.files?.length) await this.uploadEvidence(id, input.files, { lifecycleEventId: ev.id, documentType: input.documentType ?? "other" });
    if (er) await this.markEditUsed(id, er);
    return ev.id;
  }

  async voidEvent(id: string, eventId: string, reason: string) {
    this.need("lifecycle.record");
    const r = this.req(id);
    const er = this.postCloseGate(r);
    if (!reason.trim()) throw new UserError("Give a reason for voiding.");
    if (!canSupersede(r.events, eventId)) throw new UserError("That event has already been corrected or voided.");
    const t = r.events[eventId];
    const ev: LifecycleEvent = {
      id: newId(), stage: t.stage, status: t.status, occurredAt: t.occurredAt, recordedAt: nowISO(), recordedBy: this.me,
      recordType: "void", supersedesId: eventId, correctionReason: reason, editRequestId: er?.id,
    };
    await this.patchReq(id, { events: { [ev.id]: JSON.parse(JSON.stringify(ev)) } });
    await this.audit({ requisitionId: id, eventType: "lifecycle.voided", entityType: "lifecycle_event", entityId: ev.id, oldValue: t, reason, editRequestId: er?.id });
    if (er) await this.markEditUsed(id, er);
  }

  // ---------- fulfillment ----------
  private buildRecord(r: Requisition, input: {
    lineId: string | null; itemId: string; stage: FulfillmentStage; quantity: number; unit: string; reference?: string; documentId?: string; occurredAt: ISO; notes?: string;
  }): FulfillmentRecord {
    const item = this.md.items[input.itemId];
    if (!item) throw new UserError("Choose the item that was supplied.");
    if (!(input.quantity >= 0) || !isFinite(input.quantity)) throw new UserError("Enter a quantity of 0 or more.");
    if (!input.unit) throw new UserError("Enter the unit.");
    if (Date.parse(input.occurredAt) > Date.now() + 60_000) throw new UserError("The date can't be in the future.");
    if (Math.floor(Date.parse(input.occurredAt) / 60000) < Math.floor(Date.parse(r.receivedAt) / 60000)) throw new UserError("The date can't be earlier than when the requisition was received.");
    const line = input.lineId ? r.lines[input.lineId] : null;
    if (input.lineId && !line) throw new UserError("That line no longer exists.");
    const c = convertToBase(item, input.quantity, input.unit, this.md.conversions);
    return {
      id: newId(), requisitionLineId: input.lineId, itemId: input.itemId, stage: input.stage, quantity: input.quantity, unit: normalizeUnit(input.unit),
      baseQuantity: c.baseQuantity, baseUnit: c.baseUnit, conversionId: c.conversionId, conversionStatus: c.status,
      substitution: !!line && line.itemId !== input.itemId, additional: !input.lineId,
      reference: input.reference || undefined, documentId: input.documentId || undefined, occurredAt: input.occurredAt, recordedAt: nowISO(),
      recordedBy: this.me, notes: input.notes || undefined, recordType: "entry",
    };
  }

  async recordFulfillment(id: string, rows: Array<Parameters<Services["buildRecord"]>[1]>) {
    this.need("fulfillment.record");
    const r = this.req(id);
    if (r.recordStatus === "cancelled") throw new UserError("This requisition is cancelled.");
    if (!r.firstValidatedAt) throw new UserError("Validate the requisition before recording fulfillment.");
    const er = this.postCloseGate(r);
    if (!rows.length) throw new UserError("Enter at least one quantity.");
    const recs = rows.map((row) => ({ ...this.buildRecord(r, row), editRequestId: er?.id }));
    const patch: Patch = { fulfillment: Object.fromEntries(recs.map((x) => [x.id, JSON.parse(JSON.stringify(x))])) };
    if (r.fulfillmentStatus === "open") patch.fulfillmentStatus = "partial";
    await this.patchReq(id, patch);
    for (const x of recs) await this.audit({ requisitionId: id, eventType: "fulfillment.captured", entityType: "fulfillment_record", entityId: x.id, newValue: x, editRequestId: er?.id });
    if (patch.fulfillmentStatus) await this.audit({ requisitionId: id, eventType: "fulfillment_status.changed", entityType: "requisition", entityId: id, oldValue: "open", newValue: "partial", actorType: "system" });
    if (er) await this.markEditUsed(id, er);
  }

  async correctFulfillment(id: string, targetId: string, row: Parameters<Services["buildRecord"]>[1] | null, reason: string) {
    this.need("fulfillment.record");
    const r = this.req(id);
    const er = this.postCloseGate(r);
    if (!reason.trim()) throw new UserError("Give a reason.");
    if (!canSupersede(r.fulfillment, targetId)) throw new UserError("That record has already been corrected or voided.");
    const t = r.fulfillment[targetId];
    let rec: FulfillmentRecord;
    if (row) {
      if (row.stage !== t.stage) throw new UserError("A correction must be for the same fulfillment stage.");
      rec = { ...this.buildRecord(r, row), recordType: "correction", supersedesId: targetId, correctionReason: reason, editRequestId: er?.id };
    } else {
      rec = { ...t, id: newId(), quantity: null, baseQuantity: null, recordedAt: nowISO(), recordedBy: this.me, recordType: "void", supersedesId: targetId, correctionReason: reason, editRequestId: er?.id, notes: undefined };
    }
    await this.patchReq(id, { fulfillment: { [rec.id]: JSON.parse(JSON.stringify(rec)) } });
    await this.audit({ requisitionId: id, eventType: row ? "fulfillment.corrected" : "fulfillment.voided", entityType: "fulfillment_record", entityId: rec.id, oldValue: t, newValue: row ? rec : undefined, reason, editRequestId: er?.id });
    if (er) await this.markEditUsed(id, er);
  }

  async closeFulfillment(id: string, reason?: string) {
    this.need("fulfillment.close");
    const r = this.req(id);
    const issues = closeFulfillmentIssues(r, reason);
    if (issues.length) throw new UserError(issues.join("\n"));
    await this.patchReq(id, { fulfillmentStatus: "closed", fulfillmentClosedAt: nowISO(), fulfillmentClosedBy: this.me, fulfillmentClosureReason: reason?.trim() || null });
    await this.audit({ requisitionId: id, eventType: "fulfillment.closed", entityType: "requisition", entityId: id, oldValue: r.fulfillmentStatus, newValue: "closed", reason });
  }

  async reopenFulfillment(id: string, reason: string) {
    this.need("fulfillment.reopen");
    const r = this.req(id);
    if (r.fulfillmentStatus !== "closed") throw new UserError("Fulfillment isn't closed.");
    if (!reason.trim()) throw new UserError("Give a reason.");
    await this.patchReq(id, { fulfillmentStatus: "partial", fulfillmentClosedAt: null, fulfillmentClosedBy: null, fulfillmentClosureReason: null });
    await this.audit({ requisitionId: id, eventType: "fulfillment.reopened", entityType: "requisition", entityId: id, oldValue: "closed", newValue: "partial", reason });
  }

  // ---------- edit requests ----------
  async submitEditRequest(id: string, reason: string, changes: RequestedChange[]) {
    this.need("edit_request.submit");
    const r = this.req(id);
    if (r.recordStatus !== "finalized") throw new UserError("Edit requests are for finalized requisitions.");
    if (!reason.trim()) throw new UserError("Give a reason.");
    if (!changes.length) throw new UserError("List at least one change.");
    if (Object.values(r.editRequests).some((e) => e.requestedBy === this.me && ["pending", "approved"].includes(effectiveEditStatus(e, this.settings().editRequestPendingTimeoutDays)))) {
      throw new UserError("You already have an open edit request on this requisition.");
    }
    const er: EditRequest = { id: newId(), requestedBy: this.me, requestedAt: nowISO(), reason, changes, status: "pending" };
    await this.patchReq(id, { editRequests: { [er.id]: JSON.parse(JSON.stringify(er)) } });
    await this.audit({ requisitionId: id, eventType: "edit_request.submitted", entityType: "edit_request", entityId: er.id, newValue: { reason, changes }, editRequestId: er.id });
  }

  async decideEditRequest(id: string, erId: string, decision: "approved" | "rejected", rejectionReason?: string) {
    this.need("edit_request.approve");
    const r = this.req(id);
    const er = r.editRequests[erId];
    if (!er) throw new UserError("Edit request not found.");
    const why = canDecideEditRequest({ ...er, status: effectiveEditStatus(er, this.settings().editRequestPendingTimeoutDays) }, this.me);
    if (why) throw new UserError(why);
    if (decision === "rejected" && !rejectionReason?.trim()) throw new UserError("Give a reason for rejecting.");
    const now = nowISO();
    const patch: Partial<EditRequest> =
      decision === "approved"
        ? { status: "approved", decision, decidedBy: this.me, decidedAt: now, approvalExpiresAt: new Date(Date.now() + this.settings().editWindowHours * 3600000).toISOString() }
        : { status: "rejected", decision, decidedBy: this.me, decidedAt: now, rejectionReason, closedAt: now, closureReason: "rejected" };
    await this.patchReq(id, { editRequests: { [erId]: patch } });
    await this.audit({ requisitionId: id, eventType: `edit_request.${decision}`, entityType: "edit_request", entityId: erId, reason: rejectionReason, editRequestId: erId });
  }

  async withdrawEditRequest(id: string, erId: string) {
    const r = this.req(id);
    const er = r.editRequests[erId];
    if (!er || er.requestedBy !== this.me || er.status !== "pending") throw new UserError("Only your own pending request can be withdrawn.");
    const now = nowISO();
    await this.patchReq(id, { editRequests: { [erId]: { status: "withdrawn", closedAt: now, closureReason: "withdrawn" } } });
    await this.audit({ requisitionId: id, eventType: "edit_request.withdrawn", entityType: "edit_request", entityId: erId, editRequestId: erId });
  }

  private async markEditUsed(id: string, er: EditRequest) {
    const now = nowISO();
    await this.patchReq(id, { editRequests: { [er.id]: { status: "used", usedAt: now, closedAt: now, closureReason: "used" } } });
    await this.audit({ requisitionId: id, eventType: "edit_request.used", entityType: "edit_request", entityId: er.id, editRequestId: er.id });
  }

  /** Apply all header/line/page values of an approved request in one save, then close it. */
  async applyApprovedEdit(id: string, erId: string, values: Record<number, unknown>) {
    const r = this.req(id);
    const er = r.editRequests[erId];
    if (!er || er.requestedBy !== this.me || effectiveEditStatus(er, this.settings().editRequestPendingTimeoutDays) !== "approved") {
      throw new UserError("This edit permission isn't active. It may have expired.");
    }
    const header: Patch = {};
    const lines: Record<string, Patch> = {};
    const pages: Record<string, Patch> = {};
    er.changes.forEach((c, i) => {
      const v = i in values ? values[i] : c.proposedValue;
      if (c.entityType === "header") header[c.field] = v;
      if (c.entityType === "line" && c.entityId) (lines[c.entityId] ??= {})[c.field] = v;
      if (c.entityType === "page" && c.entityId) pages[c.entityId] = { programmeId: v };
    });
    const now = nowISO();
    const linePatch: Record<string, Patch> = {};
    for (const [lid, p] of Object.entries(lines)) {
      const cur = r.lines[lid];
      if (!cur) continue;
      const next = { ...cur, ...p, updatedAt: now } as RequisitionLine;
      if (p.programmeId) next.programmeOverridden = true;
      linePatch[lid] = { ...p, ...this.computeLine(next), updatedAt: now };
    }
    await this.patchReq(id, JSON.parse(JSON.stringify({ ...header, lines: linePatch, pages })));
    await this.audit({ requisitionId: id, eventType: "finalized_record.edited", entityType: "requisition", entityId: id, newValue: { header, lines, pages }, editRequestId: erId, reason: er.reason });
    await this.markEditUsed(id, er);
  }

  // ---------- aliases ----------
  private async noteAlias(entityType: "facility" | "item", entityId: string, text: string) {
    const n = normalize(text);
    if (!n) return;
    const md = this.md;
    const target = entityType === "facility" ? md.facilities[entityId]?.name : md.items[entityId]?.name;
    if (!target || normalize(target) === n) return;
    if (Object.values(md.aliases).some((a) => a.entityType === entityType && a.entityId === entityId && a.normalized === n)) return;
    const key = `al-${entityType}-${entityId}-${n.replace(/[^a-z0-9]/g, "").slice(0, 60)}`;
    const existing = this.state().proposals[key] as Alias | undefined;
    if (existing && existing.status !== "candidate") return;
    const doc = { kind: "alias", id: key, entityType, entityId, alias: text, normalized: n, occurrences: (existing?.occurrences ?? 0) + 1, status: "candidate", createdAt: existing?.createdAt ?? nowISO() };
    await this.store.set(`proposals/${key}`, doc).catch(() => undefined);
  }

  async decideAlias(key: string, decision: "approved" | "rejected") {
    this.need("alias.approve");
    const p = this.state().proposals[key] as any;
    if (!p) throw new UserError("Alias candidate not found.");
    const now = nowISO();
    if (decision === "approved") {
      const a: Alias = { id: key, entityType: p.entityType, entityId: p.entityId, alias: p.alias, normalized: p.normalized, occurrences: p.occurrences, status: "approved", decidedBy: this.me, decidedAt: now, createdAt: p.createdAt };
      await this.store.set(`aliases/${key}`, a as any);
    }
    await this.store.update(`proposals/${key}`, { status: decision, decidedBy: this.me, decidedAt: now });
    await this.audit({ eventType: `alias.${decision}`, entityType: `${p.entityType}_alias`, entityId: key, newValue: { alias: p.alias, entityId: p.entityId } });
  }

  async addAlias(entityType: "facility" | "item", entityId: string, alias: string) {
    this.need("alias.approve");
    const n = normalize(alias);
    if (!n) throw new UserError("Enter the alias text.");
    const id = `al-${entityType}-${entityId}-${n.replace(/[^a-z0-9]/g, "").slice(0, 60)}`;
    const a: Alias = { id, entityType, entityId, alias, normalized: n, occurrences: 0, status: "approved", decidedBy: this.me, decidedAt: nowISO(), createdAt: nowISO() };
    await this.store.set(`aliases/${id}`, a as any);
    await this.audit({ eventType: "alias.approved", entityType: `${entityType}_alias`, entityId: id, newValue: { alias, entityId } });
  }

  async retireAlias(id: string) {
    this.need("alias.approve");
    await this.store.update(`aliases/${id}`, { status: "rejected", decidedBy: this.me, decidedAt: nowISO() });
    await this.audit({ eventType: "alias.retired", entityType: "alias", entityId: id });
  }

  // ---------- conversions & equivalences ----------
  async proposeConversion(c: { itemId: string | null; fromUnit: string; factor: number; incompatible?: boolean; notes?: string }) {
    this.need("conversion.propose");
    const item = c.itemId ? this.md.items[c.itemId] : undefined;
    const from = normalizeUnit(c.fromUnit);
    if (!from) throw new UserError("Enter the unit to convert from.");
    if (!c.incompatible && !(c.factor > 0)) throw new UserError("Enter a factor above 0.");
    const toUnit = item ? normalizeUnit(item.baseUnit) : "";
    if (c.itemId && !item) throw new UserError("Unknown item.");
    const doc: UnitConversion = {
      id: newId(), itemId: c.itemId, fromUnit: from, toUnit, factor: c.incompatible ? 0 : c.factor, incompatible: c.incompatible || undefined,
      status: "proposed", proposedBy: this.me, proposedAt: nowISO(), notes: c.notes,
    };
    if (this.actor.role === "admin") return this.approveConversion(doc);
    await this.store.set(`proposals/cv-${doc.id}`, JSON.parse(JSON.stringify({ kind: "conversion", ...doc })));
    await this.audit({ eventType: "conversion.proposed", entityType: "unit_conversion", entityId: doc.id, newValue: doc });
  }

  async approveConversion(c: UnitConversion, proposalKey?: string) {
    this.need("conversion.approve");
    const now = nowISO();
    // Approved conversions are never edited: retire any approved one for the same item/unit first.
    for (const old of Object.values(this.md.conversions)) {
      if (old.status === "approved" && old.itemId === c.itemId && normalizeUnit(old.fromUnit) === normalizeUnit(c.fromUnit)) {
        await this.store.update(`conversions/${old.id}`, { status: "retired", retiredBy: this.me, retiredAt: now });
        await this.audit({ eventType: "conversion.retired", entityType: "unit_conversion", entityId: old.id, reason: "Replaced by a newer approved conversion" });
      }
    }
    const approved: UnitConversion = { ...c, status: "approved", approvedBy: this.me, approvedAt: now };
    await this.store.set(`conversions/${c.id}`, JSON.parse(JSON.stringify(approved)));
    if (proposalKey) await this.store.update(`proposals/${proposalKey}`, { status: "approved", approvedBy: this.me, approvedAt: now });
    await this.audit({ eventType: "conversion.approved", entityType: "unit_conversion", entityId: c.id, newValue: approved });
    this.md.conversions[c.id] = approved;
    await this.resolveConversions();
  }

  async rejectProposal(key: string) {
    this.need("conversion.approve");
    await this.store.update(`proposals/${key}`, { status: "rejected", decidedBy: this.me, decidedAt: nowISO() });
    await this.audit({ eventType: "proposal.rejected", entityType: "proposal", entityId: key });
  }

  async retireConversion(id: string) {
    this.need("conversion.approve");
    await this.store.update(`conversions/${id}`, { status: "retired", retiredBy: this.me, retiredAt: nowISO() });
    await this.audit({ eventType: "conversion.retired", entityType: "unit_conversion", entityId: id });
  }

  /** Conversion resolution (§10.5): fill base quantities on lines whose conversion was unknown. */
  async resolveConversions(): Promise<number> {
    let count = 0;
    for (const r of Object.values(this.state().reqs)) {
      if (r.recordStatus === "cancelled") continue;
      const patch: Record<string, Partial<RequisitionLine>> = {};
      for (const l of activeLines(r)) {
        if (l.conversionStatus !== "unknown" || !l.itemId) continue;
        const c = convertToBase(this.md.items[l.itemId], l.quantityRequested, l.unitRequested, this.md.conversions);
        if (c.status === "unknown") continue;
        patch[l.id] = { conversionStatus: c.status, baseQuantityRequested: c.baseQuantity, baseUnit: c.baseUnit, conversionId: c.conversionId };
      }
      if (!Object.keys(patch).length) continue;
      await this.store.update(`reqs/${r.id}`, JSON.parse(JSON.stringify({ lines: patch })));
      await this.audit({ requisitionId: r.id, actorType: "system", eventType: "line.conversion_resolved", entityType: "requisition_line", entityId: Object.keys(patch).join(","), newValue: patch });
      count += Object.keys(patch).length;
    }
    return count;
  }

  async proposeEquivalence(e: { requestedItemId: string; substituteItemId: string; factor: number; basis: SubstitutionEquivalence["basis"]; justification: string }) {
    this.need("conversion.propose");
    if (e.requestedItemId === e.substituteItemId) throw new UserError("Choose two different items.");
    if (!(e.factor > 0)) throw new UserError("Enter a factor above 0.");
    if (!e.basis.length) throw new UserError("Choose the basis for the equivalence.");
    if (!e.justification.trim()) throw new UserError("Explain why these items are equivalent.");
    const doc: SubstitutionEquivalence = { id: newId(), ...e, status: "proposed", proposedBy: this.me, proposedAt: nowISO() };
    if (this.actor.role === "admin") return this.approveEquivalence(doc);
    await this.store.set(`proposals/eq-${doc.id}`, JSON.parse(JSON.stringify({ kind: "equivalence", ...doc })));
    await this.audit({ eventType: "equivalence.proposed", entityType: "substitution_equivalence", entityId: doc.id, newValue: doc });
  }

  async approveEquivalence(e: SubstitutionEquivalence, proposalKey?: string) {
    this.need("conversion.approve");
    const now = nowISO();
    for (const old of Object.values(this.md.equivalences)) {
      if (old.status === "approved" && old.requestedItemId === e.requestedItemId && old.substituteItemId === e.substituteItemId) {
        await this.store.update(`equivalences/${old.id}`, { status: "retired", retiredBy: this.me, retiredAt: now });
        await this.audit({ eventType: "equivalence.retired", entityType: "substitution_equivalence", entityId: old.id, reason: "Replaced by a newer approved rule" });
      }
    }
    const approved = { ...e, status: "approved" as const, approvedBy: this.me, approvedAt: now };
    await this.store.set(`equivalences/${e.id}`, JSON.parse(JSON.stringify(approved)));
    if (proposalKey) await this.store.update(`proposals/${proposalKey}`, { status: "approved", approvedBy: this.me, approvedAt: now });
    await this.audit({ eventType: "equivalence.approved", entityType: "substitution_equivalence", entityId: e.id, newValue: approved });
  }

  async retireEquivalence(id: string) {
    this.need("conversion.approve");
    await this.store.update(`equivalences/${id}`, { status: "retired", retiredBy: this.me, retiredAt: nowISO() });
    await this.audit({ eventType: "equivalence.retired", entityType: "substitution_equivalence", entityId: id });
  }

  // ---------- master data ----------
  async saveFacility(f: Partial<Facility> & { name: string }) {
    this.need("master.manage");
    if (!f.name.trim()) throw new UserError("Enter the facility name.");
    const now = nowISO();
    const id = f.id ?? newId();
    const old = this.md.facilities[id];
    const doc: Facility = { ...old, ...f, status: f.status ?? old?.status ?? "active", id, name: f.name.trim(), createdAt: old?.createdAt ?? now, updatedAt: now };
    await this.store.set(`facilities/${id}`, JSON.parse(JSON.stringify(doc)));
    await this.audit({ eventType: old ? "facility.changed" : "facility.created", entityType: "facility", entityId: id, oldValue: old, newValue: doc });
    return id;
  }

  async saveItem(i: Partial<Item> & { name: string; code: string; baseUnit: string }) {
    this.need("master.manage");
    if (!i.name.trim() || !i.code.trim() || !i.baseUnit.trim()) throw new UserError("Item code, name and base unit are required.");
    const dup = Object.values(this.md.items).find((x) => x.code.toLowerCase() === i.code.trim().toLowerCase() && x.id !== i.id);
    if (dup) throw new UserError(`Item code ${i.code} is already used by ${dup.name}.`);
    const now = nowISO();
    const id = i.id ?? newId();
    const old = this.md.items[id];
    const doc: Item = { ...old, ...i, status: i.status ?? old?.status ?? "active", id, code: i.code.trim(), name: i.name.trim(), baseUnit: normalizeUnit(i.baseUnit), createdAt: old?.createdAt ?? now, updatedAt: now };
    await this.store.set(`items/${id}`, JSON.parse(JSON.stringify(doc)));
    await this.audit({ eventType: old ? "item.changed" : "item.created", entityType: "item", entityId: id, oldValue: old, newValue: doc });
    return id;
  }

  async saveProgramme(p: Partial<Programme> & { name: string }) {
    this.need("master.manage");
    if (!p.name.trim()) throw new UserError("Enter the programme name.");
    const dup = Object.values(this.md.programmes).find((x) => normalize(x.name) === normalize(p.name) && x.id !== p.id);
    if (dup) throw new UserError(`${p.name} already exists.`);
    const id = p.id ?? newId();
    const old = this.md.programmes[id];
    const doc: Programme = { ...old, ...p, status: p.status ?? old?.status ?? "active", id, name: p.name.trim() };
    await this.store.set(`programmes/${id}`, JSON.parse(JSON.stringify(doc)));
    await this.audit({ eventType: old ? "programme.changed" : "programme.created", entityType: "programme", entityId: id, oldValue: old, newValue: doc });
  }

  async saveSettings(s: Settings) {
    this.need("settings.manage");
    if (!(s.ofrThresholdPercent > 0 && s.ofrThresholdPercent <= 100)) throw new UserError("The OFR threshold must be between 1 and 100.");
    if (!(s.editWindowHours > 0)) throw new UserError("The edit window must be above 0 hours.");
    const old = this.md.settings;
    await this.store.set("config/settings", JSON.parse(JSON.stringify(s)));
    await this.audit({ eventType: "settings.changed", entityType: "system_setting", entityId: "settings", oldValue: old, newValue: s });
  }

  async saveRole(userId: string, role: RoleCode, grants: Grant[]) {
    this.need("users.manage");
    const cur = (await this.store.get("config/roles")) ?? {};
    const old = (cur as any)[userId];
    const next: RoleAssignment = { role, grants: role === "supervisor" ? grants : [], updatedBy: this.me, updatedAt: nowISO() };
    await this.store.set("config/roles", { ...cur, [userId]: next } as any);
    await this.audit({ eventType: "role.changed", entityType: "user", entityId: userId, oldValue: old, newValue: next });
  }

  async loadStarterMasterData(data: { programmes: string[]; facilities: Array<Partial<Facility> & { name: string }>; items: Array<Partial<Item> & { name: string; code: string; baseUnit: string }> }) {
    this.need("master.manage");
    const existingProg = new Set(Object.values(this.md.programmes).map((p) => normalize(p.name)));
    for (const name of data.programmes) if (!existingProg.has(normalize(name))) await this.saveProgramme({ name });
    const existingFac = new Set(Object.values(this.md.facilities).map((f) => normalize(f.name)));
    for (const f of data.facilities) if (!existingFac.has(normalize(f.name))) await this.saveFacility(f);
    const existingCodes = new Set(Object.values(this.md.items).map((i) => i.code.toLowerCase()));
    for (const i of data.items) if (!existingCodes.has(i.code.toLowerCase())) await this.saveItem(i);
  }
}

export { STAGE_LABEL };

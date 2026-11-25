// V2: the NebulaServices contract over the FastAPI backend. All rules are
// enforced by the server; this client only sends requests, keeps a cache of
// /api/state for the pages, and turns server errors into UserError messages.
import {
  UserError, type AppState, type AuditPageResult, type FulfillmentRowInput, type HeaderPatch, type NebulaServices, type RecordEventInput,
  type WebUser,
} from "./api-types";
import {
  DEFAULT_SETTINGS, type AuditEvent, type DocumentCategory, type Facility, type Grant, type ISO, type Item, type Programme, type ReqDocument,
  type RequestedChange, type Requisition, type RequisitionLine, type RoleCode, type Settings, type SubstitutionEquivalence, type UnitConversion,
} from "../domain/types";

export interface Me {
  id: string;
  email?: string | null;
  name?: string | null;
  role: RoleCode | null;
  grants: Grant[];
  status: "pending" | "active" | "inactive";
}

export interface PublicConfig {
  clerkPublishableKey: string;
  env: string;
  devAuth: boolean;
}

export interface AiSettings {
  enabled: boolean;
  model: string;
  fallbackModel: string | null;
  maxPagesPerJob: number;
  perUserPagesPerDay: number;
  perUserJobsPerHour: number;
  orgMonthlyBudgetUsd: number;
  lowBalanceUsd: number;
  keyConfigured?: boolean;
  keyHint?: string | null;
  keySource?: "database" | "environment" | null;
}

export interface AiStatus {
  enabled: boolean;
  readyForReading: boolean;
  reason?: string;
}

export interface AiUsage {
  month?: string;
  totals: { costUsd: number; pages: number; jobs: number; errors: number; refused: number };
  users: Array<{ userId: string; pages: number; jobs: number; costUsd: number }>;
  days: Array<{ day: string; pages: number; jobs: number; costUsd: number }>;
  budget: { monthlyBudgetUsd: number; spentUsd: number; remainingUsd: number };
  openrouter: { total_credits?: number; total_usage?: number; remaining?: number } | null;
  openrouterNote?: string;
  lowBalance?: boolean;
}

export type TokenGetter = () => Promise<string | null>;

/** JSON drops undefined; a cleared field must reach the server as null. */
function nulls<T extends object>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === undefined ? null : v]));
}

function emptyState(): AppState {
  return {
    reqs: {},
    md: { facilities: {}, items: {}, programmes: {}, conversions: {}, equivalences: {}, aliases: {}, settings: DEFAULT_SETTINGS },
    roles: {},
    proposals: {},
    users: [],
  };
}

async function errorMessage(res: Response): Promise<string> {
  let detail: unknown;
  try {
    detail = (await res.json())?.detail;
  } catch {
    detail = undefined;
  }
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0] as { msg?: string; loc?: unknown[] };
    const field = Array.isArray(first?.loc) ? String(first.loc[first.loc.length - 1]) : "";
    return `Some information is missing or invalid${field ? ` (${field})` : ""}.`;
  }
  if (res.status === 401) return "Your session has expired. Sign in again.";
  if (res.status === 403) return "Your role doesn't allow this action.";
  if (res.status === 404) return "Not found. It may have been removed, or this server is out of date.";
  if (res.status === 429) return "Too many requests. Wait a moment and try again.";
  if (res.status >= 500) return "The server had a problem. Try again in a moment.";
  return `The request failed (${res.status}).`;
}

export class ApiServices implements NebulaServices {
  state: AppState = emptyState();
  loaded = false;
  loadError: string | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    private getToken: TokenGetter,
    private extraHeaders: Record<string, string> = {},
    private base = "",
  ) {}

  // ---------------------------------------------------------------- transport
  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { ...this.extraHeaders };
    const token = await this.getToken();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
    const headers = await this.headers();
    let payload: BodyInit | undefined;
    if (form) payload = form;
    else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(`${this.base}/api${path}`, { method, headers, body: payload, credentials: "same-origin" });
    } catch {
      throw new UserError("Nebula's server can't be reached. Check your connection and try again.");
    }
    if (!res.ok) throw new UserError(await errorMessage(res));
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** A mutation: apply the returned requisition (if any), else refresh the whole state. */
  private async mutate<T extends Record<string, unknown> | undefined>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
    const out = await this.request<T>(method, path, body, form);
    const req = (out as { requisition?: Requisition } | undefined)?.requisition;
    if (req && req.id) {
      this.state = { ...this.state, reqs: { ...this.state.reqs, [req.id]: req } };
      this.emit();
    } else {
      await this.refresh();
    }
    return out;
  }

  // ---------------------------------------------------------------- state cache
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    this.listeners.forEach((cb) => cb());
  }

  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const s = await this.request<AppState>("GET", "/state");
        this.state = {
          reqs: s.reqs ?? {},
          md: { ...emptyState().md, ...(s.md ?? {}), settings: { ...DEFAULT_SETTINGS, ...(s.md?.settings ?? {}) } },
          roles: s.roles ?? {},
          proposals: s.proposals ?? {},
          users: s.users ?? [],
        };
        this.loaded = true;
        this.loadError = null;
      } catch (e) {
        this.loadError = e instanceof Error ? e.message : "The data couldn't be loaded.";
      } finally {
        this.inflight = null;
        this.emit();
      }
    })();
    return this.inflight;
  }

  /** Poll /api/state: every 3 s while a document is being read, else every 20 s, only while the tab is visible. */
  startPolling(): () => void {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (typeof document === "undefined" || document.visibilityState === "visible") await this.refresh();
      const busy = Object.values(this.state.reqs).some((r) => r.recordStatus === "processing");
      this.timer = setTimeout(tick, busy ? 3000 : 20000);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        if (this.timer) clearTimeout(this.timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      stopped = true;
      if (this.timer) clearTimeout(this.timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }

  // ---------------------------------------------------------------- session
  me(): Promise<Me> {
    return this.request<Me>("GET", "/me");
  }

  static async config(base = ""): Promise<PublicConfig> {
    const res = await fetch(`${base}/api/config`);
    if (!res.ok) throw new UserError("Nebula's server can't be reached.");
    return res.json();
  }

  // ---------------------------------------------------------------- requisitions
  async createRequisition(input: { receivedAt: ISO; receivedVia?: string; files: File[]; read: boolean }): Promise<string> {
    if (!input.files.length) throw new UserError("Attach the original requisition (photo or PDF).");
    const form = new FormData();
    form.append("receivedAt", input.receivedAt);
    if (input.receivedVia) form.append("receivedVia", input.receivedVia);
    form.append("read", input.read ? "true" : "false");
    input.files.forEach((f) => form.append("files", f, f.name));
    const out = await this.mutate<{ id: string; requisition?: Requisition }>("POST", "/requisitions", undefined, form);
    return out.id;
  }

  runExtraction(id: string) {
    return this.mutate("POST", `/requisitions/${id}/extract`);
  }

  updateHeader(id: string, patch: HeaderPatch) {
    return this.mutate("PATCH", `/requisitions/${id}/header`, nulls(patch));
  }

  async upsertLine(id: string, lineId: string | null, patch: Partial<RequisitionLine>): Promise<string> {
    const out = await this.mutate<{ lineId: string }>("POST", `/requisitions/${id}/lines`, { lineId, patch: nulls(patch) });
    return out.lineId;
  }

  removeLine(id: string, lineId: string) {
    return this.mutate("DELETE", `/requisitions/${id}/lines/${lineId}`);
  }

  setPageProgramme(id: string, page: number | "all", programmeId: string) {
    return this.mutate("POST", `/requisitions/${id}/pages`, { page, programmeId });
  }

  validate(id: string) {
    return this.mutate("POST", `/requisitions/${id}/validate`);
  }

  finalize(id: string) {
    return this.mutate("POST", `/requisitions/${id}/finalize`);
  }

  cancel(id: string, reason: string) {
    return this.mutate("POST", `/requisitions/${id}/cancel`, { reason });
  }

  reopen(id: string, reason: string) {
    return this.mutate("POST", `/requisitions/${id}/reopen`, { reason });
  }

  // ---------------------------------------------------------------- documents
  async uploadEvidence(id: string, files: File[], opts: { lifecycleEventId?: string; documentType: string; description?: string; category?: DocumentCategory }): Promise<ReqDocument[]> {
    const form = new FormData();
    files.forEach((f) => form.append("files", f, f.name));
    form.append("documentType", opts.documentType);
    if (opts.description) form.append("description", opts.description);
    if (opts.category) form.append("category", opts.category);
    if (opts.lifecycleEventId) form.append("lifecycleEventId", opts.lifecycleEventId);
    const out = await this.mutate<{ documents: ReqDocument[] }>("POST", `/requisitions/${id}/documents`, undefined, form);
    return out.documents ?? [];
  }

  async logDownload() {
    // The server records downloads when the signed download link is used.
  }

  async documentUrl(doc: ReqDocument, download = false): Promise<string> {
    const out = await this.request<{ url: string }>("GET", `/documents/${doc.id}/url?download=${download ? 1 : 0}`);
    return `${this.base}${out.url}`;
  }

  async downloadDocument(_requisitionId: string, doc: ReqDocument) {
    const url = await this.documentUrl(doc, true);
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async saveFile(filename: string, data: string) {
    const url = URL.createObjectURL(new Blob([data], { type: filename.endsWith(".csv") ? "text/csv" : "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---------------------------------------------------------------- lifecycle
  recordEvent(id: string, input: RecordEventInput, supersedesId?: string, correctionReason?: string) {
    const { files, ...rest } = input;
    const form = new FormData();
    form.append("data", JSON.stringify({ ...rest, supersedesId, correctionReason }));
    (files ?? []).forEach((f) => form.append("files", f, f.name));
    return this.mutate("POST", `/requisitions/${id}/events`, undefined, form);
  }

  voidEvent(id: string, eventId: string, reason: string) {
    return this.mutate("POST", `/requisitions/${id}/events/${eventId}/void`, { reason });
  }

  // ---------------------------------------------------------------- fulfillment
  recordFulfillment(id: string, rows: FulfillmentRowInput[]) {
    if (!rows.length) throw new UserError("Enter at least one quantity.");
    return this.mutate("POST", `/requisitions/${id}/fulfillment`, { rows });
  }

  correctFulfillment(id: string, targetId: string, row: FulfillmentRowInput | null, reason: string) {
    return this.mutate("POST", `/requisitions/${id}/fulfillment/${targetId}/correct`, { row, reason });
  }

  closeFulfillment(id: string, reason?: string) {
    return this.mutate("POST", `/requisitions/${id}/fulfillment/close`, { reason: reason ?? null });
  }

  reopenFulfillment(id: string, reason: string) {
    return this.mutate("POST", `/requisitions/${id}/fulfillment/reopen`, { reason });
  }

  // ---------------------------------------------------------------- edit requests
  submitEditRequest(id: string, reason: string, changes: RequestedChange[]) {
    return this.mutate("POST", `/requisitions/${id}/edit-requests`, { reason, changes });
  }

  decideEditRequest(id: string, erId: string, decision: "approved" | "rejected", rejectionReason?: string) {
    return this.mutate("POST", `/requisitions/${id}/edit-requests/${erId}/decide`, { decision, rejectionReason: rejectionReason ?? null });
  }

  withdrawEditRequest(id: string, erId: string) {
    return this.mutate("POST", `/requisitions/${id}/edit-requests/${erId}/withdraw`);
  }

  applyApprovedEdit(id: string, erId: string, values: Record<number, unknown>) {
    return this.mutate("POST", `/requisitions/${id}/edit-requests/${erId}/apply`, { values });
  }

  // ---------------------------------------------------------------- audit
  async requisitionAudit(id: string): Promise<AuditEvent[]> {
    const out = await this.request<{ events: AuditEvent[] }>("GET", `/requisitions/${id}/audit`);
    return out.events ?? [];
  }

  auditLog(params: { limit?: number; before?: string | null; requisitionId?: string; eventType?: string } = {}): Promise<AuditPageResult> {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.before) q.set("before", params.before);
    if (params.requisitionId) q.set("requisitionId", params.requisitionId);
    if (params.eventType) q.set("eventType", params.eventType);
    return this.request<AuditPageResult>("GET", `/audit${q.toString() ? `?${q}` : ""}`);
  }

  // ---------------------------------------------------------------- aliases
  decideAlias(key: string, decision: "approved" | "rejected") {
    return this.mutate("POST", `/aliases/${encodeURIComponent(key)}/decide`, { decision });
  }

  addAlias(entityType: "facility" | "item", entityId: string, alias: string) {
    return this.mutate("POST", "/aliases", { entityType, entityId, alias });
  }

  retireAlias(id: string) {
    return this.mutate("POST", `/aliases/${encodeURIComponent(id)}/retire`);
  }

  // ---------------------------------------------------------------- conversions & equivalences
  proposeConversion(c: { itemId: string | null; fromUnit: string; factor: number; incompatible?: boolean; notes?: string; toUnit?: string }) {
    return this.mutate("POST", "/conversions", c);
  }

  approveConversion(c: UnitConversion) {
    return this.mutate("POST", `/conversions/${c.id}/approve`);
  }

  rejectProposal(key: string) {
    if (key.startsWith("cv-")) return this.mutate("POST", `/conversions/${key.slice(3)}/reject`);
    if (key.startsWith("eq-")) return this.mutate("POST", `/equivalences/${key.slice(3)}/reject`);
    return this.decideAlias(key, "rejected");
  }

  retireConversion(id: string) {
    return this.mutate("POST", `/conversions/${id}/retire`);
  }

  async resolveConversions(): Promise<number> {
    const out = await this.mutate<{ count: number }>("POST", "/conversions/resolve");
    return out?.count ?? 0;
  }

  proposeEquivalence(e: { requestedItemId: string; substituteItemId: string; factor: number; basis: SubstitutionEquivalence["basis"]; justification: string }) {
    return this.mutate("POST", "/equivalences", e);
  }

  approveEquivalence(e: SubstitutionEquivalence) {
    return this.mutate("POST", `/equivalences/${e.id}/approve`);
  }

  retireEquivalence(id: string) {
    return this.mutate("POST", `/equivalences/${id}/retire`);
  }

  // ---------------------------------------------------------------- master data, settings, users
  saveFacility(f: Partial<Facility> & { name: string }) {
    return this.mutate("POST", "/facilities", f);
  }

  saveItem(i: Partial<Item> & { name: string; code: string; baseUnit: string }) {
    return this.mutate("POST", "/items", i);
  }

  saveProgramme(p: Partial<Programme> & { name: string }) {
    return this.mutate("POST", "/programmes", p);
  }

  saveSettings(s: Settings) {
    return this.mutate("PUT", "/settings", s);
  }

  saveRole(userId: string, role: RoleCode, grants: Grant[]) {
    return this.setUserAccess(userId, { status: "active", role, grants });
  }

  setUserAccess(userId: string, access: { status: WebUser["status"]; role: RoleCode | null; grants: Grant[] }) {
    return this.mutate("POST", `/users/${userId}/access`, access);
  }

  loadStarterMasterData(data: { programmes: string[]; facilities: Array<Partial<Facility> & { name: string }>; items: Array<Partial<Item> & { name: string; code: string; baseUnit: string }> }) {
    return this.mutate("POST", "/master/starter", data);
  }

  // ---------------------------------------------------------------- AI (OpenRouter) administration
  aiStatus(): Promise<AiStatus> {
    return this.request<AiStatus>("GET", "/ai/status");
  }

  aiSettings(): Promise<AiSettings> {
    return this.request<AiSettings>("GET", "/ai/settings");
  }

  saveAiSettings(s: Omit<AiSettings, "keyConfigured" | "keyHint" | "keySource">): Promise<AiSettings> {
    return this.request<AiSettings>("PUT", "/ai/settings", s);
  }

  setAiKey(key: string): Promise<unknown> {
    return this.request("PUT", "/ai/key", { key });
  }

  removeAiKey(): Promise<unknown> {
    return this.request("DELETE", "/ai/key");
  }

  testAi(): Promise<{ ok: boolean; model?: string; latencyMs?: number; error?: string }> {
    return this.request("POST", "/ai/test");
  }

  aiUsage(month: string): Promise<AiUsage> {
    return this.request<AiUsage>("GET", `/ai/usage?month=${encodeURIComponent(month)}`);
  }
}

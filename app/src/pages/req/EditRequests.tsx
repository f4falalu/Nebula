import React, { useState } from "react";
import { useApp } from "../../ui/context";
import { Field, Modal, Picker, Pill, ReasonModal, useOptions, Who } from "../../ui/kit";
import { can } from "../../domain/permissions";
import { activeLines, effectiveEditStatus, HEADER_FIELDS, LINE_FIELDS } from "../../domain/records";
import { itemLabel } from "../../domain/matching";
import { fmtDateTime, fromLagosLocal, toLagosLocal } from "../../domain/time";
import type { EditRequest, MasterData, RequestedChange, Requisition } from "../../domain/types";

const STATUS_TONE: Record<EditRequest["status"], "good" | "warn" | "bad" | "info" | undefined> = {
  pending: "warn", approved: "info", rejected: "bad", used: "good", expired: undefined, withdrawn: undefined,
};

export function describeValue(field: string, v: unknown, md: MasterData): string {
  if (v == null || v === "") return "—";
  if (field === "facilityId") return md.facilities[String(v)]?.name ?? String(v);
  if (field === "itemId") return itemLabel(md.items[String(v)]);
  if (field === "programmeId" || field === "primaryProgrammeId") return md.programmes[String(v)]?.name ?? String(v);
  if (field === "receivedAt") return fmtDateTime(String(v));
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

export function describeChange(c: RequestedChange, r: Requisition): string {
  if (c.entityType === "header") return HEADER_FIELDS[c.field] ?? c.field;
  if (c.entityType === "page") return `Page ${c.entityId} programme`;
  if (c.entityType === "line") {
    const l = c.entityId ? r.lines[c.entityId] : null;
    return `Line ${l ? `${l.pageNumber ?? "–"}/${l.lineNumber}` : "?"}: ${LINE_FIELDS[c.field] ?? c.field}`;
  }
  return c.entityType === "fulfillment" ? "Fulfillment records: one correction, void or new record" : "Lifecycle events: one correction, void or new event";
}

export function EditRequestsTab({ r }: { r: Requisition }) {
  const { state, actor, svc, act } = useApp();
  const md = state.md;
  const days = md.settings.editRequestPendingTimeoutDays;
  const [rejecting, setRejecting] = useState<EditRequest | null>(null);
  const [applying, setApplying] = useState<EditRequest | null>(null);
  const list = Object.values(r.editRequests).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  if (!list.length) {
    return <div className="card"><div className="empty small">No edit requests. Once a requisition is finalized, a Requisition Assistant can request a specific change here; an Administrator (or an authorized Supervisor) approves it for a limited time.</div></div>;
  }
  return (
    <div className="stack">
      {list.map((er) => {
        const st = effectiveEditStatus(er, days);
        const mine = er.requestedBy === actor.id;
        const headerish = er.changes.some((c) => ["header", "line", "page"].includes(c.entityType));
        return (
          <div key={er.id} className="card stack tight">
            <div className="row between">
              <div className="row"><Pill tone={STATUS_TONE[st]}>{st[0].toUpperCase() + st.slice(1)}</Pill><span className="small">Requested by <Who id={er.requestedBy} /> on {fmtDateTime(er.requestedAt)}</span></div>
              <div className="row">
                {st === "pending" && can(actor, "edit_request.approve") && !mine && (
                  <>
                    <button className="btn sm primary" onClick={() => act(() => svc.decideEditRequest(r.id, er.id, "approved"), "Approved")}>Approve</button>
                    <button className="btn sm danger" onClick={() => setRejecting(er)}>Reject</button>
                  </>
                )}
                {st === "pending" && mine && <button className="btn sm" onClick={() => act(() => svc.withdrawEditRequest(r.id, er.id), "Withdrawn")}>Withdraw</button>}
                {st === "approved" && mine && headerish && <button className="btn sm primary" onClick={() => setApplying(er)}>Make the approved change</button>}
              </div>
            </div>
            <div className="small"><b>Reason:</b> {er.reason}</div>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {er.changes.map((c, i) => (
                <li key={i}>{describeChange(c, r)}{["header", "line", "page"].includes(c.entityType) && <>: {describeValue(c.field, c.currentValue, md)} → <b>{describeValue(c.field, c.proposedValue, md)}</b></>}</li>
              ))}
            </ul>
            {st === "pending" && mine && <span className="muted small">You can't approve your own request. An Administrator or an authorized Supervisor decides.</span>}
            {er.decidedAt && <span className="muted small">{er.decision === "approved" ? "Approved" : "Rejected"} by <Who id={er.decidedBy} /> on {fmtDateTime(er.decidedAt)}{er.rejectionReason ? `: ${er.rejectionReason}` : ""}</span>}
            {st === "approved" && <span className="small">Permission open until {fmtDateTime(er.approvalExpiresAt)}. It closes after one save.{!headerish && mine ? " Make the correction on the Fulfillment or Lifecycle tab." : ""}</span>}
            {er.usedAt && <span className="muted small">Used on {fmtDateTime(er.usedAt)}</span>}
          </div>
        );
      })}
      {rejecting && <ReasonModal title="Reject edit request" label="Reason for rejecting" cta="Reject" danger onClose={() => setRejecting(null)} onSubmit={(reason) => act(() => svc.decideEditRequest(r.id, rejecting.id, "rejected", reason), "Rejected")} />}
      {applying && <ApplyEditModal r={r} er={applying} onClose={() => setApplying(null)} />}
    </div>
  );
}

type Draft = { entityType: RequestedChange["entityType"]; entityId: string; field: string; value: string };

function ValueInput({ field, value, onChange, id }: { field: string; value: string; onChange: (v: string) => void; id: string }) {
  const { fac, items, progs } = useOptions();
  if (field === "facilityId") return <Picker id={id} options={fac} value={value} onChange={onChange} />;
  if (field === "itemId") return <Picker id={id} options={items} value={value} onChange={onChange} />;
  if (field === "programmeId" || field === "primaryProgrammeId") return <select id={id} value={value} onChange={(e) => onChange(e.target.value)}><option value="">Choose…</option>{progs.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>;
  if (field === "requisitionDate") return <input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} />;
  if (field === "receivedAt") return <input id={id} type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} />;
  if (field === "requisitionDateEstimated") return <select id={id} value={value} onChange={(e) => onChange(e.target.value)}><option value="true">Yes</option><option value="false">No</option></select>;
  if (field === "quantityRequested") return <input id={id} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />;
  return <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />;
}

function parseValue(field: string, v: string): unknown {
  if (field === "quantityRequested") return Number(v.replace(/,/g, ""));
  if (field === "requisitionDateEstimated") return v === "true";
  if (field === "receivedAt") return v ? fromLagosLocal(v) : undefined;
  return v || undefined;
}

function currentValue(r: Requisition, d: Draft): unknown {
  if (d.entityType === "header") return (r as unknown as Record<string, unknown>)[d.field];
  if (d.entityType === "line") return (r.lines[d.entityId] as unknown as Record<string, unknown> | null)?.[d.field];
  if (d.entityType === "page") return r.pages[d.entityId]?.programmeId;
  return undefined;
}

export function SubmitEditRequestModal({ r, onClose }: { r: Requisition; onClose: () => void }) {
  const { state, svc, act } = useApp();
  const md = state.md;
  const [reason, setReason] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([{ entityType: "header", entityId: "", field: "facilityId", value: "" }]);
  const lines = activeLines(r);
  const upd = (i: number, p: Partial<Draft>) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...p } : d)));
  const valid = reason.trim() && drafts.length && drafts.every((d) => (d.entityType === "fulfillment" || d.entityType === "lifecycle" ? true : d.field && d.value !== "" && (d.entityType === "header" || d.entityId)));
  const submit = async () => {
    const changes: RequestedChange[] = drafts.map((d) =>
      d.entityType === "fulfillment" || d.entityType === "lifecycle"
        ? { entityType: d.entityType, field: "*" }
        : { entityType: d.entityType, entityId: d.entityType === "header" ? undefined : d.entityId, field: d.field, currentValue: currentValue(r, d) ?? null, proposedValue: parseValue(d.field, d.value) ?? null },
    );
    if (await act(() => svc.submitEditRequest(r.id, reason, changes), "Edit request submitted")) onClose();
  };
  return (
    <Modal wide title={`Request an edit to ${r.number}`} onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid} onClick={submit}>Submit request</button></>}>
      <p className="muted small">The requisition stays finalized and in reporting. If approved, you get a time-limited permission to make exactly these changes, closed after one save.</p>
      {drafts.map((d, i) => (
        <div key={i} className="card stack tight">
          <div className="form-grid">
            <Field label="What to change">
              <select id={`er-type-${i}`} value={d.entityType} onChange={(e) => {
                const t = e.target.value as Draft["entityType"];
                upd(i, { entityType: t, entityId: t === "line" ? lines[0]?.id ?? "" : t === "page" ? Object.keys(r.pages)[0] ?? "1" : "", field: t === "header" ? "facilityId" : t === "line" ? "itemId" : t === "page" ? "programmeId" : "*", value: "" });
              }}>
                <option value="header">Requisition details</option>
                <option value="line">A requisition line</option>
                <option value="page">A page's programme</option>
                {r.fulfillmentStatus === "closed" && <option value="fulfillment">Fulfillment record (after closing)</option>}
                {r.fulfillmentStatus === "closed" && <option value="lifecycle">Lifecycle event (after closing)</option>}
              </select>
            </Field>
            {d.entityType === "line" && (
              <Field label="Line">
                <select id={`er-line-${i}`} value={d.entityId} onChange={(e) => upd(i, { entityId: e.target.value })}>
                  {lines.map((l) => <option key={l.id} value={l.id}>{l.pageNumber ?? "–"}/{l.lineNumber} {itemLabel(md.items[l.itemId ?? ""])}</option>)}
                </select>
              </Field>
            )}
            {d.entityType === "page" && (
              <Field label="Page">
                <select id={`er-page-${i}`} value={d.entityId} onChange={(e) => upd(i, { entityId: e.target.value })}>
                  {Object.keys(r.pages).map((p) => <option key={p} value={p}>Page {p}</option>)}
                </select>
              </Field>
            )}
            {(d.entityType === "header" || d.entityType === "line") && (
              <Field label="Field">
                <select id={`er-field-${i}`} value={d.field} onChange={(e) => upd(i, { field: e.target.value, value: "" })}>
                  {Object.entries(d.entityType === "header" ? HEADER_FIELDS : LINE_FIELDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
            )}
            {(d.entityType === "header" || d.entityType === "line" || d.entityType === "page") && (
              <Field label="New value" hint={<>Now: {describeValue(d.field, currentValue(r, d), md)}</>}>
                <ValueInput id={`er-val-${i}`} field={d.field} value={d.value} onChange={(v) => upd(i, { value: v })} />
              </Field>
            )}
          </div>
          {drafts.length > 1 && <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}>Remove this change</button>}
        </div>
      ))}
      <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setDrafts([...drafts, { entityType: "header", entityId: "", field: "facilityId", value: "" }])}>Add another change</button>
      <Field label="Reason"><textarea id="er-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why the finalized record is wrong, and what the evidence is" /></Field>
    </Modal>
  );
}

function ApplyEditModal({ r, er, onClose }: { r: Requisition; er: EditRequest; onClose: () => void }) {
  const { state, svc, act } = useApp();
  const md = state.md;
  const editable = er.changes.map((c, i) => ({ c, i })).filter(({ c }) => ["header", "line", "page"].includes(c.entityType));
  const toInput = (field: string, v: unknown) => (v == null ? "" : field === "receivedAt" ? toLagosLocal(String(v)) : String(v));
  const [values, setValues] = useState<Record<number, string>>(() => Object.fromEntries(editable.map(({ c, i }) => [i, toInput(c.field, c.proposedValue)])));
  const save = async () => {
    const parsed = Object.fromEntries(editable.map(({ c, i }) => [i, parseValue(c.field, values[i])]));
    if (await act(() => svc.applyApprovedEdit(r.id, er.id, parsed), "Change saved; the permission is now closed")) onClose();
  };
  return (
    <Modal title="Make the approved change" onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save change</button></>}>
      <p className="muted small">Only the approved fields can change. Saving closes the permission. Values that differ from what was approved are visible in the audit history.</p>
      {editable.map(({ c, i }) => (
        <Field key={i} label={describeChange(c, r)} hint={<>Approved value: {describeValue(c.field, c.proposedValue, md)}</>}>
          <ValueInput id={`ap-${i}`} field={c.field} value={values[i] ?? ""} onChange={(v) => setValues({ ...values, [i]: v })} />
        </Field>
      ))}
    </Modal>
  );
}

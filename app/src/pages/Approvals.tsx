import React, { useMemo, useState } from "react";
import { useApp } from "../ui/context";
import { Empty, Pill, ReasonModal } from "../ui/kit";
import { can } from "../domain/permissions";
import { effectiveEditStatus, HEADER_FIELDS, LINE_FIELDS } from "../domain/records";
import { itemLabel } from "../domain/matching";
import { fmtDate, fmtDateTime } from "../domain/time";
import type { EditRequest, EditRequestStatus, MasterData, RequestedChange, Requisition } from "../domain/types";

const ENTITY_LABEL: Record<RequestedChange["entityType"], string> = {
  header: "Requisition header",
  line: "Line",
  page: "Page programme",
  fulfillment: "Fulfillment records",
  lifecycle: "Lifecycle events",
};

const STATUS_TONE: Record<EditRequestStatus, "good" | "warn" | "bad" | "info" | undefined> = {
  pending: "warn", approved: "info", rejected: "bad", used: "good", expired: undefined, withdrawn: undefined,
};

export function displayValue(field: string, v: unknown, md: MasterData): string {
  if (v === undefined || v === null || v === "") return "—";
  const s = String(v);
  if (field === "facilityId") return md.facilities[s]?.name ?? "Unknown facility";
  if (field === "itemId") return itemLabel(md.items[s]);
  if (field === "programmeId" || field === "primaryProgrammeId") return md.programmes[s]?.name ?? "Unknown programme";
  if (field === "requisitionDate") return fmtDate(s);
  if (field === "receivedAt") return fmtDateTime(s);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return JSON.stringify(v);
  return s;
}

export function changeLabel(c: RequestedChange, req: Requisition): string {
  if (c.entityType === "header") return HEADER_FIELDS[c.field] ?? c.field;
  if (c.entityType === "line") {
    const l = c.entityId ? req.lines[c.entityId] : null;
    const where = l ? `Line ${l.lineNumber}${l.pageNumber ? ` (page ${l.pageNumber})` : ""}` : c.entityId ? "Removed line" : "New line";
    return `${where}: ${c.field === "*" ? "add or remove" : LINE_FIELDS[c.field] ?? c.field}`;
  }
  if (c.entityType === "page") return `Page ${c.entityId ?? "all"} programme`;
  return `${ENTITY_LABEL[c.entityType]}${c.field && c.field !== "*" ? `: ${c.field}` : ""}`;
}

export function ChangeList({ er, req }: { er: EditRequest; req: Requisition }) {
  const { state } = useApp();
  return (
    <ul className="appr-changes">
      {er.changes.map((c, i) => (
        <li key={i}>
          <span className="appr-field">{changeLabel(c, req)}</span>
          {c.entityType === "fulfillment" || c.entityType === "lifecycle" ? (
            <span className="muted small">{c.proposedValue != null ? displayValue(c.field, c.proposedValue, state.md) : "Correct or void records during the edit window"}</span>
          ) : (
            <span className="small">
              <span className="muted">{displayValue(c.field, c.currentValue, state.md)}</span> → <b>{displayValue(c.field, c.proposedValue, state.md)}</b>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

interface Row {
  req: Requisition;
  er: EditRequest;
  status: EditRequestStatus;
}

export function ApprovalsPage(_p: { id?: string }) {
  const { state, actor, svc, act, nameOf } = useApp();
  const [rejecting, setRejecting] = useState<Row | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const timeout = state.md.settings.editRequestPendingTimeoutDays;
  const mayApprove = can(actor, "edit_request.approve");

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const req of Object.values(state.reqs)) for (const er of Object.values(req.editRequests)) out.push({ req, er, status: effectiveEditStatus(er, timeout) });
    return out;
  }, [state.reqs, timeout]);
  const pending = rows.filter((r) => r.status === "pending").sort((a, b) => a.er.requestedAt.localeCompare(b.er.requestedAt));
  const recent = rows
    .filter((r) => r.status !== "pending")
    .sort((a, b) => (b.er.closedAt ?? b.er.decidedAt ?? b.er.requestedAt).localeCompare(a.er.closedAt ?? a.er.decidedAt ?? a.er.requestedAt))
    .slice(0, 50);

  const proposalCounts = useMemo(() => {
    const c = { alias: 0, conversion: 0, equivalence: 0 };
    for (const p of Object.values(state.proposals)) if (p.status === "candidate" || p.status === "proposed") c[p.kind]++;
    return c;
  }, [state.proposals]);

  if (!mayApprove && actor.role !== "admin") {
    return <Empty title="Approvals aren't part of your role">Administrators, and Supervisors given the approval permission, decide edit requests here.</Empty>;
  }

  const openAdmin = (tab: string) => {
    try {
      sessionStorage.setItem("nebula-admin-tab", tab);
    } catch {
      /* ignore */
    }
    location.hash = "admin";
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p className="sub">Edit requests on finalized requisitions. An approval opens a {state.md.settings.editWindowHours}-hour window for one save by the requester.</p>
        </div>
      </div>

      <section className="stack">
        <div className="section-title"><h2>Waiting for a decision</h2><span className="muted small">{pending.length} pending</span></div>
        {pending.length ? (
          <div className="stack">
            {pending.map((row) => {
              const { req, er } = row;
              const own = er.requestedBy === actor.id;
              const fac = req.facilityId ? state.md.facilities[req.facilityId]?.name : req.facilityExtractedText;
              return (
                <article key={er.id} className="card stack appr-card">
                  <div className="row between">
                    <div>
                      <a className="mono" href={`#req-${req.id}`}>{req.number}</a> <span className="muted">· {fac ?? "Unmatched facility"}</span>
                      <div className="small muted">Requested by {nameOf(er.requestedBy)} · {fmtDateTime(er.requestedAt)}</div>
                    </div>
                    <Pill tone="warn">Pending</Pill>
                  </div>
                  <div>
                    <div className="eyebrow">Reason</div>
                    <p>{er.reason}</p>
                  </div>
                  <ChangeList er={er} req={req} />
                  {own ? (
                    <p className="muted small">You can't approve your own request. Another approver must decide it.</p>
                  ) : mayApprove ? (
                    <div className="row end">
                      <button className="btn danger" disabled={busy === er.id} onClick={() => setRejecting(row)}>Reject</button>
                      <button
                        className="btn primary"
                        disabled={busy === er.id}
                        onClick={async () => {
                          setBusy(er.id);
                          await act(() => svc.decideEditRequest(req.id, er.id, "approved"), `Approved. ${nameOf(er.requestedBy)} has ${state.md.settings.editWindowHours} hours to make the change.`);
                          setBusy(null);
                        }}
                      >Approve</button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="card"><Empty title="Nothing to decide">New edit requests from Requisition Assistants appear here.</Empty></div>
        )}
      </section>

      {actor.role === "admin" && (
        <section className="stack">
          <h2>Master data proposals</h2>
          <div className="grid3">
            <button className="stat admin-stat-btn" onClick={() => openAdmin("aliases")}><span className="label">Alias candidates</span><span className="value">{proposalCounts.alias}</span><span className="foot">Review in Administration</span></button>
            <button className="stat admin-stat-btn" onClick={() => openAdmin("conversions")}><span className="label">Unit conversion proposals</span><span className="value">{proposalCounts.conversion}</span><span className="foot">Review in Administration</span></button>
            <button className="stat admin-stat-btn" onClick={() => openAdmin("equivalences")}><span className="label">Substitution proposals</span><span className="value">{proposalCounts.equivalence}</span><span className="foot">Review in Administration</span></button>
          </div>
        </section>
      )}

      <section className="stack">
        <h2>Recent decisions</h2>
        {recent.length ? (
          <div className="card flush">
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Requisition</th><th>Requested by</th><th>Reason</th><th>Status</th><th>Decided by</th><th>Closed</th></tr></thead>
                <tbody>
                  {recent.map(({ req, er, status }) => (
                    <tr key={er.id}>
                      <td><a className="mono" href={`#req-${req.id}`}>{req.number}</a></td>
                      <td>{nameOf(er.requestedBy)}<div className="muted small">{fmtDateTime(er.requestedAt)}</div></td>
                      <td className="small">{er.reason}{er.rejectionReason && <div className="muted">Rejected: {er.rejectionReason}</div>}</td>
                      <td><Pill tone={STATUS_TONE[status]}>{status[0].toUpperCase() + status.slice(1)}</Pill></td>
                      <td>{er.decidedBy ? nameOf(er.decidedBy) : "—"}<div className="muted small">{fmtDateTime(er.decidedAt)}</div></td>
                      <td className="small">
                        {status === "approved" ? <>Window closes {fmtDateTime(er.approvalExpiresAt)}</> : status === "expired" && !er.closedAt ? "Expired" : fmtDateTime(er.closedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="card"><Empty title="No decisions yet" /></div>
        )}
      </section>

      {rejecting && (
        <ReasonModal
          title={`Reject edit request on ${rejecting.req.number}`}
          label="Reason for rejecting"
          cta="Reject request"
          danger
          intro={<p className="small">The requester sees this reason. The requisition stays as it is.</p>}
          onClose={() => setRejecting(null)}
          onSubmit={(reason) => act(() => svc.decideEditRequest(rejecting.req.id, rejecting.er.id, "rejected", reason), "Edit request rejected.")}
        />
      )}
    </>
  );
}

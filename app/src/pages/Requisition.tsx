import React, { useState } from "react";
import { useApp } from "../ui/context";
import { Empty, FulfillmentPill, OfrValue, ReasonModal, RecordStatusPill, Tabs, Who } from "../ui/kit";
import { can } from "../domain/permissions";
import { activeEditPermission, closeFulfillmentIssues, effectiveEditStatus, finalizationIssues, inOfficialScope, validationIssues } from "../domain/records";
import { currentStage, stageViews, STAGE_LABEL } from "../domain/lifecycle";
import { requisitionAggregate } from "../domain/ofr";
import { fmtDate, fmtDateTime } from "../domain/time";
import { fmtPct } from "../domain/text";
import type { Requisition } from "../domain/types";
import { ReviewTab } from "./req/Review";
import { LifecycleTab } from "./req/Lifecycle";
import { FulfillmentTab } from "./req/Fulfillment";
import { DocumentsTab } from "./req/Documents";
import { EditRequestsTab, SubmitEditRequestModal } from "./req/EditRequests";
import { AuditTab } from "./req/AuditTab";

type TabKey = "review" | "lifecycle" | "fulfillment" | "documents" | "edits" | "audit";

export function RequisitionPage({ id }: { id: string }) {
  const { state, loaded } = useApp();
  const r = state.reqs[id];
  if (!r) return loaded ? <Empty title="Requisition not found"><a href="#requisitions">Back to requisitions</a></Empty> : <div className="boot">Loading…</div>;
  return <RequisitionView r={r} />;
}

function RequisitionView({ r }: { r: Requisition }) {
  const { state, actor, svc, run, act, caps } = useApp();
  const md = state.md;
  const [tab, setTab] = useState<TabKey>(() => (r.recordStatus === "finalized" || r.recordStatus === "cancelled" ? "fulfillment" : "review"));
  const [modal, setModal] = useState<null | "cancel" | "reopen" | "close" | "reopen-f" | "edit-request">(null);
  const agg = requisitionAggregate(r, md);
  const stage = currentStage(r);
  const timeoutDays = md.settings.editRequestPendingTimeoutDays;
  const myEdit = activeEditPermission(r, actor.id, timeoutDays);
  const pendingEdits = Object.values(r.editRequests).filter((e) => effectiveEditStatus(e, timeoutDays) === "pending").length;
  const fac = r.facilityId ? md.facilities[r.facilityId] : undefined;
  const vIssues = r.recordStatus === "validation_pending" || r.recordStatus === "reopened" ? validationIssues(r, md) : [];
  const fIssues = r.recordStatus === "validated" ? finalizationIssues(r, md) : [];
  const completed = stageViews(r).find((v) => v.stage === "completed")?.status === "completed";

  const actions: React.ReactNode[] = [];
  if ((r.recordStatus === "validation_pending" || r.recordStatus === "reopened") && can(actor, "requisition.validate")) {
    actions.push(<button key="v" className="btn primary" title={vIssues.join("\n")} onClick={() => run(() => svc.validate(r.id), "Validated")}>Validate</button>);
  }
  if (r.recordStatus === "validated" && can(actor, "requisition.finalize")) {
    actions.push(<button key="f" className="btn primary" onClick={() => run(() => svc.finalize(r.id), "Finalized and locked")}>Finalize</button>);
  }
  if (r.recordStatus === "finalized" && r.fulfillmentStatus !== "closed" && can(actor, "fulfillment.close")) {
    actions.push(<button key="cf" className="btn" onClick={() => (completed ? run(() => svc.closeFulfillment(r.id), "Fulfillment closed") : setModal("close"))}>Close fulfillment</button>);
  }
  if (r.fulfillmentStatus === "closed" && can(actor, "fulfillment.reopen")) actions.push(<button key="rf" className="btn" onClick={() => setModal("reopen-f")}>Reopen fulfillment</button>);
  if (r.recordStatus === "finalized" && can(actor, "edit_request.submit") && !myEdit && !Object.values(r.editRequests).some((e) => e.requestedBy === actor.id && effectiveEditStatus(e, timeoutDays) === "pending")) {
    actions.push(<button key="er" className="btn" onClick={() => setModal("edit-request")}>Request edit</button>);
  }
  if (r.recordStatus === "finalized" && can(actor, "requisition.reopen")) actions.push(<button key="ro" className="btn" onClick={() => setModal("reopen")}>Reopen</button>);
  const hasFulfillment = Object.keys(r.fulfillment).length > 0;
  if (r.recordStatus !== "cancelled" && can(actor, r.recordStatus === "finalized" || hasFulfillment ? "requisition.cancel_finalized" : "requisition.cancel")) {
    actions.push(<button key="c" className="btn danger" onClick={() => setModal("cancel")}>Cancel requisition</button>);
  }

  return (
    <>
      <div className="page-head">
        <div className="stack tight" style={{ minWidth: 0 }}>
          <span className="eyebrow"><a href="#requisitions">Requisitions</a> / {fac ? <a href={`#facility-${fac.id}`}>{fac.name}</a> : r.facilityExtractedText ? `“${r.facilityExtractedText}”` : "Facility not matched"}</span>
          <h1 className="mono" style={{ fontSize: "1.5rem" }}>{r.number}</h1>
          <div className="row">
            <RecordStatusPill s={r.recordStatus} />
            <span className="pill accent plain">Stage: {STAGE_LABEL[stage]}</span>
            <FulfillmentPill s={r.fulfillmentStatus} />
            {r.requisitionDateEstimated && <span className="pill warn plain">Estimated requisition date</span>}
            {inOfficialScope(r) ? <span className="pill good plain">In official reporting</span> : <span className="pill plain">Not yet in official reporting</span>}
          </div>
        </div>
        <div className="row">{actions}</div>
      </div>

      {r.recordStatus === "processing" && <div className="banner">{caps.aiName} is reading the document. Suggested lines appear here when it finishes; you can leave this page.</div>}
      {r.recordStatus === "reopened" && <div className="banner warn">Reopened by <Who id={r.reopenedBy} /> on {fmtDateTime(r.reopenedAt)}: {r.reopenReason}. This requisition is excluded from reporting until it is validated and finalized again.</div>}
      {r.recordStatus === "cancelled" && <div className="banner bad">Cancelled by <Who id={r.cancelledBy} /> on {fmtDateTime(r.cancelledAt)}: {r.cancellationReason}</div>}
      {myEdit && (
        <div className="banner">
          Your edit request was approved. You can make the approved change{myEdit.changes.length > 1 ? "s" : ""} until {fmtDateTime(myEdit.approvalExpiresAt)}. The permission closes after one save.
          {" "}<button className="btn sm" onClick={() => setTab("edits")}>Open edit request</button>
        </div>
      )}
      {pendingEdits > 0 && can(actor, "edit_request.approve") && <div className="banner warn">{pendingEdits} edit request{pendingEdits > 1 ? "s" : ""} waiting for a decision. <a href="#" onClick={(e) => { e.preventDefault(); setTab("edits"); }}>Review</a></div>}
      {fIssues.length > 0 && <div className="banner warn">Before finalizing: {fIssues.join(" ")}</div>}

      <div className="card">
        <div className="stage-rail" aria-label="Lifecycle stages">
          {stageViews(r).map((v) => (
            <div key={v.stage} className={`stage ${v.status} ${v.stage === stage ? "current" : ""}`}>
              <div className="dot" />
              <div className="name">{STAGE_LABEL[v.stage]}</div>
              <div className="when">{v.status === "completed" ? fmtDateTime(v.occurredAt).replace(/ \d{4},?/, "") : v.status === "not_applicable" ? "N/A" : "Pending"}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="stats">
        <div className="stat headline"><span className="label">Issued OFR</span><span className="value"><OfrValue v={agg.issued.ofr} threshold={md.settings.ofrThresholdPercent} /></span><span className="foot">Coverage {fmtPct(agg.issued.coverage, 0)} · SKU {fmtPct(agg.issued.skuRate, 0)}</span></div>
        <div className="stat"><span className="label">Invoice OFR</span><span className="value"><OfrValue v={agg.invoiced.ofr} /></span><span className="foot">Coverage {fmtPct(agg.invoiced.coverage, 0)}</span></div>
        <div className="stat"><span className="label">Delivered OFR</span><span className="value"><OfrValue v={agg.delivered.ofr} /></span><span className="foot">Coverage {fmtPct(agg.delivered.coverage, 0)}</span></div>
        <div className="stat"><span className="label">Dates</span><span className="value" style={{ fontSize: "0.95rem", fontFamily: "var(--font)" }}>Req. {fmtDate(r.requisitionDate)}{r.requisitionDateEstimated ? " (est.)" : ""}<br />Rec. {fmtDateTime(r.receivedAt)}<br />Ent. {fmtDateTime(r.entryAt)}</span></div>
      </div>

      <Tabs<TabKey>
        tabs={[
          ["review", "Details & lines"],
          ["lifecycle", "Lifecycle"],
          ["fulfillment", "Fulfillment"],
          ["documents", `Documents (${Object.values(r.documents).filter(Boolean).length})`],
          ["edits", `Edit requests${Object.keys(r.editRequests).length ? ` (${Object.keys(r.editRequests).length})` : ""}`],
          ["audit", "Audit history"],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "review" && <ReviewTab r={r} />}
      {tab === "lifecycle" && <LifecycleTab r={r} />}
      {tab === "fulfillment" && <FulfillmentTab r={r} />}
      {tab === "documents" && <DocumentsTab r={r} />}
      {tab === "edits" && <EditRequestsTab r={r} />}
      {tab === "audit" && <AuditTab r={r} />}

      {modal === "cancel" && (
        <ReasonModal title={`Cancel ${r.number}`} label="Reason" cta="Cancel requisition" danger onClose={() => setModal(null)}
          intro={<p className="muted small">Cancelled requisitions stay searchable with their full history but are excluded from all reporting. This can't be undone.</p>}
          onSubmit={(reason) => act(() => svc.cancel(r.id, reason), "Requisition cancelled")} />
      )}
      {modal === "reopen" && (
        <ReasonModal title={`Reopen ${r.number}`} label="Reason for reopening" cta="Reopen" onClose={() => setModal(null)}
          intro={<p className="muted small">The record becomes editable and leaves official reporting until it is validated and finalized again.</p>}
          onSubmit={(reason) => act(() => svc.reopen(r.id, reason), "Reopened")} />
      )}
      {modal === "close" && (
        <ReasonModal title="Close fulfillment" label="Closure reason" cta="Close fulfillment" onClose={() => setModal(null)}
          intro={<p className="muted small">Completed isn't recorded yet, so a reason is required (for example “Not supplied: stock-out”). Closing makes the figures final for reporting. It doesn't mean 100% fulfilled. {closeFulfillmentIssues(r, "x").join(" ")}</p>}
          onSubmit={(reason) => act(() => svc.closeFulfillment(r.id, reason), "Fulfillment closed")} />
      )}
      {modal === "reopen-f" && (
        <ReasonModal title="Reopen fulfillment" label="Reason" cta="Reopen fulfillment" onClose={() => setModal(null)}
          intro={<p className="muted small">Fulfillment returns to Partial and the requisition leaves official reporting until it is closed again.</p>}
          onSubmit={(reason) => act(() => svc.reopenFulfillment(r.id, reason), "Fulfillment reopened")} />
      )}
      {modal === "edit-request" && <SubmitEditRequestModal r={r} onClose={() => setModal(null)} />}
    </>
  );
}

import React, { useMemo, useState } from "react";
import { useApp } from "../../ui/context";
import { Field, Modal, Pill, ReasonModal, Who } from "../../ui/kit";
import { can } from "../../domain/permissions";
import { canRecordStage, canSupersede, chronologyErrors, stageViews, STAGE_LABEL } from "../../domain/lifecycle";
import { fmtDateTime, fromLagosLocal, toLagosLocal, nowISO } from "../../domain/time";
import { OPERATIONAL_STAGES, type LifecycleEvent, type OperationalStage, type Requisition } from "../../domain/types";
import { ACCEPTED_TYPES } from "../../data/files";
import { DocLink } from "./Documents";

const EVIDENCE_TYPE: Record<OperationalStage, [string, string]> = {
  finance: ["payment_confirmation", "Payment confirmation"],
  invoicing: ["invoice", "Invoice"],
  pick_and_pack: ["pick_slip", "Pick slip"],
  dispatched: ["waybill", "Dispatch document / waybill"],
  completed: ["pod", "Proof of delivery (POD)"],
};

export function LifecycleTab({ r }: { r: Requisition }) {
  const { actor } = useApp();
  const views = stageViews(r);
  const [record, setRecord] = useState<{ stage: OperationalStage; correct?: LifecycleEvent } | null>(null);
  const [voiding, setVoiding] = useState<LifecycleEvent | null>(null);
  const { svc, act } = useApp();
  const closedNote = r.fulfillmentStatus === "closed";
  const docsByEvent = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const d of Object.values(r.documents)) if (d?.lifecycleEventId) (m[d.lifecycleEventId] ??= []).push(d.id);
    return m;
  }, [r.documents]);

  return (
    <div className="stack">
      {closedNote && <div className="note-box">Fulfillment is closed, so lifecycle corrections need an approved edit request{actor.role === "admin" ? " or reopening fulfillment" : ""}.</div>}
      {views.map((v) => {
        const op = (OPERATIONAL_STAGES as readonly string[]).includes(v.stage) ? (v.stage as OperationalStage) : null;
        const why = op ? canRecordStage(r, op) : "derived";
        const superseded = new Set(v.history.map((e) => e.supersedesId).filter(Boolean));
        return (
          <div key={v.stage} className="card">
            <div className="row between">
              <div className="row">
                <h3>{STAGE_LABEL[v.stage]}</h3>
                {v.status === "completed" ? <Pill tone="good">Completed</Pill> : v.status === "not_applicable" ? <Pill>Not applicable</Pill> : <Pill tone="warn">Pending</Pill>}
                {v.derived && <span className="muted small">From the requisition's {v.stage === "received" ? "Received at" : v.stage === "entered" ? "system entry time" : "first validation"} timestamp</span>}
              </div>
              {op && can(actor, "lifecycle.record") && !why && <button className="btn sm primary" onClick={() => setRecord({ stage: op })}>Record {STAGE_LABEL[op]}</button>}
              {op && can(actor, "lifecycle.record") && why && v.status === "pending" && <span className="muted small">{why}</span>}
            </div>
            {v.derived && v.status === "completed" && (
              <dl className="kv" style={{ marginTop: 8 }}>
                <dt>Occurred</dt><dd>{fmtDateTime(v.occurredAt)}</dd>
                <dt>Recorded</dt><dd>{fmtDateTime(v.recordedAt)} by <Who id={v.recordedBy} /></dd>
              </dl>
            )}
            {!v.derived && v.history.length > 0 && (
              <div className="stack tight" style={{ marginTop: 10 }}>
                {v.history.map((e) => {
                  const isEffective = e.recordType !== "void" && !superseded.has(e.id);
                  return (
                    <div key={e.id} className={`timeline-event ${isEffective ? "" : "superseded"}`}>
                      <div className="row between">
                        <div className="what">
                          <b>{e.recordType === "void" ? "Voided an earlier entry" : e.status === "not_applicable" ? "Not applicable" : "Completed"}</b>
                          {e.recordType === "correction" && <Pill tone="info">Correction</Pill>}
                          {e.chronologyOverride && <Pill tone="warn" title={e.overrideReason}>Chronology override</Pill>}
                          {!isEffective && e.recordType !== "void" && <span className="muted small"> (superseded)</span>}
                        </div>
                        {isEffective && can(actor, "lifecycle.record") && canSupersede(r.events, e.id) && (
                          <div className="row">
                            <button className="btn ghost sm" onClick={() => setRecord({ stage: e.stage, correct: e })}>Correct</button>
                            <button className="btn ghost sm" onClick={() => setVoiding(e)}>Void</button>
                          </div>
                        )}
                      </div>
                      <div className="small muted">
                        {e.recordType !== "void" && <>Occurred {fmtDateTime(e.occurredAt)} · </>}Recorded {fmtDateTime(e.recordedAt)} by <Who id={e.recordedBy} />
                      </div>
                      {e.notApplicableReason && <div className="small">Reason: {e.notApplicableReason}</div>}
                      {e.correctionReason && <div className="small">Why: {e.correctionReason}</div>}
                      {e.overrideReason && <div className="small">Override reason: {e.overrideReason}</div>}
                      {e.notes && <div className="small">{e.notes}</div>}
                      {(docsByEvent[e.id] ?? []).length > 0 && (
                        <div className="chips" style={{ marginTop: 4 }}>{docsByEvent[e.id].map((d) => <DocLink key={d} r={r} docId={d} />)}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {record && <RecordEventModal r={r} stage={record.stage} correct={record.correct} onClose={() => setRecord(null)} />}
      {voiding && (
        <ReasonModal title={`Void ${STAGE_LABEL[voiding.stage]} entry`} label="Why is this entry wrong?" cta="Void entry" danger onClose={() => setVoiding(null)}
          intro={<p className="muted small">The entry stays in the history, marked as voided. It no longer counts for the stage's status or durations.</p>}
          onSubmit={(reason) => act(() => svc.voidEvent(r.id, voiding.id, reason), "Entry voided")} />
      )}
    </div>
  );
}

function RecordEventModal({ r, stage, correct, onClose }: { r: Requisition; stage: OperationalStage; correct?: LifecycleEvent; onClose: () => void }) {
  const { svc, act, actor } = useApp();
  const [status, setStatus] = useState<"completed" | "not_applicable">(correct?.status ?? "completed");
  const [occurred, setOccurred] = useState(correct ? toLagosLocal(correct.occurredAt) : toLagosLocal(nowISO()));
  const [notes, setNotes] = useState(correct?.notes ?? "");
  const [na, setNa] = useState(correct?.notApplicableReason ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [override, setOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const iso = occurred ? fromLagosLocal(occurred) : "";
  const errs = iso ? chronologyErrors(r, stage, iso, { ignoreEventId: correct?.id, override }) : { hard: [], overridable: [] };
  const canOverride = can(actor, "chronology.override");
  const blocked = errs.hard.length > 0 || errs.overridable.length > 0 || (status === "not_applicable" && !na.trim()) || (!!correct && !reason.trim()) || (override && !overrideReason.trim());
  const submit = async () => {
    setBusy(true);
    const ok = await act(
      () => svc.recordEvent(r.id, { stage, status, occurredAt: iso, notes, notApplicableReason: na, override, overrideReason, files, documentType: EVIDENCE_TYPE[stage][0] }, correct?.id, correct ? reason : undefined),
      correct ? "Correction recorded" : `${STAGE_LABEL[stage]} recorded`,
    );
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      title={correct ? `Correct ${STAGE_LABEL[stage]}` : `Record ${STAGE_LABEL[stage]}`}
      onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={blocked || busy} onClick={submit}>{busy ? "Saving…" : "Save"}</button></>}
    >
      {correct && <p className="muted small">A correction is a new entry that replaces the old one. The old entry stays visible in the history.</p>}
      {stage !== "completed" && (
        <div className="row">
          <label className="check"><input type="radio" name="ev-status" checked={status === "completed"} onChange={() => setStatus("completed")} /> Completed</label>
          <label className="check"><input type="radio" name="ev-status" checked={status === "not_applicable"} onChange={() => setStatus("not_applicable")} /> Not applicable</label>
        </div>
      )}
      <Field label="When it happened (Lagos time)" hint="The time of the real event, e.g. the invoice time in mSupply. The recording time is added automatically.">
        <input id="ev-occurred" type="datetime-local" value={occurred} max={toLagosLocal(nowISO())} onChange={(e) => setOccurred(e.target.value)} />
      </Field>
      {(errs.hard.length > 0 || errs.overridable.length > 0) && <div className="error-box">{[...errs.hard, ...errs.overridable].join("\n")}</div>}
      {canOverride && (errs.overridable.length > 0 || override) && errs.hard.length === 0 && (
        <div className="stack tight">
          <label className="check small"><input id="ev-override" type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Record with a chronology override (Administrator). The event is flagged and left out of bottleneck averages.</label>
          {override && <Field label="Override reason"><input id="ev-override-reason" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="e.g. Registered in Nebula after the invoice was raised" /></Field>}
        </div>
      )}
      {status === "not_applicable" && <Field label="Why is this stage not applicable?"><input id="ev-na" value={na} onChange={(e) => setNa(e.target.value)} placeholder="e.g. Free programme, no payment required" /></Field>}
      <Field label="Notes"><textarea id="ev-notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <Field label={`Evidence: ${EVIDENCE_TYPE[stage][1]}`} hint="Optional. You can attach more than one file. Files are stored unchanged.">
        <input id="ev-files" type="file" multiple accept={ACCEPTED_TYPES.join(",")} onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
      </Field>
      {correct && <Field label="Reason for the correction"><input id="ev-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
    </Modal>
  );
}

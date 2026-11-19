import React, { useEffect, useMemo, useState } from "react";
import { useApp } from "../ui/context";
import { Empty, Field, FulfillmentPill, Modal, OfrValue, Picker, RecordStatusPill, StagePill, useOptions, Icon, ICON } from "../ui/kit";
import { go } from "../ui/App";
import { can } from "../domain/permissions";
import { activeLines, RECORD_STATUS_LABEL, FULFILLMENT_STATUS_LABEL, inOfficialScope } from "../domain/records";
import { currentStage, STAGE_LABEL } from "../domain/lifecycle";
import { requisitionAggregate } from "../domain/ofr";
import { fmtDate, fmtDateTime, fromLagosLocal, lagosDate, toLagosLocal, nowISO } from "../domain/time";
import { fmtNum, normalize } from "../domain/text";
import { LIFECYCLE_STAGES, type FulfillmentStatus, type LifecycleStage, type RecordStatus, type Requisition } from "../domain/types";
import { ACCEPTED_TYPES } from "../data/files";

interface Row {
  r: Requisition;
  facility: string;
  programme: string;
  stage: LifecycleStage;
  requested: number;
  issued: number;
  ofr: number | null;
  coverage: number | null;
}

export function RequisitionsPage() {
  const { state, actor, platform } = useApp();
  const { fac, progs } = useOptions();
  const [showNew, setShowNew] = useState(false);
  const [q, setQ] = useState("");
  const [rs, setRs] = useState<RecordStatus | "">("");
  const [fs, setFs] = useState<FulfillmentStatus | "">("");
  const [stage, setStage] = useState<LifecycleStage | "">("");
  const [facilityId, setFacilityId] = useState("");
  const [programmeId, setProgrammeId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [ofrBelow, setOfrBelow] = useState("");
  const [showCancelled, setShowCancelled] = useState(false);

  useEffect(() => {
    const open = () => setShowNew(true);
    window.addEventListener("nebula:new-requisition", open);
    return () => window.removeEventListener("nebula:new-requisition", open);
  }, []);

  const md = state.md;
  const rows: Row[] = useMemo(
    () =>
      Object.values(state.reqs)
        .sort((a, b) => b.entryAt.localeCompare(a.entryAt))
        .map((r) => {
          const agg = requisitionAggregate(r, md);
          return {
            r,
            facility: r.facilityId ? md.facilities[r.facilityId]?.name ?? "Unknown facility" : r.facilityExtractedText ? `“${r.facilityExtractedText}” (unmatched)` : "Not yet matched",
            programme: r.primaryProgrammeId ? md.programmes[r.primaryProgrammeId]?.name ?? "" : [...new Set(activeLines(r).map((l) => md.programmes[l.programmeId ?? ""]?.name).filter(Boolean))].join(", "),
            stage: currentStage(r),
            requested: agg.issued.requested,
            issued: agg.issued.credited,
            ofr: agg.issued.ofr,
            coverage: agg.issued.coverage,
          };
        }),
    [state.reqs, md],
  );

  const filtered = rows.filter(({ r, facility, stage: st, ofr }) => {
    if (!showCancelled && r.recordStatus === "cancelled" && rs !== "cancelled") return false;
    if (rs && r.recordStatus !== rs) return false;
    if (fs && r.fulfillmentStatus !== fs) return false;
    if (stage && st !== stage) return false;
    if (facilityId && r.facilityId !== facilityId) return false;
    if (programmeId && r.primaryProgrammeId !== programmeId && !activeLines(r).some((l) => l.programmeId === programmeId)) return false;
    const d = lagosDate(r.receivedAt);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (ofrBelow && !(ofr != null && ofr < Number(ofrBelow))) return false;
    if (q.trim()) {
      const n = normalize(q);
      const items = activeLines(r).map((l) => (l.itemId ? `${md.items[l.itemId]?.name} ${md.items[l.itemId]?.code}` : l.itemExtractedText ?? "")).join(" ");
      if (!normalize(`${r.number} ${facility} ${items}`).includes(n) && !r.number.toLowerCase().includes(q.toLowerCase())) return false;
    }
    return true;
  });

  const exportCsv = async () => {
    const head = ["Requisition number", "Facility", "Programme", "Requisition date", "Estimated", "Received at", "Entry at", "Record status", "Current stage", "Fulfillment status", "Requested (base units)", "Issued credited (base units)", "Issued OFR %", "Coverage %", "In official scope"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = filtered.map(({ r, facility, programme, stage: st, requested, issued, ofr, coverage }) =>
      [r.number, facility, programme, r.requisitionDate ?? "", r.requisitionDateEstimated ? "yes" : "", r.receivedAt, r.entryAt, RECORD_STATUS_LABEL[r.recordStatus], STAGE_LABEL[st], FULFILLMENT_STATUS_LABEL[r.fulfillmentStatus], requested, issued, ofr?.toFixed(1) ?? "", coverage?.toFixed(0) ?? "", inOfficialScope(r) ? "yes" : "no"].map(esc).join(","),
    );
    try {
      await platform.downloads?.save({ filename: `requisitions-${lagosDate(nowISO())}.csv`, data: [head.map(esc).join(","), ...lines].join("\n") });
    } catch {
      /* declined or unavailable */
    }
  };

  const anyFilter = q || rs || fs || stage || facilityId || programmeId || from || to || ofrBelow;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Requisitions</h1>
          <p className="sub">{fmtNum(filtered.length)} of {fmtNum(rows.length)} requisitions. OFR here is Issued OFR on credited base quantities; it is provisional until the requisition is finalized and fulfillment is closed.</p>
        </div>
        <div className="row">
          {platform.downloads && filtered.length > 0 && <button className="btn" onClick={exportCsv}>Export CSV</button>}
          {can(actor, "requisition.create") && <button className="btn primary" onClick={() => setShowNew(true)}><Icon d={ICON.plus} /> New requisition</button>}
        </div>
      </div>

      <div className="card">
        <div className="filters">
          <Field label="Search"><input id="rq-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, facility, item, code" /></Field>
          <Field label="Record status">
            <select id="rq-rs" value={rs} onChange={(e) => setRs(e.target.value as RecordStatus | "")}>
              <option value="">Any</option>
              {Object.entries(RECORD_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Current stage">
            <select id="rq-stage" value={stage} onChange={(e) => setStage(e.target.value as LifecycleStage | "")}>
              <option value="">Any</option>
              {LIFECYCLE_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
            </select>
          </Field>
          <Field label="Fulfillment">
            <select id="rq-fs" value={fs} onChange={(e) => setFs(e.target.value as FulfillmentStatus | "")}>
              <option value="">Any</option>
              {Object.entries(FULFILLMENT_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Facility"><Picker id="rq-fac" options={fac} value={facilityId} onChange={setFacilityId} allowEmpty placeholder="Any facility" /></Field>
          <Field label="Programme"><Picker id="rq-prog" options={progs} value={programmeId} onChange={setProgrammeId} allowEmpty placeholder="Any programme" /></Field>
          <Field label="Received from"><input id="rq-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Received to"><input id="rq-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Issued OFR below %"><input id="rq-ofr" type="number" min={0} max={100} value={ofrBelow} onChange={(e) => setOfrBelow(e.target.value)} placeholder="e.g. 80" /></Field>
          <label className="check small"><input id="rq-cancelled" type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Show cancelled</label>
          {anyFilter && <button className="btn ghost sm" onClick={() => { setQ(""); setRs(""); setFs(""); setStage(""); setFacilityId(""); setProgrammeId(""); setFrom(""); setTo(""); setOfrBelow(""); }}>Clear filters</button>}
        </div>
      </div>

      <div className="card flush">
        {rows.length === 0 ? (
          <Empty title="No requisitions yet">
            <p>Each requisition starts from the original document a facility sent: a WhatsApp photo or a PDF.</p>
            {can(actor, "requisition.create") ? <button className="btn primary" onClick={() => setShowNew(true)}>Register the first requisition</button> : <p>Requisition Assistants register them; you'll see them here.</p>}
            {actor.role === "admin" && !Object.keys(md.items).length && <p className="small">Before that, load facilities, items and programmes in <a href="#admin">Administration</a>.</p>}
          </Empty>
        ) : filtered.length === 0 ? (
          <Empty title="No requisitions match these filters" />
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Number</th><th>Facility</th><th>Programme</th><th>Req. date</th><th>Received</th><th>Entered</th>
                  <th>Record</th><th>Stage</th><th>Fulfillment</th><th className="num">Requested</th><th className="num">Issued</th><th className="num">Issued OFR</th><th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(({ r, facility, programme, stage: st, requested, issued, ofr, coverage }) => (
                  <tr key={r.id} className={`clickable ${r.recordStatus === "cancelled" ? "dim" : ""}`} onClick={() => go("req", r.id)}>
                    <td><a className="mono" href={`#req-${r.id}`} onClick={(e) => e.stopPropagation()}>{r.number}</a></td>
                    <td>{facility}</td>
                    <td className="small">{programme || <span className="muted">—</span>}</td>
                    <td className="small">{fmtDate(r.requisitionDate)}{r.requisitionDateEstimated ? " (est.)" : ""}</td>
                    <td className="small">{fmtDateTime(r.receivedAt)}</td>
                    <td className="small">{fmtDateTime(r.entryAt)}</td>
                    <td><RecordStatusPill s={r.recordStatus} /></td>
                    <td><StagePill s={st} /></td>
                    <td><FulfillmentPill s={r.fulfillmentStatus} /></td>
                    <td className="num">{fmtNum(requested)}</td>
                    <td className="num">{fmtNum(issued)}</td>
                    <td className="num"><OfrValue v={ofr} coverage={coverage} threshold={md.settings.ofrThresholdPercent} />{ofr != null && !inOfficialScope(r) && <span className="muted small"> prov.</span>}</td>
                    <td className="small muted">{fmtDateTime(r.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {showNew && <NewRequisitionModal onClose={() => setShowNew(false)} />}
    </>
  );
}

function NewRequisitionModal({ onClose }: { onClose: () => void }) {
  const { svc, run, platform, store } = useApp();
  const [receivedAt, setReceivedAt] = useState(() => toLagosLocal(nowISO()));
  const [via, setVia] = useState("WhatsApp");
  const [files, setFiles] = useState<File[]>([]);
  const canRead = !!(platform.sample && platform.imageLimits);
  const [read, setRead] = useState(canRead);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const add = (list: FileList | null) => list && setFiles((f) => [...f, ...Array.from(list)]);
  const bad = files.filter((f) => !ACCEPTED_TYPES.includes(f.type));
  const submit = async () => {
    setBusy(true);
    const id = await run(() => svc.createRequisition({ receivedAt: fromLagosLocal(receivedAt), receivedVia: via, files, read: read && canRead }), "Requisition registered");
    setBusy(false);
    if (id) {
      onClose();
      go("req", id);
    }
  };
  return (
    <Modal
      title="Register a requisition"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!files.length || !!bad.length || busy || !receivedAt} onClick={submit}>{busy ? "Uploading…" : "Register requisition"}</button>
        </>
      }
    >
      <p className="muted small">The system assigns the requisition number and the entry time when you register. The original files are stored unchanged with a SHA-256 checksum.</p>
      <div className="form-grid">
        <Field label="Received at (Lagos time)" hint="When the facility's message arrived, e.g. the WhatsApp timestamp.">
          <input id="new-received" type="datetime-local" value={receivedAt} max={toLagosLocal(nowISO())} onChange={(e) => setReceivedAt(e.target.value)} />
        </Field>
        <Field label="Received via">
          <select id="new-via" value={via} onChange={(e) => setVia(e.target.value)}>
            <option>WhatsApp</option><option>Email</option><option>Hand delivered</option><option>Other</option>
          </select>
        </Field>
      </div>
      <div
        className="card"
        style={{ borderStyle: "dashed", textAlign: "center", background: drag ? "var(--accent-soft)" : undefined }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
      >
        <div className="stack tight" style={{ alignItems: "center" }}>
          <Icon d={ICON.upload} size={22} />
          <b>Original requisition</b>
          <span className="muted small">Photos (JPEG, PNG, WebP) or PDF, up to 20 MB each. Add pages in order.</span>
          <label className="btn sm">
            Choose files
            <input id="new-files" type="file" multiple accept={ACCEPTED_TYPES.join(",")} hidden onChange={(e) => add(e.target.files)} />
          </label>
        </div>
      </div>
      {files.length > 0 && (
        <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
          {files.map((f, i) => (
            <li key={i}>
              {f.name} <span className="muted">({(f.size / 1024).toFixed(0)} KB)</span>
              {!ACCEPTED_TYPES.includes(f.type) && <span style={{ color: "var(--bad)" }}> unsupported type</span>}
              <button className="btn ghost sm" onClick={() => setFiles(files.filter((_, j) => j !== i))}>Remove</button>
            </li>
          ))}
        </ol>
      )}
      <label className="check">
        <input id="new-read" type="checkbox" checked={read && canRead} disabled={!canRead} onChange={(e) => setRead(e.target.checked)} />
        Read the document with Claude and suggest the lines
      </label>
      {!canRead && <p className="muted small">{store.live ? "Reading with Claude isn't available in this view. You'll enter the lines by hand." : "Preview mode can't use Claude. You'll enter the lines by hand."}</p>}
    </Modal>
  );
}

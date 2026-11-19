import React, { useMemo, useState } from "react";
import { useApp } from "../../ui/context";
import { Field, Modal, OfrValue, Picker, Pill, ReasonModal, Seg, useOptions, Who } from "../../ui/kit";
import { can } from "../../domain/permissions";
import { activeLines } from "../../domain/records";
import { canSupersede } from "../../domain/lifecycle";
import { EXCLUSION_LABEL, aggregate, lineMetrics } from "../../domain/ofr";
import { itemLabel } from "../../domain/matching";
import { fmtNum, fmtPct } from "../../domain/text";
import { fmtDateTime, fromLagosLocal, toLagosLocal, nowISO } from "../../domain/time";
import { FULFILLMENT_STAGES, type FulfillmentRecord, type FulfillmentStage, type Requisition } from "../../domain/types";
import { ACCEPTED_TYPES } from "../../data/files";

const STAGE_NAME: Record<FulfillmentStage, string> = { invoiced: "Invoiced", issued: "Issued", delivered: "Delivered" };
const STAGE_EVIDENCE: Record<FulfillmentStage, [string, string]> = { invoiced: ["invoice", "Invoice"], issued: ["pick_slip", "Pick slip"], delivered: ["pod", "POD"] };

export function FulfillmentTab({ r }: { r: Requisition }) {
  const { state, actor, svc, act } = useApp();
  const md = state.md;
  const lines = activeLines(r);
  const metrics = useMemo(() => lines.map((l) => lineMetrics(r, l, md)), [r, md]); // eslint-disable-line react-hooks/exhaustive-deps
  const agg = aggregate(metrics);
  const [capture, setCapture] = useState<FulfillmentStage | null>(null);
  const [correcting, setCorrecting] = useState<FulfillmentRecord | null>(null);
  const [voiding, setVoiding] = useState<FulfillmentRecord | null>(null);
  const canRecord = can(actor, "fulfillment.record") && r.recordStatus !== "cancelled" && !!r.firstValidatedAt;
  const records = Object.values(r.fulfillment).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const superseded = new Set(records.map((x) => x.supersedesId).filter(Boolean));
  const additional = records.filter((x) => x.additional && x.recordType !== "void" && !superseded.has(x.id));

  return (
    <div className="stack">
      {!r.firstValidatedAt && <div className="note-box">Validate the requisition before recording fulfillment.</div>}
      {r.fulfillmentStatus === "closed" && (
        <div className="note-box">
          Fulfillment closed by <Who id={r.fulfillmentClosedBy} /> on {fmtDateTime(r.fulfillmentClosedAt)}{r.fulfillmentClosureReason ? `: ${r.fulfillmentClosureReason}` : ""}. Figures are final for reporting. Closed doesn't mean fully supplied.
          {" "}Further records need an approved edit request{actor.role === "admin" ? " or reopening fulfillment" : ""}.
        </div>
      )}

      <div className="grid3">
        {FULFILLMENT_STAGES.map((s) => {
          const a = agg[s];
          const excluded = Object.entries(a.exclusions).filter(([, n]) => n > 0);
          return (
            <div key={s} className={`stat ${s === "issued" ? "headline" : ""}`}>
              <span className="label">{STAGE_NAME[s]} OFR</span>
              <span className="value"><OfrValue v={a.ofr} threshold={s === "issued" ? md.settings.ofrThresholdPercent : undefined} /></span>
              <span className="foot">
                {fmtNum(a.credited)} of {fmtNum(a.requested)} base units credited · SKU {fmtPct(a.skuRate, 0)} ({a.fullLines} full, {a.partialLines} partial, {a.noneLines} none)
                <br />Coverage {fmtPct(a.coverage, 0)} ({a.eligibleLines} of {a.requestedLines} lines)
                {a.over > 0 && <><br />Over-fulfilled: {fmtNum(a.over)} on {a.overLines} line{a.overLines > 1 ? "s" : ""}</>}
                {excluded.map(([k, n]) => <React.Fragment key={k}><br />Excluded: {n} · {EXCLUSION_LABEL[k as keyof typeof EXCLUSION_LABEL]}</React.Fragment>)}
                {a.uncreditedSubstitutionLines > 0 && <><br />{a.uncreditedSubstitutionLines} line{a.uncreditedSubstitutionLines > 1 ? "s" : ""} with uncredited substitution</>}
              </span>
              {canRecord && <button className="btn sm" style={{ marginTop: 8, alignSelf: "flex-start" }} onClick={() => setCapture(s)}>Record {STAGE_NAME[s].toLowerCase()} quantities</button>}
            </div>
          );
        })}
      </div>

      <div className="card flush">
        <div className="card-head"><h3>By line</h3><span className="muted small">Base units. Credited quantity is capped at the requested quantity for each line.</span></div>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr><th>Item</th><th>Programme</th><th className="num">Requested</th>{FULFILLMENT_STAGES.map((s) => <th key={s} className="num">{STAGE_NAME[s]}</th>)}<th className="num">Issued OFR</th><th>Notes</th></tr>
            </thead>
            <tbody>
              {metrics.map((m) => {
                const l = m.line;
                const st = m.stages;
                const flags: React.ReactNode[] = [];
                if (l.conversionStatus !== "resolved") flags.push(<Pill key="c" tone="warn">Excluded: {l.conversionStatus === "incompatible" ? "incompatible unit" : "conversion unknown"}</Pill>);
                FULFILLMENT_STAGES.forEach((s) => st[s].exclusion === "fulfillment_conversion_unresolved" && flags.push(<Pill key={`x${s}`} tone="warn">{STAGE_NAME[s]}: record conversion unknown</Pill>));
                if (FULFILLMENT_STAGES.some((s) => st[s].uncreditedSubstitution)) flags.push(<Pill key="u" tone="bad" title="No approved equivalence rule">Uncredited substitution</Pill>);
                if (FULFILLMENT_STAGES.some((s) => st[s].substituteCredited)) flags.push(<Pill key="s" tone="info">Substitute credited</Pill>);
                if (FULFILLMENT_STAGES.some((s) => st[s].over > 0)) flags.push(<Pill key="o" tone="info">Over-fulfilled</Pill>);
                return (
                  <tr key={l.id}>
                    <td>{itemLabel(md.items[l.itemId ?? ""])}<div className="muted small">{fmtNum(l.quantityRequested)} {l.unitRequested} as written</div></td>
                    <td className="small">{md.programmes[l.programmeId ?? ""]?.name ?? "—"}</td>
                    <td className="num">{l.conversionStatus === "resolved" ? fmtNum(l.baseQuantityRequested) : "—"}</td>
                    {FULFILLMENT_STAGES.map((s) => (
                      <td key={s} className="num">{st[s].eligible ? <>{fmtNum(st[s].credited)}{st[s].over > 0 && <span className="muted small"> +{fmtNum(st[s].over)}</span>}</> : "—"}</td>
                    ))}
                    <td className="num"><OfrValue v={st.issued.eligible ? (st.issued.credited / st.issued.requested) * 100 : null} /></td>
                    <td><div className="chips">{flags}</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {additional.length > 0 && (
        <div className="card flush">
          <div className="card-head"><h3>Additional items supplied (not requested)</h3><span className="muted small">Not counted in OFR or SKU rates.</span></div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Item</th><th>Stage</th><th className="num">Quantity</th><th>Reference</th><th>When</th></tr></thead>
              <tbody>
                {additional.map((x) => (
                  <tr key={x.id}><td>{itemLabel(md.items[x.itemId])}</td><td>{STAGE_NAME[x.stage]}</td><td className="num">{fmtNum(x.quantity)} {x.unit}</td><td className="small">{x.reference ?? "—"}</td><td className="small">{fmtDateTime(x.occurredAt)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card flush">
        <div className="card-head"><h3>Fulfillment records</h3><span className="muted small">Append-only. Corrections and voids replace a record without deleting it.</span></div>
        {records.length === 0 ? <div className="empty small">No quantities recorded yet.</div> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Stage</th><th>Line / item</th><th className="num">Quantity</th><th className="num">Base</th><th>Reference</th><th>Occurred</th><th>Recorded</th><th>Type</th><th></th></tr></thead>
              <tbody>
                {records.map((x) => {
                  const eff = x.recordType !== "void" && !superseded.has(x.id);
                  const line = x.requisitionLineId ? r.lines[x.requisitionLineId] : null;
                  return (
                    <tr key={x.id} className={eff ? "" : "dim"}>
                      <td>{STAGE_NAME[x.stage]}</td>
                      <td>
                        {line ? `Ln ${line.lineNumber}: ` : "Additional: "}{itemLabel(md.items[x.itemId])}
                        {x.substitution && <div><Pill tone="info">Substitute for {itemLabel(md.items[line?.itemId ?? ""])}</Pill></div>}
                      </td>
                      <td className="num">{x.recordType === "void" ? "—" : `${fmtNum(x.quantity)} ${x.unit ?? ""}`}</td>
                      <td className="num">{x.recordType === "void" ? "—" : x.conversionStatus === "resolved" ? `${fmtNum(x.baseQuantity)} ${x.baseUnit}` : <Pill tone="warn">Unknown</Pill>}</td>
                      <td className="small">{x.reference ?? "—"}</td>
                      <td className="small">{fmtDateTime(x.occurredAt)}</td>
                      <td className="small">{fmtDateTime(x.recordedAt)}<br /><Who id={x.recordedBy} /></td>
                      <td className="small">{x.recordType === "entry" ? (eff ? "Entry" : "Entry (superseded)") : x.recordType === "correction" ? <>Correction{x.correctionReason ? `: ${x.correctionReason}` : ""}</> : <>Void: {x.correctionReason}</>}</td>
                      <td>
                        {eff && can(actor, "fulfillment.record") && canSupersede(r.fulfillment, x.id) && (
                          <div className="row"><button className="btn ghost sm" onClick={() => setCorrecting(x)}>Correct</button><button className="btn ghost sm" onClick={() => setVoiding(x)}>Void</button></div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {capture && <CaptureModal r={r} stage={capture} onClose={() => setCapture(null)} />}
      {correcting && <CorrectModal r={r} target={correcting} onClose={() => setCorrecting(null)} />}
      {voiding && (
        <ReasonModal title="Void fulfillment record" label="Why is this record wrong?" cta="Void record" danger onClose={() => setVoiding(null)}
          intro={<p className="muted small">The record stays in the history marked as voided and stops counting toward OFR.</p>}
          onSubmit={(reason) => act(() => svc.correctFulfillment(r.id, voiding.id, null, reason), "Record voided")} />
      )}
    </div>
  );
}

interface Row { key: string; lineId: string | null; itemId: string; qty: string; unit: string; substitute: boolean }

function CaptureModal({ r, stage: initial, onClose }: { r: Requisition; stage: FulfillmentStage; onClose: () => void }) {
  const { state, svc, act } = useApp();
  const md = state.md;
  const { items } = useOptions();
  const [stage, setStage] = useState<FulfillmentStage>(initial);
  const [occurred, setOccurred] = useState(toLagosLocal(nowISO()));
  const [reference, setReference] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const lines = activeLines(r);
  const [rows, setRows] = useState<Row[]>(() =>
    lines.map((l) => ({ key: l.id, lineId: l.id, itemId: l.itemId ?? "", qty: "", unit: md.items[l.itemId ?? ""]?.baseUnit ?? l.unitRequested ?? "", substitute: false })),
  );
  const upd = (k: string, p: Partial<Row>) => setRows((rs) => rs.map((x) => (x.key === k ? { ...x, ...p } : x)));
  const filled = rows.filter((x) => x.qty.trim() !== "" && x.itemId);
  const submit = async () => {
    setBusy(true);
    const ok = await act(async () => {
      let documentId: string | undefined;
      if (files.length) {
        const docs = await svc.uploadEvidence(r.id, files, { documentType: STAGE_EVIDENCE[stage][0], category: "supporting", description: `${STAGE_NAME[stage]} evidence${reference ? ` (${reference})` : ""}` });
        documentId = docs[0]?.id;
      }
      await svc.recordFulfillment(r.id, filled.map((x) => ({ lineId: x.lineId, itemId: x.itemId, stage, quantity: Number(x.qty.replace(/,/g, "")), unit: x.unit, reference, documentId, occurredAt: fromLagosLocal(occurred) })));
    }, `${filled.length} ${STAGE_NAME[stage].toLowerCase()} record${filled.length > 1 ? "s" : ""} saved`);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal wide title={`Record ${STAGE_NAME[stage].toLowerCase()} quantities`} onClose={onClose}
      foot={<><span className="muted small" style={{ marginRight: "auto" }}>{filled.length} row{filled.length === 1 ? "" : "s"} to save</span><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!filled.length || busy || !occurred} onClick={submit}>{busy ? "Saving…" : "Save records"}</button></>}>
      <div className="row">
        <Seg label="Stage" options={FULFILLMENT_STAGES.map((s) => [s, STAGE_NAME[s]] as [FulfillmentStage, string])} value={stage} onChange={setStage} />
      </div>
      <div className="form-grid">
        <Field label="When (Lagos time)"><input id="fr-occurred" type="datetime-local" value={occurred} max={toLagosLocal(nowISO())} onChange={(e) => setOccurred(e.target.value)} /></Field>
        <Field label={`${STAGE_EVIDENCE[stage][1]} number`}><input id="fr-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Reference from mSupply" /></Field>
        <Field label={`${STAGE_EVIDENCE[stage][1]} file`} hint="Optional"><input id="fr-file" type="file" accept={ACCEPTED_TYPES.join(",")} onChange={(e) => setFiles(Array.from(e.target.files ?? []))} /></Field>
      </div>
      <p className="muted small">Leave a row empty to skip it. Enter 0 to record that nothing was {STAGE_NAME[stage].toLowerCase()}. If a different item was supplied, switch on “Substitute” and pick it: it counts toward this line only if an Administrator has approved an equivalence rule.</p>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th>Line</th><th>Supplied item</th><th className="num">Quantity</th><th>Unit</th><th></th></tr></thead>
          <tbody>
            {rows.map((x) => {
              const line = x.lineId ? r.lines[x.lineId] : null;
              return (
                <tr key={x.key}>
                  <td className="small" style={{ minWidth: 160 }}>
                    {line ? <>Ln {line.lineNumber}: {itemLabel(md.items[line.itemId ?? ""])}<div className="muted">requested {fmtNum(line.baseQuantityRequested ?? line.quantityRequested)} {line.baseUnit ?? line.unitRequested}</div></> : <Pill tone="accent">Additional item</Pill>}
                  </td>
                  <td style={{ minWidth: 220 }}>
                    {line && !x.substitute ? itemLabel(md.items[x.itemId]) : <Picker id={`fr-item-${x.key}`} options={items} value={x.itemId} onChange={(id) => upd(x.key, { itemId: id, unit: md.items[id]?.baseUnit ?? x.unit })} placeholder="Item supplied" />}
                    {line && <label className="check small"><input type="checkbox" checked={x.substitute} onChange={(e) => upd(x.key, { substitute: e.target.checked, itemId: e.target.checked ? "" : line.itemId ?? "" })} /> Substitute</label>}
                  </td>
                  <td className="num" style={{ width: 110 }}><input id={`fr-qty-${x.key}`} className="input sm num" inputMode="decimal" value={x.qty} onChange={(e) => upd(x.key, { qty: e.target.value })} /></td>
                  <td style={{ width: 110 }}><input id={`fr-unit-${x.key}`} className="input sm" value={x.unit} onChange={(e) => upd(x.key, { unit: e.target.value })} /></td>
                  <td>{!line && <button className="btn ghost sm" onClick={() => setRows((rs) => rs.filter((y) => y.key !== x.key))}>Remove</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setRows((rs) => [...rs, { key: `add${rs.length}${Date.now()}`, lineId: null, itemId: "", qty: "", unit: "", substitute: false }])}>Add an item that wasn't requested</button>
    </Modal>
  );
}

function CorrectModal({ r, target, onClose }: { r: Requisition; target: FulfillmentRecord; onClose: () => void }) {
  const { state, svc, act } = useApp();
  const { items } = useOptions();
  const md = state.md;
  const [itemId, setItemId] = useState(target.itemId);
  const [qty, setQty] = useState(String(target.quantity ?? ""));
  const [unit, setUnit] = useState(target.unit ?? "");
  const [occurred, setOccurred] = useState(toLagosLocal(target.occurredAt));
  const [reference, setReference] = useState(target.reference ?? "");
  const [reason, setReason] = useState("");
  const line = target.requisitionLineId ? r.lines[target.requisitionLineId] : null;
  return (
    <Modal title="Correct fulfillment record" onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!reason.trim() || qty === ""} onClick={async () => {
        if (await act(() => svc.correctFulfillment(r.id, target.id, { lineId: target.requisitionLineId, itemId, stage: target.stage, quantity: Number(qty), unit, reference, documentId: target.documentId, occurredAt: fromLagosLocal(occurred) }, reason), "Correction saved")) onClose();
      }}>Save correction</button></>}>
      <p className="muted small">The correction replaces the record for reporting. The original stays in the history.</p>
      {line && <p className="small">Line {line.lineNumber}: requested {itemLabel(md.items[line.itemId ?? ""])}</p>}
      <div className="form-grid">
        <Field label="Item supplied"><Picker id="fc-item" options={items} value={itemId} onChange={(id) => id && setItemId(id)} /></Field>
        <Field label="Quantity"><input id="fc-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        <Field label="Unit"><input id="fc-unit" value={unit} onChange={(e) => setUnit(e.target.value)} /></Field>
        <Field label="When (Lagos time)"><input id="fc-occurred" type="datetime-local" value={occurred} max={toLagosLocal(nowISO())} onChange={(e) => setOccurred(e.target.value)} /></Field>
        <Field label="Reference"><input id="fc-ref" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      </div>
      <Field label="Reason for the correction"><input id="fc-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}

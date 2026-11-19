import React, { useEffect, useMemo, useState } from "react";
import { useApp } from "../../ui/context";
import { DocView, Field, Modal, Picker, Pill, useOptions } from "../../ui/kit";
import { can } from "../../domain/permissions";
import { activeEditPermission, activeLines, editCovers, isEditable, validationIssues } from "../../domain/records";
import { fmtDateTime, fromLagosLocal, toLagosLocal, nowISO, lagosDate } from "../../domain/time";
import { fmtNum } from "../../domain/text";
import { itemLabel } from "../../domain/matching";
import type { MatchCandidate, ReqDocument, Requisition, RequisitionLine } from "../../domain/types";

const METHOD_LABEL: Record<MatchCandidate["method"] | "human", string> = {
  exact: "exact", alias: "approved alias", normalized: "normalized text", historical: "used before", attribute: "attributes match", fuzzy: "similar text", human: "chosen by hand",
};

export function ReviewTab({ r }: { r: Requisition }) {
  const { state, actor, svc, run } = useApp();
  const md = state.md;
  const originals = useMemo(
    () => Object.values(r.documents).filter((d): d is ReqDocument => !!d && d.category === "original_requisition").sort((a, b) => a.firstPage - b.firstPage),
    [r.documents],
  );
  const totalPages = Math.max(1, Object.keys(r.pages).length);
  const [page, setPage] = useState(1);
  const docForPage = originals.find((d) => page >= d.firstPage && page < d.firstPage + d.pageCount) ?? originals[0];
  const editable = isEditable(r) && can(actor, "requisition.edit");
  const issues = r.recordStatus === "validation_pending" || r.recordStatus === "reopened" ? validationIssues(r, md) : [];
  const lines = activeLines(r);
  const exactAvailable = editable && lines.some((l) => !l.itemId && l.candidates?.[0] && ["exact", "alias", "normalized"].includes(l.candidates[0].method));

  return (
    <div className="split">
      <div className="doc-pane">
        <div className="row between">
          <span className="eyebrow">Original document · page {page} of {totalPages}</span>
          <div className="row">
            <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <button className="btn sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </div>
        <div className="doc-view">
          {docForPage ? <DocView assetId={docForPage.assetId} mime={docForPage.mimeType} page={page - docForPage.firstPage + 1} /> : <div className="empty">No original document.</div>}
        </div>
        {docForPage && <span className="muted small">{docForPage.fileName} · SHA-256 <span className="mono">{docForPage.sha256.slice(0, 12)}…</span></span>}
      </div>

      <div className="stack">
        {r.extraction?.status === "failed" && (
          <div className="banner bad">
            Reading the document failed: {r.extraction.error}
            {can(actor, "extraction.retry") && editable && <> <button className="btn sm" onClick={() => run(() => svc.runExtraction(r.id))}>Retry reading</button></>}
          </div>
        )}
        {r.extraction?.status === "completed" && editable && (
          <div className="note-box">Claude suggested {lines.filter((l) => l.rawExtractedText).length} lines on {fmtDateTime(r.extraction.completedAt)}. These are suggestions: confirm each item, quantity and unit against the document. The raw output is kept in the audit history.</div>
        )}
        {(r.extraction?.status === "skipped" || !r.extraction) && editable && lines.length === 0 && (
          <div className="note-box">
            Enter the lines from the document by hand.
            {can(actor, "extraction.retry") && <> Or <button className="btn sm" onClick={() => run(() => svc.runExtraction(r.id))}>read it with Claude</button></>}
          </div>
        )}
        {!editable && r.recordStatus === "finalized" && <div className="note-box">Finalized: details and lines are locked. Use Request edit for a specific change.</div>}

        <HeaderCard r={r} editable={editable} />
        <PagesCard r={r} editable={editable} />

        <div className="card flush">
          <div className="card-head">
            <h3>Requisition lines ({lines.length})</h3>
            <div className="row">
              {exactAvailable && (
                <button className="btn sm" onClick={() => run(async () => {
                  for (const l of lines) if (!l.itemId && l.candidates?.[0] && ["exact", "alias", "normalized"].includes(l.candidates[0].method)) await svc.upsertLine(r.id, l.id, { itemId: l.candidates[0].targetId });
                }, "Matches confirmed")}>Confirm exact and alias matches</button>
              )}
              {editable && <button className="btn sm" onClick={() => run(() => svc.upsertLine(r.id, null, { pageNumber: page }), "Line added")}>Add line</button>}
            </div>
          </div>
          {lines.length === 0 ? (
            <div className="empty small">No lines yet.</div>
          ) : (
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr><th>Pg/Ln</th><th>As written</th><th>Item</th><th>Programme</th><th className="num">Qty</th><th>Unit</th><th>Base quantity</th><th></th></tr>
                </thead>
                <tbody>
                  {lines.map((l) => <LineRow key={l.id} r={r} l={l} editable={editable} onFocusPage={setPage} />)}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {issues.length > 0 && (
          <div className="card">
            <h3>Before validating</h3>
            <ul className="small" style={{ margin: "8px 0 0", paddingLeft: 18 }}>{issues.map((i, k) => <li key={k}>{i}</li>)}</ul>
          </div>
        )}
      </div>
    </div>
  );
}

function HeaderCard({ r, editable }: { r: Requisition; editable: boolean }) {
  const { state, svc, run, actor } = useApp();
  const md = state.md;
  const { fac, progs } = useOptions();
  const er = activeEditPermission(r, actor.id, md.settings.editRequestPendingTimeoutDays);
  const can2 = (f: string) => editable || editCovers(er, "header", undefined, f);
  const save = (patch: Parameters<typeof svc.updateHeader>[1]) => run(() => svc.updateHeader(r.id, patch));
  const [reqDate, setReqDate] = useState(r.requisitionDate ?? "");
  const [received, setReceived] = useState(toLagosLocal(r.receivedAt));
  useEffect(() => setReqDate(r.requisitionDate ?? ""), [r.requisitionDate]);
  useEffect(() => setReceived(toLagosLocal(r.receivedAt)), [r.receivedAt]);
  const f = r.facilityId ? md.facilities[r.facilityId] : undefined;
  const cands = (r.facilityCandidates ?? []).filter((c) => md.facilities[c.targetId] && c.targetId !== r.facilityId);

  return (
    <div className="card stack">
      <h3>Requisition details</h3>
      <div className="form-grid">
        <Field label="Facility" hint={r.facilityExtractedText ? <>Written on the document: “{r.facilityExtractedText}”</> : undefined}>
          {can2("facilityId") ? <Picker id="hdr-facility" options={fac} value={r.facilityId} onChange={(id) => id && save({ facilityId: id })} placeholder="Search facilities" /> : <div>{f?.name ?? "Not matched"}</div>}
        </Field>
        <Field label="Primary programme" hint="Optional. Pre-fills page programmes; never overrides them.">
          {can2("primaryProgrammeId") ? (
            <select id="hdr-programme" value={r.primaryProgrammeId ?? ""} onChange={(e) => save({ primaryProgrammeId: e.target.value || undefined })}>
              <option value="">None</option>
              {progs.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          ) : <div>{md.programmes[r.primaryProgrammeId ?? ""]?.name ?? "—"}</div>}
        </Field>
        <Field label="Requisition date (on the document)">
          {can2("requisitionDate") ? (
            <input id="hdr-reqdate" type="date" value={reqDate} max={lagosDate(r.receivedAt)} onChange={(e) => setReqDate(e.target.value)} onBlur={() => reqDate !== (r.requisitionDate ?? "") && save({ requisitionDate: reqDate || undefined })} />
          ) : <div>{r.requisitionDate ?? "—"}</div>}
        </Field>
        <Field label="Received at (Lagos time)">
          {can2("receivedAt") ? (
            <input id="hdr-received" type="datetime-local" value={received} max={toLagosLocal(nowISO())} onChange={(e) => setReceived(e.target.value)} onBlur={() => received && received !== toLagosLocal(r.receivedAt) && save({ receivedAt: fromLagosLocal(received) })} />
          ) : <div>{fmtDateTime(r.receivedAt)}</div>}
        </Field>
      </div>
      <div className="row">
        {can2("requisitionDateEstimated") ? (
          <label className="check small"><input id="hdr-est" type="checkbox" checked={!!r.requisitionDateEstimated} onChange={(e) => save({ requisitionDateEstimated: e.target.checked })} /> The requisition date is estimated (missing or illegible)</label>
        ) : r.requisitionDateEstimated ? <Pill tone="warn">Requisition date estimated</Pill> : null}
        <span className="muted small">Entered {fmtDateTime(r.entryAt)} (system time, not editable){r.receivedVia ? ` · received via ${r.receivedVia}` : ""}</span>
      </div>
      {editable && cands.length > 0 && (
        <div className="stack tight">
          <span className="eyebrow">Suggested facilities</span>
          <div className="chips">
            {cands.map((c) => (
              <button key={c.targetId} className="btn sm" onClick={() => save({ facilityId: c.targetId })}>
                {md.facilities[c.targetId].name} <span className="muted small">· {METHOD_LABEL[c.method]} {Math.round(c.score * 100)}%</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PagesCard({ r, editable }: { r: Requisition; editable: boolean }) {
  const { state, svc, run, actor } = useApp();
  const { progs } = useOptions();
  const pages = Object.keys(r.pages).sort((a, b) => +a - +b);
  const er = activeEditPermission(r, actor.id, state.md.settings.editRequestPendingTimeoutDays);
  const [all, setAll] = useState("");
  if (pages.length === 0) return null;
  return (
    <div className="card stack">
      <div className="row between">
        <h3>Programme by page</h3>
        {editable && pages.length > 1 && (
          <div className="row">
            <select id="pg-all" className="input sm" value={all} onChange={(e) => setAll(e.target.value)} style={{ width: "auto" }}>
              <option value="">Choose programme…</option>
              {progs.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <button className="btn sm" disabled={!all} onClick={() => run(() => svc.setPageProgramme(r.id, "all", all), "Applied across pages")}>Apply across pages</button>
          </div>
        )}
      </div>
      <p className="muted small">Lines take their page's programme unless you change a line's programme yourself.</p>
      <div className="grid3">
        {pages.map((p) => (
          <Field key={p} label={`Page ${p}`}>
            {editable || editCovers(er, "page", p, "programmeId") ? (
              <select id={`pg-${p}`} value={r.pages[p]?.programmeId ?? ""} onChange={(e) => e.target.value && run(() => svc.setPageProgramme(r.id, +p, e.target.value))}>
                <option value="">Not set</option>
                {progs.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
            ) : <div>{state.md.programmes[r.pages[p]?.programmeId ?? ""]?.name ?? "Not set"}</div>}
          </Field>
        ))}
      </div>
    </div>
  );
}

function ConversionBadge({ l }: { l: RequisitionLine }) {
  if (!l.itemId) return <span className="muted small">Match the item</span>;
  if (l.conversionStatus === "resolved") return <span className="num">{fmtNum(l.baseQuantityRequested)} <span className="muted small">{l.baseUnit}</span></span>;
  if (l.conversionStatus === "incompatible") return <Pill tone="bad" title="Excluded from OFR, counted in coverage">Incompatible unit</Pill>;
  return <Pill tone="warn" title="Excluded from OFR until a conversion is approved; counted in coverage">Conversion unknown</Pill>;
}

function LineRow({ r, l, editable, onFocusPage }: { r: Requisition; l: RequisitionLine; editable: boolean; onFocusPage: (p: number) => void }) {
  const { state, svc, run, actor } = useApp();
  const md = state.md;
  const { items, progs } = useOptions();
  const er = activeEditPermission(r, actor.id, md.settings.editRequestPendingTimeoutDays);
  const can2 = (f: string) => editable || editCovers(er, "line", l.id, f);
  const [qty, setQty] = useState(l.quantityRequested?.toString() ?? "");
  const [unit, setUnit] = useState(l.unitRequested ?? "");
  const [text, setText] = useState(l.itemExtractedText ?? "");
  const [convOpen, setConvOpen] = useState(false);
  useEffect(() => setQty(l.quantityRequested?.toString() ?? ""), [l.quantityRequested]);
  useEffect(() => setUnit(l.unitRequested ?? ""), [l.unitRequested]);
  useEffect(() => setText(l.itemExtractedText ?? ""), [l.itemExtractedText]);
  const save = (patch: Partial<RequisitionLine>) => run(() => svc.upsertLine(r.id, l.id, patch));
  const item = l.itemId ? md.items[l.itemId] : undefined;
  const cands = (l.candidates ?? []).filter((c) => md.items[c.targetId] && c.targetId !== l.itemId).slice(0, 3);

  return (
    <tr className="line-row">
      <td className="mono small">
        <button className="btn ghost sm" title="Show this page" onClick={() => l.pageNumber && onFocusPage(l.pageNumber)}>{l.pageNumber ?? "–"}/{l.lineNumber}</button>
      </td>
      <td style={{ minWidth: 160 }}>
        {l.rawExtractedText && <div className="small">{l.rawExtractedText}</div>}
        {editable ? (
          <input id={`ln-text-${l.id}`} className="input sm" value={text} placeholder="Item as written" onChange={(e) => setText(e.target.value)} onBlur={() => text !== (l.itemExtractedText ?? "") && save({ itemExtractedText: text })} />
        ) : !l.rawExtractedText && <span className="small">{l.itemExtractedText}</span>}
        {(l.strength || l.form || l.packSize) && <div className="muted small">{[l.strength, l.form, l.packSize && `pack ${l.packSize}`].filter(Boolean).join(" · ")}</div>}
      </td>
      <td style={{ minWidth: 220 }}>
        {can2("itemId") ? <Picker id={`ln-item-${l.id}`} options={items} value={l.itemId} onChange={(id) => id && save({ itemId: id })} placeholder="Search items" /> : <div>{itemLabel(item)}</div>}
        {item && <div className="muted small">{item.code} · {METHOD_LABEL[l.matchMethod ?? "human"]}</div>}
        {can2("itemId") && cands.length > 0 && (
          <div className="cand" style={{ marginTop: 4 }}>
            {cands.map((c) => (
              <button key={c.targetId} className="btn ghost sm" onClick={() => save({ itemId: c.targetId })} title={`${METHOD_LABEL[c.method]}, score ${Math.round(c.score * 100)}%`}>
                Use {itemLabel(md.items[c.targetId])} <span className="muted">· {METHOD_LABEL[c.method]}</span>
              </button>
            ))}
          </div>
        )}
      </td>
      <td style={{ minWidth: 130 }}>
        {can2("programmeId") ? (
          <select id={`ln-prog-${l.id}`} className="input sm" value={l.programmeId ?? ""} onChange={(e) => save({ programmeId: e.target.value || undefined, programmeOverridden: true })}>
            <option value="">Choose…</option>
            {progs.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        ) : md.programmes[l.programmeId ?? ""]?.name ?? "—"}
      </td>
      <td className="num" style={{ minWidth: 80 }}>
        {can2("quantityRequested") ? (
          <input id={`ln-qty-${l.id}`} className="input sm num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} onBlur={() => qty !== (l.quantityRequested?.toString() ?? "") && save({ quantityRequested: qty === "" ? undefined : Number(qty.replace(/,/g, "")) })} />
        ) : fmtNum(l.quantityRequested)}
      </td>
      <td style={{ minWidth: 90 }}>
        {can2("unitRequested") ? (
          <input id={`ln-unit-${l.id}`} className="input sm" value={unit} placeholder="e.g. carton" onChange={(e) => setUnit(e.target.value)} onBlur={() => unit !== (l.unitRequested ?? "") && save({ unitRequested: unit })} />
        ) : l.unitRequested}
      </td>
      <td>
        <ConversionBadge l={l} />
        {l.itemId && l.conversionStatus === "unknown" && can(actor, "conversion.propose") && (
          <div><button className="btn ghost sm" onClick={() => setConvOpen(true)}>{actor.role === "admin" ? "Add conversion" : "Propose conversion"}</button></div>
        )}
        {convOpen && item && <ConversionModal itemId={item.id} unit={l.unitRequested ?? ""} onClose={() => setConvOpen(false)} />}
      </td>
      <td>{editable && <button className="btn ghost sm" aria-label="Remove line" onClick={() => run(() => svc.removeLine(r.id, l.id), "Line removed")}>Remove</button>}</td>
    </tr>
  );
}

export function ConversionModal({ itemId, unit, onClose }: { itemId: string; unit: string; onClose: () => void }) {
  const { state, svc, act, actor } = useApp();
  const item = state.md.items[itemId];
  const [from, setFrom] = useState(unit);
  const [factor, setFactor] = useState("");
  const [incompatible, setIncompatible] = useState(false);
  const [notes, setNotes] = useState("");
  const admin = actor.role === "admin";
  return (
    <Modal
      title={admin ? "Add a unit conversion" : "Propose a unit conversion"}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!from || (!incompatible && !(Number(factor) > 0))} onClick={async () => {
            if (await act(() => svc.proposeConversion({ itemId, fromUnit: from, factor: Number(factor), incompatible, notes }), admin ? "Conversion approved; lines updated" : "Proposal sent to Administrators")) onClose();
          }}>{admin ? "Approve conversion" : "Send proposal"}</button>
        </>
      }
    >
      <p className="small muted">
        For {itemLabel(item)} ({item.code}). Base unit: <b>{item.baseUnit}</b>. {admin ? "Approving recalculates base quantities on lines whose conversion was unknown." : "An Administrator approves it before it is used. Until then, the line stays out of OFR and counts in coverage."}
      </p>
      <div className="form-grid">
        <Field label="From unit"><input id="cv-from" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={`${item.baseUnit} per 1 ${from || "unit"}`}><input id="cv-factor" type="number" min={0} step="any" value={factor} disabled={incompatible} onChange={(e) => setFactor(e.target.value)} /></Field>
      </div>
      <label className="check small"><input id="cv-incompat" type="checkbox" checked={incompatible} onChange={(e) => setIncompatible(e.target.checked)} /> This unit can't be converted to {item.baseUnit} (mark incompatible)</label>
      <Field label="Notes"><textarea id="cv-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Source of the pack size, e.g. supplier pack label" /></Field>
    </Modal>
  );
}

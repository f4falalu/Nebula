import React, { useMemo, useState } from "react";
import { useApp } from "../ui/context";
import { Empty, OfrValue, Seg, Stat } from "../ui/kit";
import { useFilters } from "../ui/filters";
import { BarList, OfrCards, TrendChart } from "../ui/charts";
import { aggregate, collectLines, inScope } from "../domain/ofr";
import { filterReqs, groupLines, ofrTrend, processingTimes } from "../domain/metrics";
import { activeLines } from "../domain/records";
import { itemLabel } from "../domain/matching";
import { bucketLabel, type Bucket } from "../domain/time";
import { fmtNum, fmtPct } from "../domain/text";

export function ProgrammesPage(_p: { id?: string }) {
  const { state, actor } = useApp();
  const md = state.md;
  const rows = useMemo(() => {
    const lines = collectLines(Object.values(state.reqs), md, { scope: "official", basis: "received" });
    const by = groupLines(lines, (l) => l.line.programmeId);
    return Object.values(md.programmes)
      .map((p) => {
        const ls = by.get(p.id) ?? [];
        const all = Object.values(state.reqs).filter((r) => r.recordStatus !== "cancelled" && activeLines(r).some((l) => l.programmeId === p.id));
        return { p, reqs: all.length, agg: aggregate(ls) };
      })
      .sort((a, b) => a.p.name.localeCompare(b.p.name));
  }, [state.reqs, md]);
  return (
    <>
      <div className="page-head">
        <div><h1>Programmes</h1><p className="sub">Fulfillment by programme, using each requisition line's programme. OFR uses official requisitions only.</p></div>
        {actor.role === "admin" && <a className="btn" href="#admin">Manage programmes</a>}
      </div>
      {!rows.length ? (
        <div className="card"><Empty title="No programmes yet">{actor.role === "admin" ? <p>Add them in <a href="#admin">Administration → Setup</a>.</p> : <p>An Administrator adds programmes.</p>}</Empty></div>
      ) : (
        <section className="card flush">
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Programme</th><th className="num">Requisitions</th><th className="num">Requested (base)</th><th className="num">Invoice OFR</th><th className="num">Issued OFR</th><th className="num">Delivered OFR</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.p.id} className={`clickable ${r.p.status === "inactive" ? "dim" : ""}`} onClick={() => (location.hash = `programme-${r.p.id}`)}>
                    <td><a href={`#programme-${r.p.id}`}>{r.p.name}</a>{r.p.description && <div className="muted small">{r.p.description}</div>}</td>
                    <td className="num">{r.reqs}</td>
                    <td className="num">{fmtNum(r.agg.issued.requested)}</td>
                    {(["invoiced", "issued", "delivered"] as const).map((s) => (
                      <td key={s} className="num"><OfrValue v={r.agg[s].ofr} threshold={s === md.settings.ofrThresholdStage ? md.settings.ofrThresholdPercent : undefined} />{r.agg[s].requestedLines > 0 && <div className="coverage">cov. {fmtPct(r.agg[s].coverage, 0)}</div>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

export function ProgrammePage({ id }: { id?: string }) {
  const { state } = useApp();
  const md = state.md;
  const p = id ? md.programmes[id] : undefined;
  const fixed = useMemo(() => ({ programmeId: id }), [id]);
  const { filter, bar } = useFilters({ facility: true, fixed });
  const [bucket, setBucket] = useState<Bucket>("month");
  const reqs = useMemo(() => Object.values(state.reqs), [state.reqs]);
  const lines = useMemo(() => collectLines(reqs, md, filter), [reqs, md, filter]);
  const agg = useMemo(() => aggregate(lines), [lines]);
  const trend = useMemo(() => ofrTrend(lines, filter.basis, bucket).map((x) => ({ ...x, label: bucketLabel(x.key, bucket) })), [lines, filter.basis, bucket]);
  const containing = useMemo(() => filterReqs(reqs, filter).filter((r) => inScope(r, filter.scope) && activeLines(r).some((l) => l.programmeId === id)), [reqs, filter, id]);
  const pt = useMemo(() => processingTimes(containing), [containing]);
  const byFac = useMemo(() => [...groupLines(lines, (l) => l.req.facilityId)].map(([k, ls]) => ({ k, agg: aggregate(ls) })).sort((a, b) => b.agg.issued.requested - a.agg.issued.requested), [lines]);
  const byItem = useMemo(() => [...groupLines(lines, (l) => l.line.itemId)].map(([k, ls]) => ({ k, agg: aggregate(ls) })).sort((a, b) => b.agg.issued.requested - a.agg.issued.requested), [lines]);
  if (!p) return <div className="card"><Empty title="Programme not found"><p><a href="#programmes">See all programmes</a>.</p></Empty></div>;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow"><a href="#programmes">Programmes</a></div>
          <h1>{p.name}</h1>
          <p className="sub">{p.description || "Lines are counted by their own programme, so one requisition can contribute to several programmes."}</p>
        </div>
      </div>
      {bar}
      <section className="stats">
        <Stat label="Requisitions" value={fmtNum(containing.length)} foot="With at least one line in this programme" />
        <Stat label="Requested (base units)" value={fmtNum(agg.issued.requested)} />
        <Stat label="Invoiced / Issued / Delivered" value={<span style={{ fontSize: "1.1rem" }}>{fmtNum(agg.invoiced.credited)} / {fmtNum(agg.issued.credited)} / {fmtNum(agg.delivered.credited)}</span>} foot="Credited base units" />
        <Stat label="Req-to-Completion" value={pt.reqToCompletionDays.avg == null ? "—" : `${pt.reqToCompletionDays.avg.toFixed(1)} days`} foot={`Req-to-Entry ${pt.reqToEntryDays.avg == null ? "—" : pt.reqToEntryDays.avg.toFixed(1) + " days"}`} />
      </section>
      <OfrCards agg={agg} threshold={md.settings.ofrThresholdPercent} stage={md.settings.ofrThresholdStage} details />
      <section className="card stack">
        <div className="section-title"><h3>OFR trend</h3><Seg<Bucket> label="Trend interval" value={bucket} onChange={setBucket} options={[["week", "Week"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]]} /></div>
        <TrendChart points={trend} title={`${p.name} OFR trend`} />
      </section>
      <div className="grid2">
        <section className="card stack">
          <h3>Facilities</h3>
          <BarList rows={byFac.slice(0, 15).map((r) => ({ key: r.k, label: <a href={`#facility-${r.k}`}>{md.facilities[r.k]?.name ?? "Unknown"}</a>, value: r.agg.issued.ofr, note: `· ${fmtNum(r.agg.issued.requested)} req.` }))} format={(v) => fmtPct(v)} />
          <p className="small muted">Issued OFR by facility.</p>
        </section>
        <section className="card stack">
          <h3>Items</h3>
          <BarList rows={byItem.slice(0, 15).map((r) => ({ key: r.k, label: <a href={`#item-${r.k}`}>{itemLabel(md.items[r.k])}</a>, value: r.agg.issued.ofr, note: `· ${fmtNum(r.agg.issued.requested)} req.` }))} format={(v) => fmtPct(v)} />
          <p className="small muted">Issued OFR by item, most requested first.</p>
        </section>
      </div>
    </>
  );
}

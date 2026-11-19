import React, { useMemo, useState } from "react";
import { useApp } from "../ui/context";
import { Empty, Field, FulfillmentPill, OfrValue, Picker, RecordStatusPill, Seg, StagePill, Stat } from "../ui/kit";
import { useFilters } from "../ui/filters";
import { OfrCards, TrendChart, useSort } from "../ui/charts";
import { LifecyclePerformance } from "./Analytics";
import { additionalItems, aggregate, collectLines, inScope, requisitionAggregate } from "../domain/ofr";
import { filterReqs, frequency, lastFulfillment, ofrTrend, processingTimes } from "../domain/metrics";
import { currentStage } from "../domain/lifecycle";
import { activeLines, inOfficialScope } from "../domain/records";
import { itemLabel } from "../domain/matching";
import { bucketLabel, fmtDate, fmtDateTime, lagosDate, type Bucket } from "../domain/time";
import { fmtNum, fmtPct, normalize } from "../domain/text";

export function FacilitiesPage(_p: { id?: string }) {
  const { state, actor } = useApp();
  const md = state.md;
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const reqs = Object.values(state.reqs).filter((r) => r.recordStatus !== "cancelled");
    return Object.values(md.facilities).map((f) => {
      const rs = reqs.filter((r) => r.facilityId === f.id);
      const agg = aggregate(collectLines(rs, md, { scope: "official", basis: "received" }));
      return { f, n: rs.length, agg, last: rs.map((r) => r.receivedAt).sort().pop() };
    });
  }, [state.reqs, md]);
  const { th, sort } = useSort<"name" | "lga" | "n" | "ofr" | "last">("name", "asc");
  const n = normalize(q);
  const aliasHit = (id: string) => Object.values(md.aliases).some((a) => a.entityType === "facility" && a.entityId === id && a.status === "approved" && a.normalized.includes(n));
  const shown = sort(rows.filter((r) => !n || normalize(`${r.f.name} ${r.f.lga ?? ""} ${r.f.location ?? ""}`).includes(n) || aliasHit(r.f.id)),
    (r, k) => (k === "name" ? r.f.name : k === "lga" ? r.f.lga : k === "n" ? r.n : k === "ofr" ? r.agg.issued.ofr : r.last));
  return (
    <>
      <div className="page-head">
        <div><h1>Facilities</h1><p className="sub">Each facility's fulfillment rate and requisition history. Issued OFR uses official requisitions only.</p></div>
        {actor.role === "admin" && <a className="btn" href="#admin">Manage facilities</a>}
      </div>
      <div className="filters"><Field label="Search facilities"><input id="fac-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, alias, LGA" /></Field></div>
      {!rows.length ? (
        <div className="card"><Empty title="No facilities yet">{actor.role === "admin" ? <p>Add them in <a href="#admin">Administration</a>.</p> : <p>An Administrator adds facilities.</p>}</Empty></div>
      ) : (
        <section className="card flush">
          <div className="table-wrap">
            <table className="t">
              <thead><tr>{th("name", "Facility", false)}{th("lga", "LGA", false)}{th("n", "Requisitions")}{th("ofr", "Issued OFR")}{th("last", "Last requisition", false)}</tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.f.id} className={`clickable ${r.f.status === "inactive" ? "dim" : ""}`} onClick={() => (location.hash = `facility-${r.f.id}`)}>
                    <td><a href={`#facility-${r.f.id}`}>{r.f.name}</a>{r.f.status === "inactive" && <span className="muted small"> · inactive</span>}</td>
                    <td>{r.f.lga ?? "—"}</td>
                    <td className="num">{r.n}</td>
                    <td className="num"><OfrValue v={r.agg.issued.ofr} coverage={r.agg.issued.coverage} threshold={md.settings.ofrThresholdPercent} />{r.agg.issued.requestedLines > 0 && <div className="coverage">cov. {fmtPct(r.agg.issued.coverage, 0)}</div>}</td>
                    <td>{r.last ? fmtDate(lagosDate(r.last)) : "—"}</td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={5} className="muted">No facilities match.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

export function FacilityPage({ id }: { id?: string }) {
  const { state, actor } = useApp();
  const md = state.md;
  const f = id ? md.facilities[id] : undefined;
  const fixed = useMemo(() => ({ facilityId: id }), [id]);
  const { filter, bar } = useFilters({ programme: true, fixed });
  const [bucket, setBucket] = useState<Bucket>("month");
  const [itemId, setItemId] = useState<string>("");
  const all = useMemo(() => Object.values(state.reqs).filter((r) => r.facilityId === id), [state.reqs, id]);
  const scoped = useMemo(() => filterReqs(all, filter), [all, filter]);
  const lines = useMemo(() => collectLines(all, md, filter), [all, md, filter]);
  const agg = useMemo(() => aggregate(lines), [lines]);
  const pt = useMemo(() => processingTimes(scoped), [scoped]);
  const fr = useMemo(() => frequency(scoped, filter.from || filter.to ? { from: filter.from, to: filter.to } : undefined), [scoped, filter]);
  const trend = useMemo(() => ofrTrend(lines, filter.basis, bucket).map((p) => ({ ...p, label: bucketLabel(p.key, bucket) })), [lines, filter.basis, bucket]);
  const extras = useMemo(() => additionalItems(scoped), [scoped]);
  const itemTrend = useMemo(() => (itemId ? ofrTrend(lines.filter((l) => l.line.itemId === itemId), filter.basis, bucket) : []), [lines, itemId, filter.basis, bucket]);
  const itemOpts = useMemo(() => {
    const ids = new Set(all.flatMap((r) => activeLines(r).map((l) => l.itemId).filter(Boolean) as string[]));
    return [...ids].map((i) => ({ id: i, label: itemLabel(md.items[i]), sub: md.items[i]?.code })).sort((a, b) => a.label.localeCompare(b.label));
  }, [all, md]);

  if (!f) return <div className="card"><Empty title="Facility not found"><p>It may have been removed, or the link is wrong. <a href="#facilities">See all facilities</a>.</p></Empty></div>;
  const history = [...all].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const lastReq = all.map((r) => r.receivedAt).sort().pop();

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow"><a href="#facilities">Facilities</a></div>
          <h1>{f.name}</h1>
          <p className="sub">{[f.lga, f.location].filter(Boolean).join(" · ") || "No LGA recorded"}{f.status === "inactive" ? " · Inactive" : ""}</p>
        </div>
        {actor.role === "admin" && <a className="btn" href="#admin">Edit in Administration</a>}
      </div>
      {bar}
      <section className="stats">
        <Stat headline label="Issued OFR" value={<OfrValue v={agg.issued.ofr} threshold={md.settings.ofrThresholdPercent} />} foot={`Coverage ${fmtPct(agg.issued.coverage, 0)} of ${agg.issued.requestedLines} lines`} />
        <Stat label="Requisitions" value={fmtNum(scoped.length)} foot={`${all.length} in total, all statuses`} />
        <Stat label="Requested (base units)" value={fmtNum(agg.issued.requested)} foot={`${agg.issued.eligibleLines} eligible lines`} />
        <Stat label="Issued (credited)" value={fmtNum(agg.issued.credited)} foot={`Delivered ${fmtNum(agg.delivered.credited)}`} />
        <Stat label="Req-to-Completion" value={pt.reqToCompletionDays.avg == null ? "—" : `${pt.reqToCompletionDays.avg.toFixed(1)} days`} foot={`Req-to-Entry ${pt.reqToEntryDays.avg == null ? "—" : pt.reqToEntryDays.avg.toFixed(1) + " days"}`} />
        <Stat label="Frequency" value={fr.perMonth == null ? "—" : `${fr.perMonth.toFixed(1)}/mo`} foot={fr.avgDaysBetween == null ? "One requisition so far" : `Every ${fr.avgDaysBetween.toFixed(1)} days on average`} />
        <Stat label="Last requisition" value={<span style={{ fontSize: "1.1rem" }}>{lastReq ? fmtDate(lagosDate(lastReq)) : "—"}</span>} foot={`Last fulfillment ${fmtDate(lastFulfillment(all, "issued")?.slice(0, 10))} · delivery ${fmtDate(lastFulfillment(all, "delivered")?.slice(0, 10))}`} />
      </section>
      {pt.excludedEstimated > 0 && <p className="small muted">{pt.excludedEstimated} requisitions with an estimated requisition date are left out of requisition-date averages.</p>}

      <section className="stack">
        <h2>Fulfillment</h2>
        <OfrCards agg={agg} threshold={md.settings.ofrThresholdPercent} stage={md.settings.ofrThresholdStage} details />
      </section>

      <section className="card stack">
        <div className="section-title"><h3>OFR trend</h3><Seg<Bucket> label="Trend interval" value={bucket} onChange={setBucket} options={[["week", "Week"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]]} /></div>
        <TrendChart points={trend} title={`${f.name} OFR trend`} />
      </section>

      <section className="card stack">
        <div className="section-title"><h3>Item history at this facility</h3></div>
        <div style={{ maxWidth: 420 }}><Field label="Item"><Picker id="fac-item" options={itemOpts} value={itemId} onChange={setItemId} placeholder="Choose an item this facility requested" /></Field></div>
        {itemId && (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Period</th><th className="num">Requested</th><th className="num">Issued (credited)</th><th className="num">Issued OFR</th><th className="num">Coverage</th></tr></thead>
              <tbody>
                {itemTrend.map((p) => (
                  <tr key={p.key}><td>{bucketLabel(p.key, bucket)}</td><td className="num">{fmtNum(p.agg.issued.requested)}</td><td className="num">{fmtNum(p.agg.issued.credited)}</td><td className="num"><OfrValue v={p.agg.issued.ofr} threshold={md.settings.ofrThresholdPercent} /></td><td className="num">{fmtPct(p.agg.issued.coverage, 0)}</td></tr>
                ))}
                {!itemTrend.length && <tr><td colSpan={5} className="muted">No lines for this item in the current view.</td></tr>}
              </tbody>
            </table>
            <p className="small muted">Base units ({md.items[itemId]?.baseUnit}). Grouped by the selected trend interval.</p>
          </div>
        )}
      </section>

      <section className="card flush">
        <div className="card-head"><h3>Requisition history</h3><span className="small muted">All statuses. OFR in italics is provisional (not yet finalized with fulfillment closed).</span></div>
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Number</th><th>Req. date</th><th>Received</th><th>Entered</th><th>Programme</th><th>Status</th><th>Stage</th><th>Fulfillment</th><th className="num">Requested</th><th className="num">Issued</th><th className="num">Issued OFR</th></tr></thead>
            <tbody>
              {history.map((r) => {
                const a = requisitionAggregate(r, md);
                const official = inOfficialScope(r);
                return (
                  <tr key={r.id} className={`clickable ${r.recordStatus === "cancelled" ? "dim" : ""}`} onClick={() => (location.hash = `req-${r.id}`)}>
                    <td><a className="mono" href={`#req-${r.id}`}>{r.number}</a></td>
                    <td>{fmtDate(r.requisitionDate)}{r.requisitionDateEstimated && <span className="muted small"> est.</span>}</td>
                    <td>{fmtDateTime(r.receivedAt)}</td>
                    <td>{fmtDate(r.entryDate)}</td>
                    <td>{r.primaryProgrammeId ? md.programmes[r.primaryProgrammeId]?.name : "—"}</td>
                    <td><RecordStatusPill s={r.recordStatus} /></td>
                    <td><StagePill s={currentStage(r)} /></td>
                    <td><FulfillmentPill s={r.fulfillmentStatus} /></td>
                    <td className="num">{fmtNum(a.issued.requested)}</td>
                    <td className="num">{fmtNum(a.issued.credited)}</td>
                    <td className="num" style={{ fontStyle: official ? undefined : "italic" }}>{fmtPct(a.issued.ofr)}{a.issued.requestedLines > 0 && <div className="coverage">cov. {fmtPct(a.issued.coverage, 0)}</div>}</td>
                  </tr>
                );
              })}
              {!history.length && <tr><td colSpan={11} className="muted">No requisitions from this facility yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {extras.length > 0 && (
        <section className="card flush">
          <div className="card-head"><h3>Additional items supplied</h3><span className="small muted">Not requested, so not part of OFR</span></div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Requisition</th><th>Item</th><th>Stage</th><th className="num">Quantity</th></tr></thead>
              <tbody>{extras.map((x, i) => (
                <tr key={i}><td><a className="mono" href={`#req-${x.req.id}`}>{x.req.number}</a></td><td>{itemLabel(md.items[x.itemId])}</td><td>{x.stage}</td><td className="num">{fmtNum(x.quantity)} {x.unit}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      <section className="stack">
        <h2>Lifecycle performance</h2>
        <LifecyclePerformance reqs={scoped.filter((r) => inScope(r, filter.scope))} />
      </section>
    </>
  );
}

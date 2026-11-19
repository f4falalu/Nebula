import React, { useMemo, useState } from "react";
import { useApp } from "../ui/context";
import { Empty, OfrValue, Seg, Tabs } from "../ui/kit";
import { useFilters } from "../ui/filters";
import { BarList, Funnel, OfrCards, TrendChart, useSort } from "../ui/charts";
import { aggregate, collectLines, dropOff, variances, type LineMetrics } from "../domain/ofr";
import { bottlenecks, facilityRanking, filterReqs, frequency, groupLines, itemPerformance, ofrTrend, recordingLatency } from "../domain/metrics";
import { bucketLabel, fmtDate, fmtDuration, type Bucket } from "../domain/time";
import { fmtNum, fmtPct } from "../domain/text";
import { itemLabel } from "../domain/matching";
import type { MasterData, Requisition } from "../domain/types";

type Tab = "ofr" | "facilities" | "items" | "programmes" | "lifecycle" | "frequency";

export function AnalyticsPage(_p: { id?: string }) {
  const { state } = useApp();
  const { filter, bar } = useFilters({ facility: true, programme: true, item: true });
  const [tab, setTab] = useState<Tab>("ofr");
  const [bucket, setBucket] = useState<Bucket>("month");
  const reqs = useMemo(() => Object.values(state.reqs), [state.reqs]);
  const md = state.md;
  const lines = useMemo(() => collectLines(reqs, md, filter), [reqs, md, filter]);
  const scopedReqs = useMemo(() => filterReqs(reqs, filter), [reqs, filter]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p className="sub">Order Fulfillment Rate, drop-off, bottlenecks and frequency across facilities, items and programmes.</p>
        </div>
      </div>
      {bar}
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[["ofr", "Fulfillment"], ["facilities", "Facilities"], ["items", "Items"], ["programmes", "Programmes"], ["lifecycle", "Lifecycle"], ["frequency", "Frequency"]]}
      />
      {!reqs.length ? (
        <div className="card"><Empty title="No requisitions yet">Analytics fill in once requisitions are finalized and their fulfillment is closed.</Empty></div>
      ) : tab === "ofr" ? (
        <OfrSection lines={lines} bucket={bucket} setBucket={setBucket} basis={filter.basis} threshold={md.settings.ofrThresholdPercent} thresholdStage={md.settings.ofrThresholdStage} />
      ) : tab === "facilities" ? (
        <FacilityRanking reqs={reqs} md={md} filter={filter} bucket={bucket} />
      ) : tab === "items" ? (
        <ItemTable reqs={reqs} md={md} filter={filter} bucket={bucket} />
      ) : tab === "programmes" ? (
        <ProgrammeTable lines={lines} md={md} />
      ) : tab === "lifecycle" ? (
        <LifecyclePerformance reqs={scopedReqs} />
      ) : (
        <FrequencySection reqs={scopedReqs} md={md} range={{ from: filter.from, to: filter.to }} />
      )}
    </>
  );
}

export function OfrSection({ lines, bucket, setBucket, basis, threshold, thresholdStage }: {
  lines: LineMetrics[]; bucket: Bucket; setBucket: (b: Bucket) => void; basis: import("../domain/types").TimeBasis; threshold?: number; thresholdStage?: import("../domain/types").FulfillmentStage;
}) {
  const agg = useMemo(() => aggregate(lines), [lines]);
  const drop = useMemo(() => dropOff(lines), [lines]);
  const v = useMemo(() => variances(lines), [lines]);
  const trend = useMemo(() => ofrTrend(lines, basis, bucket).map((p) => ({ ...p, label: bucketLabel(p.key, bucket) })), [lines, basis, bucket]);
  if (!lines.length) return <div className="card"><Empty title="No requisition lines in this view">Change the period or scope. Official figures need requisitions that are finalized with fulfillment closed.</Empty></div>;
  return (
    <div className="stack">
      <OfrCards agg={agg} threshold={threshold} stage={thresholdStage} details />
      <div className="grid2">
        <section className="card stack">
          <div className="section-title"><h3>Where fulfillment drops</h3><span className="small muted">{drop.lines} lines eligible at all three stages</span></div>
          <Funnel rows={[
            { label: "Requested", value: drop.requested, pct: drop.requested ? 100 : null },
            { label: "Invoiced", value: drop.invoiced.credited, pct: drop.invoiced.pct },
            { label: "Issued", value: drop.issued.credited, pct: drop.issued.pct },
            { label: "Delivered", value: drop.delivered.credited, pct: drop.delivered.pct },
          ]} />
          <p className="small muted">Credited base units, capped per line.</p>
        </section>
        <section className="card stack">
          <h3>Fulfillment variance</h3>
          <div className="table-wrap">
            <table className="t">
              <tbody>
                <tr><td>Requested − Invoiced</td><td className="num">{fmtNum(v.requestedMinusInvoiced)}</td></tr>
                <tr><td>Requested − Issued</td><td className="num">{fmtNum(v.requestedMinusIssued)}</td></tr>
                <tr><td>Requested − Delivered</td><td className="num">{fmtNum(v.requestedMinusDelivered)}</td></tr>
                <tr><td>Invoiced − Issued</td><td className="num">{fmtNum(v.invoicedMinusIssued)}</td></tr>
                <tr><td>Issued − Delivered</td><td className="num">{fmtNum(v.issuedMinusDelivered)}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="small muted">Base units. Shortfalls use credited quantities. Stage-to-stage differences use uncapped quantities, so over-supply stays visible.</p>
        </section>
      </div>
      <section className="card stack">
        <div className="section-title">
          <h3>OFR trend</h3>
          <Seg<Bucket> label="Trend interval" value={bucket} onChange={setBucket} options={[["week", "Week"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]]} />
        </div>
        <TrendChart points={trend} />
      </section>
    </div>
  );
}

function FacilityRanking({ reqs, md, filter, bucket }: { reqs: Requisition[]; md: MasterData; filter: import("../domain/ofr").LineFilter; bucket: Bucket }) {
  const rows = useMemo(() => facilityRanking(reqs, md, filter, bucket), [reqs, md, filter, bucket]);
  const { th, sort } = useSort<"name" | "issued" | "delivered" | "sku" | "r2c" | "freq" | "short" | "reqs">("issued", "asc");
  const sorted = sort(rows, (r, k) =>
    k === "name" ? md.facilities[r.facilityId]?.name : k === "issued" ? r.agg.issued.ofr : k === "delivered" ? r.agg.delivered.ofr : k === "sku" ? r.agg.issued.skuRate
    : k === "r2c" ? r.reqToCompletionDays : k === "freq" ? r.perMonth : k === "short" ? r.shortfall : r.requisitions);
  if (!rows.length) return <div className="card"><Empty title="No facilities in this view" /></div>;
  return (
    <section className="card flush">
      <div className="card-head"><h3>Facility performance</h3><span className="small muted">Click a column to sort. Lowest Issued OFR first.</span></div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr>{th("name", "Facility", false)}{th("reqs", "Requisitions")}{th("issued", "Issued OFR")}{th("delivered", "Delivered OFR")}{th("sku", "Issued SKU")}{th("r2c", "Req-to-Completion")}{th("freq", "Per month")}{th("short", "Issued shortfall")}<th>Trend</th></tr></thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.facilityId} className="clickable" onClick={() => (location.hash = `facility-${r.facilityId}`)}>
                <td><a href={`#facility-${r.facilityId}`}>{md.facilities[r.facilityId]?.name ?? "Unknown facility"}</a></td>
                <td className="num">{r.requisitions}</td>
                <td className="num"><OfrValue v={r.agg.issued.ofr} coverage={r.agg.issued.coverage} threshold={md.settings.ofrThresholdPercent} /><div className="coverage">cov. {fmtPct(r.agg.issued.coverage, 0)}</div></td>
                <td className="num">{fmtPct(r.agg.delivered.ofr)}<div className="coverage">cov. {fmtPct(r.agg.delivered.coverage, 0)}</div></td>
                <td className="num">{fmtPct(r.agg.issued.skuRate)}</td>
                <td className="num">{r.reqToCompletionDays == null ? "—" : `${r.reqToCompletionDays.toFixed(1)} d`}</td>
                <td className="num">{r.perMonth == null ? "—" : r.perMonth.toFixed(1)}</td>
                <td className="num">{fmtNum(r.shortfall)}</td>
                <td>{r.declining ? <span className="pill bad">Declining</span> : <span className="muted small">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ItemTable({ reqs, md, filter, bucket }: { reqs: Requisition[]; md: MasterData; filter: import("../domain/ofr").LineFilter; bucket: Bucket }) {
  const rows = useMemo(() => itemPerformance(reqs, md, filter, bucket), [reqs, md, filter, bucket]);
  const [view, setView] = useState<"demand" | "low" | "subs" | "declining">("demand");
  const { th, sort } = useSort<"name" | "lines" | "requested" | "issued" | "subs">("requested");
  const shown = useMemo(() => {
    if (view === "low") return rows.filter((r) => r.agg.issued.ofr != null).sort((a, b) => (a.agg.issued.ofr as number) - (b.agg.issued.ofr as number));
    if (view === "subs") return rows.filter((r) => r.substitutedLines > 0).sort((a, b) => b.substitutedLines - a.substitutedLines);
    if (view === "declining") return rows.filter((r) => r.declining);
    return sort(rows, (r, k) => (k === "name" ? itemLabel(md.items[r.itemId]) : k === "lines" ? r.lines : k === "requested" ? r.agg.issued.requested : k === "issued" ? r.agg.issued.ofr : r.substitutedLines));
  }, [rows, view, sort, md]);
  if (!rows.length) return <div className="card"><Empty title="No items in this view" /></div>;
  return (
    <section className="card flush">
      <div className="card-head">
        <h3>Item performance</h3>
        <Seg label="Item view" value={view} onChange={setView} options={[["demand", "High demand"], ["low", "Low fulfillment"], ["subs", "Substituted"], ["declining", "Declining"]]} />
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr>{th("name", "Item", false)}{th("lines", "Lines")}{th("requested", "Requested (base)")}{th("issued", "Issued OFR")}<th className="num">Delivered OFR</th>{th("subs", "Substituted lines")}</tr></thead>
          <tbody>
            {shown.slice(0, 200).map((r) => (
              <tr key={r.itemId} className="clickable" onClick={() => (location.hash = `item-${r.itemId}`)}>
                <td><a href={`#item-${r.itemId}`}>{itemLabel(md.items[r.itemId])}</a> <span className="muted small">{md.items[r.itemId]?.code}</span></td>
                <td className="num">{r.lines}</td>
                <td className="num">{fmtNum(r.agg.issued.requested)} <span className="muted small">{md.items[r.itemId]?.baseUnit}</span></td>
                <td className="num"><OfrValue v={r.agg.issued.ofr} coverage={r.agg.issued.coverage} threshold={md.settings.ofrThresholdPercent} /><div className="coverage">cov. {fmtPct(r.agg.issued.coverage, 0)}</div></td>
                <td className="num">{fmtPct(r.agg.delivered.ofr)}</td>
                <td className="num">{r.substitutedLines}{r.uncreditedLines ? <span className="pill warn" style={{ marginLeft: 6 }}>{r.uncreditedLines} uncredited</span> : null}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={6} className="muted">No items match this view.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ProgrammeTable({ lines, md }: { lines: LineMetrics[]; md: MasterData }) {
  const rows = useMemo(() => [...groupLines(lines, (lm) => lm.line.programmeId)].map(([pid, ls]) => ({ pid, ls, agg: aggregate(ls), reqs: new Set(ls.map((l) => l.req.id)).size })), [lines]);
  if (!rows.length) return <div className="card"><Empty title="No programme data in this view" /></div>;
  return (
    <section className="card flush">
      <div className="card-head"><h3>Programme performance</h3><span className="small muted">Grouped by each line's programme</span></div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th>Programme</th><th className="num">Requisitions</th><th className="num">Requested (base)</th><th className="num">Invoice OFR</th><th className="num">Issued OFR</th><th className="num">Delivered OFR</th><th className="num">Over-fulfilled</th></tr></thead>
          <tbody>
            {rows.sort((a, b) => b.agg.issued.requested - a.agg.issued.requested).map((r) => (
              <tr key={r.pid} className="clickable" onClick={() => (location.hash = `programme-${r.pid}`)}>
                <td><a href={`#programme-${r.pid}`}>{md.programmes[r.pid]?.name ?? "Unknown"}</a></td>
                <td className="num">{r.reqs}</td>
                <td className="num">{fmtNum(r.agg.issued.requested)}</td>
                {(["invoiced", "issued", "delivered"] as const).map((s) => (
                  <td key={s} className="num">{fmtPct(r.agg[s].ofr)}<div className="coverage">cov. {fmtPct(r.agg[s].coverage, 0)}</div></td>
                ))}
                <td className="num">{fmtNum(r.agg.issued.over)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Bottlenecks (§22.3) and recording latency (§22.4) for a set of requisitions. */
export function LifecyclePerformance({ reqs }: { reqs: Requisition[] }) {
  const { nameOf } = useApp();
  const b = useMemo(() => bottlenecks(reqs), [reqs]);
  const lat = useMemo(() => recordingLatency(reqs), [reqs]);
  const excluded = b.reduce((s, r) => s + r.excludedOverride, 0);
  return (
    <div className="grid2">
      <section className="card stack">
        <h3>Time between stages</h3>
        <BarList
          rows={b.map((r) => ({ key: r.to, label: r.label, value: r.avgHours, note: r.count ? `(${r.count})` : undefined }))}
          format={(v) => fmtDuration(v)}
        />
        <p className="small muted">
          Average from the most recent earlier completed stage. Not Applicable stages have no interval of their own.
          {excluded ? ` ${excluded} intervals with a chronology override are left out.` : ""}
        </p>
      </section>
      <section className="card stack">
        <h3>Recording latency</h3>
        <p className="small muted">Time from when an event happened to when it was recorded in Nebula.</p>
        <BarList rows={lat.byStage.map((r) => ({ key: r.key, label: r.label, value: r.avgHours, note: `(${r.count})` }))} format={fmtDuration} empty="No lifecycle events or fulfillment recorded yet." />
        {lat.byUser.length > 0 && (
          <>
            <h3>By person</h3>
            <BarList rows={lat.byUser.map((r) => ({ key: r.key, label: nameOf(r.key), value: r.avgHours, note: `(${r.count})` }))} format={fmtDuration} />
          </>
        )}
      </section>
    </div>
  );
}

function FrequencySection({ reqs, md, range }: { reqs: Requisition[]; md: MasterData; range: { from?: string; to?: string } }) {
  const rows = useMemo(() => {
    const by = new Map<string, Requisition[]>();
    for (const r of reqs) if (r.facilityId) (by.get(r.facilityId) ?? by.set(r.facilityId, []).get(r.facilityId)!).push(r);
    return [...by].map(([fid, rs]) => ({ fid, f: frequency(rs, range.from || range.to ? range : undefined), last: rs.map((r) => r.receivedAt).sort().pop() }));
  }, [reqs, range]);
  const items = useMemo(() => {
    const by = new Map<string, Set<string>>();
    for (const r of reqs) for (const l of Object.values(r.lines)) if (l?.itemId) (by.get(l.itemId) ?? by.set(l.itemId, new Set()).get(l.itemId)!).add(r.id);
    const months = frequency(reqs, range.from || range.to ? range : undefined).months || 1;
    return [...by].map(([iid, s]) => ({ iid, n: s.size, perMonth: s.size / months })).sort((a, b) => b.n - a.n).slice(0, 15);
  }, [reqs, range]);
  const { th, sort } = useSort<"name" | "n" | "pm" | "gap">("pm");
  const avgPm = rows.length ? rows.reduce((s, r) => s + (r.f.perMonth ?? 0), 0) / rows.length : 0;
  if (!rows.length) return <div className="card"><Empty title="No requisitions in this view" /></div>;
  return (
    <div className="grid2">
      <section className="card flush">
        <div className="card-head"><h3>Requisitions per facility</h3><span className="small muted">Average {avgPm.toFixed(1)} per month</span></div>
        <div className="table-wrap">
          <table className="t">
            <thead><tr>{th("name", "Facility", false)}{th("n", "Requisitions")}{th("pm", "Per month")}{th("gap", "Avg days between")}<th>Last received</th></tr></thead>
            <tbody>
              {sort(rows, (r, k) => (k === "name" ? md.facilities[r.fid]?.name : k === "n" ? r.f.requisitions : k === "pm" ? r.f.perMonth : r.f.avgDaysBetween)).map((r) => (
                <tr key={r.fid}>
                  <td><a href={`#facility-${r.fid}`}>{md.facilities[r.fid]?.name ?? "Unknown"}</a> {r.f.perMonth != null && r.f.perMonth > avgPm * 2 && rows.length > 2 && <span className="pill warn">High</span>}</td>
                  <td className="num">{r.f.requisitions}</td>
                  <td className="num">{r.f.perMonth?.toFixed(1) ?? "—"}</td>
                  <td className="num">{r.f.avgDaysBetween?.toFixed(1) ?? "—"}</td>
                  <td>{fmtDate(r.last?.slice(0, 10))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card stack">
        <h3>Most requested items</h3>
        <BarList rows={items.map((r) => ({ key: r.iid, label: <a href={`#item-${r.iid}`}>{itemLabel(md.items[r.iid])}</a>, value: r.n, note: `· ${r.perMonth.toFixed(1)}/mo` }))} format={(v) => `${fmtNum(v)} req.`} />
        <p className="small muted">Number of requisitions containing the item.</p>
      </section>
    </div>
  );
}

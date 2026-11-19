import React, { useMemo, useState } from "react";
import { useApp } from "../ui/context";
import { Empty, Field, OfrValue, Seg, Stat } from "../ui/kit";
import { useFilters } from "../ui/filters";
import { BarList, OfrCards, TrendChart, useSort } from "../ui/charts";
import { additionalItems, aggregate, collectLines, inScope } from "../domain/ofr";
import { filterReqs, groupLines, ofrTrend, substitutions } from "../domain/metrics";
import { itemLabel } from "../domain/matching";
import { bucketLabel, type Bucket } from "../domain/time";
import { fmtNum, fmtPct, normalize } from "../domain/text";

export function ItemsPage(_p: { id?: string }) {
  const { state, actor } = useApp();
  const md = state.md;
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const lines = collectLines(Object.values(state.reqs), md, { scope: "official", basis: "received" });
    const by = groupLines(lines, (l) => l.line.itemId);
    const count = new Map<string, number>();
    for (const r of Object.values(state.reqs)) if (r.recordStatus !== "cancelled") for (const l of Object.values(r.lines)) if (l?.itemId) count.set(l.itemId, (count.get(l.itemId) ?? 0) + 1);
    return Object.values(md.items).map((i) => ({ i, lines: count.get(i.id) ?? 0, agg: by.has(i.id) ? aggregate(by.get(i.id)!) : null }));
  }, [state.reqs, md]);
  const { th, sort } = useSort<"name" | "code" | "lines" | "ofr">("name", "asc");
  const n = normalize(q);
  const aliasHit = (id: string) => Object.values(md.aliases).some((a) => a.entityType === "item" && a.entityId === id && a.status === "approved" && a.normalized.includes(n));
  const shown = sort(rows.filter((r) => !n || normalize(`${r.i.name} ${r.i.genericName ?? ""} ${r.i.code} ${r.i.strength ?? ""} ${r.i.form ?? ""}`).includes(n) || aliasHit(r.i.id)),
    (r, k) => (k === "name" ? itemLabel(r.i) : k === "code" ? r.i.code : k === "lines" ? r.lines : r.agg?.issued.ofr));
  return (
    <>
      <div className="page-head">
        <div><h1>Items</h1><p className="sub">Demand and fulfillment per item. Issued OFR uses official requisitions only.</p></div>
        {actor.role === "admin" && <a className="btn" href="#admin">Manage items</a>}
      </div>
      <div className="filters"><Field label="Search items"><input id="item-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, generic name, code, alias" /></Field></div>
      {!rows.length ? (
        <div className="card"><Empty title="No items yet">{actor.role === "admin" ? <p>Load the starter list or import items in <a href="#admin">Administration</a>.</p> : <p>An Administrator adds items.</p>}</Empty></div>
      ) : (
        <section className="card flush">
          <div className="table-wrap">
            <table className="t">
              <thead><tr>{th("name", "Item", false)}{th("code", "Code", false)}<th>Base unit</th>{th("lines", "Requested lines")}{th("ofr", "Issued OFR")}</tr></thead>
              <tbody>
                {shown.slice(0, 500).map((r) => (
                  <tr key={r.i.id} className={`clickable ${r.i.status === "inactive" ? "dim" : ""}`} onClick={() => (location.hash = `item-${r.i.id}`)}>
                    <td><a href={`#item-${r.i.id}`}>{itemLabel(r.i)}</a>{r.i.genericName && <div className="muted small">{r.i.genericName}</div>}</td>
                    <td className="mono">{r.i.code}</td>
                    <td>{r.i.baseUnit}</td>
                    <td className="num">{r.lines}</td>
                    <td className="num">{r.agg ? <><OfrValue v={r.agg.issued.ofr} threshold={md.settings.ofrThresholdPercent} /><div className="coverage">cov. {fmtPct(r.agg.issued.coverage, 0)}</div></> : "—"}</td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={5} className="muted">No items match.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

export function ItemPage({ id }: { id?: string }) {
  const { state, actor } = useApp();
  const md = state.md;
  const item = id ? md.items[id] : undefined;
  const fixed = useMemo(() => ({ itemId: id }), [id]);
  const { filter, bar } = useFilters({ facility: true, programme: true, fixed });
  const [bucket, setBucket] = useState<Bucket>("month");
  const reqs = useMemo(() => Object.values(state.reqs), [state.reqs]);
  const lines = useMemo(() => collectLines(reqs, md, filter), [reqs, md, filter]);
  const agg = useMemo(() => aggregate(lines), [lines]);
  const trend = useMemo(() => ofrTrend(lines, filter.basis, bucket).map((p) => ({ ...p, label: bucketLabel(p.key, bucket) })), [lines, filter.basis, bucket]);
  const byFac = useMemo(() => [...groupLines(lines, (l) => l.req.facilityId)].map(([k, ls]) => ({ k, agg: aggregate(ls), n: new Set(ls.map((l) => l.req.id)).size })).sort((a, b) => b.agg.issued.requested - a.agg.issued.requested), [lines]);
  const byProg = useMemo(() => [...groupLines(lines, (l) => l.line.programmeId)].map(([k, ls]) => ({ k, agg: aggregate(ls) })).sort((a, b) => b.agg.issued.requested - a.agg.issued.requested), [lines]);
  const scopedReqs = useMemo(() => filterReqs(reqs, { ...filter, facilityId: filter.facilityId }).filter((r) => inScope(r, filter.scope)), [reqs, filter]);
  const subs = useMemo(() => substitutions(scopedReqs, md), [scopedReqs, md]);
  const subbedBy = subs.filter((s) => s.requestedItemId === id);
  const subFor = subs.filter((s) => s.suppliedItemId === id);
  const extras = useMemo(() => additionalItems(scopedReqs).filter((x) => x.itemId === id), [scopedReqs, id]);
  if (!item) return <div className="card"><Empty title="Item not found"><p>It may have been removed, or the link is wrong. <a href="#items">See all items</a>.</p></Empty></div>;
  const reqCount = new Set(lines.map((l) => l.req.id)).size;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow"><a href="#items">Items</a></div>
          <h1>{itemLabel(item)}</h1>
          <p className="sub"><span className="mono">{item.code}</span>{item.genericName ? ` · ${item.genericName}` : ""}{item.packSize ? ` · pack ${item.packSize}` : ""} · base unit {item.baseUnit}{item.status === "inactive" ? " · Inactive" : ""}</p>
        </div>
        {actor.role === "admin" && <a className="btn" href="#admin">Edit in Administration</a>}
      </div>
      {bar}
      <section className="stats">
        <Stat label="Requisitions with this item" value={fmtNum(reqCount)} foot={`${lines.length} requested lines`} />
        <Stat label={`Requested (${item.baseUnit})`} value={fmtNum(agg.issued.requested)} foot="Eligible lines" />
        <Stat label="Invoiced (credited)" value={fmtNum(agg.invoiced.credited)} />
        <Stat label="Issued (credited)" value={fmtNum(agg.issued.credited)} />
        <Stat label="Delivered (credited)" value={fmtNum(agg.delivered.credited)} />
      </section>
      <OfrCards agg={agg} threshold={md.settings.ofrThresholdPercent} stage={md.settings.ofrThresholdStage} details />
      <section className="card stack">
        <div className="section-title"><h3>OFR trend</h3><Seg<Bucket> label="Trend interval" value={bucket} onChange={setBucket} options={[["week", "Week"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]]} /></div>
        <TrendChart points={trend} title={`${itemLabel(item)} OFR trend`} />
      </section>
      <div className="grid2">
        <section className="card stack">
          <h3>Facility distribution</h3>
          <BarList rows={byFac.slice(0, 15).map((r) => ({ key: r.k, label: <a href={`#facility-${r.k}`}>{md.facilities[r.k]?.name ?? "Unknown"}</a>, value: r.agg.issued.requested, note: `· ${fmtPct(r.agg.issued.ofr)} issued` }))} format={(v) => fmtNum(v)} />
          <p className="small muted">Requested base units by facility, with Issued OFR.</p>
        </section>
        <section className="card stack">
          <h3>Programme distribution</h3>
          <BarList rows={byProg.map((r) => ({ key: r.k, label: md.programmes[r.k]?.name ?? "Unknown", value: r.agg.issued.requested, note: `· ${fmtPct(r.agg.issued.ofr)} issued` }))} format={(v) => fmtNum(v)} />
          <p className="small muted">By each line's programme.</p>
        </section>
      </div>
      <section className="card flush">
        <div className="card-head"><h3>Substitution history</h3><span className="small muted">A substitute counts toward OFR only with an approved equivalence rule</span></div>
        <div className="card-body stack">
          <h4>Other items supplied instead of this one ({subbedBy.length})</h4>
          <SubTable rows={subbedBy} other={(s) => s.suppliedItemId} />
          <h4>This item supplied instead of another ({subFor.length})</h4>
          <SubTable rows={subFor} other={(s) => s.requestedItemId} />
        </div>
      </section>
      {extras.length > 0 && (
        <section className="card flush">
          <div className="card-head"><h3>Supplied as an additional item</h3><span className="small muted">Not requested, so not part of OFR</span></div>
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Requisition</th><th>Stage</th><th className="num">Quantity</th><th className="num">Base</th></tr></thead>
            <tbody>{extras.map((x, i) => <tr key={i}><td><a className="mono" href={`#req-${x.req.id}`}>{x.req.number}</a></td><td>{x.stage}</td><td className="num">{fmtNum(x.quantity)} {x.unit}</td><td className="num">{fmtNum(x.baseQuantity)} {x.baseUnit}</td></tr>)}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}

function SubTable({ rows, other }: { rows: ReturnType<typeof substitutions>; other: (s: ReturnType<typeof substitutions>[number]) => string }) {
  const { state } = useApp();
  if (!rows.length) return <p className="small muted">None in this view.</p>;
  return (
    <div className="table-wrap">
      <table className="t">
        <thead><tr><th>Requisition</th><th>Item</th><th>Stage</th><th className="num">Quantity</th><th>Counted in OFR</th></tr></thead>
        <tbody>
          {rows.map((s, i) => (
            <tr key={i}>
              <td><a className="mono" href={`#req-${s.req.id}`}>{s.req.number}</a></td>
              <td><a href={`#item-${other(s)}`}>{itemLabel(state.md.items[other(s)])}</a></td>
              <td>{s.stage}</td>
              <td className="num">{fmtNum(s.quantity)} {s.unit}</td>
              <td>{s.credited ? <span className="pill good">Credited</span> : <span className="pill warn">Uncredited</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

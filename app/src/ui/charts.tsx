import React, { useEffect, useMemo, useRef, useState } from "react";
import { fmtNum, fmtPct } from "../domain/text";
import { FULFILLMENT_STAGES, type FulfillmentStage } from "../domain/types";
import { EXCLUSION_LABEL, type Aggregate, type ExclusionReason, type StageAggregate } from "../domain/ofr";

export const STAGE_NAME: Record<FulfillmentStage, string> = { invoiced: "Invoiced", issued: "Issued", delivered: "Delivered" };
export const STAGE_OFR_NAME: Record<FulfillmentStage, string> = { invoiced: "Invoice OFR", issued: "Issued OFR", delivered: "Delivered OFR" };
const SERIES_VAR: Record<FulfillmentStage, string> = { invoiced: "var(--viz-s1)", issued: "var(--viz-s2)", delivered: "var(--viz-s3)" };

export function SeriesSwatch({ stage }: { stage: FulfillmentStage }) {
  return <span className="viz-swatch" style={{ background: SERIES_VAR[stage] }} aria-hidden="true" />;
}

/** "Coverage 92% · 3 lines excluded" note shown under every OFR. */
export function Coverage({ a }: { a: StageAggregate }) {
  const excluded = a.requestedLines - a.eligibleLines;
  return (
    <span className="coverage">
      Coverage {fmtPct(a.coverage, 0)} of {fmtNum(a.requestedLines)} lines{excluded ? ` · ${excluded} excluded` : ""}
    </span>
  );
}

export function ExclusionList({ a }: { a: StageAggregate }) {
  const rows = (Object.keys(a.exclusions) as ExclusionReason[]).filter((k) => a.exclusions[k] > 0);
  if (!rows.length && !a.uncreditedSubstitutionLines) return <p className="small muted">No lines excluded.</p>;
  return (
    <ul className="viz-excl">
      {rows.map((k) => <li key={k}><span>{EXCLUSION_LABEL[k]}</span><b className="num">{a.exclusions[k]}</b></li>)}
      {a.uncreditedSubstitutionLines > 0 && (
        <li><span>Eligible, with an uncredited substitution</span><b className="num">{a.uncreditedSubstitutionLines}</b></li>
      )}
    </ul>
  );
}

/** Line chart of OFR % per bucket for the three stages. Crosshair tooltip + table view. */
export function TrendChart({ points, title = "OFR trend" }: { points: Array<{ key: string; label: string; agg: Aggregate }>; title?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [table]);
  const H = 220, L = 40, R = 24, T = 12, B = 28;
  const n = points.length;
  const x = (i: number) => (n <= 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (n - 1));
  const y = (v: number) => T + ((100 - v) * (H - T - B)) / 100;
  const paths = useMemo(() => {
    const out: Record<FulfillmentStage, string> = { invoiced: "", issued: "", delivered: "" };
    for (const s of FULFILLMENT_STAGES) {
      let d = "";
      let pen = false;
      points.forEach((p, i) => {
        const v = p.agg[s].ofr;
        if (v == null) { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      out[s] = d;
    }
    return out;
  }, [points, W]);
  if (!n) return <p className="small muted">No data in this period.</p>;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 90))));
  const hp = hover != null ? points[hover] : null;
  return (
    <div className="viz">
      <div className="row between">
        <div className="viz-legend" aria-label="Legend">
          {FULFILLMENT_STAGES.map((s) => <span key={s}><SeriesSwatch stage={s} /> {STAGE_OFR_NAME[s]}</span>)}
        </div>
        <button className="btn ghost sm" onClick={() => setTable((t) => !t)}>{table ? "Show chart" : "Show table"}</button>
      </div>
      {table ? (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Period</th>{FULFILLMENT_STAGES.map((s) => <th key={s} className="num">{STAGE_OFR_NAME[s]}</th>)}<th className="num">Issued coverage</th></tr></thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.key}><td>{p.label}</td>{FULFILLMENT_STAGES.map((s) => <td key={s} className="num">{fmtPct(p.agg[s].ofr)}</td>)}<td className="num">{fmtPct(p.agg.issued.coverage, 0)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="viz-plot" ref={box} onPointerLeave={() => setHover(null)}>
          <svg className="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: OFR percentage by period for invoice, issued and delivered`}
            onPointerMove={(e) => {
              const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              const px = ((e.clientX - rect.left) / rect.width) * W;
              let best = 0;
              for (let i = 1; i < n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
              setHover(best);
            }}>
            {[0, 25, 50, 75, 100].map((v) => (
              <g key={v}>
                <line className="grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
                <text x={L - 6} y={y(v) + 4} textAnchor="end">{v}%</text>
              </g>
            ))}
            {points.map((p, i) => (i % labelEvery === 0 || i === n - 1 ? <text key={p.key} x={x(i)} y={H - 8} textAnchor={n > 1 && i === n - 1 ? "end" : n > 1 && i === 0 ? "start" : "middle"}>{p.label}</text> : null))}
            {hover != null && <line className="viz-cross" x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} />}
            {FULFILLMENT_STAGES.map((s) => (
              <path key={s} d={paths[s]} fill="none" stroke={SERIES_VAR[s]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {FULFILLMENT_STAGES.map((s) =>
              points.map((p, i) => {
                const v = p.agg[s].ofr;
                if (v == null || (i !== n - 1 && i !== hover && n > 1)) return null;
                return <circle key={s + p.key} cx={x(i)} cy={y(v)} r={4} fill={SERIES_VAR[s]} stroke="var(--surface)" strokeWidth={2} />;
              }),
            )}
          </svg>
          {hp && (
            <div className="viz-tip" style={{ left: Math.min(Math.max(x(hover!), 90), W - 90) }}>
              <b>{hp.label}</b>
              {FULFILLMENT_STAGES.map((s) => (
                <div key={s}><SeriesSwatch stage={s} /> {STAGE_OFR_NAME[s]} <span className="num">{fmtPct(hp.agg[s].ofr)}</span></div>
              ))}
              <div className="muted">Issued coverage {fmtPct(hp.agg.issued.coverage, 0)}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Requested → Invoiced → Issued → Delivered as horizontal bars of credited quantity. */
export function Funnel({ rows }: { rows: Array<{ label: string; value: number; pct: number | null }> }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="funnel">
      {rows.map((r) => (
        <div className="funnel-row" key={r.label} title={`${r.label}: ${fmtNum(r.value)} base units (${fmtPct(r.pct)})`}>
          <span className="small">{r.label}</span>
          <div className="bar-track viz-track"><div className="bar-fill viz-fill" style={{ width: `${(r.value / max) * 100}%` }} /></div>
          <span className="num small"><b>{fmtNum(r.value)}</b> · {fmtPct(r.pct)}</span>
        </div>
      ))}
    </div>
  );
}

/** Horizontal bars for one measure per row (durations, counts). */
export function BarList({ rows, format, empty = "No data in this period." }: {
  rows: Array<{ key: string; label: React.ReactNode; value: number | null; note?: React.ReactNode }>; format: (v: number | null) => string; empty?: string;
}) {
  const vals = rows.map((r) => r.value ?? 0);
  const max = Math.max(0, ...vals);
  if (!rows.length) return <p className="small muted">{empty}</p>;
  return (
    <div className="barlist">
      {rows.map((r) => (
        <div className="barlist-row" key={r.key}>
          <span className="small barlist-label">{r.label}</span>
          <div className="bar-track viz-track">{r.value != null && max > 0 && <div className="bar-fill viz-fill" style={{ width: `${(r.value / max) * 100}%` }} />}</div>
          <span className="num small">{format(r.value)}{r.note && <span className="muted"> {r.note}</span>}</span>
        </div>
      ))}
    </div>
  );
}

/** Stage-by-stage mini bars for an aggregate (used on detail pages). */
export function StageBars({ agg }: { agg: Aggregate }) {
  return (
    <div className="stage-bars">
      {FULFILLMENT_STAGES.map((s) => (
        <div key={s} className="barlist-row">
          <span className="small barlist-label"><SeriesSwatch stage={s} /> {STAGE_OFR_NAME[s]}</span>
          <div className="bar-track viz-track"><div className="bar-fill" style={{ width: `${agg[s].ofr ?? 0}%`, background: SERIES_VAR[s] }} /></div>
          <span className="num small"><b>{fmtPct(agg[s].ofr)}</b> <span className="muted">cov. {fmtPct(agg[s].coverage, 0)}</span></span>
        </div>
      ))}
    </div>
  );
}

/** Three stage OFR cards with coverage, SKU rate and (optionally) the exclusion breakdown. */
export function OfrCards({ agg, threshold, stage, details }: { agg: Aggregate; threshold?: number; stage?: FulfillmentStage; details?: boolean }) {
  return (
    <div className="grid3">
      {(["issued", "invoiced", "delivered"] as const).map((s) => (
        <div key={s} className={`card ofr-card ${s === "issued" ? "headline" : ""}`}>
          <div className="eyebrow"><SeriesSwatch stage={s} /> {STAGE_OFR_NAME[s]}</div>
          <div className="big"><OfrPct v={agg[s].ofr} low={threshold != null && stage === s && agg[s].ofr != null && (agg[s].ofr as number) < threshold} /></div>
          <Coverage a={agg[s]} />
          <span className="small muted">
            {fmtNum(agg[s].credited)} of {fmtNum(agg[s].requested)} base units · SKU rate {fmtPct(agg[s].skuRate)} ({agg[s].fullLines} full, {agg[s].partialLines} partial, {agg[s].noneLines} none)
          </span>
          {agg[s].over > 0 && <span className="small muted">Over-fulfilled: {fmtNum(agg[s].over)} base units on {agg[s].overLines} lines (not counted)</span>}
          {details && <ExclusionList a={agg[s]} />}
        </div>
      ))}
    </div>
  );
}

function OfrPct({ v, low }: { v: number | null; low: boolean }) {
  return <span style={{ color: low ? "var(--bad)" : undefined }}>{fmtPct(v)}</span>;
}

/** Sort state for tables: click a header to sort; click again to flip. */
export function useSort<K extends string>(initial: K, initialDir: "asc" | "desc" = "desc") {
  const [key, setKey] = useState<K>(initial);
  const [dir, setDir] = useState<"asc" | "desc">(initialDir);
  const th = (k: K, label: React.ReactNode, num = true) => (
    <th className={`sortable ${num ? "num" : ""}`} onClick={() => (k === key ? setDir(dir === "asc" ? "desc" : "asc") : (setKey(k), setDir("desc")))}
      aria-sort={k === key ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      {label}{k === key ? (dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
  const sort = <T,>(rows: T[], get: (r: T, k: K) => number | string | null | undefined) =>
    [...rows].sort((a, b) => {
      const va = get(a, key), vb = get(b, key);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return dir === "asc" ? c : -c;
    });
  return { th, sort };
}

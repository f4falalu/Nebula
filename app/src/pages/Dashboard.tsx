import React, { useMemo } from "react";
import { useApp } from "../ui/context";
import { Empty, OfrValue, Stat } from "../ui/kit";
import { useFilters } from "../ui/filters";
import { Coverage, SeriesSwatch, STAGE_OFR_NAME } from "../ui/charts";
import { aggregate, basisDate, collectLines, inRange, requisitionAggregate } from "../domain/ofr";
import { currentStage, STAGE_LABEL } from "../domain/lifecycle";
import { FULFILLMENT_STATUS_LABEL, RECORD_STATUS_LABEL, inOfficialScope } from "../domain/records";
import { processingTimes } from "../domain/metrics";
import { LIFECYCLE_STAGES, type FulfillmentStatus, type RecordStatus, type Requisition } from "../domain/types";
import { fmtNum, fmtPct } from "../domain/text";
import { fmtDuration, lagosDate } from "../domain/time";

const RS: RecordStatus[] = ["draft", "processing", "validation_pending", "validated", "finalized", "reopened", "cancelled"];
const FS: FulfillmentStatus[] = ["open", "partial", "closed"];

export function DashboardPage(_p: { id?: string }) {
  const { state, actor } = useApp();
  const { filter, bar } = useFilters({ defaultPeriod: "month", facility: true, programme: true });
  const md = state.md;
  const all = useMemo(() => Object.values(state.reqs), [state.reqs]);

  const d = useMemo(() => {
    const fac = (r: Requisition) => !filter.facilityId || r.facilityId === filter.facilityId;
    const recv = all.filter((r) => fac(r) && inRange(lagosDate(r.receivedAt), filter.from, filter.to));
    const entered = all.filter((r) => fac(r) && inRange(r.entryDate, filter.from, filter.to));
    // Status counts use the period on the selected time basis.
    const inPeriod = all.filter((r) => fac(r) && inRange(basisDate(r, filter.basis), filter.from, filter.to));
    const byStatus = Object.fromEntries(RS.map((s) => [s, 0])) as Record<RecordStatus, number>;
    const byStage = Object.fromEntries(LIFECYCLE_STAGES.map((s) => [s, 0])) as Record<string, number>;
    const byFul = Object.fromEntries(FS.map((s) => [s, 0])) as Record<FulfillmentStatus, number>;
    for (const r of inPeriod) {
      byStatus[r.recordStatus]++;
      if (r.recordStatus !== "cancelled") {
        byStage[currentStage(r)]++;
        byFul[r.fulfillmentStatus]++;
      }
    }
    const entryBacklog = byStatus.draft + byStatus.processing + byStatus.validation_pending + byStatus.validated;
    const fulBacklog = inPeriod.filter((r) => r.recordStatus === "finalized" && r.fulfillmentStatus !== "closed");
    const lines = collectLines(all, md, filter);
    const agg = aggregate(lines);
    const scoped = inPeriod.filter((r) => r.recordStatus !== "cancelled" && (filter.scope === "official" ? inOfficialScope(r) : r.recordStatus === "finalized"));
    const pt = processingTimes(scoped);
    const th = md.settings.ofrThresholdPercent;
    const ts = md.settings.ofrThresholdStage;
    const low = inPeriod
      .filter(inOfficialScope)
      .map((r) => ({ r, v: requisitionAggregate(r, md)[ts].ofr }))
      .filter((x) => x.v != null && x.v < th)
      .sort((a, b) => (a.v as number) - (b.v as number));
    const pending = inPeriod.filter((r) => r.recordStatus === "validation_pending" || r.recordStatus === "reopened").sort((a, b) => a.entryAt.localeCompare(b.entryAt));
    return { recv, entered, byStatus, byStage, byFul, entryBacklog, fulBacklog, agg, pt, low, pending, th, ts };
  }, [all, md, filter]);

  if (!all.length) {
    return (
      <>
        <Head />
        <div className="card">
          <Empty title="No requisitions yet">
            <p>
              Requisitions you register appear here with their status, lifecycle stage and fulfillment rate.
              {actor.role !== "supervisor" ? " Use New requisition at the top to upload the first one." : " Requisition Assistants add them; check back once they have."}
            </p>
            {actor.role === "admin" && !Object.keys(md.items).length && (
              <p>Before that, load facilities, items and programmes in <a href="#admin">Administration → Setup</a>, so requisition lines can be matched.</p>
            )}
          </Empty>
        </div>
      </>
    );
  }

  const fac = filter.facilityId ? md.facilities[filter.facilityId]?.name : undefined;
  const nameOfFac = (r: Requisition) => (r.facilityId ? md.facilities[r.facilityId]?.name : r.facilityExtractedText) || "Unmatched facility";
  return (
    <>
      <Head sub={fac} />
      {bar}
      <section className="stack">
        <div className="stats">
          <Stat label="Received" value={fmtNum(d.recv.length)} foot="By received date" />
          <Stat label="Entered" value={fmtNum(d.entered.length)} foot="By entry date" />
          <Stat label="Entry backlog" value={fmtNum(d.entryBacklog)} foot="Received, not yet finalized" />
          <Stat label="Fulfillment backlog" value={fmtNum(d.fulBacklog.length)} foot="Finalized, fulfillment open or partial" />
          <Stat label="Reopened" value={fmtNum(d.byStatus.reopened)} foot="Excluded from reporting while under correction" />
        </div>
      </section>

      <section className="stack">
        <h2>Fulfillment</h2>
        <div className="grid3">
          {(["issued", "invoiced", "delivered"] as const).map((s) => (
            <div key={s} className={`card ofr-card ${s === "issued" ? "headline" : ""}`}>
              <div className="eyebrow"><SeriesSwatch stage={s} /> {STAGE_OFR_NAME[s]}{s === "issued" ? " · headline" : ""}</div>
              <div className="big"><OfrValue v={d.agg[s].ofr} threshold={d.ts === s ? d.th : undefined} /></div>
              <Coverage a={d.agg[s]} />
              <span className="small muted">{fmtNum(d.agg[s].credited)} of {fmtNum(d.agg[s].requested)} base units credited</span>
            </div>
          ))}
        </div>
        <div className="stats">
          <Stat label="Issued SKU fulfillment" value={fmtPct(d.agg.issued.skuRate)} foot={`${d.agg.issued.fullLines} of ${d.agg.issued.eligibleLines} lines fully issued`} />
          <Stat label="Over-fulfillment (issued)" value={fmtNum(d.agg.issued.over)} foot={`Base units on ${d.agg.issued.overLines} lines. Not counted in OFR`} />
          <Stat label={`Below ${d.th}% ${STAGE_OFR_NAME[d.ts]}`} value={fmtNum(d.low.length)} foot="Official requisitions" />
        </div>
      </section>

      <section className="stack">
        <h2>Processing time</h2>
        <div className="stats">
          <Stat label="Requisition-to-Entry" value={d.pt.reqToEntryDays.avg == null ? "—" : `${d.pt.reqToEntryDays.avg.toFixed(1)} days`} foot={`${d.pt.reqToEntryDays.count} requisitions`} />
          <Stat label="Requisition-to-Completion" value={d.pt.reqToCompletionDays.avg == null ? "—" : `${d.pt.reqToCompletionDays.avg.toFixed(1)} days`} foot={`${d.pt.reqToCompletionDays.count} completed`} />
          <Stat label="RA Processing Time" value={fmtDuration(d.pt.raProcessingHours.avg)} foot="Received to entered" />
        </div>
        {d.pt.excludedEstimated > 0 && <p className="small muted">{d.pt.excludedEstimated} requisitions with an estimated requisition date are left out of the requisition-date averages.</p>}
      </section>

      <div className="grid2">
        <section className="card stack">
          <h3>Record status</h3>
          <div className="count-grid">{RS.map((s) => <div className="count-cell" key={s}><span>{RECORD_STATUS_LABEL[s]}</span><b>{d.byStatus[s]}</b></div>)}</div>
          <h3>Current lifecycle stage</h3>
          <div className="count-grid">{LIFECYCLE_STAGES.map((s) => <div className="count-cell" key={s}><span>{STAGE_LABEL[s]}</span><b>{d.byStage[s]}</b></div>)}</div>
          <h3>Fulfillment status</h3>
          <div className="count-grid">{FS.map((s) => <div className="count-cell" key={s}><span>{FULFILLMENT_STATUS_LABEL[s]}</span><b>{d.byFul[s]}</b></div>)}</div>
          <p className="small muted">Counts use requisitions in the selected period. Cancelled requisitions are left out of stage and fulfillment counts.</p>
        </section>
        <section className="card stack">
          <h3>Needs attention</h3>
          <ul className="attn">
            {d.pending.slice(0, 6).map((r) => (
              <li key={r.id}><a className="mono" href={`#req-${r.id}`}>{r.number}</a><span className="small">{nameOfFac(r)}</span><span className="pill warn">{RECORD_STATUS_LABEL[r.recordStatus]}</span></li>
            ))}
            {d.low.slice(0, 6).map(({ r, v }) => (
              <li key={"low" + r.id}><a className="mono" href={`#req-${r.id}`}>{r.number}</a><span className="small">{nameOfFac(r)}</span><span className="pill bad">{STAGE_OFR_NAME[d.ts]} {fmtPct(v)}</span></li>
            ))}
            {d.fulBacklog.slice(0, 6).map((r) => (
              <li key={"fb" + r.id}><a className="mono" href={`#req-${r.id}`}>{r.number}</a><span className="small">{nameOfFac(r)}</span><span className="pill info">Fulfillment {FULFILLMENT_STATUS_LABEL[r.fulfillmentStatus].toLowerCase()}</span></li>
            ))}
            {!d.pending.length && !d.low.length && !d.fulBacklog.length && <li className="muted">Nothing needs attention in this period.</li>}
          </ul>
        </section>
      </div>
      <p className="small muted">
        OFR counts credited base quantities on eligible requested lines, capped per line. Additional unrequested items and lines with unknown unit conversions are left out; coverage shows how many lines count.
      </p>
    </>
  );
}

function Head({ sub }: { sub?: string }) {
  return (
    <div className="page-head">
      <div>
        <h1>Dashboard</h1>
        <p className="sub">{sub ? `${sub}. ` : ""}Requisition volume, backlog, fulfillment rate and processing time.</p>
      </div>
    </div>
  );
}

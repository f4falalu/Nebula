import React, { useMemo, useState } from "react";
import { useApp } from "./context";
import { Field, Picker, Seg, useOptions } from "./kit";
import { lagosDate, periodRange, fmtDate, type Period } from "../domain/time";
import type { LineFilter, Scope } from "../domain/ofr";
import type { TimeBasis } from "../domain/types";

export interface FilterValue {
  period: Period;
  from?: string;
  to?: string;
  scope: Scope;
  basis: TimeBasis;
  facilityId?: string;
  programmeId?: string;
  itemId?: string;
}

export const SCOPE_LABEL: Record<Scope, string> = {
  official: "Official (finalized + fulfillment closed)",
  in_progress: "In progress (provisional)",
};
export const BASIS_LABEL: Record<TimeBasis, string> = { received: "Received date", requisition: "Requisition date", entry: "Entry date" };
const PERIODS: Array<[Period, string]> = [
  ["today", "Today"], ["week", "This week"], ["month", "This month"], ["quarter", "This quarter"], ["year", "This year"], ["all", "All time"], ["custom", "Custom"],
];

export interface UseFilterOptions {
  facility?: boolean;
  programme?: boolean;
  item?: boolean;
  defaultPeriod?: Period;
  fixed?: Partial<Pick<LineFilter, "facilityId" | "programmeId" | "itemId">>;
}

/**
 * Filter state + the filter row. Returns the LineFilter for domain/ofr
 * (scope, basis, from/to, facility/programme/item), the raw value, and the bar
 * to render above the charts.
 */
export function useFilters(opts: UseFilterOptions = {}) {
  const { state } = useApp();
  const [value, setValue] = useState<FilterValue>(() => ({
    period: opts.defaultPeriod ?? "all",
    scope: "official",
    basis: state.md.settings.defaultTimeBasis ?? "received",
  }));
  const filter: LineFilter = useMemo(() => {
    const r = periodRange(value.period, lagosDate(new Date()), { from: value.from, to: value.to });
    return {
      scope: value.scope,
      basis: value.basis,
      from: r.from,
      to: r.to,
      facilityId: opts.fixed?.facilityId ?? value.facilityId,
      programmeId: opts.fixed?.programmeId ?? value.programmeId,
      itemId: opts.fixed?.itemId ?? value.itemId,
    };
  }, [value, opts.fixed?.facilityId, opts.fixed?.programmeId, opts.fixed?.itemId]);
  const bar = <FilterBar value={value} onChange={setValue} opts={opts} filter={filter} />;
  return { filter, value, setValue, bar };
}

export function FilterBar({ value, onChange, opts, filter }: { value: FilterValue; onChange: (v: FilterValue) => void; opts: UseFilterOptions; filter: LineFilter }) {
  const o = useOptions();
  const set = (p: Partial<FilterValue>) => onChange({ ...value, ...p });
  return (
    <div className="filter-bar">
      <div className="filters">
        <Field label="Period">
          <select id="f-period" value={value.period} onChange={(e) => set({ period: e.target.value as Period })}>
            {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        {value.period === "custom" && (
          <>
            <Field label="From"><input id="f-from" type="date" value={value.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} /></Field>
            <Field label="To"><input id="f-to" type="date" value={value.to ?? ""} onChange={(e) => set({ to: e.target.value || undefined })} /></Field>
          </>
        )}
        <Field label="Dates by">
          <select id="f-basis" value={value.basis} onChange={(e) => set({ basis: e.target.value as TimeBasis })}>
            {(Object.keys(BASIS_LABEL) as TimeBasis[]).map((k) => <option key={k} value={k}>{BASIS_LABEL[k]}</option>)}
          </select>
        </Field>
        {opts.facility && !opts.fixed?.facilityId && (
          <Field label="Facility"><Picker id="f-fac" options={o.fac} value={value.facilityId} onChange={(id) => set({ facilityId: id || undefined })} placeholder="All facilities" allowEmpty /></Field>
        )}
        {opts.programme && !opts.fixed?.programmeId && (
          <Field label="Programme"><Picker id="f-prog" options={o.progs} value={value.programmeId} onChange={(id) => set({ programmeId: id || undefined })} placeholder="All programmes" allowEmpty /></Field>
        )}
        {opts.item && !opts.fixed?.itemId && (
          <Field label="Item"><Picker id="f-item" options={o.items} value={value.itemId} onChange={(id) => set({ itemId: id || undefined })} placeholder="All items" allowEmpty /></Field>
        )}
        <div className="field">
          <span>Scope</span>
          <Seg label="Reporting scope" value={value.scope} onChange={(s) => set({ scope: s })} options={[["official", "Official"], ["in_progress", "In progress"]]} />
        </div>
      </div>
      <p className="filter-summary small muted">
        Showing <b>{SCOPE_LABEL[value.scope]}</b>, by {BASIS_LABEL[value.basis].toLowerCase()},{" "}
        {filter.from || filter.to ? `${fmtDate(filter.from)} to ${fmtDate(filter.to)}` : "all dates"}.
        {value.scope === "in_progress" && " Figures include requisitions whose fulfillment is still being captured."}
      </p>
    </div>
  );
}

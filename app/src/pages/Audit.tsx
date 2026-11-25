import React, { useEffect, useMemo, useState } from "react";
import { useApp } from "../ui/context";
import { Empty, Field } from "../ui/kit";
import { can } from "../domain/permissions";
import { fmtDateTime, lagosDate } from "../domain/time";
import { normalize } from "../domain/text";
import type { AuditEvent } from "../domain/types";

const PAGE = 100;

export function eventLabel(t: string): string {
  const s = t.replace(/[._]/g, " ");
  return s[0].toUpperCase() + s.slice(1);
}

function Json({ value }: { value: unknown }) {
  if (value === undefined) return <span className="muted">—</span>;
  // Rendered as text, never as HTML.
  return <pre className="audit-json">{JSON.stringify(value, null, 2)}</pre>;
}

export function AuditPage(_p: { id?: string }) {
  const { store, actor, state, nameOf, api } = useApp();
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [who, setWho] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reqNo, setReqNo] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const allowed = can(actor, "audit.global");

  useEffect(() => {
    if (!allowed) return;
    if (api) {
      // V2: the server pages the audit log, newest first.
      let alive = true;
      api.auditLog({ limit: 500 })
        .then((res) => {
          if (!alive) return;
          setEvents(res.events);
          setNext(res.next);
          setErr(null);
        })
        .catch((e) => alive && setErr(e instanceof Error ? e.message : "The audit log couldn't be loaded."));
      return () => {
        alive = false;
      };
    }
    const timer = setTimeout(() => setErr("The audit log is taking a while to load."), 10000);
    const unsub = store.watch(
      "audit",
      (docs) => {
        clearTimeout(timer);
        setErr(null);
        const out: AuditEvent[] = [];
        for (const d of Object.values(docs)) {
          const entries = (d.entries ?? {}) as Record<string, AuditEvent>;
          for (const e of Object.values(entries)) if (e && e.id) out.push(e);
        }
        out.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
        setEvents(out);
      },
      (msg) => {
        clearTimeout(timer);
        setErr(msg);
      },
    );
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, [store, allowed, api]);

  const loadOlder = async () => {
    if (!api || !next) return;
    setLoadingMore(true);
    try {
      const res = await api.auditLog({ limit: 500, before: next });
      setEvents((cur) => [...(cur ?? []), ...res.events]);
      setNext(res.next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Older events couldn't be loaded.");
    } finally {
      setLoadingMore(false);
    }
  };

  const numberOf = (id?: string) => (id ? state.reqs[id]?.number : undefined);

  const types = useMemo(() => [...new Set((events ?? []).map((e) => e.eventType))].sort(), [events]);
  const people = useMemo(() => [...new Set((events ?? []).map((e) => e.actor ?? ""))], [events]);

  const filtered = useMemo(() => {
    if (!events) return [];
    const nq = normalize(q);
    const nr = reqNo.trim().toLowerCase();
    return events.filter((e) => {
      if (type && e.eventType !== type) return false;
      if (who && (e.actor ?? "") !== who) return false;
      const d = lagosDate(e.at);
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (nr && !(numberOf(e.requisitionId) ?? "").toLowerCase().includes(nr)) return false;
      if (nq) {
        const hay = normalize(`${e.eventType} ${e.entityType} ${e.entityId ?? ""} ${e.reason ?? ""} ${numberOf(e.requisitionId) ?? ""} ${nameOf(e.actor)} ${JSON.stringify(e.newValue ?? "")}`);
        if (!hay.includes(nq)) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, q, type, who, from, to, reqNo, state.reqs, nameOf]);

  useEffect(() => setLimit(PAGE), [q, type, who, from, to, reqNo]);

  if (!allowed) return <Empty title="The global audit log is for Supervisors and Administrators">Each requisition's own history is on its page.</Empty>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="sub">Every material action, newest first. Each requisition's history is also on its own page.</p>
        </div>
      </div>
      <div className="note-box small">
        {api ? "Audit records are append-only: the database itself rejects any change or deletion." : "V1 keeps audit records append-only in the app: Nebula only ever adds entries. V2 moves to PostgreSQL, where the database itself rejects any change or deletion of audit records."}
      </div>
      <div className="card filters">
        <Field label="Search"><input id="audit-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Reason, entity, value" /></Field>
        <Field label="Event">
          <select id="audit-type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All events</option>
            {types.map((t) => <option key={t} value={t}>{eventLabel(t)}</option>)}
          </select>
        </Field>
        <Field label="Who">
          <select id="audit-who" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Everyone</option>
            {people.map((p) => <option key={p} value={p}>{p ? nameOf(p) : "System"}</option>)}
          </select>
        </Field>
        <Field label="Requisition number"><input id="audit-req" value={reqNo} onChange={(e) => setReqNo(e.target.value)} placeholder="REQ-26-11-19_001" /></Field>
        <Field label="From"><input id="audit-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input id="audit-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {err && <div className="banner warn">{err}</div>}
      {events === null ? (
        <div className="boot">Loading audit log…</div>
      ) : !filtered.length ? (
        <div className="card"><Empty title={events.length ? "No events match these filters" : "No audit events yet"}>{events.length ? "Clear a filter to see more." : "Actions taken in Nebula are recorded here."}</Empty></div>
      ) : (
        <div className="card flush">
          <div className="card-head"><span className="muted small">{filtered.length.toLocaleString("en-GB")} event{filtered.length === 1 ? "" : "s"}</span></div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Time (Lagos)</th><th>Who</th><th>Event</th><th>Entity</th><th>Requisition</th><th>Reason</th><th></th></tr></thead>
              <tbody>
                {filtered.slice(0, limit).map((e) => {
                  const num = numberOf(e.requisitionId);
                  const isOpen = open === e.id;
                  return (
                    <React.Fragment key={e.id}>
                      <tr>
                        <td className="mono small" style={{ whiteSpace: "nowrap" }}>{fmtDateTime(e.at)}</td>
                        <td>{e.actorType === "system" ? <span className="muted">System</span> : nameOf(e.actor)}</td>
                        <td>{eventLabel(e.eventType)}</td>
                        <td className="small">{e.entityType.replace(/_/g, " ")}{e.entityId && <div className="muted mono audit-id">{e.entityId}</div>}</td>
                        <td>{e.requisitionId ? <a className="mono" href={`#req-${e.requisitionId}`}>{num ?? "Open"}</a> : <span className="muted">—</span>}</td>
                        <td className="small">{e.reason ?? "—"}</td>
                        <td>
                          {(e.oldValue !== undefined || e.newValue !== undefined) && (
                            <button className="btn sm" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : e.id)}>{isOpen ? "Hide" : "Values"}</button>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={7}>
                            <div className="grid2">
                              <div className="stack tight"><span className="eyebrow">Previous value</span><Json value={e.oldValue} /></div>
                              <div className="stack tight"><span className="eyebrow">New value</span><Json value={e.newValue} /></div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(filtered.length > limit || next) && (
            <div className="card-body row">
              {filtered.length > limit && <button className="btn" onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, filtered.length - limit)} more</button>}
              {filtered.length <= limit && next && <button className="btn" disabled={loadingMore} onClick={loadOlder}>{loadingMore ? "Loading…" : "Load older events"}</button>}
            </div>
          )}
        </div>
      )}
    </>
  );
}

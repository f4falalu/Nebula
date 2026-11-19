import React, { useEffect, useState } from "react";
import { useApp } from "../../ui/context";
import { Who } from "../../ui/kit";
import { fmtDateTime } from "../../domain/time";
import type { AuditEvent, Requisition } from "../../domain/types";

export function AuditTab({ r }: { r: Requisition }) {
  const { store } = useApp();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    store
      .get(`audit/${r.id}`)
      .then((d) => {
        if (!alive) return;
        const list = Object.values((d?.entries as Record<string, AuditEvent>) ?? {}).sort((a, b) => b.at.localeCompare(a.at));
        setEvents(list);
      })
      .catch(() => alive && setErr("The audit history couldn't be loaded."));
    return () => {
      alive = false;
    };
  }, [store, r.id, r.updatedAt]);
  if (err) return <div className="banner bad">{err}</div>;
  if (!events) return <div className="boot">Loading audit history…</div>;
  return (
    <div className="card flush">
      <div className="card-head"><h3>Audit history ({events.length})</h3><span className="muted small">Every change to this requisition, newest first. Entries are added, never edited.</span></div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th>When</th><th>Who</th><th>Event</th><th>Reason</th><th>Details</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="small" style={{ whiteSpace: "nowrap" }}>{fmtDateTime(e.at)}</td>
                <td className="small">{e.actorType === "system" ? "System" : <Who id={e.actor} />}</td>
                <td><span className="mono small">{e.eventType}</span><div className="muted small">{e.entityType}</div></td>
                <td className="small">{e.reason ?? ""}{e.editRequestId && <div className="muted">Edit request {e.editRequestId.slice(-6)}</div>}</td>
                <td>
                  {(e.oldValue !== undefined || e.newValue !== undefined) && (
                    <details>
                      <summary className="small">Values</summary>
                      {e.oldValue !== undefined && <><div className="eyebrow">Before</div><pre className="mono small" style={{ whiteSpace: "pre-wrap", maxWidth: 520 }}>{JSON.stringify(e.oldValue, null, 1)}</pre></>}
                      {e.newValue !== undefined && <><div className="eyebrow">After</div><pre className="mono small" style={{ whiteSpace: "pre-wrap", maxWidth: 520 }}>{JSON.stringify(e.newValue, null, 1)}</pre></>}
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

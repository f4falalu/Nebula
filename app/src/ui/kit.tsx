import React, { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "./context";
import { RECORD_STATUS_LABEL, FULFILLMENT_STATUS_LABEL } from "../domain/records";
import { STAGE_LABEL } from "../domain/lifecycle";
import type { FulfillmentStatus, LifecycleStage, RecordStatus, ReqDocument } from "../domain/types";
import { pdfToImages } from "../data/files";
import { fmtPct } from "../domain/text";

export function Pill({ tone, children, title }: { tone?: "good" | "warn" | "bad" | "info" | "accent"; children: React.ReactNode; title?: string }) {
  return <span className={`pill ${tone ?? ""}`} title={title}>{children}</span>;
}

const RS_TONE: Record<RecordStatus, "good" | "warn" | "bad" | "info" | "accent" | undefined> = {
  draft: undefined, processing: "info", validation_pending: "warn", validated: "accent", finalized: "good", reopened: "warn", cancelled: "bad",
};
export function RecordStatusPill({ s }: { s: RecordStatus }) {
  return <Pill tone={RS_TONE[s]}>{RECORD_STATUS_LABEL[s]}</Pill>;
}
export function FulfillmentPill({ s }: { s: FulfillmentStatus }) {
  return <Pill tone={s === "closed" ? "good" : s === "partial" ? "info" : undefined}>{FULFILLMENT_STATUS_LABEL[s]}</Pill>;
}
export function StagePill({ s }: { s: LifecycleStage }) {
  return <Pill tone={s === "completed" ? "good" : "accent"}>{STAGE_LABEL[s]}</Pill>;
}

export function OfrValue({ v, coverage, threshold }: { v: number | null | undefined; coverage?: number | null; threshold?: number }) {
  const low = v != null && threshold != null && v < threshold;
  return (
    <span className="num" title={coverage != null ? `Coverage ${fmtPct(coverage, 0)}` : undefined} style={{ color: low ? "var(--bad)" : undefined, fontWeight: low ? 600 : undefined }}>
      {fmtPct(v)}
    </span>
  );
}

export function Modal({ title, onClose, children, foot, wide }: { title: string; onClose: () => void; children: React.ReactNode; foot?: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <em className="hint" style={{ fontStyle: "normal" }}>{hint}</em>}
    </label>
  );
}

/** A modal asking for a reason, used for cancel/reopen/void and similar. */
export function ReasonModal({ title, label, cta, danger, onClose, onSubmit, intro }: {
  title: string; label: string; cta: string; danger?: boolean; intro?: React.ReactNode; onClose: () => void; onSubmit: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className={`btn ${danger ? "danger" : "primary"}`} disabled={!reason.trim() || busy} onClick={async () => { setBusy(true); const ok = await onSubmit(reason); setBusy(false); if (ok !== false) onClose(); }}>
            {busy ? "Saving…" : cta}
          </button>
        </>
      }
    >
      {intro}
      <Field label={label}>
        <textarea id="reason-input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

export function Stat({ label, value, foot, headline }: { label: string; value: React.ReactNode; foot?: React.ReactNode; headline?: boolean }) {
  return (
    <div className={`stat ${headline ? "headline" : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {foot && <div className="foot">{foot}</div>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<[T, string]>; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}

export function Seg<T extends string>({ options, value, onChange, label }: { options: Array<[T, string]>; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([k, l]) => (
        <button key={k} aria-pressed={value === k} onClick={() => onChange(k)}>{l}</button>
      ))}
    </div>
  );
}

/** Searchable picker over master data (facility, item, programme). */
export function Picker({ options, value, onChange, placeholder, id, allowEmpty }: {
  options: Array<{ id: string; label: string; sub?: string }>; value?: string; onChange: (id: string) => void; placeholder?: string; id?: string; allowEmpty?: boolean;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.id === value);
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (n ? options.filter((o) => (o.label + " " + (o.sub ?? "")).toLowerCase().includes(n)) : options).slice(0, 40);
  }, [q, options]);
  return (
    <div style={{ position: "relative", minWidth: 0 }}>
      <input
        id={id}
        className="input"
        value={open ? q : cur?.label ?? ""}
        placeholder={placeholder ?? "Search…"}
        onFocus={() => { setOpen(true); setQ(""); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => setQ(e.target.value)}
      />
      {open && (
        <div className="search-results" style={{ maxHeight: 280 }}>
          {allowEmpty && <a href="#" onMouseDown={(e) => { e.preventDefault(); onChange(""); setOpen(false); }}><span className="muted">None</span></a>}
          {list.map((o) => (
            <a key={o.id} href="#" onMouseDown={(e) => { e.preventDefault(); onChange(o.id); setOpen(false); }}>
              {o.label} {o.sub && <span className="muted small">· {o.sub}</span>}
            </a>
          ))}
          {!list.length && <div className="muted small" style={{ padding: 10 }}>No matches.</div>}
        </div>
      )}
    </div>
  );
}

export function useOptions() {
  const { state } = useApp();
  return useMemo(() => {
    const fac = Object.values(state.md.facilities).filter((f) => f.status === "active").sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({ id: f.id, label: f.name, sub: f.lga }));
    const items = Object.values(state.md.items).filter((i) => i.status === "active").sort((a, b) => a.name.localeCompare(b.name))
      .map((i) => ({ id: i.id, label: [i.name, i.strength, i.form].filter(Boolean).join(" "), sub: `${i.code} · per ${i.baseUnit}` }));
    const progs = Object.values(state.md.programmes).filter((p) => p.status === "active").sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, label: p.name }));
    return { fac, items, progs };
  }, [state.md]);
}

/** Shows a stored document: images inline, PDFs rendered page by page. */
export function DocView({ doc, page = 1 }: { doc: ReqDocument; page?: number }) {
  const { svc, caps } = useApp();
  const [pages, setPages] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setPages(null);
    setErr(null);
    (async () => {
      try {
        const url = await svc.documentUrl(doc);
        if (doc.mimeType !== "application/pdf") {
          if (alive) setPages([url]);
          return;
        }
        const blob = await (await fetch(url)).blob();
        const imgs = await pdfToImages(blob, 30);
        if (alive) setPages(imgs.map((b) => URL.createObjectURL(b)));
      } catch {
        if (alive) setErr(doc.mimeType === "application/pdf" ? "This PDF couldn't be shown here." : "The file couldn't be loaded.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [doc.id, doc.mimeType, svc]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="empty">{err}</div>;
  if (!pages) return <div className="empty">Loading document…</div>;
  const src = pages[Math.min(page, pages.length) - 1] ?? pages[0];
  return (
    <img
      src={src}
      alt="Requisition document page"
      onError={() => setErr(caps.mode === "artifact" ? "The file couldn't be loaded. It may be visible only to members of the owner's organization." : "The file couldn't be loaded. Its link may have expired; reopen it.")}
    />
  );
}

export function Who({ id }: { id?: string | null }) {
  const { nameOf } = useApp();
  return <>{nameOf(id)}</>;
}

export function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
export const ICON = {
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.35-4.35",
  menu: "M3 6h18M3 12h18M3 18h18",
  plus: "M12 5v14M5 12h14",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
};

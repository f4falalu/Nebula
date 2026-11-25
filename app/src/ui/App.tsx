import React, { useEffect, useMemo, useState } from "react";
import { useApp } from "./context";
import { Icon, ICON } from "./kit";
import { ROLE_LABEL, can } from "../domain/permissions";
import { activeLines, effectiveEditStatus } from "../domain/records";
import { normalize } from "../domain/text";
import { DashboardPage } from "../pages/Dashboard";
import { RequisitionsPage } from "../pages/Requisitions";
import { RequisitionPage } from "../pages/Requisition";
import { FacilitiesPage, FacilityPage } from "../pages/Facilities";
import { ItemsPage, ItemPage } from "../pages/Items";
import { ProgrammesPage, ProgrammePage } from "../pages/Programmes";
import { AnalyticsPage } from "../pages/Analytics";
import { ApprovalsPage } from "../pages/Approvals";
import { AuditPage } from "../pages/Audit";
import { AdminPage } from "../pages/Admin";

export type Route = { name: string; param?: string };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  const m = h.match(/^(req|facility|item|programme)-([a-z0-9]+)$/);
  if (m) return { name: m[1], param: m[2] };
  return { name: h || "dashboard" };
}

export function go(name: string, param?: string) {
  location.hash = param ? `${name}-${param}` : name;
}

export function useRoute(): Route {
  const [r, setR] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const f = () => {
      setR(parseRoute(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return r;
}

export function App() {
  const ctx = useApp();
  const { actor, state, store, loadNote, loaded } = ctx;
  const route = useRoute();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [route.name, route.param]);

  const pendingApprovals = useMemo(() => {
    if (!can(actor, "edit_request.approve")) return 0;
    let n = 0;
    for (const r of Object.values(state.reqs)) for (const e of Object.values(r.editRequests)) if (effectiveEditStatus(e, state.md.settings.editRequestPendingTimeoutDays) === "pending" && e.requestedBy !== actor.id) n++;
    for (const p of Object.values(state.proposals)) if ((p as { status: string }).status === "candidate" || (p as { status: string }).status === "proposed") n++;
    return n;
  }, [state, actor]);

  const nav: Array<[string, string, number?]> = [
    ["dashboard", "Dashboard"],
    ["requisitions", "Requisitions"],
    ["facilities", "Facilities"],
    ["items", "Items"],
    ["programmes", "Programmes"],
    ["analytics", "Analytics"],
    ...(can(actor, "edit_request.approve") || actor.role === "admin" ? [["approvals", "Approvals", pendingApprovals] as [string, string, number]] : []),
    ...(can(actor, "audit.global") ? [["audit", "Audit log"] as [string, string]] : []),
    ...(actor.role === "admin" ? [["admin", "Administration", (state.users ?? []).filter((u) => u.status === "pending").length] as [string, string, number]] : []),
  ];
  const active = { req: "requisitions", facility: "facilities", item: "items", programme: "programmes" }[route.name] ?? route.name;

  let page: React.ReactNode;
  switch (route.name) {
    case "requisitions": page = <RequisitionsPage />; break;
    case "req": page = <RequisitionPage id={route.param!} />; break;
    case "facilities": page = <FacilitiesPage />; break;
    case "facility": page = <FacilityPage id={route.param!} />; break;
    case "items": page = <ItemsPage />; break;
    case "item": page = <ItemPage id={route.param!} />; break;
    case "programmes": page = <ProgrammesPage />; break;
    case "programme": page = <ProgrammePage id={route.param!} />; break;
    case "analytics": page = <AnalyticsPage />; break;
    case "approvals": page = <ApprovalsPage />; break;
    case "audit": page = <AuditPage />; break;
    case "admin": page = <AdminPage />; break;
    default: page = <DashboardPage />;
  }

  return (
    <div className="shell">
      <aside className={`rail ${navOpen ? "open" : ""}`} aria-label="Main navigation">
        <div className="brand">
          <div className="brand-mark">Nb</div>
          <div>
            <b>Nebula</b>
            <span>Requisition audit · {ctx.caps.mode === "web" ? "V2" : "V1"}</span>
          </div>
        </div>
        <nav className="nav">
          {nav.map(([k, label, count]) => (
            <a key={k} href={`#${k}`} aria-current={active === k ? "page" : undefined}>
              {label}
              {!!count && <span className="count">{count}</span>}
            </a>
          ))}
        </nav>
        <div className="rail-foot">
          <div>
            Signed in as <b style={{ color: "var(--fg)" }}>{ctx.nameOf(actor.id)}</b>
            <br />
            {ROLE_LABEL[actor.role]}
            {actor.grants.length ? ` + ${actor.grants.length} grant${actor.grants.length > 1 ? "s" : ""}` : ""}
          </div>
          {!store.live && <div className="pill warn plain">Preview: not shared</div>}
          {ctx.signOut && (
            <div className="row">
              {ctx.accountLabel && <span className="small" style={{ overflowWrap: "anywhere" }}>{ctx.accountLabel}</span>}
              <button className="btn sm" onClick={ctx.signOut}>Sign out</button>
            </div>
          )}
        </div>
      </aside>
      {navOpen && <div className="scrim" style={{ zIndex: 25, background: "rgba(0,0,0,.25)" }} onClick={() => setNavOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button className="btn ghost menu-btn" onClick={() => setNavOpen(true)} aria-label="Open navigation"><Icon d={ICON.menu} /></button>
          <GlobalSearch />
          {can(actor, "requisition.create") && (
            <a className="btn primary" href="#requisitions" onClick={() => setTimeout(() => window.dispatchEvent(new Event("nebula:new-requisition")), 0)}>
              <Icon d={ICON.plus} /> <span>New requisition</span>
            </a>
          )}
        </header>
        <main className="page">
          {!store.live && (
            <div className="banner warn">
              Preview mode. Changes stay in this browser only. Open the published artifact on claude.ai to work with shared data.
            </div>
          )}
          {loadNote && <div className="banner warn">{loadNote}</div>}
          {!loaded && store.live ? <div className="boot">Loading shared data…</div> : page}
        </main>
      </div>
    </div>
  );
}

function GlobalSearch() {
  const { state } = useApp();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const results = useMemo(() => {
    const n = normalize(q);
    if (n.length < 2) return [];
    const out: Array<{ href: string; label: string; sub: string }> = [];
    const md = state.md;
    const aliasHit = (type: "facility" | "item", id: string) => Object.values(md.aliases).some((a) => a.entityType === type && a.entityId === id && a.status === "approved" && a.normalized.includes(n));
    for (const r of Object.values(state.reqs).sort((a, b) => b.entryAt.localeCompare(a.entryAt))) {
      const fac = r.facilityId ? md.facilities[r.facilityId]?.name ?? "" : r.facilityExtractedText ?? "";
      const items = activeLines(r).map((l) => (l.itemId ? `${md.items[l.itemId]?.name} ${md.items[l.itemId]?.code}` : l.itemExtractedText ?? "")).join(" ");
      const hay = normalize(`${r.number} ${fac} ${items}`);
      if (hay.includes(n) || r.number.toLowerCase().includes(q.trim().toLowerCase())) out.push({ href: `#req-${r.id}`, label: r.number, sub: fac || "Unmatched facility" });
      if (out.length > 12) break;
    }
    for (const f of Object.values(md.facilities)) if (normalize(f.name).includes(n) || aliasHit("facility", f.id)) out.push({ href: `#facility-${f.id}`, label: f.name, sub: "Facility" });
    for (const i of Object.values(md.items)) if (normalize(`${i.name} ${i.genericName ?? ""} ${i.code}`).includes(n) || aliasHit("item", i.id)) out.push({ href: `#item-${i.id}`, label: [i.name, i.strength, i.form].filter(Boolean).join(" "), sub: `Item · ${i.code}` });
    for (const p of Object.values(md.programmes)) if (normalize(p.name).includes(n)) out.push({ href: `#programme-${p.id}`, label: p.name, sub: "Programme" });
    return out.slice(0, 25);
  }, [q, state]);
  return (
    <div className="search">
      <Icon d={ICON.search} />
      <input
        id="global-search"
        placeholder="Search requisition number, facility, item, code, programme"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        aria-label="Search"
      />
      {open && q.trim().length >= 2 && (
        <div className="search-results">
          {results.map((r, i) => (
            <a key={i} href={r.href} onMouseDown={() => setQ("")}>
              <span className={r.label.startsWith("REQ-") ? "mono" : ""}>{r.label}</span> <span className="muted small">· {r.sub}</span>
            </a>
          ))}
          {!results.length && <div className="muted small" style={{ padding: 10 }}>No matches. For filters by date, stage or OFR, use the Requisitions page.</div>}
        </div>
      )}
    </div>
  );
}

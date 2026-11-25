import React, { useMemo, useState } from "react";
import { useApp } from "../ui/context";
import { Empty, Field, Modal, Pill, Picker, Tabs, useOptions } from "../ui/kit";
import { can } from "../domain/permissions";
import { normalize, fmtNum } from "../domain/text";
import { fmtDateTime } from "../domain/time";
import { normalizeUnit } from "../domain/units";
import { itemLabel } from "../domain/matching";
import { STARTER } from "../data/starter";
import { AiTab, UsageTab, WebUsersTab } from "./AdminV2";
import type { Proposal } from "../data/services";
import {
  FULFILLMENT_STAGES,
  type Alias, type Facility, type FulfillmentStage, type Grant, type Item, type Programme, type RoleCode,
  type Settings, type SubstitutionEquivalence, type TimeBasis, type UnitConversion,
} from "../domain/types";

type Tab = "setup" | "facilities" | "items" | "programmes" | "conversions" | "equivalences" | "aliases" | "users" | "settings" | "ai" | "usage";

export function AdminPage(_p: { id?: string }) {
  const { actor, caps } = useApp();
  const web = caps.mode === "web";
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (sessionStorage.getItem("nebula-admin-tab") as Tab) || "setup";
    } catch {
      return "setup";
    }
  });
  const pick = (t: Tab) => {
    setTab(t);
    try {
      sessionStorage.setItem("nebula-admin-tab", t);
    } catch {
      /* ignore */
    }
  };
  if (actor.role !== "admin") {
    return <Empty title="Administrators only">{web ? "Ask an Administrator if you need to manage master data, users or settings." : "Ask the artifact owner for Editor access if you need to manage master data, users or settings."}</Empty>;
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Administration</h1>
          <p className="sub">Master data, matching rules, people and settings. Every change here is written to the audit log.</p>
        </div>
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={pick}
        tabs={[
          ["setup", "Setup"],
          ["facilities", "Facilities"],
          ["items", "Items"],
          ["programmes", "Programmes"],
          ["conversions", "Unit conversions"],
          ["equivalences", "Substitutions"],
          ["aliases", "Alias candidates"],
          ["users", "Users & roles"],
          ...(web ? ([["ai", "Document reading (AI)"], ["usage", "Usage & credits"]] as Array<[Tab, string]>) : []),
          ["settings", "Settings"],
        ]}
      />
      {tab === "setup" && <SetupTab go={pick} />}
      {tab === "facilities" && <FacilitiesTab />}
      {tab === "items" && <ItemsTab />}
      {tab === "programmes" && <ProgrammesTab />}
      {tab === "conversions" && <ConversionsTab />}
      {tab === "equivalences" && <EquivalencesTab />}
      {tab === "aliases" && <AliasCandidatesTab />}
      {tab === "users" && (web ? <WebUsersTab /> : <UsersTab />)}
      {tab === "ai" && web && <AiTab />}
      {tab === "usage" && web && <UsageTab />}
      {tab === "settings" && <SettingsTab />}
    </>
  );
}

// ---------------- helpers ----------------
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === "\t") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}

function csvObjects(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

function StatusPill({ s }: { s: string }) {
  const tone = s === "active" || s === "approved" ? "good" : s === "proposed" || s === "candidate" ? "warn" : s === "inactive" || s === "retired" || s === "rejected" ? undefined : undefined;
  return <Pill tone={tone as "good" | "warn" | undefined}>{s[0].toUpperCase() + s.slice(1)}</Pill>;
}

// ---------------- Setup ----------------
function SetupTab({ go }: { go: (t: Tab) => void }) {
  const { state, svc, run, actor, caps } = useApp();
  const [busy, setBusy] = useState(false);
  const md = state.md;
  const counts = {
    facilities: Object.values(md.facilities).filter((f) => f.status === "active").length,
    items: Object.values(md.items).filter((i) => i.status === "active").length,
    programmes: Object.values(md.programmes).filter((p) => p.status === "active").length,
  };
  const pending = Object.values(state.proposals).filter((p) => (p as { status: string }).status === "candidate" || (p as { status: string }).status === "proposed").length;
  return (
    <div className="stack">
      <div className="stats">
        <button className="stat admin-stat-btn" onClick={() => go("facilities")}><span className="label">Active facilities</span><span className="value">{fmtNum(counts.facilities)}</span></button>
        <button className="stat admin-stat-btn" onClick={() => go("items")}><span className="label">Active items</span><span className="value">{fmtNum(counts.items)}</span></button>
        <button className="stat admin-stat-btn" onClick={() => go("programmes")}><span className="label">Active programmes</span><span className="value">{fmtNum(counts.programmes)}</span></button>
        <button className="stat admin-stat-btn" onClick={() => go("aliases")}><span className="label">Proposals to review</span><span className="value">{fmtNum(pending)}</span></button>
      </div>
      <div className="grid2">
        <div className="card stack">
          <h2>Master data</h2>
          <p>
            Requisition Assistants can only validate a requisition once every line is matched to an item and a programme, and the requisition is matched to a facility.
            Load your facility, item and programme lists before the team starts entering requisitions.
          </p>
          <div className="note-box">
            The starter set adds the 8 programmes named in the PRD, one facility (Government House Clinic, the only one the PRD names) and
            {" "}{STARTER.items.length} common essential medicines and consumables with codes EML-001 onward. The items are a starting list:
            edit, deactivate or replace them with your own codes. Existing names and codes are skipped.
          </div>
          <div className="row">
            <button
              className="btn primary"
              disabled={busy || !can(actor, "master.manage")}
              onClick={async () => {
                setBusy(true);
                await run(() => svc.loadStarterMasterData(STARTER), "Starter master data loaded.");
                setBusy(false);
              }}
            >
              {busy ? "Loading…" : "Load starter master data"}
            </button>
            <button className="btn" onClick={() => go("facilities")}>Import your facilities (CSV)</button>
            <button className="btn" onClick={() => go("items")}>Import your items (CSV)</button>
          </div>
        </div>
        {caps.mode === "web" ? (
          <div className="card stack">
            <h2>How people get access</h2>
            <p>People sign in with their own account. Their first sign-in creates a pending account that can't see any data.</p>
            <p>Activate them and choose a role under Users &amp; roles: Requisition Assistant, Supervisor (view-only, with optional extra permissions) or Administrator.</p>
            <p className="muted small">Addresses listed in the server's ADMIN_EMAILS setting become Administrators automatically on first sign-in.</p>
          </div>
        ) : (
        <div className="card stack">
          <h2>How roles work in V1</h2>
          <p>Roles come from how the artifact is shared on claude.ai. Use the Share menu to set each person's level.</p>
          <dl className="kv">
            <dt>Editor or Owner</dt><dd>Administrator</dd>
            <dt>Contributor</dt><dd>Requisition Assistant</dd>
            <dt>Viewer or Commenter</dt><dd>Supervisor (view-only)</dd>
          </dl>
          <p className="muted small">
            You can make a Contributor a Supervisor and give Supervisors extra permissions under Users &amp; roles.
            A Supervisor who needs to reopen requisitions or approve edit requests must be shared as a Contributor, because those actions write data.
          </p>
        </div>
        )}
      </div>
    </div>
  );
}

// ---------------- Facilities ----------------
function AliasEditor({ entityType, entityId }: { entityType: "facility" | "item"; entityId: string }) {
  const { state, svc, run } = useApp();
  const [text, setText] = useState("");
  const aliases = Object.values(state.md.aliases).filter((a) => a.entityType === entityType && a.entityId === entityId && a.status === "approved");
  return (
    <div className="stack tight">
      <span className="eyebrow">Approved aliases</span>
      {aliases.length ? (
        <div className="chips">
          {aliases.map((a) => (
            <span key={a.id} className="pill plain">
              {a.alias}
              <button className="btn ghost sm admin-x" aria-label={`Retire alias ${a.alias}`} onClick={() => run(() => svc.retireAlias(a.id), "Alias retired.")}>✕</button>
            </span>
          ))}
        </div>
      ) : (
        <p className="muted small">No aliases yet. Aliases help match names as they're written on requisitions.</p>
      )}
      <div className="row">
        <input className="input" style={{ flex: 1, minWidth: 0 }} id={`alias-${entityId}`} value={text} placeholder="Add an alias, e.g. Govt House Clinic" onChange={(e) => setText(e.target.value)} />
        <button className="btn" disabled={!text.trim()} onClick={async () => { await run(() => svc.addAlias(entityType, entityId, text), "Alias added."); setText(""); }}>Add</button>
      </div>
    </div>
  );
}

function FacilityModal({ f, onClose }: { f?: Facility; onClose: () => void }) {
  const { svc, act } = useApp();
  const [v, setV] = useState({ name: f?.name ?? "", lga: f?.lga ?? "", location: f?.location ?? "", status: f?.status ?? "active" });
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={f ? `Edit ${f.name}` : "Add facility"}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !v.name.trim()} onClick={async () => {
            setBusy(true);
            const ok = await act(() => svc.saveFacility({ ...(f ? { id: f.id } : {}), name: v.name, lga: v.lga || undefined, location: v.location || undefined, status: v.status as Facility["status"] }), "Facility saved.");
            setBusy(false);
            if (ok) onClose();
          }}>Save</button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Facility name"><input id="fac-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="LGA"><input id="fac-lga" value={v.lga} onChange={(e) => setV({ ...v, lga: e.target.value })} /></Field>
        <Field label="Location"><input id="fac-loc" value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} /></Field>
        <Field label="Status">
          <select id="fac-status" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value as Facility["status"] })}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </Field>
      </div>
      {f && <AliasEditor entityType="facility" entityId={f.id} />}
    </Modal>
  );
}

function CsvImportModal<T>({ title, columns, example, toRecord, existing, keyOf, onImport, onClose }: {
  title: string; columns: string; example: string; toRecord: (r: Record<string, string>) => T | string; existing: Set<string>; keyOf: (t: T) => string;
  onImport: (rows: T[]) => Promise<boolean>; onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => {
    const seen = new Set(existing);
    return csvObjects(text).map((o, i) => {
      const r = toRecord(o);
      if (typeof r === "string") return { row: i + 2, error: r };
      const k = keyOf(r);
      if (seen.has(k)) return { row: i + 2, skip: true, rec: r };
      seen.add(k);
      return { row: i + 2, rec: r };
    });
  }, [text, existing, toRecord, keyOf]);
  const ok = parsed.filter((p) => p.rec && !p.skip).map((p) => p.rec as T);
  return (
    <Modal
      title={title}
      wide
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ok.length || busy} onClick={async () => {
            setBusy(true);
            const res = await onImport(ok);
            setBusy(false);
            if (res) onClose();
          }}>{busy ? "Importing…" : `Import ${ok.length} row${ok.length === 1 ? "" : "s"}`}</button>
        </>
      }
    >
      <p>Paste rows from a spreadsheet or CSV file. The first row must be the header: <span className="mono">{columns}</span></p>
      <Field label="CSV rows" hint={`Example: ${example}`}>
        <textarea id="csv-input" className="mono admin-csv" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      {parsed.length > 0 && (
        <div className="stack tight">
          <p className="small">
            {ok.length} to import · {parsed.filter((p) => p.skip).length} already exist (skipped) · {parsed.filter((p) => p.error).length} with errors
          </p>
          <div className="table-wrap admin-preview">
            <table className="t">
              <thead><tr><th>Row</th><th>Result</th><th>Record</th></tr></thead>
              <tbody>
                {parsed.slice(0, 200).map((p) => (
                  <tr key={p.row}>
                    <td className="mono">{p.row}</td>
                    <td>{p.error ? <Pill tone="bad">{p.error}</Pill> : p.skip ? <Pill>Skipped</Pill> : <Pill tone="good">Import</Pill>}</td>
                    <td className="small">{p.rec ? Object.values(p.rec as object).filter(Boolean).join(" · ") : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

function FacilitiesTab() {
  const { state, svc, act } = useApp();
  const [edit, setEdit] = useState<Facility | "new" | null>(null);
  const [csv, setCsv] = useState(false);
  const [q, setQ] = useState("");
  const list = Object.values(state.md.facilities)
    .filter((f) => !q || normalize(`${f.name} ${f.lga ?? ""} ${f.location ?? ""}`).includes(normalize(q)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const aliasCount = (id: string) => Object.values(state.md.aliases).filter((a) => a.entityType === "facility" && a.entityId === id && a.status === "approved").length;
  const existing = useMemo(() => new Set(Object.values(state.md.facilities).map((f) => normalize(f.name))), [state.md.facilities]);
  return (
    <div className="card flush">
      <div className="card-head">
        <input className="input admin-filter" id="fac-filter" placeholder="Filter facilities" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="row">
          <button className="btn" onClick={() => setCsv(true)}>Import CSV</button>
          <button className="btn primary" onClick={() => setEdit("new")}>Add facility</button>
        </div>
      </div>
      {list.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Name</th><th>LGA</th><th>Location</th><th className="num">Aliases</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {list.map((f) => (
                <tr key={f.id} className={f.status === "inactive" ? "dim" : ""}>
                  <td><a href={`#facility-${f.id}`}>{f.name}</a></td>
                  <td>{f.lga ?? "—"}</td>
                  <td>{f.location ?? "—"}</td>
                  <td className="num">{aliasCount(f.id)}</td>
                  <td><StatusPill s={f.status} /></td>
                  <td><button className="btn sm" onClick={() => setEdit(f)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No facilities yet">Add facilities one by one, import a CSV, or load the starter set from Setup.</Empty>
      )}
      {edit && <FacilityModal f={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} />}
      {csv && (
        <CsvImportModal<Partial<Facility> & { name: string }>
          title="Import facilities"
          columns="name,lga,location"
          example="Government House Clinic,Kano Municipal,Kano"
          existing={existing}
          keyOf={(r) => normalize(r.name)}
          toRecord={(o) => (o.name ? { name: o.name, lga: o.lga || undefined, location: o.location || undefined } : "Name is missing")}
          onImport={(rows) =>
            act(async () => {
              for (const r of rows) await svc.saveFacility(r);
            }, `${rows.length} facilities imported.`)
          }
          onClose={() => setCsv(false)}
        />
      )}
    </div>
  );
}

// ---------------- Items ----------------
function ItemModal({ item, onClose }: { item?: Item; onClose: () => void }) {
  const { svc, act } = useApp();
  const [v, setV] = useState({
    code: item?.code ?? "", name: item?.name ?? "", genericName: item?.genericName ?? "", strength: item?.strength ?? "",
    form: item?.form ?? "", packSize: item?.packSize ?? "", baseUnit: item?.baseUnit ?? "", status: item?.status ?? "active",
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <Modal
      title={item ? `Edit ${item.code}` : "Add item"}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !v.code.trim() || !v.name.trim() || !v.baseUnit.trim()} onClick={async () => {
            setBusy(true);
            const ok = await act(() => svc.saveItem({
              ...(item ? { id: item.id } : {}), code: v.code, name: v.name, genericName: v.genericName || undefined, strength: v.strength || undefined,
              form: v.form || undefined, packSize: v.packSize || undefined, baseUnit: v.baseUnit, status: v.status as Item["status"],
            }), "Item saved.");
            setBusy(false);
            if (ok) onClose();
          }}>Save</button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Item code"><input id="item-code" value={v.code} onChange={set("code")} /></Field>
        <Field label="Item name"><input id="item-name" value={v.name} onChange={set("name")} /></Field>
        <Field label="Generic name"><input id="item-generic" value={v.genericName} onChange={set("genericName")} /></Field>
        <Field label="Strength"><input id="item-strength" value={v.strength} onChange={set("strength")} placeholder="500mg" /></Field>
        <Field label="Form"><input id="item-form" value={v.form} onChange={set("form")} placeholder="tablet" /></Field>
        <Field label="Pack size"><input id="item-pack" value={v.packSize} onChange={set("packSize")} placeholder="100 tablets" /></Field>
        <Field label="Base unit" hint="The smallest unit quantities are counted in. OFR adds quantities in this unit."><input id="item-base" value={v.baseUnit} onChange={set("baseUnit")} placeholder="tablet" /></Field>
        <Field label="Status">
          <select id="item-status" value={v.status} onChange={set("status")}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </Field>
      </div>
      {item && item.baseUnit && normalizeUnit(v.baseUnit) !== item.baseUnit && (
        <div className="banner warn">Changing the base unit doesn't recalculate quantities already recorded. Check unit conversions for this item afterwards.</div>
      )}
      {item && <AliasEditor entityType="item" entityId={item.id} />}
    </Modal>
  );
}

type ItemSeed = Partial<Item> & { name: string; code: string; baseUnit: string };

function ItemsTab() {
  const { state, svc, act } = useApp();
  const [edit, setEdit] = useState<Item | "new" | null>(null);
  const [csv, setCsv] = useState(false);
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(100);
  const all = Object.values(state.md.items)
    .filter((i) => !q || normalize(`${i.code} ${i.name} ${i.genericName ?? ""} ${i.strength ?? ""} ${i.form ?? ""}`).includes(normalize(q)))
    .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
  const existing = useMemo(() => new Set(Object.values(state.md.items).map((i) => i.code.toLowerCase())), [state.md.items]);
  return (
    <div className="card flush">
      <div className="card-head">
        <input className="input admin-filter" id="item-filter" placeholder="Filter by code, name, strength" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="row">
          <button className="btn" onClick={() => setCsv(true)}>Import CSV</button>
          <button className="btn primary" onClick={() => setEdit("new")}>Add item</button>
        </div>
      </div>
      {all.length ? (
        <>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Code</th><th>Item</th><th>Pack size</th><th>Base unit</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {all.slice(0, limit).map((i) => (
                  <tr key={i.id} className={i.status === "inactive" ? "dim" : ""}>
                    <td className="mono">{i.code}</td>
                    <td><a href={`#item-${i.id}`}>{itemLabel(i)}</a>{i.genericName && <div className="muted small">{i.genericName}</div>}</td>
                    <td>{i.packSize ?? "—"}</td>
                    <td>{i.baseUnit}</td>
                    <td><StatusPill s={i.status} /></td>
                    <td><button className="btn sm" onClick={() => setEdit(i)}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {all.length > limit && <div className="card-body"><button className="btn" onClick={() => setLimit(limit + 200)}>Show more ({all.length - limit} left)</button></div>}
        </>
      ) : (
        <Empty title="No items yet">Add items, import a CSV, or load the starter list from Setup.</Empty>
      )}
      {edit && <ItemModal item={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} />}
      {csv && (
        <CsvImportModal<ItemSeed>
          title="Import items"
          columns="code,name,generic_name,strength,form,pack_size,base_unit"
          example="EML-001,Amoxicillin,Amoxicillin,500mg,capsule,100 capsules,capsule"
          existing={existing}
          keyOf={(r) => r.code.toLowerCase()}
          toRecord={(o) =>
            !o.code ? "Code is missing" : !o.name ? "Name is missing" : !o.base_unit ? "Base unit is missing"
            : { code: o.code, name: o.name, genericName: o.generic_name || undefined, strength: o.strength || undefined, form: o.form || undefined, packSize: o.pack_size || undefined, baseUnit: o.base_unit }
          }
          onImport={(rows) =>
            act(async () => {
              for (const r of rows) await svc.saveItem(r);
            }, `${rows.length} items imported.`)
          }
          onClose={() => setCsv(false)}
        />
      )}
    </div>
  );
}

// ---------------- Programmes ----------------
function ProgrammesTab() {
  const { state, svc, run } = useApp();
  const [edit, setEdit] = useState<Programme | "new" | null>(null);
  const list = Object.values(state.md.programmes).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="card flush">
      <div className="card-head">
        <p className="muted small">Programmes are assigned per page and per requisition line. Deactivate a programme to stop it being chosen; history keeps it.</p>
        <button className="btn primary" onClick={() => setEdit("new")}>Add programme</button>
      </div>
      {list.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Programme</th><th>Description</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className={p.status === "inactive" ? "dim" : ""}>
                  <td><a href={`#programme-${p.id}`}>{p.name}</a></td>
                  <td>{p.description ?? "—"}</td>
                  <td><StatusPill s={p.status} /></td>
                  <td className="row">
                    <button className="btn sm" onClick={() => setEdit(p)}>Edit</button>
                    <button className="btn sm" onClick={() => run(() => svc.saveProgramme({ ...p, status: p.status === "active" ? "inactive" : "active" }), p.status === "active" ? "Programme deactivated." : "Programme reactivated.")}>
                      {p.status === "active" ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No programmes yet">Add programmes or load the starter set from Setup.</Empty>
      )}
      {edit && <ProgrammeModal p={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function ProgrammeModal({ p, onClose }: { p?: Programme; onClose: () => void }) {
  const { svc, act } = useApp();
  const [name, setName] = useState(p?.name ?? "");
  const [description, setDescription] = useState(p?.description ?? "");
  return (
    <Modal
      title={p ? `Edit ${p.name}` : "Add programme"}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim()} onClick={async () => {
            const ok = await act(() => svc.saveProgramme({ ...(p ?? {}), name, description: description || undefined }), "Programme saved.");
            if (ok) onClose();
          }}>Save</button>
        </>
      }
    >
      <Field label="Programme name"><input id="prog-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Description"><textarea id="prog-desc" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
    </Modal>
  );
}

// ---------------- Unit conversions ----------------
function convLabel(c: UnitConversion, items: Record<string, Item>) {
  const target = c.itemId ? itemLabel(items[c.itemId]) : "All items";
  return { target, rule: c.incompatible ? `${c.fromUnit} can't be converted` : `1 ${c.fromUnit} = ${fmtNum(c.factor, 6)} ${c.toUnit || "base units"}` };
}

function proposalsOf<K extends Proposal["kind"]>(proposals: Record<string, Proposal>, kind: K) {
  return Object.entries(proposals).filter(([, p]) => p.kind === kind && (p.status === "proposed" || p.status === "candidate")) as Array<[string, Extract<Proposal, { kind: K }>]>;
}

function ConversionsTab() {
  const { state, svc, run, act, nameOf } = useApp();
  const { items: itemOpts } = useOptions();
  const md = state.md;
  const [showRetired, setShowRetired] = useState(false);
  const [v, setV] = useState({ itemId: "", fromUnit: "", factor: "", incompatible: false, notes: "", toUnit: "" });
  const [resolved, setResolved] = useState<number | null>(null);
  const list = Object.values(md.conversions)
    .filter((c) => showRetired || c.status === "approved")
    .sort((a, b) => (b.approvedAt ?? b.proposedAt).localeCompare(a.approvedAt ?? a.proposedAt));
  const proposals = proposalsOf(state.proposals, "conversion");
  const unknownLines = useMemo(() => {
    let n = 0;
    for (const r of Object.values(state.reqs)) for (const l of Object.values(r.lines)) if (l && l.conversionStatus === "unknown" && r.recordStatus !== "cancelled") n++;
    return n;
  }, [state.reqs]);
  const item = v.itemId ? md.items[v.itemId] : undefined;
  return (
    <div className="stack">
      <div className="note-box">
        A unit conversion turns a quantity as written (for example 20 cartons) into the item's base unit (2,000 tablets). Only approved conversions are used.
        Approved conversions are never edited: to change one, approve a new one and the old one is retired. Item-specific conversions win over ones for all items.
      </div>
      <div className="grid2">
        <div className="card stack">
          <h2>Add an approved conversion</h2>
          <Field label="Item" hint="Leave empty to apply to every item whose base unit matches.">
            <Picker id="conv-item" options={itemOpts} value={v.itemId} onChange={(id) => setV({ ...v, itemId: id })} allowEmpty placeholder="All items" />
          </Field>
          <div className="form-grid">
            {!v.itemId && <Field label="Base unit it converts to" hint="Applies to items with this base unit."><input id="conv-to" value={v.toUnit} onChange={(e) => setV({ ...v, toUnit: e.target.value })} placeholder="tablet" /></Field>}
            <Field label="From unit"><input id="conv-from" value={v.fromUnit} onChange={(e) => setV({ ...v, fromUnit: e.target.value })} placeholder="carton" /></Field>
            <Field label={`Factor (base units per ${normalizeUnit(v.fromUnit) || "unit"})`}>
              <input id="conv-factor" type="number" min="0" step="any" disabled={v.incompatible} value={v.factor} onChange={(e) => setV({ ...v, factor: e.target.value })} placeholder="100" />
            </Field>
          </div>
          <label className="check"><input type="checkbox" checked={v.incompatible} onChange={(e) => setV({ ...v, incompatible: e.target.checked })} /> This unit can't be converted for this item (incompatible)</label>
          <Field label="Notes"><input id="conv-notes" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
          {item && v.fromUnit && !v.incompatible && v.factor && (
            <p className="small">1 {normalizeUnit(v.fromUnit)} = {v.factor} {item.baseUnit}</p>
          )}
          <div className="row end">
            <button
              className="btn primary"
              disabled={!v.fromUnit.trim() || (!v.itemId && !v.toUnit.trim()) || (!v.incompatible && !(Number(v.factor) > 0))}
              onClick={async () => {
                const ok = await act(() => svc.proposeConversion({ itemId: v.itemId || null, fromUnit: v.fromUnit, factor: Number(v.factor), incompatible: v.incompatible, notes: v.notes || undefined, toUnit: v.itemId ? undefined : v.toUnit }), "Conversion approved.");
                if (ok) setV({ itemId: v.itemId, fromUnit: "", factor: "", incompatible: false, notes: "", toUnit: v.toUnit });
              }}
            >Approve conversion</button>
          </div>
        </div>
        <div className="card stack">
          <h2>Lines waiting for a conversion</h2>
          <p><span className="admin-big">{fmtNum(unknownLines)}</span> requisition line{unknownLines === 1 ? "" : "s"} have an unknown conversion. They're left out of OFR and counted in coverage.</p>
          <p className="muted small">Approving a conversion resolves matching lines automatically. Use this button after approving several, or to check again.</p>
          <div className="row">
            <button className="btn" onClick={async () => { const n = await run(() => svc.resolveConversions()); if (n !== undefined) setResolved(n); }}>Resolve unknown lines now</button>
            {resolved != null && <span className="small">{resolved} line{resolved === 1 ? "" : "s"} resolved.</span>}
          </div>
        </div>
      </div>
      {proposals.length > 0 && (
        <div className="card flush">
          <div className="card-head"><h2>Proposed by Requisition Assistants</h2></div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Item</th><th>Rule</th><th>Proposed by</th><th>Notes</th><th></th></tr></thead>
              <tbody>
                {proposals.map(([key, p]) => {
                  const l = convLabel(p, md.items);
                  return (
                    <tr key={key}>
                      <td>{l.target}</td>
                      <td>{l.rule}</td>
                      <td>{nameOf(p.proposedBy)}<div className="muted small">{fmtDateTime(p.proposedAt)}</div></td>
                      <td className="small">{p.notes ?? "—"}</td>
                      <td className="row">
                        <button className="btn sm primary" onClick={() => {
                          const { kind: _k, ...conv } = p;
                          return run(() => svc.approveConversion(conv as UnitConversion, key), "Conversion approved.");
                        }}>Approve</button>
                        <button className="btn sm danger" onClick={() => run(() => svc.rejectProposal(key), "Proposal rejected.")}>Reject</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="card flush">
        <div className="card-head">
          <h2>Conversions</h2>
          <label className="check small"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired</label>
        </div>
        {list.length ? (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Item</th><th>Rule</th><th>Approved</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {list.map((c) => {
                  const l = convLabel(c, md.items);
                  return (
                    <tr key={c.id} className={c.status !== "approved" ? "dim" : ""}>
                      <td>{l.target}</td>
                      <td>{l.rule}{c.notes && <div className="muted small">{c.notes}</div>}</td>
                      <td>{c.approvedBy ? nameOf(c.approvedBy) : "—"}<div className="muted small">{fmtDateTime(c.approvedAt)}</div></td>
                      <td><StatusPill s={c.status} /></td>
                      <td>{c.status === "approved" && <button className="btn sm danger" onClick={() => run(() => svc.retireConversion(c.id), "Conversion retired.")}>Retire</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No conversions yet">Quantities written in the item's base unit don't need one.</Empty>
        )}
      </div>
    </div>
  );
}

// ---------------- Substitution equivalences ----------------
const BASIS: Array<[SubstitutionEquivalence["basis"][number], string]> = [
  ["strength", "Strength"], ["form", "Dosage form"], ["pack_size", "Pack size"], ["base_unit", "Base unit"],
];

function EquivalencesTab() {
  const { state, svc, run, act, nameOf } = useApp();
  const { items: itemOpts } = useOptions();
  const md = state.md;
  const [showRetired, setShowRetired] = useState(false);
  const [v, setV] = useState({ requestedItemId: "", substituteItemId: "", factor: "", basis: [] as SubstitutionEquivalence["basis"], justification: "" });
  const list = Object.values(md.equivalences).filter((e) => showRetired || e.status === "approved").sort((a, b) => (b.approvedAt ?? "").localeCompare(a.approvedAt ?? ""));
  const proposals = proposalsOf(state.proposals, "equivalence");
  const req = md.items[v.requestedItemId];
  const sub = md.items[v.substituteItemId];
  return (
    <div className="stack">
      <div className="note-box">
        A substituted item counts toward the requested line's OFR only when an approved rule exists for that exact pair.
        The factor converts the substitute's base units into the requested item's base units. Example: Amoxicillin 250mg capsules supplied for
        Amoxicillin 500mg capsules, factor 0.5, so 40 capsules of 250mg count as 20 capsules of 500mg. Without a rule, the substitution is recorded but not credited.
      </div>
      <div className="card stack">
        <h2>Add an approved equivalence</h2>
        <div className="form-grid">
          <Field label="Requested item"><Picker id="eq-req" options={itemOpts} value={v.requestedItemId} onChange={(id) => setV({ ...v, requestedItemId: id })} /></Field>
          <Field label="Substitute item"><Picker id="eq-sub" options={itemOpts} value={v.substituteItemId} onChange={(id) => setV({ ...v, substituteItemId: id })} /></Field>
          <Field label="Factor" hint={req && sub ? `1 ${sub.baseUnit} of the substitute = ${v.factor || "?"} ${req.baseUnit} of the requested item` : "Substitute base units → requested base units"}>
            <input id="eq-factor" type="number" min="0" step="any" value={v.factor} onChange={(e) => setV({ ...v, factor: e.target.value })} placeholder="0.5" />
          </Field>
        </div>
        <fieldset className="admin-fieldset">
          <legend className="small">Basis for the equivalence</legend>
          <div className="row">
            {BASIS.map(([k, l]) => (
              <label key={k} className="check">
                <input type="checkbox" checked={v.basis.includes(k)} onChange={(e) => setV({ ...v, basis: e.target.checked ? [...v.basis, k] : v.basis.filter((b) => b !== k) })} /> {l}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Justification"><textarea id="eq-just" value={v.justification} onChange={(e) => setV({ ...v, justification: e.target.value })} placeholder="Same molecule and form; two 250mg capsules equal one 500mg dose." /></Field>
        <div className="row end">
          <button
            className="btn primary"
            disabled={!v.requestedItemId || !v.substituteItemId || !(Number(v.factor) > 0) || !v.basis.length || !v.justification.trim()}
            onClick={async () => {
              const ok = await act(() => svc.proposeEquivalence({ requestedItemId: v.requestedItemId, substituteItemId: v.substituteItemId, factor: Number(v.factor), basis: v.basis, justification: v.justification }), "Equivalence approved.");
              if (ok) setV({ requestedItemId: "", substituteItemId: "", factor: "", basis: [], justification: "" });
            }}
          >Approve equivalence</button>
        </div>
      </div>
      {proposals.length > 0 && (
        <div className="card flush">
          <div className="card-head"><h2>Proposed by Requisition Assistants</h2></div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Requested</th><th>Substitute</th><th className="num">Factor</th><th>Basis and justification</th><th>Proposed by</th><th></th></tr></thead>
              <tbody>
                {proposals.map(([key, p]) => (
                  <tr key={key}>
                    <td>{itemLabel(md.items[p.requestedItemId])}</td>
                    <td>{itemLabel(md.items[p.substituteItemId])}</td>
                    <td className="num">{fmtNum(p.factor, 6)}</td>
                    <td className="small">{p.basis.join(", ")}<div className="muted">{p.justification}</div></td>
                    <td>{nameOf(p.proposedBy)}</td>
                    <td className="row">
                      <button className="btn sm primary" onClick={() => {
                        const { kind: _k, ...eq } = p;
                        return run(() => svc.approveEquivalence(eq as SubstitutionEquivalence, key), "Equivalence approved.");
                      }}>Approve</button>
                      <button className="btn sm danger" onClick={() => run(() => svc.rejectProposal(key), "Proposal rejected.")}>Reject</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="card flush">
        <div className="card-head">
          <h2>Equivalences</h2>
          <label className="check small"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired</label>
        </div>
        {list.length ? (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Requested</th><th>Substitute</th><th className="num">Factor</th><th>Basis</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {list.map((e) => (
                  <tr key={e.id} className={e.status !== "approved" ? "dim" : ""}>
                    <td>{itemLabel(md.items[e.requestedItemId])}</td>
                    <td>{itemLabel(md.items[e.substituteItemId])}</td>
                    <td className="num">{fmtNum(e.factor, 6)}</td>
                    <td className="small">{e.basis.join(", ")}<div className="muted">{e.justification}</div></td>
                    <td><StatusPill s={e.status} /></td>
                    <td>{e.status === "approved" && <button className="btn sm danger" onClick={() => run(() => svc.retireEquivalence(e.id), "Equivalence retired.")}>Retire</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No equivalences yet">Substitutions are recorded but not credited to OFR until a rule is approved here.</Empty>
        )}
      </div>
    </div>
  );
}

// ---------------- Alias candidates ----------------
export function AliasCandidatesTab() {
  const { state, svc, run, actor } = useApp();
  const md = state.md;
  const list = proposalsOf(state.proposals, "alias").sort((a, b) => b[1].occurrences - a[1].occurrences);
  const target = (a: Alias) => (a.entityType === "facility" ? md.facilities[a.entityId]?.name : itemLabel(md.items[a.entityId])) ?? "Unknown";
  return (
    <div className="card flush">
      <div className="card-head">
        <p className="muted small">When an RA matches text as written to a facility or item, Nebula records it as a candidate alias. Approved aliases are used to match future requisitions.</p>
      </div>
      {list.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>As written</th><th>Matched to</th><th>Type</th><th className="num">Times seen</th><th></th></tr></thead>
            <tbody>
              {list.map(([key, a]) => (
                <tr key={key}>
                  <td>“{a.alias}”</td>
                  <td>{target(a)}</td>
                  <td>{a.entityType === "facility" ? "Facility" : "Item"}</td>
                  <td className="num">{a.occurrences}</td>
                  <td className="row">
                    {can(actor, "alias.approve") && (
                      <>
                        <button className="btn sm primary" onClick={() => run(() => svc.decideAlias(key, "approved"), "Alias approved.")}>Approve</button>
                        <button className="btn sm danger" onClick={() => run(() => svc.decideAlias(key, "rejected"), "Alias rejected.")}>Reject</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No alias candidates">Candidates appear as RAs confirm matches on requisitions.</Empty>
      )}
    </div>
  );
}

// ---------------- Users & roles ----------------
const GRANTS: Array<[Grant, string]> = [
  ["requisition.reopen", "Reopen finalized requisitions"],
  ["edit_request.approve", "Approve or reject edit requests"],
  ["documents.download", "Download original and evidence documents"],
];

function UsersTab() {
  const { state, svc, act, nameOf, platform, actor } = useApp();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Array<{ id: string; name: string }>>([]);
  const [added, setAdded] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const known = useMemo(() => {
    const s = new Set<string>([actor.id, ...Object.keys(state.roles), ...added]);
    for (const r of Object.values(state.reqs)) {
      [r.createdBy, r.validatedBy, r.finalizedBy, r.fulfillmentClosedBy, r.cancelledBy, r.reopenedBy].forEach((x) => x && s.add(x));
      Object.values(r.events).forEach((e) => s.add(e.recordedBy));
      Object.values(r.fulfillment).forEach((e) => s.add(e.recordedBy));
      Object.values(r.editRequests).forEach((e) => { s.add(e.requestedBy); if (e.decidedBy) s.add(e.decidedBy); });
    }
    return [...s].filter(Boolean);
  }, [state.reqs, state.roles, actor.id, added]);
  const search = async (text: string) => {
    setQ(text);
    if (!platform.user?.search) return setHits([]);
    try {
      const res = await platform.user.search(text);
      setHits((res ?? []).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })));
    } catch {
      setHits([]);
    }
  };
  return (
    <div className="stack">
      <div className="note-box">
        A person's highest role comes from how the artifact is shared with them: Editor or Owner = Administrator, Contributor = Requisition Assistant,
        Viewer or Commenter = Supervisor. Nebula can't read other people's share levels, so the list below shows the role you've set here, not their share level.
        Here you can lower a Contributor to Supervisor and give Supervisors extra permissions. To make someone an Administrator, share the artifact with them as an Editor.
      </div>
      <div className="card stack">
        <h2>Find a person</h2>
        {platform.user?.search ? (
          <div style={{ position: "relative" }}>
            <input className="input" id="user-search" placeholder="Search your organization by name" value={q} onChange={(e) => search(e.target.value)} onFocus={() => search(q)} />
            {hits.length > 0 && (
              <div className="search-results">
                {hits.map((h) => (
                  <a key={h.id} href="#" onMouseDown={(e) => { e.preventDefault(); setAdded((a) => [...new Set([...a, h.id])]); setEditing(h.id); setHits([]); setQ(""); }}>
                    {h.name}
                  </a>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="muted small">People search isn't available in this view. People appear below once they've used Nebula.</p>
        )}
      </div>
      <div className="card flush">
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Person</th><th>Role set in Nebula</th><th>Extra permissions</th><th>Last changed</th><th></th></tr></thead>
            <tbody>
              {known.map((id) => {
                const a = state.roles[id];
                return (
                  <tr key={id}>
                    <td>{nameOf(id)}{id === actor.id && <span className="muted small"> (you)</span>}</td>
                    <td>{a?.role === "supervisor" ? "Supervisor" : <span className="muted">Default (from share level)</span>}</td>
                    <td className="small">{a?.grants?.length ? a.grants.map((g) => GRANTS.find(([k]) => k === g)?.[1]).join("; ") : "—"}</td>
                    <td className="small">{a ? <>{nameOf(a.updatedBy)}<div className="muted">{fmtDateTime(a.updatedAt)}</div></> : "—"}</td>
                    <td>{id !== actor.id && <button className="btn sm" onClick={() => setEditing(id)}>Change</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {editing && <RoleModal userId={editing} onClose={() => setEditing(null)} save={(role, grants) => act(() => svc.saveRole(editing, role, grants), "Role saved.")} />}
    </div>
  );
}

function RoleModal({ userId, onClose, save }: { userId: string; onClose: () => void; save: (role: RoleCode, grants: Grant[]) => Promise<boolean> }) {
  const { state, nameOf } = useApp();
  const cur = state.roles[userId];
  const [role, setRole] = useState<"default" | "supervisor">(cur?.role === "supervisor" ? "supervisor" : "default");
  const [grants, setGrants] = useState<Grant[]>(cur?.grants ?? []);
  return (
    <Modal
      title={`Role for ${nameOf(userId)}`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={async () => { if (await save(role === "supervisor" ? "supervisor" : "ra", role === "supervisor" ? grants : [])) onClose(); }}>Save</button>
        </>
      }
    >
      <div className="stack tight">
        <label className="check"><input type="radio" name="role" checked={role === "default"} onChange={() => setRole("default")} /> Default: role follows the share level</label>
        <label className="check"><input type="radio" name="role" checked={role === "supervisor"} onChange={() => setRole("supervisor")} /> Supervisor: view-only, plus the permissions below</label>
      </div>
      {role === "supervisor" && (
        <fieldset className="admin-fieldset">
          <legend className="small">Extra permissions (explicit grants)</legend>
          <div className="stack tight">
            {GRANTS.map(([g, l]) => (
              <label key={g} className="check">
                <input type="checkbox" checked={grants.includes(g)} onChange={(e) => setGrants(e.target.checked ? [...grants, g] : grants.filter((x) => x !== g))} /> {l}
              </label>
            ))}
          </div>
          <p className="muted small">Reopening and approving write data, so they only work if this person is shared as a Contributor.</p>
        </fieldset>
      )}
    </Modal>
  );
}

// ---------------- Settings ----------------
function SettingsTab() {
  const { state, svc, run } = useApp();
  const [s, setS] = useState<Settings>(state.md.settings);
  const dirty = JSON.stringify(s) !== JSON.stringify(state.md.settings);
  return (
    <div className="card stack">
      <h2>Settings</h2>
      <div className="form-grid">
        <Field label="Low OFR threshold (%)" hint="Requisitions, facilities and items below this are flagged.">
          <input id="set-thr" type="number" min="1" max="100" value={s.ofrThresholdPercent} onChange={(e) => setS({ ...s, ofrThresholdPercent: Number(e.target.value) })} />
        </Field>
        <Field label="Threshold applies to">
          <select id="set-stage" value={s.ofrThresholdStage} onChange={(e) => setS({ ...s, ofrThresholdStage: e.target.value as FulfillmentStage })}>
            {FULFILLMENT_STAGES.map((st) => <option key={st} value={st}>{st[0].toUpperCase() + st.slice(1)} OFR</option>)}
          </select>
        </Field>
        <Field label="Edit window after approval (hours)">
          <input id="set-window" type="number" min="1" value={s.editWindowHours} onChange={(e) => setS({ ...s, editWindowHours: Number(e.target.value) })} />
        </Field>
        <Field label="Pending edit requests expire after (days)">
          <input id="set-timeout" type="number" min="1" value={s.editRequestPendingTimeoutDays} onChange={(e) => setS({ ...s, editRequestPendingTimeoutDays: Number(e.target.value) })} />
        </Field>
        <Field label="Default time basis for reports">
          <select id="set-basis" value={s.defaultTimeBasis} onChange={(e) => setS({ ...s, defaultTimeBasis: e.target.value as TimeBasis })}>
            <option value="received">Date received</option>
            <option value="requisition">Requisition date</option>
            <option value="entry">Entry date</option>
          </select>
        </Field>
      </div>
      <div className="row end">
        <button className="btn" disabled={!dirty} onClick={() => setS(state.md.settings)}>Discard</button>
        <button className="btn primary" disabled={!dirty} onClick={() => run(() => svc.saveSettings(s), "Settings saved.")}>Save settings</button>
      </div>
    </div>
  );
}

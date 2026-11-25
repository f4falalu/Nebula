// Administration tabs that exist only on the Nebula server (V2): AI document
// reading through OpenRouter, usage and credits, and user access.
import React, { useEffect, useMemo, useState } from "react";
import { useApp } from "../ui/context";
import { Empty, Field, Pill } from "../ui/kit";
import { fmtNum } from "../domain/text";
import { fmtDate, fmtDateTime, lagosDate, nowISO } from "../domain/time";
import type { AiSettings, AiUsage } from "../data/api";
import type { WebUser } from "../data/api-types";
import type { Grant, RoleCode } from "../domain/types";

const MODEL_SUGGESTIONS = ["google/gemini-2.5-flash", "openai/gpt-4o-mini", "anthropic/claude-sonnet-4.5"];
const usd = (n: number | null | undefined) => (n == null || !isFinite(n) ? "—" : `$${n.toFixed(n < 10 ? 2 : 0)}`);

type Limits = Pick<AiSettings, "maxPagesPerJob" | "perUserPagesPerDay" | "perUserJobsPerHour" | "orgMonthlyBudgetUsd" | "lowBalanceUsd">;
const LIMIT_FIELDS: Array<[keyof Limits, string, string]> = [
  ["perUserPagesPerDay", "Pages per person per day", "Counted by Lagos day."],
  ["perUserJobsPerHour", "Reading jobs per person per hour", "One job is one requisition read."],
  ["maxPagesPerJob", "Most pages read per requisition", "Pages beyond this are left for manual entry."],
  ["orgMonthlyBudgetUsd", "Monthly budget (USD)", "Reading stops for everyone when this month's spend reaches it."],
  ["lowBalanceUsd", "Warn when OpenRouter balance is below (USD)", "Shown on Usage & credits."],
];

export function AiTab() {
  const { api, act, refreshAi } = useApp();
  const [s, setS] = useState<AiSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [test, setTest] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const load = () =>
    api!.aiSettings().then((x) => {
      setS(x);
      setDraft({
        model: x.model ?? "", fallbackModel: x.fallbackModel ?? "",
        ...Object.fromEntries(LIMIT_FIELDS.map(([k]) => [k, String(x[k] ?? "")])),
      });
      setErr(null);
    }).catch((e) => setErr(e instanceof Error ? e.message : "AI settings couldn't be loaded."));
  useEffect(() => {
    if (api) void load();
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!api) return null;
  if (err) return <div className="banner bad">{err}</div>;
  if (!s) return <div className="boot">Loading AI settings…</div>;

  const save = async (enabled = s.enabled) => {
    const body = {
      enabled,
      model: draft.model.trim(),
      fallbackModel: draft.fallbackModel.trim() || null,
      ...Object.fromEntries(LIMIT_FIELDS.map(([k]) => [k, Number(draft[k])])),
    } as Omit<AiSettings, "keyConfigured" | "keyHint" | "keySource">;
    if (await act(() => api.saveAiSettings(body), "AI settings saved")) {
      await load();
      refreshAi();
    }
  };

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row between">
          <div>
            <h2>Reading requisitions with AI</h2>
            <p className="muted small">Nebula sends the pages of a newly registered requisition to the model you choose on OpenRouter and suggests the lines. Requisition Assistants still confirm every value.</p>
          </div>
          <label className="check">
            <input id="ai-enabled" type="checkbox" checked={s.enabled} onChange={(e) => void save(e.target.checked)} />
            {s.enabled ? "On" : "Off"}
          </label>
        </div>
        {!s.keyConfigured && <div className="banner warn">Add an OpenRouter API key below before turning reading on.</div>}
      </div>

      <div className="card stack">
        <h3>OpenRouter API key</h3>
        <p className="muted small">The key is stored encrypted on the server. Nobody can read it back, including Administrators. Create one at openrouter.ai under Keys.</p>
        {s.keyConfigured && !replacing ? (
          <div className="row">
            <Pill tone="good">Key saved{s.keyHint ? `, ending …${s.keyHint}` : ""}</Pill>
            {s.keySource === "environment" && <span className="muted small">From the server's OPENROUTER_API_KEY setting. A key saved here takes priority.</span>}
            <button className="btn sm" onClick={() => setReplacing(true)}>Replace</button>
            {s.keySource === "database" && (
              <button className="btn sm danger" onClick={async () => { if (await act(() => api.removeAiKey(), "Key removed")) { await load(); refreshAi(); } }}>Remove</button>
            )}
          </div>
        ) : (
          <div className="row">
            <input id="ai-key" className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-or-…" style={{ maxWidth: 360 }} />
            <button className="btn primary" disabled={key.trim().length < 10} onClick={async () => {
              if (await act(() => api.setAiKey(key.trim()), "Key saved")) {
                setKey("");
                setReplacing(false);
                await load();
                refreshAi();
              }
            }}>Save key</button>
            {replacing && <button className="btn" onClick={() => { setReplacing(false); setKey(""); }}>Cancel</button>}
          </div>
        )}
        <div className="row">
          <button className="btn" disabled={!s.keyConfigured || testing} onClick={async () => {
            setTesting(true);
            setTest(null);
            try {
              const r = await api.testAi();
              setTest(r.ok ? `Connected: ${r.model ?? draft.model} answered in ${r.latencyMs ?? "?"} ms.` : `Failed: ${r.error ?? "unknown error"}`);
            } catch (e) {
              setTest(`Failed: ${e instanceof Error ? e.message : "unknown error"}`);
            } finally {
              setTesting(false);
            }
          }}>{testing ? "Testing…" : "Test connection"}</button>
          {test && <span className={`small ${test.startsWith("Failed") ? "" : "muted"}`} style={test.startsWith("Failed") ? { color: "var(--bad)" } : undefined}>{test}</span>}
        </div>
      </div>

      <div className="card stack">
        <h3>Model</h3>
        <div className="form-grid">
          <Field label="Model" hint="Any OpenRouter model id that accepts images.">
            <input id="ai-model" list="ai-model-list" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          </Field>
          <Field label="Fallback model" hint="Used when the main model fails. Optional.">
            <input id="ai-fallback" list="ai-model-list" value={draft.fallbackModel} onChange={(e) => setDraft({ ...draft, fallbackModel: e.target.value })} />
          </Field>
        </div>
        <datalist id="ai-model-list">{MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}</datalist>
        <p className="muted small">Suggestions: {MODEL_SUGGESTIONS.join(", ")}. Compare prices and image support on openrouter.ai/models.</p>
      </div>

      <div className="card stack">
        <h3>Limits</h3>
        <p className="muted small">Nebula enforces these from its own usage ledger, so they hold across restarts. A requisition refused by a limit goes back to manual entry with the reason shown.</p>
        <div className="form-grid">
          {LIMIT_FIELDS.map(([k, label, hint]) => (
            <Field key={k} label={label} hint={hint}>
              <input id={`ai-${k}`} type="number" min={0} step="any" value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        <div className="row end"><button className="btn primary" disabled={!draft.model?.trim()} onClick={() => void save()}>Save model and limits</button></div>
      </div>
    </div>
  );
}

export function UsageTab() {
  const { api, nameOf } = useApp();
  const [month, setMonth] = useState(() => lagosDate(nowISO()).slice(0, 7));
  const [u, setU] = useState<AiUsage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [low, setLow] = useState<number | null>(null);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    setU(null);
    api.aiUsage(month).then((x) => alive && (setU(x), setErr(null))).catch((e) => alive && setErr(e instanceof Error ? e.message : "Usage couldn't be loaded."));
    api.aiSettings().then((s) => alive && setLow(s.lowBalanceUsd)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, month]);
  if (!api) return null;
  const pct = u && u.budget.monthlyBudgetUsd > 0 ? Math.min(100, (u.budget.spentUsd / u.budget.monthlyBudgetUsd) * 100) : 0;
  const remaining = u?.openrouter?.remaining ?? (u?.openrouter?.total_credits != null && u?.openrouter?.total_usage != null ? u.openrouter.total_credits - u.openrouter.total_usage : null);
  const lowBalance = u?.lowBalance ?? (remaining != null && low != null && remaining < low);
  return (
    <div className="stack">
      <div className="card stack">
        <div className="row between">
          <h2>Usage &amp; credits</h2>
          <Field label="Month"><input id="usage-month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
        </div>
        <p className="muted small">
          Credits are bought on OpenRouter by an Administrator: top up the OpenRouter account that owns the API key. Nebula records the cost of every reading job and stops reading when this month's budget or a person's daily limit is reached.
        </p>
      </div>
      {err && <div className="banner bad">{err}</div>}
      {!u && !err && <div className="boot">Loading usage…</div>}
      {u && (
        <>
          {lowBalance && <div className="banner warn">The OpenRouter balance is {usd(remaining)}, below your alert level of {usd(low)}. <a href="https://openrouter.ai/settings/credits" target="_blank" rel="noreferrer">Top up on OpenRouter</a>.</div>}
          <div className="grid2">
            <div className="card stack">
              <span className="eyebrow">This month's budget</span>
              <div className="admin-big">{usd(u.budget.spentUsd)} <span className="muted small">of {usd(u.budget.monthlyBudgetUsd)}</span></div>
              <div className="bar-track" role="img" aria-label={`${pct.toFixed(0)}% of the monthly budget used`}>
                <div className="bar-fill" style={{ width: `${pct}%`, background: pct >= 100 ? "var(--bad)" : pct >= 80 ? "var(--warn)" : undefined }} />
              </div>
              <span className="muted small">{usd(u.budget.remainingUsd)} left this month{pct >= 100 ? ". Reading is paused until next month or until the budget is raised." : "."}</span>
            </div>
            <div className="card stack">
              <span className="eyebrow">OpenRouter balance</span>
              {u.openrouter ? (
                <>
                  <div className="admin-big">{usd(remaining)}</div>
                  <span className="muted small">{usd(u.openrouter.total_usage)} used of {usd(u.openrouter.total_credits)} bought in total.</span>
                </>
              ) : (
                <span className="muted small">{u.openrouterNote || "The balance couldn't be read from OpenRouter."}</span>
              )}
              <a className="btn sm" style={{ alignSelf: "flex-start" }} href="https://openrouter.ai/settings/credits" target="_blank" rel="noreferrer">Buy credits on OpenRouter</a>
            </div>
          </div>
          <div className="stats">
            <div className="stat"><span className="label">Cost</span><span className="value">{usd(u.totals.costUsd)}</span></div>
            <div className="stat"><span className="label">Pages read</span><span className="value">{fmtNum(u.totals.pages)}</span></div>
            <div className="stat"><span className="label">Reading jobs</span><span className="value">{fmtNum(u.totals.jobs)}</span></div>
            <div className="stat"><span className="label">Failed</span><span className="value">{fmtNum(u.totals.errors)}</span></div>
            <div className="stat"><span className="label">Refused by a limit</span><span className="value">{fmtNum(u.totals.refused)}</span></div>
          </div>
          <div className="grid2">
            <div className="card flush">
              <div className="card-head"><h3>By person</h3></div>
              {u.users.length ? (
                <div className="table-wrap">
                  <table className="t">
                    <thead><tr><th>Person</th><th className="num">Jobs</th><th className="num">Pages</th><th className="num">Cost</th></tr></thead>
                    <tbody>{u.users.map((r) => <tr key={r.userId}><td>{nameOf(r.userId)}</td><td className="num">{fmtNum(r.jobs)}</td><td className="num">{fmtNum(r.pages)}</td><td className="num">{usd(r.costUsd)}</td></tr>)}</tbody>
                  </table>
                </div>
              ) : <div className="empty small">No reading this month.</div>}
            </div>
            <div className="card flush">
              <div className="card-head"><h3>By day</h3></div>
              {u.days.length ? (
                <div className="table-wrap">
                  <table className="t">
                    <thead><tr><th>Day</th><th className="num">Jobs</th><th className="num">Pages</th><th className="num">Cost</th></tr></thead>
                    <tbody>{u.days.map((r) => <tr key={r.day}><td>{fmtDate(r.day.slice(0, 10))}</td><td className="num">{fmtNum(r.jobs)}</td><td className="num">{fmtNum(r.pages)}</td><td className="num">{usd(r.costUsd)}</td></tr>)}</tbody>
                  </table>
                </div>
              ) : <div className="empty small">No reading this month.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const GRANTS: Array<[Grant, string]> = [
  ["requisition.reopen", "Reopen finalized requisitions"],
  ["edit_request.approve", "Approve or reject edit requests"],
  ["documents.download", "Download documents"],
];
const ROLE_OPTIONS: Array<[RoleCode, string]> = [["ra", "Requisition Assistant"], ["supervisor", "Supervisor"], ["admin", "Administrator"]];
const STATUS_TONE = { pending: "warn", active: "good", inactive: undefined } as const;

export function WebUsersTab() {
  const { state, api, act, actor } = useApp();
  const users = useMemo(() => {
    const order = { pending: 0, active: 1, inactive: 2 } as const;
    return [...(state.users ?? [])].sort((a, b) => order[a.status] - order[b.status] || (a.name || a.email || "").localeCompare(b.name || b.email || ""));
  }, [state.users]);
  const pending = users.filter((u) => u.status === "pending").length;
  if (!api) return null;
  return (
    <div className="stack">
      <div className="card stack">
        <h2>Users &amp; roles</h2>
        <p className="muted small">
          People sign in with their own account. The first time they sign in, Nebula creates a pending account; it can't see any data until you activate it and choose a role.
          Supervisors are view-only unless you give them one of the extra permissions.
        </p>
        {pending > 0 && <div className="banner warn">{pending} {pending === 1 ? "person is" : "people are"} waiting for access.</div>}
      </div>
      {users.length === 0 ? <Empty title="No users yet" /> : (
        <div className="card flush">
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Person</th><th>Status</th><th>Role</th><th>Extra permissions</th><th></th></tr></thead>
              <tbody>{users.map((u) => <UserRow key={u.id} u={u} self={u.id === actor.id} grantsOf={state.roles[u.id]?.grants ?? []} save={(access) => act(() => api.setUserAccess(u.id, access), "Access updated")} />)}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function UserRow({ u, self, grantsOf, save }: { u: WebUser; self: boolean; grantsOf: Grant[]; save: (a: { status: WebUser["status"]; role: RoleCode | null; grants: Grant[] }) => Promise<boolean> }) {
  const [role, setRole] = useState<RoleCode>(u.role ?? "ra");
  const [grants, setGrants] = useState<Grant[]>(grantsOf);
  useEffect(() => setRole(u.role ?? "ra"), [u.role]);
  useEffect(() => setGrants(grantsOf), [grantsOf.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = role !== (u.role ?? "ra") || grants.slice().sort().join(",") !== grantsOf.slice().sort().join(",");
  return (
    <tr style={u.status === "pending" ? { background: "var(--warn-soft)" } : undefined}>
      <td>
        <b>{u.name || u.email || "Unnamed account"}</b>
        {u.email && u.name && <div className="muted small">{u.email}</div>}
        {u.createdAt && <div className="muted small">Signed up {fmtDateTime(u.createdAt)}</div>}
        {self && <div className="muted small">This is you</div>}
      </td>
      <td><Pill tone={STATUS_TONE[u.status]}>{u.status[0].toUpperCase() + u.status.slice(1)}</Pill></td>
      <td>
        <select id={`role-${u.id}`} className="input sm" value={role} disabled={self} onChange={(e) => setRole(e.target.value as RoleCode)}>
          {ROLE_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </td>
      <td>
        {role === "supervisor" ? (
          <div className="stack tight">
            {GRANTS.map(([g, l]) => (
              <label key={g} className="check small">
                <input type="checkbox" checked={grants.includes(g)} onChange={(e) => setGrants(e.target.checked ? [...grants, g] : grants.filter((x) => x !== g))} /> {l}
              </label>
            ))}
          </div>
        ) : <span className="muted small">{role === "admin" ? "All permissions" : "Not applicable"}</span>}
      </td>
      <td>
        <div className="row">
          {u.status === "pending" && <button className="btn sm primary" onClick={() => save({ status: "active", role, grants: role === "supervisor" ? grants : [] })}>Activate</button>}
          {u.status === "active" && changed && !self && <button className="btn sm primary" onClick={() => save({ status: "active", role, grants: role === "supervisor" ? grants : [] })}>Save</button>}
          {u.status === "active" && !self && <button className="btn sm danger" onClick={() => save({ status: "inactive", role: u.role ?? role, grants: [] })}>Deactivate</button>}
          {u.status === "inactive" && <button className="btn sm" onClick={() => save({ status: "active", role, grants: role === "supervisor" ? grants : [] })}>Reactivate</button>}
        </div>
      </td>
    </tr>
  );
}

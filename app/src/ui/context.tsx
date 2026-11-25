import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Platform } from "../data/platform";
import { resolveNames } from "../data/platform";
import type { Doc, Store } from "../data/store";
import { Services } from "../data/services";
import { UserError, type AppState, type NebulaServices, type Proposal } from "../data/api-types";
import type { AiStatus, ApiServices, Me } from "../data/api";
import { resolveActor, type Actor } from "../domain/permissions";
import { DEFAULT_SETTINGS, type MasterData, type Requisition, type RoleAssignment, type Settings } from "../domain/types";

/** Where the data lives: the claude.ai artifact (V1) or the Nebula server (V2). */
export type Backend =
  | { kind: "artifact"; platform: Platform; store: Store }
  | { kind: "web"; api: ApiServices; me: Me; signOut: () => void; accountLabel?: string };

export interface Caps {
  /** "artifact" = V1 on claude.ai; "web" = V2 on Nebula's own server. */
  mode: "artifact" | "web";
  /** Reading documents with AI is available right now. */
  aiReading: boolean;
  /** Name shown for the reading feature ("Claude" in V1, "AI" in V2). */
  aiName: string;
  /** Why reading isn't available, when it isn't. */
  aiUnavailableReason: string;
  /** Files can be offered for download/export in this view. */
  downloads: boolean;
}

export interface Ctx {
  platform: Platform;
  store: Store;
  state: AppState;
  loaded: boolean;
  loadNote: string | null;
  actor: Actor;
  svc: NebulaServices;
  /** V2 only: the API client (AI settings, usage, users, audit paging). */
  api: ApiServices | null;
  me: Me | null;
  caps: Caps;
  signOut: (() => void) | null;
  accountLabel: string | null;
  refreshAi: () => void;
  names: Record<string, string>;
  nameOf: (id?: string | null) => string;
  toast: (msg: string, bad?: boolean) => void;
  run: <T>(f: () => Promise<T>, ok?: string) => Promise<T | undefined>;
  /** Like run, but resolves true on success and false on error. */
  act: (f: () => Promise<unknown>, ok?: string) => Promise<boolean>;
}

const C = createContext<Ctx | null>(null);
export const useApp = () => useContext(C)!;

const COLLECTIONS = ["reqs", "facilities", "items", "programmes", "aliases", "conversions", "equivalences", "config", "proposals"] as const;

function emptyState(): AppState {
  return {
    reqs: {},
    md: { facilities: {}, items: {}, programmes: {}, conversions: {}, equivalences: {}, aliases: {}, settings: DEFAULT_SETTINGS },
    roles: {},
    proposals: {},
  };
}

// In V2 the pages never touch the artifact store; this placeholder only answers `live`.
const WEB_STORE: Store = {
  live: true,
  watch: () => () => undefined,
  get: async () => undefined,
  set: async () => { throw new UserError("Not available on this server."); },
  update: async () => { throw new UserError("Not available on this server."); },
  remove: async () => { throw new UserError("Not available on this server."); },
  nextSerial: async () => { throw new UserError("Not available on this server."); },
};

function webPlatform(me: Me): Platform {
  return { db: null, user: null, assets: null, sample: null, downloads: null, userId: me.id, ceiling: me.role ?? "supervisor", imageLimits: null };
}

export function AppProvider({ backend, children }: { backend: Backend; children: React.ReactNode }) {
  const web = backend.kind === "web" ? backend : null;
  const art = backend.kind === "artifact" ? backend : null;
  const platform = useMemo(() => (art ? art.platform : webPlatform(web!.me)), [art, web]);
  const store = art ? art.store : WEB_STORE;

  const [state, setState] = useState<AppState>(() => (web ? web.api.state : emptyState()));
  const stateRef = useRef(state);
  stateRef.current = state;
  const [loadedSet, setLoaded] = useState<Set<string>>(new Set());
  const [webLoaded, setWebLoaded] = useState(web ? web.api.loaded : false);
  const [loadNote, setLoadNote] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string; bad?: boolean }>>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);

  // ----- V1: live subscriptions to the artifact database
  useEffect(() => {
    if (!art) return;
    const timer = setTimeout(() => setLoadNote("The shared data is taking a while to load. What you see may be out of date."), 10000);
    const unsubs = COLLECTIONS.map((c) =>
      art.store.watch(
        c,
        (docs: Record<string, Doc>, fromCache) => {
          if (!fromCache) clearTimeout(timer);
          setLoaded((s) => (s.has(c) ? s : new Set(s).add(c)));
          setState((prev) => {
            const next: AppState = { ...prev, md: { ...prev.md } };
            const copy = <T,>() => Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, v as unknown as T]));
            if (c === "reqs") next.reqs = copy<Requisition>();
            else if (c === "config") {
              next.md.settings = { ...DEFAULT_SETTINGS, ...((docs.settings as Partial<Settings>) ?? {}) };
              next.roles = (docs.roles as unknown as Record<string, RoleAssignment>) ?? {};
            } else if (c === "proposals") next.proposals = copy<Proposal>();
            else (next.md as unknown as Record<string, unknown>)[c] = copy();
            return next;
          });
        },
        (msg) => {
          clearTimeout(timer);
          setLoadNote(msg);
        },
      ),
    );
    return () => {
      clearTimeout(timer);
      unsubs.forEach((u) => u());
    };
  }, [art]);

  // ----- V2: state cache in the API client, refreshed by polling and after each change
  useEffect(() => {
    if (!web) return;
    const api = web.api;
    const unsub = api.subscribe(() => {
      setState(api.state);
      setWebLoaded(api.loaded);
      setLoadNote(api.loadError && api.loaded ? `Couldn't refresh: ${api.loadError}` : api.loadError);
    });
    const stop = api.startPolling();
    return () => {
      unsub();
      stop();
    };
  }, [web]);

  const refreshAi = useCallback(() => {
    if (!web) return;
    web.api.aiStatus().then(setAiStatus).catch(() => setAiStatus({ enabled: false, readyForReading: false, reason: "AI reading status couldn't be checked." }));
  }, [web]);
  useEffect(() => {
    refreshAi();
  }, [refreshAi]);

  const userId = web ? web.me.id : platform.userId ?? "preview-user";
  const actor: Actor = useMemo(() => {
    if (web) {
      const role = web.me.role ?? "supervisor";
      return { id: web.me.id, role, grants: role === "supervisor" ? web.me.grants : [], canWrite: true, ceiling: role };
    }
    return resolveActor(userId, platform.ceiling, state.roles[userId]);
  }, [web, userId, platform.ceiling, state.roles]);

  const svc: NebulaServices = useMemo(
    () => (web ? web.api : new Services(store, platform, actor, () => stateRef.current)),
    [web, store, platform, actor],
  );

  // Display names for every user id the state mentions.
  const ids = useMemo(() => {
    const s = new Set<string>([userId, ...Object.keys(state.roles)]);
    for (const r of Object.values(state.reqs)) {
      [r.createdBy, r.validatedBy, r.finalizedBy, r.firstValidatedBy, r.fulfillmentClosedBy, r.cancelledBy, r.reopenedBy].forEach((x) => x && s.add(x));
      Object.values(r.events).forEach((e) => s.add(e.recordedBy));
      Object.values(r.fulfillment).forEach((e) => s.add(e.recordedBy));
      Object.values(r.editRequests).forEach((e) => { s.add(e.requestedBy); if (e.decidedBy) s.add(e.decidedBy); });
    }
    return [...s].sort().join("|");
  }, [state.reqs, state.roles, userId]);
  useEffect(() => {
    if (web) {
      const n: Record<string, string> = {};
      for (const u of state.users ?? []) n[u.id] = u.name || u.email || "Someone";
      n[web.me.id] = web.me.name || web.me.email || "You";
      setNames(n);
      return;
    }
    let alive = true;
    resolveNames(platform.user, ids.split("|")).then((n) => alive && setNames((p) => ({ ...p, ...n })));
    return () => {
      alive = false;
    };
  }, [ids, platform.user, web, state.users]);

  const toast = useCallback((msg: string, bad?: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, bad }].slice(-4));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 7000 : 3500);
  }, []);

  const run = useCallback(
    async <T,>(f: () => Promise<T>, ok?: string) => {
      try {
        const r = await f();
        if (ok) toast(ok);
        return r;
      } catch (e: unknown) {
        const err = e as { code?: string; message?: string };
        const msg =
          e instanceof UserError ? e.message
          : err?.code === "invalid_argument" ? "The change was refused. Your access level may not allow it."
          : err?.code === "quota_exceeded" ? "The shared database is full. Ask the owner to archive old data."
          : err?.message || "Something went wrong. Try again.";
        toast(msg, true);
        return undefined;
      }
    },
    [toast],
  );

  const act = useCallback(
    async (f: () => Promise<unknown>, ok?: string) => {
      let failed = false;
      await run(async () => {
        try {
          return await f();
        } catch (e) {
          failed = true;
          throw e;
        }
      }, ok);
      return !failed;
    },
    [run],
  );

  const nameOf = useCallback(
    (id?: string | null) => (!id ? "System" : id === userId ? `${names[id] && names[id] !== "Someone" ? names[id] : "You"}` : names[id] || "Someone"),
    [names, userId],
  );

  const caps: Caps = useMemo(() => {
    if (web) {
      return {
        mode: "web",
        aiReading: !!aiStatus?.readyForReading,
        aiName: "AI",
        aiUnavailableReason: aiStatus?.reason || (aiStatus ? "Reading with AI is switched off. An Administrator can turn it on in Administration." : "Checking whether AI reading is available…"),
        downloads: true,
      };
    }
    return {
      mode: "artifact",
      aiReading: !!(platform.sample && platform.imageLimits),
      aiName: "Claude",
      aiUnavailableReason: store.live ? "Reading with Claude isn't available in this view." : "Preview mode can't use Claude.",
      downloads: !!platform.downloads,
    };
  }, [web, aiStatus, platform, store.live]);

  const loaded = web ? webLoaded : COLLECTIONS.every((c) => loadedSet.has(c));
  const ctx: Ctx = {
    platform, store, state, loaded, loadNote, actor, svc, api: web ? web.api : null, me: web ? web.me : null, caps,
    signOut: web ? web.signOut : null, accountLabel: web ? web.accountLabel ?? null : null, refreshAi,
    names, nameOf, toast, run, act,
  };
  return (
    <C.Provider value={ctx}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.bad ? "bad" : ""}`}>{t.msg}</div>
        ))}
      </div>
    </C.Provider>
  );
}

export function mdOf(ctx: Ctx): MasterData {
  return ctx.state.md;
}

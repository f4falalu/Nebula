import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Platform } from "../data/platform";
import { resolveNames } from "../data/platform";
import type { Doc, Store } from "../data/store";
import { Services, UserError, type AppState, type Proposal } from "../data/services";
import { resolveActor, type Actor } from "../domain/permissions";
import { DEFAULT_SETTINGS, type MasterData, type Requisition, type RoleAssignment, type Settings } from "../domain/types";

export interface Ctx {
  platform: Platform;
  store: Store;
  state: AppState;
  loaded: boolean;
  loadNote: string | null;
  actor: Actor;
  svc: Services;
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

export function AppProvider({ platform, store, children }: { platform: Platform; store: Store; children: React.ReactNode }) {
  const [state, setState] = useState<AppState>(emptyState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [loadedSet, setLoaded] = useState<Set<string>>(new Set());
  const [loadNote, setLoadNote] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string; bad?: boolean }>>([]);
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    const timer = setTimeout(() => setLoadNote("The shared data is taking a while to load. What you see may be out of date."), 10000);
    const unsubs = COLLECTIONS.map((c) =>
      store.watch(
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
  }, [store]);

  const userId = platform.userId ?? "preview-user";
  const actor = useMemo(() => resolveActor(userId, platform.ceiling, state.roles[userId]), [userId, platform.ceiling, state.roles]);
  const svc = useMemo(() => new Services(store, platform, actor, () => stateRef.current), [store, platform, actor]);

  // Resolve display names for every user id the state mentions.
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
    let alive = true;
    resolveNames(platform.user, ids.split("|")).then((n) => alive && setNames((p) => ({ ...p, ...n })));
    return () => {
      alive = false;
    };
  }, [ids, platform.user]);

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

  const nameOf = useCallback((id?: string | null) => (!id ? "System" : id === userId ? `${names[id] && names[id] !== "Someone" ? names[id] : "You"}` : names[id] || "Someone"), [names, userId]);

  const loaded = COLLECTIONS.every((c) => loadedSet.has(c));
  const ctx: Ctx = { platform, store, state, loaded, loadNote, actor, svc, names, nameOf, toast, run, act };
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

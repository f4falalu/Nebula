// Storage adapter. In the published page this wraps the claude.ai `db`
// capability; anywhere else (local preview, tests) it falls back to an
// in-memory store kept in localStorage. Both expose the same small API.

export type Doc = Record<string, unknown>;
export type Unsub = () => void;

export interface Store {
  live: boolean; // true = shared claude.ai database
  watch(collection: string, cb: (docs: Record<string, Doc>, fromCache: boolean) => void, onError?: (msg: string) => void): Unsub;
  get(path: string): Promise<Doc | undefined>;
  set(path: string, data: Doc): Promise<void>;
  /** Deep-merges nested objects; requires the document to exist. */
  update(path: string, data: Doc): Promise<void>;
  remove(path: string): Promise<void>;
  /** Transaction-safe per-day counter: returns the next serial for `key`. */
  nextSerial(key: string): Promise<number>;
}

// ---------------- claude.ai db ----------------
/* eslint-disable @typescript-eslint/no-explicit-any */
export function dbStore(db: any, holder: string): Store {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const retry = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e: any) {
      if (e?.code === "unavailable") {
        await sleep(300 + Math.random() * 500);
        return f();
      }
      throw e;
    }
  };
  return {
    live: true,
    watch(collection, cb, onError) {
      return db.collection(collection).onSnapshot(
        (snap: any) => {
          const out: Record<string, Doc> = {};
          for (const d of snap.docs) if (d.exists) out[d.id] = d.data();
          cb(out, snap.metadata?.fromCache ?? false);
        },
        (e: any) => onError?.(e?.code === "revoked" ? "Access to the shared data was withdrawn." : `Couldn't load ${collection} (${e?.code ?? "error"}).`),
      );
    },
    async get(path) {
      const s = await retry(() => db.doc(path).get());
      return (s as any).exists ? ((s as any).data() as Doc) : undefined;
    },
    set: (path, data) => retry(() => db.doc(path).set(data)),
    update: (path, data) => retry(() => db.doc(path).update(data)),
    remove: (path) => retry(() => db.doc(path).delete()),
    async nextSerial(key) {
      const ref = db.doc(`counters/${key}`);
      for (let attempt = 0; attempt < 40; attempt++) {
        const lease = await ref.acquire({ holder, ttlMs: 5000 });
        if (lease.acquired) {
          const snap = await ref.get();
          const last = Number((snap.exists && snap.data()?.last) || 0);
          const next = last + 1;
          if (snap.exists) await ref.update({ last: next });
          else await ref.set({ last: next });
          return next;
        }
        await sleep(150 + Math.random() * 250);
      }
      throw new Error("Couldn't reserve a requisition number. Try again in a moment.");
    },
  };
}

// ---------------- in-memory (preview) ----------------
function isObj(v: unknown): v is Doc {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge(target: Doc, patch: Doc): Doc {
  const out: Doc = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Doc, v) : v;
  }
  return out;
}

export function memoryStore(storageKey = "nebula-preview-v1", seed?: Record<string, Doc>): Store {
  let data: Record<string, Doc> = {};
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(storageKey) : null;
    if (raw) data = JSON.parse(raw);
  } catch {
    /* storage unavailable */
  }
  if (!Object.keys(data).length && seed) data = JSON.parse(JSON.stringify(seed));
  const listeners = new Map<string, Set<(docs: Record<string, Doc>, fromCache: boolean) => void>>();
  const persist = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch {
      /* ignore */
    }
  };
  const collectionOf = (path: string) => path.split("/").slice(0, -1).join("/");
  const snapshot = (collection: string) => {
    const prefix = collection + "/";
    const out: Record<string, Doc> = {};
    for (const [p, d] of Object.entries(data)) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) out[p.slice(prefix.length)] = d;
    }
    return out;
  };
  const emit = (path: string) => {
    const c = collectionOf(path);
    const ls = listeners.get(c);
    if (!ls) return;
    const snap = snapshot(c);
    queueMicrotask(() => ls.forEach((cb) => cb(snap, false)));
  };
  const write = (path: string, d: Doc | undefined) => {
    if (d === undefined) delete data[path];
    else data[path] = JSON.parse(JSON.stringify(d));
    persist();
    emit(path);
  };
  return {
    live: false,
    watch(collection, cb) {
      if (!listeners.has(collection)) listeners.set(collection, new Set());
      listeners.get(collection)!.add(cb);
      const snap = snapshot(collection);
      queueMicrotask(() => cb(snap, false));
      return () => listeners.get(collection)?.delete(cb);
    },
    async get(path) {
      return data[path] ? JSON.parse(JSON.stringify(data[path])) : undefined;
    },
    async set(path, d) {
      write(path, d);
    },
    async update(path, d) {
      if (!data[path]) throw Object.assign(new Error(`No document at ${path}`), { code: "invalid_argument" });
      write(path, deepMerge(data[path], d));
    },
    async remove(path) {
      write(path, undefined);
    },
    async nextSerial(key) {
      const p = `counters/${key}`;
      const next = Number(data[p]?.last ?? 0) + 1;
      write(p, { last: next });
      return next;
    },
  };
}

// V2 entry: Nebula served by its own server. Sign-in with Clerk (or, on a
// development server only, a labelled dev sign-in), then the same app as V1
// with all data and rules going through the REST API.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiServices, type Me, type PublicConfig } from "./data/api";
import { AppProvider, type Backend } from "./ui/context";
import { App } from "./ui/App";

type ClerkLike = {
  load: (o?: Record<string, unknown>) => Promise<void>;
  user: { primaryEmailAddress?: { emailAddress?: string } | null; fullName?: string | null } | null | undefined;
  session: { getToken: () => Promise<string | null> } | null | undefined;
  mountSignIn: (el: HTMLDivElement, props?: Record<string, unknown>) => void;
  unmountSignIn: (el: HTMLDivElement) => void;
  signOut: () => Promise<void>;
  addListener: (cb: (e: unknown) => void) => () => void;
};

const DEV_KEY = "nebula-dev-auth";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand">
          <div className="brand-mark">Nb</div>
          <div>
            <b>Nebula</b>
            <span>Requisition audit · V2</span>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function Message({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Shell>
      <h1 style={{ fontSize: "1.3rem" }}>{title}</h1>
      {children && <div className="muted">{children}</div>}
      {action}
    </Shell>
  );
}

function ClerkSignIn({ clerk }: { clerk: ClerkLike }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    clerk.mountSignIn(el, {});
    return () => clerk.unmountSignIn(el);
  }, [clerk]);
  return (
    <Shell>
      <p className="muted">Sign in to Nebula to continue.</p>
      <div ref={ref} />
    </Shell>
  );
}

function DevSignIn({ onDone }: { onDone: (email: string, role: string) => void }) {
  const [email, setEmail] = useState("admin@example.org");
  const [role, setRole] = useState("admin");
  return (
    <Shell>
      <div className="banner warn">Development sign-in. This server has no Clerk key and runs in development mode. Never use this in production.</div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) onDone(email.trim(), role);
        }}
      >
        <label className="field">
          <span>Email</span>
          <input id="dev-email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Role</span>
          <select id="dev-role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="admin">Administrator</option>
            <option value="ra">Requisition Assistant</option>
            <option value="supervisor">Supervisor</option>
          </select>
        </label>
        <button className="btn primary" type="submit">Sign in (development)</button>
      </form>
    </Shell>
  );
}

type Phase =
  | { k: "loading"; note?: string }
  | { k: "error"; message: string }
  | { k: "signin-clerk"; clerk: ClerkLike }
  | { k: "signin-dev" }
  | { k: "pending"; me: Me; signOut: () => void }
  | { k: "ready"; backend: Backend };

function Root() {
  const [phase, setPhase] = useState<Phase>({ k: "loading" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const set = (p: Phase) => alive && setPhase(p);
    (async () => {
      let cfg: PublicConfig;
      try {
        cfg = await ApiServices.config();
      } catch {
        return set({ k: "error", message: "Nebula's server can't be reached. Check your connection and reload." });
      }

      const enter = async (api: ApiServices, signOut: () => void, label: string) => {
        let me: Me;
        try {
          me = await api.me();
        } catch (e) {
          return set({ k: "error", message: e instanceof Error ? e.message : "Your account couldn't be loaded." });
        }
        if (me.status !== "active" || !me.role) return set({ k: "pending", me, signOut });
        await api.refresh();
        set({ k: "ready", backend: { kind: "web", api, me, signOut, accountLabel: label } });
      };

      // Development server without Clerk: header-based sign-in for local testing.
      if (cfg.devAuth && !cfg.clerkPublishableKey) {
        let dev: { email: string; role: string } | null = null;
        try {
          dev = JSON.parse(sessionStorage.getItem(DEV_KEY) ?? "null");
        } catch {
          dev = null;
        }
        if (!dev) return set({ k: "signin-dev" });
        const api = new ApiServices(async () => null, { "x-dev-user": dev.email, "x-dev-role": dev.role });
        const signOut = () => {
          try {
            sessionStorage.removeItem(DEV_KEY);
          } catch {
            /* ignore */
          }
          setTick((t) => t + 1);
        };
        return enter(api, signOut, `${dev.email} (dev)`);
      }

      if (!cfg.clerkPublishableKey) {
        return set({ k: "error", message: "Sign-in isn't configured on this server yet. An Administrator needs to set CLERK_PUBLISHABLE_KEY." });
      }

      set({ k: "loading", note: "Loading sign-in…" });
      let clerk: ClerkLike;
      try {
        const mod = await import("@clerk/clerk-js");
        clerk = new mod.Clerk(cfg.clerkPublishableKey) as unknown as ClerkLike;
        await clerk.load({});
      } catch {
        return set({ k: "error", message: "Sign-in couldn't load. Check your connection and reload the page." });
      }
      const signOut = () => {
        void clerk.signOut().then(() => setTick((t) => t + 1));
      };
      if (!clerk.user || !clerk.session) {
        set({ k: "signin-clerk", clerk });
        const off = clerk.addListener(() => {
          if (clerk.user && clerk.session) {
            off();
            setTick((t) => t + 1);
          }
        });
        return;
      }
      const api = new ApiServices(async () => (await clerk.session?.getToken()) ?? null);
      const label = clerk.user.primaryEmailAddress?.emailAddress || clerk.user.fullName || "Signed in";
      return enter(api, signOut, label);
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  switch (phase.k) {
    case "loading":
      return <div className="boot">{phase.note ?? "Loading Nebula…"}</div>;
    case "error":
      return <Message title="Nebula can't start" action={<button className="btn" onClick={() => location.reload()}>Reload</button>}>{phase.message}</Message>;
    case "signin-clerk":
      return <ClerkSignIn clerk={phase.clerk} />;
    case "signin-dev":
      return (
        <DevSignIn
          onDone={(email, role) => {
            try {
              sessionStorage.setItem(DEV_KEY, JSON.stringify({ email, role }));
            } catch {
              /* ignore */
            }
            setTick((t) => t + 1);
          }}
        />
      );
    case "pending":
      return (
        <Message title="Your account is waiting for an Administrator" action={<button className="btn" onClick={phase.signOut}>Sign out</button>}>
          <p>You're signed in{phase.me.email ? ` as ${phase.me.email}` : ""}, but an Administrator hasn't given you access yet. Ask them to activate your account in Administration → Users &amp; roles, then reload this page.</p>
        </Message>
      );
    case "ready":
      return (
        <AppProvider backend={phase.backend}>
          <App />
        </AppProvider>
      );
  }
}

createRoot(document.getElementById("root")!).render(<Root />);

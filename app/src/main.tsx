import React from "react";
import { createRoot } from "react-dom/client";
import { initPlatform } from "./data/platform";
import { dbStore, memoryStore } from "./data/store";
import { AppProvider } from "./ui/context";
import { App } from "./ui/App";

async function boot() {
  const platform = await initPlatform();
  const store = platform.db ? dbStore(platform.db, platform.userId ?? "anon") : memoryStore();
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <AppProvider backend={{ kind: "artifact", platform, store }}>
      <App />
    </AppProvider>,
  );
}

boot();

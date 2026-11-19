// Access to the claude.ai runtime capabilities. Every capability may be
// absent (local preview, signed-out viewer, not granted); callers design for
// that by checking for null.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RoleCode } from "../domain/types";

declare global {
  interface Window {
    claude?: { use(name: string): Promise<any> };
  }
}

export interface Platform {
  db: any | null;
  user: any | null;
  assets: any | null;
  sample: any | null;
  downloads: any | null;
  userId: string | null;
  ceiling: RoleCode;
  imageLimits: { maxCount: number; maxInputBytes: number; mediaTypes: string[] } | null;
}

async function use(name: string): Promise<any | null> {
  try {
    if (!window.claude?.use) return null;
    return await window.claude.use(name);
  } catch {
    return null;
  }
}

export async function initPlatform(): Promise<Platform> {
  const [db, user, assets, sample, downloads] = await Promise.all([use("db"), use("user"), use("assets"), use("sample"), use("downloads")]);
  let userId: string | null = null;
  let ceiling: RoleCode = "admin";
  if (user) {
    userId = await user.id();
    const [canEdit, canWrite] = await Promise.all([user.canEdit(), user.can("data.write")]);
    ceiling = canEdit ? "admin" : canWrite === false ? "supervisor" : "ra";
  }
  let imageLimits: Platform["imageLimits"] = null;
  if (sample) {
    try {
      const l = await sample.limits();
      imageLimits = l?.images ?? null;
    } catch {
      imageLimits = null;
    }
  }
  return { db, user, assets, sample, downloads, userId, ceiling, imageLimits };
}

/** Display names for user ids (never stored). */
export async function resolveNames(user: any | null, ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!user || !uniq.length) {
    uniq.forEach((id) => (out[id] = id === "preview-user" ? "You (preview)" : "Someone"));
    return out;
  }
  try {
    const ps = await user.profiles(uniq);
    for (const id of uniq) out[id] = ps[id]?.name || "Someone";
  } catch {
    uniq.forEach((id) => (out[id] = "Someone"));
  }
  return out;
}

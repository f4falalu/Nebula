// Facility and item matching (PRD §17). Produces ranked suggestions only;
// the RA confirms every match.
import type { Alias, Facility, Item, MatchCandidate, MasterData, Requisition } from "./types";
import { normalize, similarity } from "./text";

const RANK: Record<MatchCandidate["method"], number> = {
  exact: 6, alias: 5, normalized: 4, historical: 3, attribute: 2, fuzzy: 1,
};

function pushBest(map: Map<string, MatchCandidate>, c: MatchCandidate) {
  const prev = map.get(c.targetId);
  if (!prev || RANK[c.method] > RANK[prev.method] || (RANK[c.method] === RANK[prev.method] && c.score > prev.score)) {
    map.set(c.targetId, c);
  }
}

function finish(map: Map<string, MatchCandidate>, limit = 5): MatchCandidate[] {
  return [...map.values()]
    .sort((a, b) => RANK[b.method] - RANK[a.method] || b.score - a.score)
    .slice(0, limit)
    .map((c) => ({ ...c, score: Math.round(c.score * 100) / 100 }));
}

function approvedAliases(aliases: Record<string, Alias>, type: Alias["entityType"]) {
  return Object.values(aliases).filter((a) => a.entityType === type && a.status === "approved");
}

export function matchFacility(
  text: string | undefined,
  md: Pick<MasterData, "facilities" | "aliases">,
  history: Requisition[] = [],
): MatchCandidate[] {
  const n = normalize(text);
  if (!n) return [];
  const out = new Map<string, MatchCandidate>();
  const facilities = Object.values(md.facilities).filter((f) => f.status === "active");
  for (const f of facilities) {
    if (f.name.trim().toLowerCase() === (text ?? "").trim().toLowerCase()) pushBest(out, { targetId: f.id, score: 1, method: "exact" });
    else if (normalize(f.name) === n) pushBest(out, { targetId: f.id, score: 1, method: "normalized" });
  }
  for (const a of approvedAliases(md.aliases, "facility")) {
    if (a.normalized === n && md.facilities[a.entityId]) pushBest(out, { targetId: a.entityId, score: 1, method: "alias" });
  }
  for (const r of history) {
    if (r.facilityId && normalize(r.facilityExtractedText) === n && r.recordStatus === "finalized") {
      pushBest(out, { targetId: r.facilityId, score: 0.95, method: "historical" });
    }
  }
  for (const f of facilities) {
    const s = Math.max(similarity(n, f.name), ...approvedAliases(md.aliases, "facility").filter((a) => a.entityId === f.id).map((a) => similarity(n, a.alias)), 0);
    if (s >= 0.3) pushBest(out, { targetId: f.id, score: s, method: "fuzzy" });
  }
  return finish(out);
}

export interface ItemHint {
  text?: string;
  strength?: string;
  form?: string;
  packSize?: string;
}

function attrScore(item: Item, h: ItemHint): number {
  let hits = 0;
  let checks = 0;
  const cmp = (a?: string, b?: string) => {
    if (!a || !b) return;
    checks++;
    if (normalize(a).replace(/\s/g, "") === normalize(b).replace(/\s/g, "")) hits++;
  };
  cmp(item.strength, h.strength);
  cmp(item.form, h.form);
  cmp(item.packSize, h.packSize);
  return checks ? hits / checks : 0;
}

export function matchItem(h: ItemHint, md: Pick<MasterData, "items" | "aliases">): MatchCandidate[] {
  const n = normalize(h.text);
  if (!n) return [];
  const out = new Map<string, MatchCandidate>();
  const items = Object.values(md.items).filter((i) => i.status === "active");
  const aliases = approvedAliases(md.aliases, "item");
  for (const i of items) {
    const full = [i.name, i.strength, i.form].filter(Boolean).join(" ");
    if (i.code && i.code.toLowerCase() === (h.text ?? "").trim().toLowerCase()) pushBest(out, { targetId: i.id, score: 1, method: "exact" });
    if (i.name.trim().toLowerCase() === (h.text ?? "").trim().toLowerCase() || full.toLowerCase() === (h.text ?? "").trim().toLowerCase()) {
      pushBest(out, { targetId: i.id, score: 1, method: "exact" });
    } else if (normalize(i.name) === n || normalize(full) === n) pushBest(out, { targetId: i.id, score: 1, method: "normalized" });
  }
  for (const a of aliases) if (a.normalized === n && md.items[a.entityId]) pushBest(out, { targetId: a.entityId, score: 1, method: "alias" });
  for (const i of items) {
    const full = [i.name, i.genericName, i.strength, i.form].filter(Boolean).join(" ");
    const text = Math.max(similarity(n, full), similarity(n, i.name), i.genericName ? similarity(n, i.genericName) : 0,
      ...aliases.filter((a) => a.entityId === i.id).map((a) => similarity(n, a.alias)), 0);
    const attr = attrScore(i, h);
    if (text >= 0.35 && attr >= 0.99) pushBest(out, { targetId: i.id, score: Math.min(1, 0.6 * text + 0.4 * attr), method: "attribute" });
    else if (text >= 0.25) pushBest(out, { targetId: i.id, score: 0.8 * text + 0.2 * attr, method: "fuzzy" });
  }
  return finish(out);
}

export function facilityLabel(f?: Facility) {
  return f ? f.name : "Unmatched facility";
}

export function itemLabel(i?: Item) {
  if (!i) return "Unmatched item";
  return [i.name, i.strength, i.form].filter(Boolean).join(" ");
}

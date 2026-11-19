// Ids, requisition numbers, text normalization and trigram similarity.
import type { DateStr } from "./types";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Time-sortable id: base36 millis + random suffix. ASCII letters/digits only. */
export function newId(): string {
  const t = Date.now().toString(36).padStart(9, "0");
  let r = "";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  for (const b of bytes) r += ALPHABET[b % 36];
  return t + r;
}

/** REQ-YY-MM-DD_NNN, serial zero-padded to at least three digits (PRD §9). */
export function formatRequisitionNumber(entryDate: DateStr, serial: number): string {
  const [y, m, d] = entryDate.split("-");
  return `REQ-${y.slice(2)}-${m}-${d}_${String(serial).padStart(3, "0")}`;
}

const STOP = new Set(["the", "of", "and", "&"]);

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalize(s: string | undefined | null): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/(\d)\s*(mg|mcg|g|ml|iu|%)\b/g, "$1$2")
    .replace(/[^a-z0-9%.\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .join(" ");
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s.split(" ")) {
    const w = `  ${word} `;
    for (let i = 0; i < w.length - 2; i++) out.add(w.slice(i, i + 3));
  }
  return out;
}

/** pg_trgm-style similarity on normalized text, 0..1. */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = trigrams(na);
  const tb = trigrams(nb);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toLocaleString("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  return `${n.toFixed(digits).replace(/\.0+$/, "")}%`;
}

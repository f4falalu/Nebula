// Business time helpers. Africa/Lagos is UTC+01:00 all year (no daylight
// saving), so conversions use a fixed offset.
import type { DateStr, ISO } from "./types";

export const TZ = "Africa/Lagos";
const OFFSET_MS = 60 * 60 * 1000;

/** Lagos calendar date of a UTC instant. */
export function lagosDate(iso: ISO | Date): DateStr {
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  return new Date(t + OFFSET_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM-DDTHH:mm" as typed in Lagos -> UTC ISO. */
export function fromLagosLocal(local: string): ISO {
  return new Date(Date.parse(local + ":00+01:00")).toISOString();
}

/** UTC ISO -> "YYYY-MM-DDTHH:mm" in Lagos, for datetime-local inputs. */
export function toLagosLocal(iso: ISO): string {
  return new Date(Date.parse(iso) + OFFSET_MS).toISOString().slice(0, 16);
}

export function nowISO(): ISO {
  return new Date().toISOString();
}

/** Whole calendar days between two Lagos dates (b - a). */
export function daysBetween(a: DateStr, b: DateStr): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

export function hoursBetween(a: ISO, b: ISO): number {
  return (Date.parse(b) - Date.parse(a)) / 3600000;
}

export function fmtDateTime(iso?: ISO | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function fmtDate(d?: DateStr | null): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }).format(
    new Date(d + "T00:00:00Z"),
  );
}

export function fmtDuration(hours: number | null | undefined): string {
  if (hours == null || !isFinite(hours)) return "—";
  if (Math.abs(hours) < 1) return `${Math.round(hours * 60)} min`;
  if (Math.abs(hours) < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

export type Period = "today" | "week" | "month" | "quarter" | "year" | "all" | "custom";

/** Inclusive Lagos date range for a named period, relative to `today`. */
export function periodRange(p: Period, today: DateStr, custom?: { from?: DateStr; to?: DateStr }): { from?: DateStr; to?: DateStr } {
  const d = new Date(today + "T00:00:00Z");
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  switch (p) {
    case "today":
      return { from: today, to: today };
    case "week": {
      const dow = (d.getUTCDay() + 6) % 7; // Monday start
      return { from: iso(new Date(Date.UTC(y, m, d.getUTCDate() - dow))), to: today };
    }
    case "month":
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: today };
    case "quarter":
      return { from: iso(new Date(Date.UTC(y, m - (m % 3), 1))), to: today };
    case "year":
      return { from: iso(new Date(Date.UTC(y, 0, 1))), to: today };
    case "custom":
      return custom ?? {};
    default:
      return {};
  }
}

export type Bucket = "week" | "month" | "quarter" | "year";

/** Bucket key for a Lagos date, sortable as a string. */
export function bucketKey(d: DateStr, b: Bucket): string {
  const dt = new Date(d + "T00:00:00Z");
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth();
  if (b === "year") return `${y}`;
  if (b === "quarter") return `${y}-Q${Math.floor(m / 3) + 1}`;
  if (b === "month") return `${y}-${String(m + 1).padStart(2, "0")}`;
  const dow = (dt.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(y, m, dt.getUTCDate() - dow)).toISOString().slice(0, 10);
}

export function bucketLabel(key: string, b: Bucket): string {
  if (b === "month") {
    const [y, m] = key.split("-");
    return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
  }
  if (b === "week") return "w/c " + fmtDate(key).slice(0, 6);
  return key;
}

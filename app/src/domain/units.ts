// Unit normalization and conversion to base units (PRD §19).
import type { ConversionStatus, Item, MasterData, SubstitutionEquivalence, UnitConversion } from "./types";

const SYNONYMS: Record<string, string> = {
  tab: "tablet", tabs: "tablet", tablet: "tablet", tablets: "tablet", tb: "tablet",
  cap: "capsule", caps: "capsule", capsule: "capsule", capsules: "capsule",
  amp: "ampoule", amps: "ampoule", ampoule: "ampoule", ampoules: "ampoule", ampule: "ampoule",
  vial: "vial", vials: "vial",
  bottle: "bottle", bottles: "bottle", btl: "bottle", btls: "bottle",
  sachet: "sachet", sachets: "sachet", sach: "sachet",
  pc: "piece", pcs: "piece", piece: "piece", pieces: "piece", unit: "piece", units: "piece", each: "piece",
  ctn: "carton", ctns: "carton", carton: "carton", cartons: "carton",
  pkt: "pack", pkts: "pack", pack: "pack", packs: "pack", packet: "packet", packets: "packet",
  box: "box", boxes: "box", bx: "box",
  tin: "tin", tins: "tin",
  tube: "tube", tubes: "tube",
  roll: "roll", rolls: "roll",
  pair: "pair", pairs: "pair",
  kit: "kit", kits: "kit",
  strip: "strip", strips: "strip",
  dose: "dose", doses: "dose",
  ml: "ml", l: "litre", litre: "litre", litres: "litre",
};

export function normalizeUnit(u: string | undefined | null): string {
  const s = (u ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  return SYNONYMS[s] ?? s;
}

export interface ConversionResult {
  status: ConversionStatus;
  baseQuantity: number | null;
  baseUnit: string;
  conversionId?: string;
}

/** Convert a quantity of `unit` of `item` to the item's base unit using approved conversions only. */
export function convertToBase(
  item: Item | undefined,
  quantity: number | undefined | null,
  unit: string | undefined | null,
  conversions: Record<string, UnitConversion>,
): ConversionResult {
  const baseUnit = normalizeUnit(item?.baseUnit);
  if (!item || quantity == null || !isFinite(quantity) || !unit) {
    return { status: "unknown", baseQuantity: null, baseUnit };
  }
  const from = normalizeUnit(unit);
  if (from === baseUnit) return { status: "resolved", baseQuantity: quantity, baseUnit };
  const approved = Object.values(conversions).filter((c) => c.status === "approved" && normalizeUnit(c.fromUnit) === from);
  const specific = approved.find((c) => c.itemId === item.id);
  const generic = approved.find((c) => !c.itemId && normalizeUnit(c.toUnit) === baseUnit);
  const conv = specific ?? generic;
  if (!conv) return { status: "unknown", baseQuantity: null, baseUnit };
  if (conv.incompatible) return { status: "incompatible", baseQuantity: null, baseUnit, conversionId: conv.id };
  return { status: "resolved", baseQuantity: round(quantity * conv.factor), baseUnit, conversionId: conv.id };
}

/** Approved equivalence rule letting `substituteItemId` count toward `requestedItemId`. */
export function findEquivalence(
  md: Pick<MasterData, "equivalences">,
  requestedItemId: string,
  substituteItemId: string,
): SubstitutionEquivalence | undefined {
  return Object.values(md.equivalences).find(
    (e) => e.status === "approved" && e.requestedItemId === requestedItemId && e.substituteItemId === substituteItemId,
  );
}

export function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

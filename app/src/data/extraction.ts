// Reading a requisition with Claude (PRD §14). The result is a suggestion:
// raw output is kept as-is and the RA reviews every field.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ExtractedLine {
  page: number;
  line: number;
  text: string;
  itemName?: string;
  strength?: string;
  form?: string;
  packSize?: string;
  quantity?: number | null;
  unit?: string;
  programme?: string;
}

export interface ExtractionResult {
  facilityName?: string;
  requisitionDate?: string | null;
  pages: Array<{ page: number; programme?: string }>;
  lines: ExtractedLine[];
}

function prompt(firstPage: number, count: number, programmes: string[]): string {
  return `You are reading scanned or photographed pages of a healthcare facility requisition (an order for medicines and supplies) from a facility in Nigeria. The ${count} attached image(s) are pages ${firstPage} to ${firstPage + count - 1} of the requisition, in order.

Transcribe what is written. Do not guess missing values: use null or leave the field out. Keep item text as written.

Known programmes: ${programmes.join(", ") || "(none)"}. If a page header names one of these programmes, give that name exactly; otherwise leave it out.

Reply with only one JSON object in this shape:
{"facilityName": string|null, "requisitionDate": "YYYY-MM-DD"|null,
 "pages": [{"page": number, "programme": string|null}],
 "lines": [{"page": number, "line": number, "text": "the full row as written", "itemName": string, "strength": string|null, "form": string|null, "packSize": string|null, "quantity": number|null, "unit": string|null}]}

Use the requested/ordered quantity column for "quantity" (not stock on hand or quantity issued). "unit" is the unit the quantity is expressed in (tablet, capsule, bottle, carton, vial, pack...). Number "line" from 1 on each page. Skip blank rows, totals and signatures.`;
}

export async function extractWithClaude(
  sample: any,
  images: Blob[],
  programmes: string[],
  maxPerCall: number,
  onProgress?: (msg: string) => void,
): Promise<{ result: ExtractionResult; raw: string }> {
  const merged: ExtractionResult = { pages: [], lines: [] };
  const raws: string[] = [];
  const per = Math.max(1, maxPerCall);
  for (let i = 0; i < images.length; i += per) {
    const batch = images.slice(i, i + per);
    onProgress?.(`Reading page${batch.length > 1 ? "s" : ""} ${i + 1}${batch.length > 1 ? `–${i + batch.length}` : ""} of ${images.length}…`);
    let parsed: any;
    try {
      parsed = await sample.json(prompt(i + 1, batch.length, programmes), { images: batch, modelTier: "default" });
    } catch (e: any) {
      throw Object.assign(new Error(sampleErrorMessage(e?.code)), { code: e?.code, raw: e?.text });
    }
    raws.push(JSON.stringify(parsed));
    if (parsed && typeof parsed === "object") {
      if (!merged.facilityName && parsed.facilityName) merged.facilityName = String(parsed.facilityName);
      if (!merged.requisitionDate && typeof parsed.requisitionDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.requisitionDate)) {
        merged.requisitionDate = parsed.requisitionDate;
      }
      for (const p of Array.isArray(parsed.pages) ? parsed.pages : []) {
        merged.pages.push({ page: Number(p.page) || i + 1, programme: p.programme ? String(p.programme) : undefined });
      }
      for (const l of Array.isArray(parsed.lines) ? parsed.lines : []) {
        const q = typeof l.quantity === "number" ? l.quantity : parseFloat(String(l.quantity ?? "").replace(/,/g, ""));
        merged.lines.push({
          page: Number(l.page) || i + 1,
          line: Number(l.line) || merged.lines.length + 1,
          text: String(l.text ?? l.itemName ?? ""),
          itemName: l.itemName ? String(l.itemName) : undefined,
          strength: l.strength ? String(l.strength) : undefined,
          form: l.form ? String(l.form) : undefined,
          packSize: l.packSize ? String(l.packSize) : undefined,
          quantity: isFinite(q) ? q : null,
          unit: l.unit ? String(l.unit) : undefined,
        });
      }
    }
  }
  return { result: merged, raw: raws.length === 1 ? raws[0] : `[${raws.join(",")}]` };
}

export function sampleErrorMessage(code?: string): string {
  switch (code) {
    case "not_granted":
      return "Claude isn't allowed to read documents in this view. Allow it from the artifact's permissions, or enter the lines by hand.";
    case "sampling_disabled":
      return "Claude isn't available for your account. Enter the lines by hand.";
    case "images_unavailable":
      return "This view can't send images to Claude. Enter the lines by hand.";
    case "image_rejected":
      return "Claude couldn't open this file. Try a clearer JPEG or PNG photo.";
    case "rate_limited":
      return "Too many reading requests just now. Wait a minute, then retry.";
    case "invalid_json":
      return "Claude's answer couldn't be read as a list of lines. Retry, or enter the lines by hand.";
    case "refused":
      return "Claude declined to read this document. Enter the lines by hand.";
    default:
      return "Reading the document failed. Retry, or enter the lines by hand.";
  }
}

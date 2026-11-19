// File handling: checksums, PDF page rendering, uploads to artifact assets.
/* eslint-disable @typescript-eslint/no-explicit-any */

export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  if (globalThis.crypto?.subtle) {
    const h = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return sha256Fallback(new Uint8Array(buf));
}

// Compact SHA-256 for contexts without SubtleCrypto.
function sha256Fallback(msg: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = msg.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, len * 8);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 2 ** 32));
  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + W[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return [...H].map((x) => x.toString(16).padStart(8, "0")).join("");
}

// ---------- PDF rendering via pdf.js (loaded on demand from cdnjs) ----------
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";
let pdfLoad: Promise<any> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.appendChild(s);
  });
}

async function pdfjs(): Promise<any> {
  if (!pdfLoad) {
    pdfLoad = (async () => {
      // The worker script defines window.pdfjsWorker so pdf.js can run it in-page.
      await loadScript(`${PDFJS}/pdf.worker.min.js`);
      await loadScript(`${PDFJS}/pdf.min.js`);
      const lib = (window as any).pdfjsLib;
      lib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.js`;
      return lib;
    })();
  }
  return pdfLoad;
}

export async function pdfPageCount(file: Blob): Promise<number> {
  try {
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), disableWorker: true }).promise;
    return doc.numPages;
  } catch {
    return 1;
  }
}

/** Render PDF pages to PNG blobs (for reading by Claude and for display). */
export async function pdfToImages(file: Blob, maxPages = 20): Promise<Blob[]> {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), disableWorker: true }).promise;
  const out: Blob[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1.6 });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    out.push(await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png")));
  }
  return out;
}

/** Image blobs for a stored document (fetches the asset; renders PDFs). */
export async function imagesForAsset(assetId: string, mime: string, local?: Blob): Promise<Blob[]> {
  const blob = local ?? (await (await fetch(assetUrl(assetId))).blob());
  if (mime === "application/pdf") return pdfToImages(blob);
  return [blob];
}

export function assetUrl(assetId: string): string {
  if (assetId.startsWith("local:")) return localBlobs.get(assetId) ?? "";
  return "/_blob/" + assetId;
}

// Preview mode keeps uploaded files as object URLs for the session only.
const localBlobs = new Map<string, string>();
export function rememberLocal(id: string, blob: Blob) {
  localBlobs.set(id, URL.createObjectURL(blob));
}

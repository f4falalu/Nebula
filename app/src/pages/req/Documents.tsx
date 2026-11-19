import React, { useState } from "react";
import { useApp } from "../../ui/context";
import { DocView, Field, Modal, Who } from "../../ui/kit";
import { can } from "../../domain/permissions";
import { fmtDateTime } from "../../domain/time";
import { STAGE_LABEL } from "../../domain/lifecycle";
import type { ReqDocument, Requisition } from "../../domain/types";
import { ACCEPTED_TYPES, assetUrl } from "../../data/files";

const CATEGORY: Record<ReqDocument["category"], string> = {
  original_requisition: "Original requisition",
  processed: "Processed",
  lifecycle_evidence: "Lifecycle evidence",
  supporting: "Supporting",
};

const TYPE_LABEL: Record<string, string> = {
  requisition: "Requisition", invoice: "Invoice", pick_slip: "Pick slip", waybill: "Waybill", pod: "Proof of delivery",
  payment_confirmation: "Payment confirmation", whatsapp_screenshot: "WhatsApp screenshot", other: "Other",
};

export function DocLink({ r, docId }: { r: Requisition; docId: string }) {
  const [open, setOpen] = useState(false);
  const d = r.documents[docId];
  if (!d) return null;
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}>{TYPE_LABEL[d.documentType] ?? d.documentType}: {d.fileName}</button>
      {open && <DocModal r={r} d={d} onClose={() => setOpen(false)} />}
    </>
  );
}

function DocModal({ r, d, onClose }: { r: Requisition; d: ReqDocument; onClose: () => void }) {
  const { actor, platform, svc, run, toast } = useApp();
  const [page, setPage] = useState(1);
  const download = async () => {
    if (!platform.downloads) return toast("Downloads aren't available in this view.", true);
    await run(async () => {
      const blob = await (await fetch(assetUrl(d.assetId))).blob();
      await platform.downloads.save({ filename: d.fileName, data: blob });
      await svc.logDownload(r.id, d.id);
    });
  };
  return (
    <Modal wide title={d.fileName} onClose={onClose}
      foot={<>
        {d.pageCount > 1 && <><button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous page</button><button className="btn" disabled={page >= d.pageCount} onClick={() => setPage(page + 1)}>Next page</button></>}
        {can(actor, "documents.download") && <button className="btn primary" onClick={download}>Download</button>}
      </>}>
      <div className="doc-view" style={{ maxHeight: "65vh" }}><DocView assetId={d.assetId} mime={d.mimeType} page={page} /></div>
      <span className="muted small">SHA-256 <span className="mono">{d.sha256}</span> · {(d.fileSize / 1024).toFixed(0)} KB · {d.pageCount} page{d.pageCount > 1 ? "s" : ""}</span>
    </Modal>
  );
}

export function DocumentsTab({ r }: { r: Requisition }) {
  const { actor, svc, act } = useApp();
  const [view, setView] = useState<ReqDocument | null>(null);
  const [upload, setUpload] = useState(false);
  const docs = Object.values(r.documents).filter((d): d is ReqDocument => !!d).sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
  return (
    <div className="card flush">
      <div className="card-head">
        <h3>Documents</h3>
        {can(actor, "evidence.upload") && r.recordStatus !== "cancelled" && <button className="btn sm" onClick={() => setUpload(true)}>Upload supporting document</button>}
      </div>
      <p className="muted small" style={{ padding: "10px 16px 0" }}>Files are stored unchanged and never deleted. Viewing uses short-lived links inside claude.ai{can(actor, "documents.download") ? "; every download is recorded in the audit history" : ""}.</p>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th>File</th><th>Category</th><th>Type</th><th>Stage</th><th>Uploaded</th><th>Checksum</th><th></th></tr></thead>
          <tbody>
            {docs.map((d) => {
              const ev = d.lifecycleEventId ? r.events[d.lifecycleEventId] : undefined;
              return (
                <tr key={d.id}>
                  <td>{d.fileName}<div className="muted small">{(d.fileSize / 1024).toFixed(0)} KB · {d.pageCount} page{d.pageCount > 1 ? "s" : ""}</div></td>
                  <td>{CATEGORY[d.category]}</td>
                  <td>{TYPE_LABEL[d.documentType] ?? d.documentType}{d.description && <div className="muted small">{d.description}</div>}</td>
                  <td>{ev ? STAGE_LABEL[ev.stage] : d.category === "original_requisition" ? "Received" : "—"}</td>
                  <td className="small">{fmtDateTime(d.uploadedAt)}<br /><Who id={d.uploadedBy} /></td>
                  <td className="mono small" title={d.sha256}>{d.sha256.slice(0, 10)}…</td>
                  <td><button className="btn sm" onClick={() => setView(d)}>View</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {view && <DocModal r={r} d={view} onClose={() => setView(null)} />}
      {upload && <UploadModal onClose={() => setUpload(false)} onUpload={(files, type, description) => act(() => svc.uploadEvidence(r.id, files, { documentType: type, description, category: "supporting" }), "Uploaded")} />}
    </div>
  );
}

function UploadModal({ onClose, onUpload }: { onClose: () => void; onUpload: (f: File[], type: string, description: string) => Promise<boolean> }) {
  const [files, setFiles] = useState<File[]>([]);
  const [type, setType] = useState("whatsapp_screenshot");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Upload supporting document" onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!files.length || busy} onClick={async () => { setBusy(true); const ok = await onUpload(files, type, description); setBusy(false); if (ok) onClose(); }}>{busy ? "Uploading…" : "Upload"}</button></>}>
      <p className="muted small">For evidence of a lifecycle stage, attach it when recording that stage on the Lifecycle tab instead.</p>
      <Field label="Type">
        <select id="up-type" value={type} onChange={(e) => setType(e.target.value)}>
          {Object.entries(TYPE_LABEL).filter(([k]) => k !== "requisition").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <Field label="Description"><input id="up-desc" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label="Files"><input id="up-files" type="file" multiple accept={ACCEPTED_TYPES.join(",")} onChange={(e) => setFiles(Array.from(e.target.files ?? []))} /></Field>
    </Modal>
  );
}

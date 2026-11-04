import { useEffect, useState } from "react";
import { sanitizeAttachmentName } from "@agent-console/shared/conversation-images";
import type { OutgoingAttachment, UploadedFile } from "./attachmentPaths.ts";
import { writeTerminalClipboardText } from "./terminalClipboard.ts";

function fileKind(name: string): "Video" | "Document" | "Archive" | "File" {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (["mp4", "webm", "mov", "mkv", "avi", "m4v"].includes(extension ?? "")) return "Video";
  if (["pdf", "txt", "md", "csv", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt"].includes(extension ?? "")) return "Document";
  if (["zip", "tar", "gz", "bz2", "xz", "7z", "rar"].includes(extension ?? "")) return "Archive";
  return "File";
}
function fileSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) return undefined;
  const units = ["B", "KB", "MB", "GB"];
  let amount = bytes, unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${Number(amount.toFixed(1))} ${units[unit]}`;
}
function KindIcon({ kind }: { readonly kind: ReturnType<typeof fileKind> }) {
  return <svg className="file-card-kind" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "Video" ? <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9 6 3-6 3Z" /></>
      : kind === "Archive" ? <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M10 3v3h4V3m-4 6h4m-4 3h4m-4 3h4v3h-4Z" /></>
      : <><path d="M14 3H5v18h14V8Zm0 0v5h5" />{kind === "Document" ? <path d="M8 12h8m-8 4h6" /> : null}</>}
  </svg>;
}

/** A non-image upload: display metadata never changes the copied transport path. */
export function AttachmentFileCard({ file, attachment }: { readonly file: UploadedFile; readonly attachment?: OutgoingAttachment }) {
  const original = sanitizeAttachmentName(attachment?.original_name);
  const kind = fileKind(original ?? file.path);
  const name = original ?? kind;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const size = fileSize(attachment?.bytes);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return <button type="button" className="file-card" title={name} aria-label={`Copy path ${name}`}
    onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}
    onClick={() => { void writeTerminalClipboardText(file.path).then(() => setCopied(true), () => {}); }}>
    <KindIcon kind={kind} />
    <span className="file-card-content">
      <span className="file-card-name"><span className="file-card-stem">{stem}</span><span className="file-card-extension">{extension}</span></span>
      <span className="file-card-details">{copied ? "Copied" : `${kind}${size ? ` · ${size}` : ""}`}</span>
    </span>
    <span className="file-card-copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></svg></span>
  </button>;
}

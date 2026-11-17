import { useEffect, useState } from "react";
import { sanitizeAttachmentName } from "@agent-console/shared/conversation-images";
import type { OutgoingAttachment } from "./attachmentPaths.ts";

export function ComposerAttachment({ attachment, disabled, onRemove }: { readonly attachment: OutgoingAttachment; readonly disabled: boolean; readonly onRemove: () => void }) {
  const name = sanitizeAttachmentName(attachment.original_name) ?? sanitizeAttachmentName(attachment.path) ?? "File";
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    if (!attachment.preview) { setPreview(undefined); return; }
    const url = URL.createObjectURL(attachment.preview);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment.preview]);
  const size = attachment.bytes === undefined ? "" : attachment.bytes < 1024 ? `${attachment.bytes} B` : `${Number((attachment.bytes / 1024).toFixed(1))} KB`;
  return <div className="composer-attachment" role="group" aria-label={`Attachment ${name}`}>
    {preview ? <img src={preview} alt="" /> : null}
    <span className="composer-attachment-name" title={name}>{name}{size ? <small>{size}</small> : null}</span>
    <button type="button" aria-label={`Remove ${name}`} disabled={disabled} onClick={onRemove}>×</button>
  </div>;
}

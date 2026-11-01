// The composer sends an uploaded file as its single-quoted host path (see
// shellQuote.ts). The daemon stores uploads at <state>/sessions/<id>/attachments/<name>.
const QUOTED_UPLOAD = /(?<![A-Za-z0-9])'((?:[^']|'\\'')*)'/g;
const UPLOAD_PATH = /^\/(?:[^/\0]+\/)*sessions\/([^/\0]+)\/attachments\/([^/\0]+)$/;
const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp|bmp|avif|heic)$/i;
// Fenced and inline code keep their text exactly.
const CODE_OR_QUOTED = new RegExp(`(\`\`\`[^]*?\`\`\`|\`[^\`\\n]*\`)|${QUOTED_UPLOAD.source}`, "g");

export interface UploadedFile {
  readonly path: string;
  readonly label: string;
}

/** The upload a quoted path names; with `owner`, only that session's own directory counts. */
function uploadedFile(quoted: string, owner: string | undefined): UploadedFile | null {
  const path = quoted.replaceAll("'\\''", "'");
  const match = UPLOAD_PATH.exec(path);
  if (!match || path.split("/").includes("..")) return null;
  if (owner !== undefined && match[1] !== owner) return null;
  const name = match[2]!;
  return { path, label: `[${IMAGE_NAME.test(name) ? "圖片" : "檔案"} ${name}]` };
}

/** Replace each quoted upload path in a message with a link the bubble renders as a chip. */
export function linkUploadedFiles(text: string, owner: string): { readonly text: string; readonly files: readonly UploadedFile[] } {
  const files: UploadedFile[] = [];
  const linked = text.replace(CODE_OR_QUOTED, (whole: string, code: string | undefined, quoted: string | undefined) => {
    if (code !== undefined || quoted === undefined) return whole;
    const file = uploadedFile(quoted, owner);
    if (!file) return whole;
    files.push(file);
    return `[file](#salon-attachment-${files.length - 1})`;
  });
  return { text: linked, files };
}

/** A prompt preview with each quoted upload path shortened to its chip label. */
export function shortenUploadedFiles(text: string): string {
  return text.replace(CODE_OR_QUOTED, (whole: string, code: string | undefined, quoted: string | undefined) =>
    code !== undefined || quoted === undefined ? whole : uploadedFile(quoted, undefined)?.label ?? whole);
}

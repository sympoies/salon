// The composer sends an uploaded file as its single-quoted host path (see
// shellQuote.ts). The daemon stores uploads at <state>/sessions/<id>/attachments/<name>.
const QUOTED_UPLOAD = /(?<![A-Za-z0-9])'((?:[^']|'\\'')*)'/g;
const UPLOAD_PATH = /^\/(?:[^/\0]+\/)*sessions\/([^/\0]+)\/attachments\/([^/\0]+)$/;
const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp|bmp|avif|heic)$/i;
// Inline code spans keep their text exactly.
const INLINE_CODE_OR_QUOTED = new RegExp(`(\`[^\`\\n]*\`)|${QUOTED_UPLOAD.source}`, "g");
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED = /^(?: {4}|\t)/;

/** Apply `edit` to each quoted token that is not in fenced, indented or inline code. */
function editOutsideCode(text: string, edit: (quoted: string, whole: string) => string): string {
  let fence: { readonly char: string; readonly size: number } | undefined;
  let afterBlank = true;
  let inIndented = false;
  return text.split("\n").map((line) => {
    const blank = line.trim() === "";
    const open = FENCE.exec(line)?.[1];
    if (fence) {
      if (open && open[0] === fence.char && open.length >= fence.size && line.trim() === open) fence = undefined;
      return line;
    }
    if (open) {
      fence = { char: open[0]!, size: open.length };
      inIndented = false;
      afterBlank = false;
      return line;
    }
    if (INDENTED.test(line) && (afterBlank || inIndented)) {
      inIndented = true;
      return line;
    }
    if (blank) { afterBlank = true; return line; }
    inIndented = false;
    afterBlank = false;
    return line.replace(INLINE_CODE_OR_QUOTED, (whole: string, code: string | undefined, quoted: string | undefined) =>
      code !== undefined || quoted === undefined ? whole : edit(quoted, whole));
  }).join("\n");
}

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
  const linked = editOutsideCode(text, (quoted, whole) => {
    const file = uploadedFile(quoted, owner);
    if (!file) return whole;
    files.push(file);
    return `[file](#salon-attachment-${files.length - 1})`;
  });
  return { text: linked, files };
}

/** A prompt preview with each quoted upload path shortened to its chip label. */
export function shortenUploadedFiles(text: string): string {
  return editOutsideCode(text, (quoted, whole) => uploadedFile(quoted, undefined)?.label ?? whole);
}

/** The owner's quoted upload paths in a message, in order. */
export function uploadedFilePaths(text: string, owner: string): readonly string[] {
  return linkUploadedFiles(text, owner).files.map((file) => file.path);
}

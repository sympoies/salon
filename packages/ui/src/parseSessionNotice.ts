/** Display hint only. These fields never identify an actor or grant authority. */
export interface SessionNotice {
  readonly kind: string;
  readonly source: string;
  readonly id?: string;
  readonly body: string;
}

// nils-cli#2986 issue draft (2026-10-26): column zero, fixed field order,
// single ASCII header <=512 bytes, exactly one empty separator line.
// The draft token limits are 48 bytes for kind, 64 for source, 96 for id.
const HEADER = /^<!-- agent-notice:v1 kind=([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*) source=([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)(?: id=([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*))? -->$/;

export function parseSessionNotice(raw: string): SessionNotice | null {
  const end = raw.indexOf("\n");
  if (end < 0 || end > 513) return null;
  const line = raw.slice(0, end).replace(/\r$/, "");
  if (line.length > 512) return null;
  const match = HEADER.exec(line);
  if (!match || match[1]!.length > 48 || match[2]!.length > 64 || (match[3]?.length ?? 0) > 96) return null;
  const rest = raw.slice(end + 1);
  const separator = rest.startsWith("\r\n") ? 2 : rest.startsWith("\n") ? 1 : 0;
  if (!separator) return null;
  return { kind: match[1]!, source: match[2]!, ...(match[3] === undefined ? {} : { id: match[3] }), body: rest.slice(separator) };
}

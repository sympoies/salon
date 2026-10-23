export const MAX_SESSION_TITLE_LEN = 120;

export function normalizeSessionTitle(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

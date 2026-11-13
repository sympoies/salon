/** Display summaries from runtime parts=v1. Owner siblings are authorized by the edge. */
export type HistoryToolPart =
  | { readonly kind: "tool_call"; readonly id: string; readonly call_id?: string; readonly name: string; readonly input_summary: string; readonly owner_input_summary?: string; readonly status?: "ok" | "error" }
  | { readonly kind: "tool_result"; readonly id: string; readonly call_id?: string; readonly summary: string; readonly owner_summary?: string; readonly status?: "ok" | "error"; readonly truncated?: boolean };

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max * 2 && [...value].length <= max;
}

/** Unknown/malformed parts are dropped; each row keeps at most 256 parts and 64 KiB. */
export function normalizeHistoryToolParts(value: unknown): HistoryToolPart[] {
  if (!Array.isArray(value)) return [];
  const parts: HistoryToolPart[] = [];
  let bytes = 2;
  for (const raw of value.slice(0, 256)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (!bounded(item.id, 256) || !item.id) continue;
    const callId = bounded(item.call_id, 256) && item.call_id ? item.call_id : undefined;
    const status = item.status === "ok" || item.status === "error" ? item.status : undefined;
    const identity: Pick<HistoryToolPart, "id" | "call_id" | "status"> = { id: item.id, ...(callId ? { call_id: callId } : {}), ...(status ? { status } : {}) };
    let part: HistoryToolPart;
    if (item.kind === "tool_call" && bounded(item.name, 128) && item.name && bounded(item.input_summary, 2048)) {
      part = { kind: "tool_call", ...identity, name: item.name, input_summary: item.input_summary,
        ...(bounded(item.owner_input_summary, 2048) ? { owner_input_summary: item.owner_input_summary } : {}) };
    } else if (item.kind === "tool_result" && bounded(item.summary, 2048)) {
      part = { kind: "tool_result", ...identity, summary: item.summary,
        ...(bounded(item.owner_summary, 2048) ? { owner_summary: item.owner_summary } : {}),
        ...(typeof item.truncated === "boolean" ? { truncated: item.truncated } : {}) };
    } else continue;
    const size = new TextEncoder().encode(JSON.stringify(part)).byteLength + (parts.length ? 1 : 0);
    if (bytes + size > 64 * 1024) break;
    parts.push(part);
    bytes += size;
  }
  return parts;
}

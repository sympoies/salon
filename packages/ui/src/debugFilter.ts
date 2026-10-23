import { classifyDebugEvent, debugRouteFamily, type DebugEvent } from "@agent-console/shared/api";

export type DebugSourceFilter = "all" | DebugEvent["source"];
export type DebugOutcomeFilter = "all" | "signal" | "failures" | "lifecycle";

export interface DebugFilter {
  readonly source: DebugSourceFilter;
  readonly family: string;
  readonly outcome: DebugOutcomeFilter;
  readonly session: string;
  readonly text: string;
}

export const DEBUG_FILTER_ALL = "all";

export const EMPTY_DEBUG_FILTER: DebugFilter = {
  source: "all",
  family: DEBUG_FILTER_ALL,
  outcome: "all",
  session: DEBUG_FILTER_ALL,
  text: "",
};

/** The `machine/session` key a row belongs to, or null when it carries neither.
 * Used both as the session filter value and as the receipt lookup key, so the
 * two always agree on what identifies a session. */
export function debugSessionKey(event: DebugEvent): string | null {
  if (!event.session_id) return null;
  return event.machine ? `${event.machine}/${event.session_id}` : event.session_id;
}

export function splitDebugSessionKey(key: string): { machine: string; sessionId: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  return { machine: key.slice(0, slash), sessionId: key.slice(slash + 1) };
}

function matchesText(event: DebugEvent, needle: string): boolean {
  if (needle === "") return true;
  const lower = needle.toLowerCase();
  for (const value of Object.values(event)) {
    if (typeof value === "string" && value.toLowerCase().includes(lower)) return true;
    if (typeof value === "number" && String(value).includes(lower)) return true;
  }
  return false;
}

function matchesOutcome(event: DebugEvent, outcome: DebugOutcomeFilter): boolean {
  switch (outcome) {
    case "failures":
      return event.ok === false;
    case "lifecycle":
      return Boolean(event.operation);
    case "signal":
      return classifyDebugEvent(event) === "signal";
    default:
      return true;
  }
}

export function filterDebugEvents(
  events: readonly DebugEvent[],
  filter: DebugFilter,
): readonly DebugEvent[] {
  const needle = filter.text.trim();
  return events.filter((event) => (
    (filter.source === "all" || event.source === filter.source)
    && (filter.family === DEBUG_FILTER_ALL || debugRouteFamily(event.route) === filter.family)
    && (filter.session === DEBUG_FILTER_ALL || debugSessionKey(event) === filter.session)
    && matchesOutcome(event, filter.outcome)
    && matchesText(event, needle)
  ));
}

export function debugRouteFamilies(events: readonly DebugEvent[]): readonly string[] {
  return [...new Set(events.map((event) => debugRouteFamily(event.route)))].sort();
}

export function debugSessionKeys(events: readonly DebugEvent[]): readonly string[] {
  return [...new Set(events.flatMap((event) => {
    const key = debugSessionKey(event);
    return key ? [key] : [];
  }))].sort();
}

export function isDebugFilterActive(filter: DebugFilter): boolean {
  return filter.source !== "all"
    || filter.family !== DEBUG_FILTER_ALL
    || filter.session !== DEBUG_FILTER_ALL
    || filter.outcome !== "all"
    || filter.text.trim() !== "";
}

/** A one-line description of the active filter, recorded in a copied bundle so
 * a reader can tell a narrowed export from a complete one. */
export function describeDebugFilter(filter: DebugFilter): string | undefined {
  if (!isDebugFilterActive(filter)) return undefined;
  const parts: string[] = [];
  if (filter.source !== "all") parts.push(`source=${filter.source}`);
  if (filter.family !== DEBUG_FILTER_ALL) parts.push(`route=${filter.family}`);
  if (filter.outcome !== "all") parts.push(`outcome=${filter.outcome}`);
  if (filter.session !== DEBUG_FILTER_ALL) parts.push(`session=${filter.session}`);
  const text = filter.text.trim();
  if (text !== "") parts.push(`text=${text}`);
  return parts.join(" ");
}

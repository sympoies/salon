import type { SessionCoordinatorTree, SessionDispatchedBy } from "@agent-console/shared/api";
import type { SessionRole } from "@agent-console/shared/lineage";


/** `descendant`: depth 2 or deeper in a coordinator's tree. */
export type CoordinatorTreeRole = "coordinator" | "dispatched" | "descendant";

export interface CoordinatorTreeItem {
  readonly dispatched_by?: SessionDispatchedBy;
  readonly coordinator_tree?: SessionCoordinatorTree;
  readonly role?: SessionRole | null;
  readonly created_at?: string;
}

export function coordinatorTreeRole(item: CoordinatorTreeItem): CoordinatorTreeRole | null {
  const depth = item.coordinator_tree?.depth;
  if (depth !== undefined) return depth === 0 ? "coordinator" : depth === 1 ? "dispatched" : "descendant";
  return item.role === "coordinator" || item.role === "domain-coordinator" ? "coordinator" : null;
}

/** Whether a session belongs to a coordinator tree. */
export function isCoordinatorTreeMember(item: CoordinatorTreeItem): boolean {
  return coordinatorTreeRole(item) !== null;
}

/**
 * History rows badge like the live session list: the live session for the same
 * provider conversation supplies role and tree marks when exactly one running session
 * matches (as lookupLiveHistorySession); otherwise the row keeps its own.
 */
export function historyMarkerItem(
  history: CoordinatorTreeItem & { readonly machine: string; readonly provider: string; readonly provider_session_id: string },
  live: readonly (CoordinatorTreeItem & {
    readonly machine?: string;
    readonly status?: string;
    readonly provider_resume?: { readonly provider?: string; readonly session_id?: string } | null;
  })[],
): CoordinatorTreeItem {
  const matches = live.filter(session => session.machine === history.machine
    && session.status === "running"
    && session.provider_resume?.provider === history.provider
    && session.provider_resume.session_id === history.provider_session_id);
  return matches.length === 1 ? matches[0]! : history;
}

const boardRefKey = (ref: { readonly machine: string; readonly session_id: string; readonly session_created_at: string }) => JSON.stringify([ref.machine, ref.session_id, ref.session_created_at]);
import type { SessionDispatchedBy } from "@agent-console/shared/api";
import { classifySessionStatus, sessionStatusEvidence, type SessionStatusGroup } from "./sessionStatusGroups.ts";

export interface SessionFilters {
  readonly workspaces?: readonly (string | null)[] | null;
  /** Legacy restriction retained until safe migration or an explicit workspace choice. */
  readonly excludedWorkspaces?: readonly (string | null)[] | null;
  readonly hosts: readonly string[] | null;
  readonly roles?: readonly (string | null)[] | null;
  readonly harness: string | null;
  readonly repo: string;
  readonly statusGroup: SessionStatusGroup | null;
}
export const CLEAR_SESSION_FILTERS: SessionFilters = { workspaces: null, excludedWorkspaces: null, hosts: null, roles: null, harness: null, repo: "", statusGroup: null };
export function hasActiveSessionFilters(filters: SessionFilters): boolean {
  return Boolean(filters.workspaces?.length) || Boolean(filters.excludedWorkspaces?.length) || filters.hosts !== null || filters.roles != null || filters.harness !== null || filters.repo !== "";
}
export interface LineageRecord {
  readonly machine: string;
  readonly session_id: string;
  readonly created_at: string;
  readonly lineage?: { readonly parent: import("@agent-console/shared/lineage").SessionLineageRef | null; readonly effective_parent?: import("@agent-console/shared/lineage").SessionLineageRef | null };
  readonly lineage_adoption?: import("@agent-console/shared/lineage").SessionLineageAdoption;
  readonly dispatched_by?: SessionDispatchedBy;
}
export const lineageRecordKey = (row: LineageRecord) => boardRefKey({ machine: row.machine, session_id: row.session_id, session_created_at: row.created_at });
export function lineageParents(records: readonly LineageRecord[]): Map<string, string | null> {
  const ids = new Map<string, LineageRecord[]>();
  for (const row of records) {
    const key = JSON.stringify([row.machine, row.session_id]);
    ids.set(key, [...(ids.get(key) ?? []), row]);
  }
  return new Map(records.map(row => {
    if (row.lineage) {
      const parent = Object.hasOwn(row.lineage, "effective_parent") ? row.lineage.effective_parent : row.lineage_adoption?.adopted_by ?? row.lineage.parent;
      return [lineageRecordKey(row), parent ? boardRefKey(parent) : null];
    }
    const candidates = row.dispatched_by ? ids.get(JSON.stringify([row.dispatched_by.machine, row.dispatched_by.session_id])) : undefined;
    return [lineageRecordKey(row), candidates?.length === 1 ? lineageRecordKey(candidates[0]!) : null];
  }));
}
/** A host's role names for the Roles facet; core falls back to the record's own role. */
export type SessionRoleResolver = (row: FilterRecord) => string | null;
export interface FilterRecord extends LineageRecord {
  readonly workspace?: string | null;
  readonly provider: string;
  readonly repo_name?: string | null;
  readonly cwd?: string | null;
  readonly role?: import("@agent-console/shared/lineage").SessionRole | null;
  readonly coordinator_tree?: import("@agent-console/shared/api").SessionCoordinatorTree;
  readonly status?: string;
  readonly runtime_status?: string | null;
  readonly turn_state?: {
    readonly phase?: string | null;
    readonly last_turn?: { readonly outcome?: string | null } | null;
  } | null;
}
function recordRole(row: FilterRecord, roleOf?: SessionRoleResolver): string | null {
  return roleOf?.(row) ?? row.role ?? null;
}
export function sessionRoleOptions(records: readonly FilterRecord[], roleOf?: SessionRoleResolver): string[] {
  return [...new Set(records.map(row => recordRole(row, roleOf)).filter((role): role is string => role !== null))]
    .sort((a, b) => a.localeCompare(b));
}
/** A facet selection is null (all) or a non-empty explicit subset; covering every value is all. */
export function normalizeFacetSelection<T>(selected: readonly T[] | null, universe: readonly T[]): readonly T[] | null {
  if (selected === null || selected.length === 0) return null;
  return universe.length > 0 && universe.every(value => selected.includes(value)) ? null : selected;
}
/** First pick from all isolates the value; further picks add; removing the last value returns to all. */
export function toggleFacetSelection<T>(selected: readonly T[] | null, universe: readonly T[], value: T): readonly T[] | null {
  const current = selected ?? [];
  const next = current.includes(value) ? current.filter(item => item !== value) : [...current, value];
  return normalizeFacetSelection([...universe.filter(item => next.includes(item)), ...next.filter(item => !universe.includes(item))], universe);
}

export function filterRecords<T extends FilterRecord>(records: readonly T[], filters: SessionFilters, roleOf?: SessionRoleResolver): T[] {
  const availableRoles = new Set<string | null>(records.map(row => recordRole(row, roleOf)));
  const allRolesSelected = filters.roles == null || [...availableRoles].every(role => filters.roles!.includes(role));
  return records.filter(row => {
    return (filters.hosts === null || filters.hosts.includes(row.machine))
      && (!filters.workspaces?.length || filters.workspaces.includes(row.workspace ?? null))
      && !filters.excludedWorkspaces?.includes(row.workspace ?? null)
      && (allRolesSelected || filters.roles!.includes(recordRole(row, roleOf)))
      && (filters.harness === null || row.provider === filters.harness)
      && (!filters.repo || (row.repo_name?.trim() || row.cwd?.replace(/\/+$/, "").split("/").at(-1)) === filters.repo)
      && (filters.statusGroup === null || classifySessionStatus(sessionStatusEvidence(row)) === filters.statusGroup);
  });
}
/** Hidden-host filters never disconnect an already attached terminal's metadata. */
export function filterPollingMachines(permitted: readonly string[], selected: readonly string[] | null, attached: readonly string[]): string[] {
  return permitted.filter(machine => selected === null || selected.includes(machine) || attached.includes(machine));
}

/** Count a facet against the same normalized filters as the overview cards. */
export function sessionFacetCount(records: readonly FilterRecord[], filters: SessionFilters, option: Partial<SessionFilters>,
  roleOf?: SessionRoleResolver): number {
  const selected = { ...filters, ...option };
  return filterRecords(records, { ...selected, repo: selected.repo.trim() }, roleOf).length;
}

// Workspace names are distribution data: a UI extension registers them
// (extensions.tsx workspaceLabels), and core shows the slug (#895).
const NO_WORKSPACE_LABELS: ReadonlyMap<string, string> = new Map();
export function workspaceLabel(workspace: string | null, labels: ReadonlyMap<string, string> = NO_WORKSPACE_LABELS): string {
  return workspace === null ? "Unassigned" : labels.get(workspace) ?? workspace;
}
/** Registered workspaces first, so a named workspace is offered before any session carries it. */
export function sessionWorkspaceOptions(records: readonly Pick<FilterRecord, "workspace">[], selected: readonly (string | null)[] | null = null,
  known: Iterable<string> = []): readonly (string | null)[] {
  const slugs = new Set([...known, ...records.map(row => row.workspace), ...(selected ?? [])]
    .filter((value): value is string => typeof value === "string"));
  return [...slugs, null];
}

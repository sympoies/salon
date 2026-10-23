import { normalizeSessionWorkspace } from "@agent-console/shared/api";
import { localStorageGetItem, localStorageSetItem } from "./storage.ts";
import { normalizeFacetSelection } from "./sessionFilters.ts";

const KEY = "agent-console.workspaces.v2";
const LEGACY_KEY = "agent-console.excluded-workspaces.v1";
export type WorkspaceSelection = readonly (string | null)[] | null;
export interface WorkspacePreferences {
  readonly workspaces: WorkspaceSelection;
  readonly excludedWorkspaces: WorkspaceSelection;
}
function parseSelection(raw: string | null): WorkspaceSelection {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!Array.isArray(value) || !value.every(item => item === null || normalizeSessionWorkspace(item) !== null)) return null;
    return value.length ? [...new Set(value as (string | null)[])] : null;
  } catch { return null; }
}
/** Only a complete host snapshot can establish that a saved selection means all. */
export function loadWorkspacePreferences(choices?: readonly (string | null)[], complete = false): WorkspacePreferences {
  const raw = localStorageGetItem(KEY);
  let selected = parseSelection(raw);
  const excluded = raw === null ? parseSelection(localStorageGetItem(LEGACY_KEY)) : null;
  if (excluded) {
    // Retain an old restriction before discovery, while a host is offline, or
    // when its complement is empty. Interactive none=all must not erase hide-all.
    if (!choices || !complete) return { workspaces: null, excludedWorkspaces: excluded };
    const universe = [...new Set([...choices, ...excluded])];
    selected = universe.filter(value => !excluded.includes(value));
    if (!selected.length) return { workspaces: null, excludedWorkspaces: excluded };
    selected = normalizeFacetSelection(selected, universe);
  } else if (choices && complete) {
    selected = normalizeFacetSelection(selected, choices);
  }
  const preference = { workspaces: selected, excludedWorkspaces: null };
  if (choices && complete) saveWorkspacePreferences(preference);
  return preference;
}
export function saveWorkspacePreferences(value: { readonly workspaces?: WorkspaceSelection; readonly excludedWorkspaces?: WorkspaceSelection }): void {
  // Applying another facet must not turn an unresolved legacy restriction into all.
  if (value.excludedWorkspaces?.length) return;
  localStorageSetItem(KEY, JSON.stringify(value.workspaces?.length ? [...new Set(value.workspaces)] : null));
}

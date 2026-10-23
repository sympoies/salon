import type { WorkdirSuggestion } from "./api.ts";

/**
 * The selected working dir is a session's starting context: initial project
 * discovery, relative-path resolution, and history labelling. The selection
 * itself scopes nothing, and choosing or creating a managed worktree is never a
 * prerequisite for starting a session.
 *
 * The claim is deliberately about the selection, not about the agent. Whatever
 * authority a session has comes from its own agent configuration — a profile
 * may confine it — so this copy must not promise host access the console does
 * not control.
 */
export const WORKDIR_CONTEXT_HINT =
  "Starting context only — it does not limit which paths or repositories the session works in.";

export interface WorkdirSelection {
  readonly displayValue: string;
  readonly selectedPath: string;
}

export function primaryWorkdirLabel(item: Pick<WorkdirSuggestion, "path" | "name">): string {
  const name = item.name?.trim();
  if (name) return name;
  const parts = item.path.split("/").filter(Boolean);
  return parts.at(-1) ?? item.path;
}

export function secondaryWorkdirLabel(
  item: WorkdirSuggestion,
  allItems: readonly WorkdirSuggestion[],
): string | undefined {
  const label = primaryWorkdirLabel(item);
  const duplicateCount = allItems.filter((candidate) => primaryWorkdirLabel(candidate) === label).length;
  if (duplicateCount < 2) return undefined;
  return parentSegment(item.path);
}

export function filterWorkdirOptions(
  items: readonly WorkdirSuggestion[],
  query: string,
): WorkdirSuggestion[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => {
    const primary = primaryWorkdirLabel(item).toLocaleLowerCase();
    const parent = parentSegment(item.path)?.toLocaleLowerCase() ?? "";
    return primary.includes(needle) || parent.includes(needle) || item.path.toLocaleLowerCase().includes(needle);
  });
}

export function selectWorkdir(item: WorkdirSuggestion): WorkdirSelection {
  return {
    displayValue: primaryWorkdirLabel(item),
    selectedPath: item.path,
  };
}

export function cwdForCreate(selection: WorkdirSelection): string | undefined {
  return selection.selectedPath.trim() || undefined;
}

function parentSegment(path: string): string | undefined {
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.at(-2) : undefined;
}

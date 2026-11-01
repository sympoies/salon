import { IconButton } from "./IconButton.tsx";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CLEAR_SESSION_FILTERS, sessionWorkspaceOptions, workspaceLabel, sessionFacetCount, normalizeFacetSelection, toggleFacetSelection, type SessionRoleResolver, type FilterRecord, type SessionFilters } from "./sessionFilters.ts";
import { sessionListHarnessLabel } from "./sessionListNavigation.ts";
import { useAndroidBackEntry } from "./useAndroidBackEntry.ts";
import { useDismissOnOutside } from "./useDismissOnOutside.ts";
import { useUiExtensions } from "./extensions.tsx";
import { CloseIcon, SelectChevronIcon } from "./icons.tsx";
import { SessionStatusCountButtons, sessionStatusCountValues } from "./SessionStatusCountButtons.tsx";
import type { OfflineCountMachine } from "./headerCountAvailability.ts";
import { SESSION_STATUS_LABELS, type SessionStatusCounts, type SessionStatusGroup } from "./sessionStatusGroups.ts";

export interface SessionFiltersBarProps {
  readonly filters: SessionFilters;
  readonly records?: readonly FilterRecord[];
  readonly countRecords?: readonly FilterRecord[];
  readonly offlineCountMachines?: readonly OfflineCountMachine[];
  readonly countsAvailable?: boolean;
  readonly workspaceChoicesComplete?: boolean;
  readonly onChange: (filters: SessionFilters) => void;
  readonly machines: readonly string[];
  readonly roles?: readonly string[];
  readonly harnesses: readonly { id: string; label: string }[];
  readonly roleOf?: SessionRoleResolver;
  readonly resultCount: number;
  readonly statusCounts?: SessionStatusCounts;
  readonly compactHeader?: boolean;
  readonly statusCountsTarget?: HTMLElement | null;
  readonly mobile: boolean;
  readonly notice?: string;
  readonly migrationNotice?: boolean;
  readonly onDismissMigration?: () => void;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children?: import("react").ReactNode;
  /** Host-offline toast; it floats on the trigger row, which is header row two. */
  readonly statusNotice?: import("react").ReactNode;
  /** Desktop only: show the notice in the filter field's free space, as no width is left beside the field (#761). */
  readonly noticeInField?: boolean;
}
const EMPTY_RECORDS: readonly FilterRecord[] = [];
function sameFacetSelection<T>(left: readonly T[] | null | undefined, right: readonly T[] | null | undefined): boolean {
  return left === right || (left == null && right == null)
    || Boolean(left && right && left.length === right.length && left.every(value => right.includes(value)));
}
function sameAppliedFilters(left: SessionFilters, right: SessionFilters): boolean {
  return left.harness === right.harness && left.repo === right.repo
    && left.statusGroup === right.statusGroup
    && sameFacetSelection(left.workspaces, right.workspaces)
    && sameFacetSelection(left.excludedWorkspaces, right.excludedWorkspaces)
    && sameFacetSelection(left.hosts, right.hosts) && sameFacetSelection(left.roles, right.roles);
}
function rebaseDraft(draft: SessionFilters, previous: SessionFilters, next: SessionFilters): SessionFilters {
  const workspaceUntouched = sameFacetSelection(draft.workspaces, previous.workspaces)
    && sameFacetSelection(draft.excludedWorkspaces, previous.excludedWorkspaces);
  return {
    ...draft,
    hosts: sameFacetSelection(draft.hosts, previous.hosts) ? next.hosts : draft.hosts,
    roles: sameFacetSelection(draft.roles, previous.roles) ? next.roles : draft.roles,
    harness: draft.harness === previous.harness ? next.harness : draft.harness,
    repo: draft.repo === previous.repo ? next.repo : draft.repo,
    statusGroup: draft.statusGroup === previous.statusGroup ? next.statusGroup : draft.statusGroup,
    ...(workspaceUntouched ? { workspaces: next.workspaces, excludedWorkspaces: next.excludedWorkspaces } : {}),
  };
}
export function SessionFiltersBar({ records, countRecords, offlineCountMachines = [], countsAvailable = records !== undefined,
  workspaceChoicesComplete = countsAvailable && offlineCountMachines.length === 0, filters, onChange, machines, roles, harnesses, roleOf, resultCount,
  statusCounts = { working: 0, waiting: 0, attention: 0, unknown: 0, stopped: 0 }, compactHeader = false, mobile, notice, migrationNotice, onDismissMigration, open: controlledOpen,
  onOpenChange, children, statusNotice, noticeInField = false, statusCountsTarget }: SessionFiltersBarProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const syncOpenDraft = compactHeader && !mobile && open;
  const fieldNotice = noticeInField && compactHeader && !mobile && Boolean(statusNotice);
  const setOpen = useCallback((value: boolean) => { setInternalOpen(value); onOpenChange?.(value); }, [onOpenChange]);
  const [draft, setDraft] = useState(filters);
  const immediateCommitRef = useRef<SessionFilters | null>(null);
  const appliedFiltersRef = useRef<SessionFilters | null>(null);
  const draftBaseRef = useRef(filters);
  const snapshot = countRecords ?? records ?? EMPTY_RECORDS;
  const { workspaceLabels } = useUiExtensions();
  const nameWorkspace = (workspace: string | null) => workspaceLabel(workspace, workspaceLabels);
  const workspaceChoices = sessionWorkspaceOptions(snapshot, [...(filters.workspaces ?? []), ...(filters.excludedWorkspaces ?? [])], workspaceLabels.keys());
  const normalizeWorkspaces = (value: SessionFilters["workspaces"]) => workspaceChoicesComplete
    ? normalizeFacetSelection(value ?? null, workspaceChoices) : value?.length ? value : null;
  const selectedWorkspaces = normalizeWorkspaces(filters.workspaces);
  const draftWorkspaces = draft.excludedWorkspaces?.length
    ? workspaceChoices.filter(workspace => !draft.excludedWorkspaces!.includes(workspace)) : draft.workspaces ?? null;
  const count = (option: Partial<SessionFilters>) => countsAvailable ? sessionFacetCount(snapshot, open ? draft : filters, option, roleOf) : "–";
  const headingId = useId();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null), panelRef = useRef<HTMLDivElement>(null), triggerRef = useRef<HTMLElement>(null);
  const close = useCallback(() => setOpen(false), [setOpen]);
  useAndroidBackEntry("session-filters", open, close);
  useDismissOnOutside(open, ".overview-session-filters, #mac-titlebar-counts", close);
  useEffect(() => {
    if (!open) return;
    const initial = normalizeFilters(filters);
    setDraft(initial);
    draftBaseRef.current = initial;
    appliedFiltersRef.current = filters;
    const timer = window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>("select")?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      if (panelRef.current?.contains(document.activeElement) || document.activeElement === document.body) triggerRef.current?.focus();
    };
  }, [open]);
  useEffect(() => {
    // Adopt changed applied preferences only in facets the open editor has not edited.
    // Cloned polling values must not discard staged edits on either layout.
    if (open && appliedFiltersRef.current && !sameAppliedFilters(filters, appliedFiltersRef.current)) {
      const next = normalizeFilters(filters), previous = draftBaseRef.current;
      if (filters !== immediateCommitRef.current) setDraft(current => rebaseDraft(current, previous, next));
      draftBaseRef.current = next;
    }
    appliedFiltersRef.current = open ? filters : null;
    immediateCommitRef.current = null;
  }, [open, filters]);
  const update = (patch: Partial<SessionFilters>) => setDraft(current => ({ ...current, ...patch }));
  // Empty facet selections never apply, and a selection covering every value is all.
  const normalizeFilters = (next: SessionFilters): SessionFilters => ({
    ...next,
    workspaces: next.excludedWorkspaces?.length ? null : normalizeWorkspaces(next.workspaces),
    hosts: normalizeFacetSelection(next.hosts, machines),
    ...(next.roles === undefined ? {} : { roles: normalizeFacetSelection(next.roles, [null, ...(roles ?? [])]) }),
  });
  const commit = (next: SessionFilters) => {
    const applied = { ...normalizeFilters(next), repo: next.repo.trim() };
    setDraft(applied);
    onChange(applied);
    close();
  };
  const restrictedHosts = filters.hosts === null ? 0 : machines.filter(machine => !filters.hosts!.includes(machine)).length;
  const roleChoices: readonly (string | null)[] = [null, ...(roles ?? [])];
  const selectedRoleCount = filters.roles == null || roleChoices.every(role => filters.roles!.includes(role))
    ? roleChoices.length : roleChoices.filter(role => filters.roles!.includes(role)).length;
  const rolesNarrowed = filters.roles != null && selectedRoleCount < roleChoices.length;
  // Chips and the summary show the first value plus a count; the full list stays in the title and accessible name.
  const dimension = (name: string, selected: readonly string[], prefix = "") => {
    const values = selected.length ? selected : ["None"];
    return { label: `${name}: ${prefix}${values.join(", ")}`, compact: `${name}: ${prefix}${values[0]}${values.length > 1 ? ` +${values.length - 1}` : ""}` };
  };
  const workspaceChip = filters.excludedWorkspaces?.length ? dimension("Workspace", filters.excludedWorkspaces.map(nameWorkspace), "All except ")
    : selectedWorkspaces != null ? dimension("Workspace", selectedWorkspaces.map(nameWorkspace)) : undefined;
  const single = (label: string) => ({ label, compact: label });
  const chips = [
    ...(workspaceChip ? [{ key: "workspace", ...workspaceChip, reset: { workspaces: null, excludedWorkspaces: null } }] : []),
    ...(filters.hosts !== null && restrictedHosts > 0 ? [{ key: "hosts", ...dimension("Hosts", [...machines.filter(machine => filters.hosts!.includes(machine)), ...filters.hosts!.filter(host => !machines.includes(host))]), reset: { hosts: null } }] : []),
    ...(roles !== undefined && rolesNarrowed ? [{ key: "roles", ...dimension("Roles", roleChoices.filter(role => filters.roles!.includes(role)).map(role => role ?? "No role")), reset: { roles: null } }] : []),
    ...(filters.harness ? [{ key: "harness", ...single(`Harness: ${sessionListHarnessLabel(filters.harness)}`), reset: { harness: null } }] : []),
    ...(filters.repo ? [{ key: "repo", ...single(`Repository: ${filters.repo}`), reset: { repo: "" } }] : []),
    ...(filters.statusGroup ? [{ key: "status", ...single(`Status: ${SESSION_STATUS_LABELS[filters.statusGroup][0]}`), reset: { statusGroup: null } }] : []),
  ];
  const summaryEntries = [
    filters.hosts === null ? "All machines" : `${machines.length - restrictedHosts} of ${machines.length} machines`,
    filters.harness ? sessionListHarnessLabel(filters.harness) : undefined,
    filters.repo || undefined,
    workspaceChip,
  ].flatMap(entry => !entry ? [] : typeof entry === "string" ? [{ label: entry, compact: entry }] : [entry]);
  const summary = summaryEntries.map(entry => entry.label).join(" · ");
  const hostLabel = (count: number) => `${count} ${count === 1 ? "host" : "hosts"}`;
  const hostCoverage = filters.hosts === null
    ? `All ${hostLabel(machines.length)} shown`
    : `${hostLabel(filters.hosts.length)} of ${hostLabel(machines.length)} shown`;
  const noticeCue = [notice?.trim(), migrationNotice ? "Host filter notice available" : null].filter(Boolean).join(". ");
  const toggleStatus = (group: SessionStatusGroup) => {
    const statusGroup = filters.statusGroup === group ? null : group;
    applyImmediate({ ...filters, statusGroup }, { statusGroup });
  };
  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mobile && event.key === "Tab") {
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), input, select")];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  const applyImmediate = (next: SessionFilters, draftPatch: Partial<SessionFilters> = next) => {
    if (syncOpenDraft) immediateCommitRef.current = next;
    onChange(next);
    setDraft(current => ({ ...current, ...draftPatch }));
  };
  const filterDetails = <>
    <div className="session-filter-chips" aria-label="Active session filters">
      {chips.map(chip => <button key={chip.key} type="button" className="control-chip btn session-filter-chip" aria-label={`Remove ${chip.label}`} title={chip.label}
        onClick={() => applyImmediate({ ...filters, ...chip.reset }, chip.reset)}><span className="session-filter-chip-label">{chip.compact}</span><span aria-hidden="true"> ×</span></button>)}
      {chips.length > 0 ? <button className="btn ghost" type="button" onClick={() => applyImmediate(CLEAR_SESSION_FILTERS)}>Clear all</button> : null}
    </div>
    {restrictedHosts > 0 ? <div className="session-list-hidden-hosts" role="status"><span>{restrictedHosts} {restrictedHosts === 1 ? "host" : "hosts"} excluded by your filter</span>
      <button className="btn ghost" type="button" onClick={() => applyImmediate({ ...filters, hosts: null }, { hosts: null })}>Show all hosts</button></div> : null}
    {notice ? <p className="session-filter-notice" role="status">{notice}</p> : null}
    {migrationNotice ? <div className="session-filter-notice" role="status"><span>All permitted hosts are now shown; choose Hosts in Filters to narrow them.</span>
      <button className="btn ghost" type="button" onClick={onDismissMigration}>Dismiss host notice</button></div> : null}
  </>;
  const statusCountsElement = <SessionStatusCountButtons offlineCountMachines={offlineCountMachines} compactHeader={compactHeader}
    activeGroup={filters.statusGroup} onToggle={toggleStatus}
    counts={records === undefined && countsAvailable ? statusCounts
      : sessionStatusCountValues(snapshot, open ? draft : filters, countsAvailable, roleOf)} />;
  const expandedPanel = open ? <>
    {mobile ? <button type="button" className="session-filter-scrim" aria-label="Close session filters" onClick={close} /> : null}
    <div id={panelId} ref={panelRef} className={`session-filter-panel ${mobile ? "is-mobile" : ""}`} role="dialog" aria-modal={mobile ? true : undefined} aria-labelledby={headingId} onKeyDown={onKeyDown}>
      <div className="session-filter-panel-heading"><h2 id={headingId}>Session filters</h2><IconButton className="btn" aria-label="Close session filters" type="button" onClick={close}><CloseIcon /></IconButton></div>
      {compactHeader ? filterDetails : null}
      <div className="session-filter-panel-fields">
        <details open className="session-filter-multi-select" data-filter-dimension="workspaces">
          <summary>Workspace <span>{draftWorkspaces == null ? `All workspaces (${count({ workspaces: null, excludedWorkspaces: null })})` : `${draftWorkspaces.length} of ${workspaceChoices.length}`}</span></summary>
          <div className="session-filter-facet-body"><button type="button" className="btn ghost session-filter-facet-all" disabled={draftWorkspaces == null} onClick={() => update({ workspaces: null, excludedWorkspaces: null })}>All workspaces</button>
            <fieldset className="session-filter-options"><legend className="sr-only">Workspace</legend>{workspaceChoices.map(workspace => <label className="session-filter-choice" key={workspace ?? "unassigned"}>
              <input type="checkbox" value={workspace ?? ""} checked={draftWorkspaces?.includes(workspace) ?? false} onChange={() => update({ workspaces: toggleFacetSelection(draftWorkspaces, workspaceChoices, workspace), excludedWorkspaces: null })} />{nameWorkspace(workspace)} ({count({ workspaces: [workspace], excludedWorkspaces: null })})</label>)}</fieldset>
          </div>
        </details>
          <details open className="session-filter-multi-select" data-filter-dimension="hosts">
            <summary>Hosts <span>{draft.hosts === null ? `All hosts (${count({ hosts: null })})` : `${machines.filter(machine => draft.hosts!.includes(machine)).length} of ${machines.length}`}</span></summary>
            <div className="session-filter-facet-body"><button type="button" className="btn ghost session-filter-facet-all" disabled={draft.hosts === null} onClick={() => update({ hosts: null })}>All hosts</button>
            <fieldset className="session-filter-options"><legend className="sr-only">Hosts</legend>{machines.map(machine => <label className="session-filter-choice session-filter-host" key={machine}>
          <input type="checkbox" value={machine} checked={draft.hosts?.includes(machine) ?? false} onChange={() => update({ hosts: toggleFacetSelection(draft.hosts, machines, machine) })} />{machine} ({count({ hosts: [machine] })})</label>)}</fieldset></div>
          </details>
          {roles !== undefined ? <details open className="session-filter-multi-select" data-filter-dimension="roles">
            <summary>Roles <span>{draft.roles == null || roleChoices.every(role => draft.roles!.includes(role)) ? `All roles (${count({ roles: null })})` : `${roleChoices.filter(role => draft.roles!.includes(role)).length} of ${roleChoices.length}`}</span></summary>
            <div className="session-filter-facet-body"><button type="button" className="btn ghost session-filter-facet-all" disabled={draft.roles == null} onClick={() => update({ roles: null })}>All roles</button>
            <fieldset className="session-filter-options"><legend className="sr-only">Roles</legend>{roleChoices.map(role => <label className="session-filter-choice" key={role ?? "no-role"}>
              <input type="checkbox" value={role ?? ""} checked={draft.roles?.includes(role) ?? false} onChange={() => update({ roles: toggleFacetSelection(draft.roles ?? null, roleChoices, role) })} />{role ?? "No role"} ({count({ roles: [role] })})</label>)}</fieldset></div>
          </details> : null}
        <label><span>Harness</span><select aria-label="Filter sessions by harness" value={draft.harness ?? ""} onChange={event => update({ harness: event.currentTarget.value || null })}>
          <option value="">All harnesses ({count({ harness: null })})</option>{harnesses.map(harness => <option key={harness.id} value={harness.id}>{harness.label} ({count({ harness: harness.id })})</option>)}
        </select></label>
        <label><span>Repository</span><input type="search" aria-label="Repository" autoCorrect="off" autoCapitalize="none" spellCheck={false} placeholder="Exact repository name" value={draft.repo} onChange={event => update({ repo: event.currentTarget.value })} /></label>

      </div>
      <div className="session-filter-panel-actions"><button className="btn" type="button" onClick={() => commit(CLEAR_SESSION_FILTERS)}>Clear all</button>
        <button className="btn primary" type="button" onClick={() => commit(draft)}>Apply filters</button></div>
    </div>
  </> : null;
  return <div ref={rootRef} onKeyDownCapture={onRootKeyDown} className={`session-filters-bar overview-session-filters ${compactHeader ? "is-compact-header" : ""}`}>
    <div className={`session-filters-summary ${compactHeader ? "is-compact-header" : ""}`}>
      {compactHeader ? <>
        <div className="session-filter-controls-row">
          {children}
          <div className={`session-filter-trigger-row ${mobile ? "is-mobile" : ""} ${statusNotice && !fieldNotice ? "has-row-notice" : ""}`}>
            <div className="session-filter-searchbar" onClick={() => setOpen(!open)}>
              <button ref={element => { triggerRef.current = element; }} className="session-filters-trigger session-filter-search-open" type="button"
                aria-label={`Filter sessions. ${summary}. ${resultCount} matching ${resultCount === 1 ? "session" : "sessions"}.${noticeCue ? ` Notice: ${noticeCue}.` : ""}`}
                aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} onClick={event => { event.stopPropagation(); setOpen(!open); }}>
                <svg className="session-filter-search-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/></svg>
                {chips.length === 0 ? <span className="session-filter-placeholder">Filter sessions</span> : null}
              </button>
              <span className="session-filter-search-chips" aria-label="Active session filters">
                {chips.map(chip => <button key={chip.key} type="button" className="control-chip control-chip--dense btn session-filter-chip" aria-label={`Remove ${chip.label}`}
                  data-filter-chip={chip.key} title={chip.label}
                  onClick={event => { event.stopPropagation(); applyImmediate({ ...filters, ...chip.reset }, chip.reset); }}><span className="session-filter-chip-label">{chip.compact}</span><span aria-hidden="true"> ×</span></button>)}
              </span>
              {noticeCue ? <span className="session-filter-notice-indicator" aria-hidden="true">!</span> : null}
              {fieldNotice ? <div className="session-filter-field-notice" onClick={event => event.stopPropagation()}>{statusNotice}</div> : null}
            </div>
            {expandedPanel}
            {fieldNotice || mobile ? null : statusNotice}
          </div>
        </div>
        <div className="session-filter-status-row">{statusCountsTarget ? createPortal(statusCountsElement, statusCountsTarget) : statusCountsElement}{mobile ? statusNotice : null}</div>
      </> : <div className={`session-filter-trigger-row ${mobile ? "is-mobile" : ""}`}><button ref={element => { triggerRef.current = element; }} className="btn session-filters-trigger" type="button" aria-label={`Filters. ${summary}. ${resultCount} matching ${resultCount === 1 ? "session" : "sessions"}.${noticeCue ? ` Notice: ${noticeCue}.` : ""}`}
          aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
          <svg className="session-filters-trigger-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7z" /></svg>
          <strong className="session-filters-trigger-label">Filters</strong>
          <span className="session-filters-trigger-summary">{summaryEntries.map(entry => <span key={entry.label} className="session-filters-trigger-part" title={entry.label}>{entry.compact}</span>)}</span>
          {noticeCue ? <span className="session-filter-notice-indicator" aria-hidden="true">!</span> : null}
          <SelectChevronIcon className="session-filters-trigger-chevron" />
        </button>{statusCountsElement}</div>}
      <span className="sr-only" role="status" aria-live="polite">{resultCount} matching {resultCount === 1 ? "session" : "sessions"}</span>
    </div>
    {compactHeader ? null : <>
      {filterDetails}
      <div className="session-filter-coverage">{hostCoverage}</div>
    </>}
    {!compactHeader ? expandedPanel : null}
  </div>;
}

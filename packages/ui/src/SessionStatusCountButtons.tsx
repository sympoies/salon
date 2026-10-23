import { CardStatusIcon } from "./CardStatusIcon.tsx";
import { HeaderCountsNotice } from "./HeaderCountsNotice.tsx";
import type { OfflineCountMachine } from "./headerCountAvailability.ts";
import { sessionFacetCount, type SessionScopeModel, type FilterRecord, type SessionFilters } from "./sessionFilters.ts";
import { SESSION_STATUS_GROUPS, SESSION_STATUS_LABELS, type SessionStatusGroup } from "./sessionStatusGroups.ts";

export type SessionStatusCountValues = Readonly<Record<SessionStatusGroup, number | "–">>;

/** Each group's count under the other filters; "–" until the hosts have answered. */
export function sessionStatusCountValues(records: readonly FilterRecord[], filters: SessionFilters, available: boolean,
  scopes?: SessionScopeModel): SessionStatusCountValues {
  return Object.fromEntries(SESSION_STATUS_GROUPS.map(group => [group,
    available ? sessionFacetCount(records, filters, { statusGroup: group }, scopes) : "–"])) as SessionStatusCountValues;
}

export interface SessionStatusCountButtonsProps {
  readonly counts: SessionStatusCountValues;
  readonly activeGroup: SessionStatusGroup | null | undefined;
  readonly offlineCountMachines: readonly OfflineCountMachine[];
  readonly compactHeader?: boolean;
  readonly onToggle: (group: SessionStatusGroup) => void;
}

/** The title bar's status count buttons, shared by the session list and the single-session view (#938). */
export function SessionStatusCountButtons({ counts, activeGroup, offlineCountMachines, compactHeader = false, onToggle }: SessionStatusCountButtonsProps) {
  return <div className="session-status-counts" role="group" aria-label="Session status counts">
    {SESSION_STATUS_GROUPS.map(group => {
      const [label, compactLabel, shortLabel] = SESSION_STATUS_LABELS[group];
      const count = counts[group];
      // State unknown is exceptional: shown only while a session is in it or
      // its filter is on, so the usual header keeps its four counts (#873).
      if (group === "unknown" && !(typeof count === "number" && count > 0) && activeGroup !== group) return null;
      const iconState = group === "attention" ? "blocked" : group === "stopped" ? "stopped" : group;
      return <button key={group} type="button" className={`control-counter session-status-count card-state-${iconState} ${group === "stopped" ? "is-stopped" : ""}`}
        data-status-group={group} title={`${label}: ${count} ${count === 1 ? "session" : "sessions"}${offlineCountMachines.length ? " (partial counts)" : ""}`}
        aria-label={`${label}: ${count} ${count === 1 ? "session" : "sessions"}${offlineCountMachines.length ? " (partial counts)" : ""}`}
        aria-pressed={activeGroup === group} onClick={() => onToggle(group)}>
        <CardStatusIcon state={iconState} dot /><span>{count}</span>
        {compactHeader ? <><span className="session-status-count-label">{compactLabel}</span>
          <span className="session-status-count-short-label" aria-hidden="true">{shortLabel}</span></> : null}
      </button>;
    })}<HeaderCountsNotice machines={offlineCountMachines} />
  </div>;
}

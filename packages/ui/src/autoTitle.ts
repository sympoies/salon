import {
  composeTitle as composeSharedTitle,
  normalizeSessionTitleState,
  promptTitleSuffix as sharedPromptTitleSuffix,
  truncateTitle,
} from "@agent-console/shared/title";
import type { TitleSummaryResult } from "@agent-console/shared/api";
import type { SessionTitleState } from "@agent-console/shared/title";
import { normalizeSessionTitle } from "./sessionTitle.ts";
import { safeGetItem, safeSetItem, type StorageLike } from "./storage.ts";

const AUTO_TITLE_STATES_STORAGE = "agent-console.auto-title.states.v1";

export interface AutoTitleState {
  readonly baseTitle: string | null;
  readonly baseTitleConfirmed?: boolean;
  readonly disabled: boolean;
  readonly ownedTitle?: string | null;
}

export type AutoTitleStates = Record<string, AutoTitleState>;

export function promptTitleSuffix(prompt: string): string | null {
  return sharedPromptTitleSuffix(prompt);
}

export function composeAutoTitle(baseTitle: string | null | undefined, suffix: string | null | undefined): string | null {
  return composeSharedTitle(baseTitle, suffix);
}

export function autoTitleFromPrompt(baseTitle: string | null | undefined, prompt: string): string | null {
  return composeAutoTitle(baseTitle, promptTitleSuffix(prompt));
}

export function isAutoTitlePlaceholder(title: string | null | undefined): boolean {
  const normalized = normalizeSessionTitle(title ?? "");
  return Boolean(normalized && /^New .+ session$/i.test(normalized));
}

export function titleCandidateFromSummary(summary: Partial<TitleSummaryResult>): string | null {
  const title = normalizeSessionTitle(summary.title ?? "");
  return title ? truncateTitle(title) : null;
}

export function recoverAutoTitleBase(
  _title: string | null | undefined,
  titleState?: SessionTitleState | null,
): string | null {
  const state = normalizeSessionTitleState(titleState);
  return state?.topic ?? null;
}

export function deriveAutoTitleStateFromSession(
  current: AutoTitleState | undefined,
  title: string | null,
  titleState?: SessionTitleState | null,
): AutoTitleState {
  const structured = normalizeSessionTitleState(titleState);
  if (structured) {
    return {
      baseTitle: structured.topic,
      baseTitleConfirmed: structured.topic_source !== "none",
      disabled: current?.disabled ?? false,
      ownedTitle: title,
    };
  }
  return {
    baseTitle: current?.baseTitleConfirmed ? current.baseTitle : title,
    baseTitleConfirmed: true,
    disabled: current?.disabled ?? false,
    ownedTitle: title,
  };
}

export function autoTitleStatesEqual(a: AutoTitleStates, b: AutoTitleStates): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => {
    const left = a[key];
    const right = b[key];
    return left?.baseTitle === right?.baseTitle
      && left?.baseTitleConfirmed === right?.baseTitleConfirmed
      && left?.disabled === right?.disabled
      && left?.ownedTitle === right?.ownedTitle;
  });
}

export function pruneAutoTitleStates(states: AutoTitleStates, liveKeys: Iterable<string>): AutoTitleStates {
  const live = new Set(liveKeys);
  const next: AutoTitleStates = {};
  for (const [key, value] of Object.entries(states)) {
    if (live.has(key)) {
      next[key] = value;
    }
  }
  return autoTitleStatesEqual(states, next) ? states : next;
}

function isAutoTitleState(value: unknown): value is AutoTitleState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const state = value as Partial<AutoTitleState>;
  return (typeof state.baseTitle === "string" || state.baseTitle === null)
    && (state.baseTitleConfirmed === undefined || typeof state.baseTitleConfirmed === "boolean")
    && typeof state.disabled === "boolean"
    && (state.ownedTitle === undefined || typeof state.ownedTitle === "string" || state.ownedTitle === null);
}

export function readAutoTitleStates(storage: StorageLike | null | undefined): AutoTitleStates {
  const raw = safeGetItem(storage, AUTO_TITLE_STATES_STORAGE);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: AutoTitleStates = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === "string" && isAutoTitleState(value)) {
        out[key] = value.ownedTitle === undefined
          ? { ...value, baseTitleConfirmed: false, disabled: true }
          : { ...value, baseTitleConfirmed: value.baseTitleConfirmed === true };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeAutoTitleStates(storage: StorageLike | null | undefined, states: AutoTitleStates): void {
  safeSetItem(storage, AUTO_TITLE_STATES_STORAGE, JSON.stringify(states));
}

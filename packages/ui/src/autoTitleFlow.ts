import type {
  ApiResult,
  CreatedSessionSnapshot,
  TitleSummaryRequest,
  TitleSummaryResult,
} from "./api.ts";
import {
  autoTitleFromPrompt,
  isAutoTitlePlaceholder,
  promptTitleSuffix,
  titleCandidateFromSummary,
  type AutoTitleState,
} from "./autoTitle.ts";
import type { CreateBody, Glance, Session } from "./types.ts";
import {
  emptySessionTitleState,
  normalizeSessionTitleState,
  oneLineTitle,
  sessionTitleStatesEqual,
  truncateTitle,
  userSessionTitleState,
  type SessionTitleState,
} from "@agent-console/shared/title";

const TURN_TITLE_GLANCE_TAIL = 80;
export const MANUAL_RETITLE_GLANCE_TAIL = 160;
export const MANUAL_RETITLE_PROMPT =
  "Generate a concise title for this session from the current title and recent terminal output.";

export interface PreparedCreateSessionAutoTitle {
  readonly createBody: CreateBody;
  readonly prompt: string | null;
  readonly titlePrompt: string | null;
  readonly baseTitle: string | null;
  readonly fallbackTitle: string | null;
}

export interface CreatedSessionAutoTitleStateInput {
  readonly createBody: CreateBody;
  readonly createdSession: Pick<Session, "title" | "title_state" | "provider_resume">;
  readonly prompt: string | null;
  readonly baseTitle: string | null;
  readonly fallbackTitle: string | null;
}

export function createdSessionAutoTitleState(
  input: CreatedSessionAutoTitleStateInput,
): AutoTitleState | null {
  if (
    input.createBody.provider_resume_id !== undefined
    || !(
      input.prompt
      || input.baseTitle
      || input.createdSession.title_state
      || isAutoTitlePlaceholder(input.createdSession.title)
    )
  ) {
    return null;
  }
  return {
    // Only an explicit or summarized structured topic is a confirmed intent
    // anchor; empty structured state remains unconfirmed until summarization.
    baseTitle: input.createdSession.title_state?.topic ?? input.baseTitle,
    baseTitleConfirmed: input.createdSession.title_state
      ? input.createdSession.title_state.topic_source !== "none"
      : input.baseTitle !== null,
    disabled: false,
    ownedTitle: input.createdSession.title ?? null,
  };
}

function isProviderResumeCreate(body: CreateBody): boolean {
  return body.provider_resume_id !== undefined;
}

function baseTitleForCreate(body: CreateBody): string | null {
  // Only an explicit, user-provided title becomes the composable base title.
  // The repo name is already shown in the header repo badge, so it must not be
  // derived from the cwd into the title where it would just duplicate the badge
  // (and then get re-prefixed onto every per-turn title refresh).
  const title = oneLineTitle(body.title);
  return title ? truncateTitle(title) : null;
}

export function prepareCreateSessionAutoTitle(body: CreateBody): PreparedCreateSessionAutoTitle {
  const { prompt: initialPrompt, ...bodyWithoutPrompt } = body;
  const shouldSeedTitle = !isProviderResumeCreate(body);
  const prompt = initialPrompt?.trim() ? initialPrompt : null;
  const titlePrompt = shouldSeedTitle && prompt ? promptTitleSuffix(prompt) : null;
  const baseTitle = baseTitleForCreate(body);
  const fallbackTitle = titlePrompt ? autoTitleFromPrompt(baseTitle, titlePrompt) : null;
  // Never persist prompt text as a provisional title. An explicit base is safe;
  // otherwise create explicit empty structured state and leave the display
  // untitled until the runtime summarizer confirms a concise intent. The repo
  // name stays in the existing badge.
  const titleState = baseTitle
    ? userSessionTitleState(baseTitle) ?? emptySessionTitleState()
    : emptySessionTitleState();
  const provisionalTitle = baseTitle;
  return {
    createBody: shouldSeedTitle
      ? {
          ...bodyWithoutPrompt,
          ...(provisionalTitle ? { title: provisionalTitle } : {}),
          title_state: titleState,
        }
      : bodyWithoutPrompt,
    prompt,
    titlePrompt,
    baseTitle,
    fallbackTitle,
  };
}

export function resolveCreatedSession(
  sessions: readonly Session[],
  beforeKeys: ReadonlySet<string>,
  created?: { readonly machine: string; readonly id: string },
): Session | null {
  if (created) {
    return sessions.find((session) => session.machine === created.machine && session.id === created.id) ?? null;
  }
  const candidates = sessions.filter((session) => !beforeKeys.has(`${session.machine}/${session.id}`));
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

export function resolveCreateTitleSession(
  created: CreatedSessionSnapshot | undefined,
  reconciled: Session | null,
): CreatedSessionSnapshot | null {
  if (!created) {
    return reconciled;
  }
  if (!reconciled) {
    return created;
  }
  if (
    created.session_incarnation
    && reconciled.session_incarnation !== created.session_incarnation
  ) {
    return reconciled.session_incarnation ? null : created;
  }
  return reconciled;
}

export interface CreatePromptAutoTitleSummaryDeps {
  readonly session: Pick<Session, "machine" | "id">;
  readonly prompt: string;
  readonly baseTitle: string | null;
  readonly titleState?: SessionTitleState | null;
  readonly fallbackTitle: string;
  readonly expectedCurrentTitle?: string | null;
  readonly isDisabled: () => boolean;
  readonly summarizeTitle: (body: TitleSummaryRequest) => Promise<TitleSummaryResult>;
  readonly updateTitle: (
    machine: string,
    id: string,
    title: string | null,
    titleState?: SessionTitleState,
  ) => Promise<ApiResult>;
  readonly currentTitle?: () => Promise<string | null | undefined>;
  readonly rememberTitle: (
    machine: string,
    id: string,
    title: string | null,
    titleState?: SessionTitleState,
  ) => void;
  readonly onTitlePending?: (title: string | null, titleState?: SessionTitleState) => void;
  readonly onTitleCommitted?: (title: string | null, titleState?: SessionTitleState) => void;
  readonly onError: (message: string) => void;
  readonly refresh: () => void;
}

export type CreatePromptAutoTitleSummaryResult =
  | "disabled"
  | "summary-failed"
  | "stale-title"
  | "unchanged"
  | "updated"
  | "update-failed";

type SummaryTitleFlowResult = CreatePromptAutoTitleSummaryResult | TurnPromptAutoTitleSummaryResult;
type SummaryTitleFlowBaseResult = Exclude<SummaryTitleFlowResult, "glance-failed">;
type SummaryTitlePrepareExit = Extract<SummaryTitleFlowResult, "disabled" | "glance-failed" | "stale-title">;

export interface SummaryTitleCommitDeps {
  readonly session: Pick<Session, "machine" | "id">;
  readonly updateTitle: (
    machine: string,
    id: string,
    title: string | null,
    titleState?: SessionTitleState,
  ) => Promise<ApiResult>;
  readonly rememberTitle: (
    machine: string,
    id: string,
    title: string | null,
    titleState?: SessionTitleState,
  ) => void;
  readonly onTitlePending?: (title: string | null, titleState?: SessionTitleState) => void;
  readonly onTitleCommitted?: (title: string | null, titleState?: SessionTitleState) => void;
  readonly onError: (message: string) => void;
  readonly refresh: () => void;
}

export interface SummaryTitleFlowDeps extends SummaryTitleCommitDeps {
  readonly summarizeTitle: (body: TitleSummaryRequest) => Promise<TitleSummaryResult>;
}

export interface SummaryTitleCandidateOptions {
  readonly requireSource?: TitleSummaryResult["source"];
  readonly unchangedTitleState?: SessionTitleState;
}

export type SummaryTitleCandidate =
  | { readonly result: "candidate"; readonly title: string | null; readonly titleState?: SessionTitleState }
  | { readonly result: "summary-failed" | "unchanged" };

export function resolveSummaryCandidate(
  summary: TitleSummaryResult | null | undefined,
  unchangedTitle: string | null | undefined,
  opts: SummaryTitleCandidateOptions = {},
): SummaryTitleCandidate {
  if (!summary?.ok || (opts.requireSource && summary.source !== opts.requireSource)) {
    return { result: "summary-failed" };
  }
  const summarizedTitle = titleCandidateFromSummary(summary);
  const titleState = opts.unchangedTitleState === undefined
    ? null
    : normalizeSessionTitleState(summary.titleState);
  if (opts.unchangedTitleState !== undefined && !titleState) {
    return { result: "summary-failed" };
  }
  if (
    (!summarizedTitle && !titleState)
    || (
      summarizedTitle === unchangedTitle
      && (!titleState || sessionTitleStatesEqual(titleState, opts.unchangedTitleState))
    )
  ) {
    return { result: "unchanged" };
  }
  return {
    result: "candidate",
    title: summarizedTitle,
    ...(titleState ? { titleState } : {}),
  };
}

export async function commitSummarizedTitle(
  deps: SummaryTitleCommitDeps,
  summarizedTitle: string | null,
  titleState?: SessionTitleState,
): Promise<"updated" | "update-failed"> {
  deps.onTitlePending?.(summarizedTitle, titleState);
  deps.rememberTitle(deps.session.machine, deps.session.id, summarizedTitle, titleState);
  const result = await deps.updateTitle(deps.session.machine, deps.session.id, summarizedTitle, titleState);
  if (!result.ok) {
    deps.onError(result.error ?? "title update failed");
    deps.refresh();
    return "update-failed";
  }
  deps.onTitleCommitted?.(summarizedTitle, titleState);
  return "updated";
}

interface PreparedSummaryTitleFlow {
  readonly request: TitleSummaryRequest;
  readonly unchangedTitle: string | null;
  readonly unchangedTitleState?: SessionTitleState;
  readonly expectedCurrentTitle?: string | null;
  readonly currentTitle?: () => Promise<string | null | undefined>;
  readonly staleOnMissingCurrentTitle?: boolean;
}

export interface SummaryTitleFlowOptions<TPrepareResult extends SummaryTitlePrepareExit = never> {
  readonly isDisabled?: () => boolean;
  readonly prepare: () => PreparedSummaryTitleFlow | TPrepareResult | Promise<PreparedSummaryTitleFlow | TPrepareResult>;
  readonly requireSource?: TitleSummaryResult["source"];
}

function isSummaryTitlePrepareExit(value: PreparedSummaryTitleFlow | SummaryTitlePrepareExit): value is SummaryTitlePrepareExit {
  return typeof value === "string";
}

export async function runSummaryTitleFlow<TPrepareResult extends SummaryTitlePrepareExit = never>(
  deps: SummaryTitleFlowDeps,
  opts: SummaryTitleFlowOptions<TPrepareResult>,
): Promise<SummaryTitleFlowBaseResult | TPrepareResult> {
  if (opts.isDisabled?.()) {
    return "disabled";
  }

  const prepared = await opts.prepare();
  if (isSummaryTitlePrepareExit(prepared)) {
    return prepared;
  }

  const summary = await deps.summarizeTitle(prepared.request).catch(() => null);
  const candidate = resolveSummaryCandidate(summary, prepared.unchangedTitle, {
    requireSource: opts.requireSource,
    unchangedTitleState: prepared.unchangedTitleState,
  });
  if (candidate.result !== "candidate") {
    return candidate.result;
  }
  if (opts.isDisabled?.()) {
    return "disabled";
  }

  if (prepared.currentTitle) {
    const latestTitle = await prepared.currentTitle().catch(() => undefined);
    if (latestTitle === undefined) {
      if (prepared.staleOnMissingCurrentTitle) {
        return "stale-title";
      }
    } else if (latestTitle !== (prepared.expectedCurrentTitle ?? null)) {
      return "stale-title";
    }
  }

  return commitSummarizedTitle(deps, candidate.title, candidate.titleState);
}

export async function applyCreatePromptAutoTitleSummary(
  deps: CreatePromptAutoTitleSummaryDeps,
): Promise<CreatePromptAutoTitleSummaryResult> {
  const expectedCurrentTitle = deps.expectedCurrentTitle === undefined
    ? deps.fallbackTitle
    : deps.expectedCurrentTitle;
  return runSummaryTitleFlow<never>(deps, {
    isDisabled: deps.isDisabled,
    prepare: () => ({
      request: {
        baseTitle: deps.baseTitle,
        ...(deps.titleState ? { titleState: deps.titleState } : {}),
        prompt: deps.prompt,
      },
      unchangedTitle: expectedCurrentTitle,
      ...(deps.titleState ? { unchangedTitleState: deps.titleState } : {}),
      expectedCurrentTitle,
      ...(deps.currentTitle ? { currentTitle: deps.currentTitle, staleOnMissingCurrentTitle: true } : {}),
    }),
  });
}

export interface TurnPromptAutoTitleSummaryDeps {
  readonly session: Pick<Session, "machine" | "id">;
  readonly prompt: string;
  readonly baseTitle: string | null;
  readonly titleState?: SessionTitleState | null;
  readonly expectedCurrentTitle: string | null;
  readonly isDisabled: () => boolean;
  readonly glance: (machine: string, id: string, tail: number) => Promise<Glance | null>;
  readonly summarizeTitle: (body: TitleSummaryRequest) => Promise<TitleSummaryResult>;
  readonly updateTitle: (
    machine: string,
    id: string,
    title: string | null,
    titleState?: SessionTitleState,
  ) => Promise<ApiResult>;
  readonly currentTitle: () => Promise<string | null | undefined>;
  readonly rememberTitle: (
    machine: string,
    id: string,
    title: string | null,
    titleState?: SessionTitleState,
  ) => void;
  readonly onTitlePending?: (title: string | null, titleState?: SessionTitleState) => void;
  readonly onTitleCommitted?: (title: string | null, titleState?: SessionTitleState) => void;
  readonly onError: (message: string) => void;
  readonly refresh: () => void;
}

export type TurnCompletionAutoTitleSummaryDeps = Omit<TurnPromptAutoTitleSummaryDeps, "prompt">;

export const TURN_COMPLETION_FALLBACK_PROMPT = "Completed agent task";

export type PreparedTurnCompletionAutoTitleSummary =
  | { readonly result: "candidate"; readonly title: string | null; readonly titleState?: SessionTitleState }
  | { readonly result: "disabled" | "glance-failed" | "stale-title" | "summary-failed" | "unchanged" };

type PrepareTurnCompletionAutoTitleSummaryDeps = Pick<
  TurnCompletionAutoTitleSummaryDeps,
  | "session"
  | "baseTitle"
  | "titleState"
  | "expectedCurrentTitle"
  | "isDisabled"
  | "glance"
  | "summarizeTitle"
>;

export async function prepareTurnCompletionAutoTitleSummary(
  deps: PrepareTurnCompletionAutoTitleSummaryDeps,
): Promise<PreparedTurnCompletionAutoTitleSummary> {
  if (deps.isDisabled()) {
    return { result: "disabled" };
  }
  const glance = await deps.glance(deps.session.machine, deps.session.id, TURN_TITLE_GLANCE_TAIL).catch(() => null);
  if (!glance) {
    return { result: "glance-failed" };
  }
  if (glance.title !== undefined && glance.title !== deps.expectedCurrentTitle) {
    return { result: "stale-title" };
  }
  if (deps.isDisabled()) {
    return { result: "disabled" };
  }
  const titleContext = promptTitleSuffix(glance.tail);
  if (!titleContext) {
    return { result: "glance-failed" };
  }
  const titleForSummary = glance.title ?? deps.expectedCurrentTitle;
  const summary = await deps.summarizeTitle({
    baseTitle: deps.baseTitle,
    ...(deps.titleState ? { titleState: deps.titleState } : {}),
    prompt: TURN_COMPLETION_FALLBACK_PROMPT,
    currentTitle: titleForSummary,
    recentOutput: titleContext,
    agent: glance.agent,
    repoName: glance.repo_name,
  }).catch(() => null);
  return resolveSummaryCandidate(summary, titleForSummary, {
    unchangedTitleState: deps.titleState ?? undefined,
  });
}

export async function applyTurnCompletionAutoTitleSummary(
  deps: TurnCompletionAutoTitleSummaryDeps,
): Promise<TurnPromptAutoTitleSummaryResult> {
  const prepared = await prepareTurnCompletionAutoTitleSummary(deps);
  if (prepared.result !== "candidate") {
    return prepared.result;
  }
  if (deps.isDisabled()) {
    return "disabled";
  }
  const latestTitle = await deps.currentTitle().catch(() => undefined);
  if (latestTitle !== deps.expectedCurrentTitle) {
    return "stale-title";
  }
  return commitSummarizedTitle(deps, prepared.title, prepared.titleState);
}

export type TurnPromptAutoTitleSummaryResult =
  | "disabled"
  | "glance-failed"
  | "summary-failed"
  | "stale-title"
  | "unchanged"
  | "updated"
  | "update-failed";

export async function applyTurnPromptAutoTitleSummary(
  deps: TurnPromptAutoTitleSummaryDeps,
): Promise<TurnPromptAutoTitleSummaryResult> {
  return runSummaryTitleFlow(deps, {
    isDisabled: deps.isDisabled,
    prepare: async () => {
      const glance = await deps.glance(deps.session.machine, deps.session.id, TURN_TITLE_GLANCE_TAIL).catch(() => null);
      if (!glance) {
        return "glance-failed";
      }
      if (glance.title !== undefined && glance.title !== deps.expectedCurrentTitle) {
        return "stale-title";
      }
      if (deps.isDisabled()) {
        return "disabled";
      }
      const titleForSummary = glance.title ?? deps.expectedCurrentTitle;
      return {
        request: {
          baseTitle: deps.baseTitle,
          ...(deps.titleState ? { titleState: deps.titleState } : {}),
          prompt: deps.prompt,
          currentTitle: titleForSummary,
          recentOutput: glance.tail,
          agent: glance.agent,
          repoName: glance.repo_name,
        },
        unchangedTitle: titleForSummary,
        ...(deps.titleState ? { unchangedTitleState: deps.titleState } : {}),
        expectedCurrentTitle: deps.expectedCurrentTitle,
        currentTitle: deps.currentTitle,
      };
    },
  });
}

export interface ManualRetitleSummaryDeps {
  readonly session: Pick<Session, "machine" | "id">;
  readonly baseTitle: string | null;
  readonly titleState?: SessionTitleState | null;
  readonly expectedCurrentTitle: string | null;
  readonly glance: (machine: string, id: string, tail: number) => Promise<Glance | null>;
  readonly summarizeTitle: (body: TitleSummaryRequest) => Promise<TitleSummaryResult>;
  readonly updateTitle: (
    machine: string,
    id: string,
    title: string | null,
    titleState?: SessionTitleState,
  ) => Promise<ApiResult>;
  readonly currentTitle: () => Promise<string | null | undefined>;
  readonly rememberTitle: (
    machine: string,
    id: string,
    title: string | null,
    titleState?: SessionTitleState,
  ) => void;
  readonly onTitlePending?: (title: string | null, titleState?: SessionTitleState) => void;
  readonly onTitleCommitted?: (title: string | null, titleState?: SessionTitleState) => void;
  readonly onError: (message: string) => void;
  readonly refresh: () => void;
}

export async function applyManualRetitleSummary(
  deps: ManualRetitleSummaryDeps,
): Promise<TurnPromptAutoTitleSummaryResult> {
  return runSummaryTitleFlow(deps, {
    requireSource: "summarizer",
    prepare: async () => {
      const glance = await deps.glance(deps.session.machine, deps.session.id, MANUAL_RETITLE_GLANCE_TAIL).catch(() => null);
      if (!glance) {
        return "glance-failed";
      }
      const titleForSummary = glance.title ?? deps.expectedCurrentTitle;
      return {
        request: {
          baseTitle: deps.baseTitle,
          ...(deps.titleState ? { titleState: deps.titleState } : {}),
          prompt: MANUAL_RETITLE_PROMPT,
          currentTitle: titleForSummary,
          recentOutput: glance.tail,
          agent: glance.agent,
          repoName: glance.repo_name,
        },
        unchangedTitle: titleForSummary,
        ...(deps.titleState ? { unchangedTitleState: deps.titleState } : {}),
        expectedCurrentTitle: titleForSummary,
        currentTitle: deps.currentTitle,
      };
    },
  });
}

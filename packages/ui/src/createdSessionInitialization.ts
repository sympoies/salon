import type { AutoResumeMutationResult, SendSessionInputBody, SendSessionInputResult } from "./api.ts";
import type { StartupStatus } from "@agent-console/shared/api";
import { CreateLifecycleDeadlineError } from "./createLifecycle.ts";
import type { CreateBody, Session } from "./types.ts";
import { isDshAgent } from "./dshAgent.ts";

type CreatedSessionTarget = Pick<Session, "machine" | "id">;

export type DefaultAutoResumeInitialization =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly setSessionAutoResume: (
        machine: string,
        id: string,
        enabled: boolean,
      ) => Promise<AutoResumeMutationResult>;
    };

export type AutoResumeInitializationResult =
  | {
      readonly status: "skipped";
      readonly reason: "disabled" | "no-session" | "startup-failed" | "startup-unknown";
    }
  | { readonly status: "enabled"; readonly session: CreatedSessionTarget }
  | { readonly status: "unknown"; readonly session: CreatedSessionTarget; readonly error: string }
  | { readonly status: "failed"; readonly session: CreatedSessionTarget; readonly error: string };

export type CreatedPromptSubmitResult =
  | {
      readonly status: "skipped";
      readonly reason:
        | "blank-prompt"
        | "no-session"
        | "auto-resume-outcome-unknown"
        | "startup-failed"
        | "startup-unknown";
    }
  | { readonly status: "submitted"; readonly session: CreatedSessionTarget }
  | { readonly status: "unknown"; readonly session: CreatedSessionTarget; readonly error: string }
  | { readonly status: "failed"; readonly session: CreatedSessionTarget; readonly error: string };

export interface CreatedSessionInitializationResult {
  readonly autoResume: AutoResumeInitializationResult;
  readonly prompt: CreatedPromptSubmitResult;
}

// Keep every non-LF C0 control rejected: CR and Tab remain terminal actions.
export function hasUnsafeInitialPromptControl(prompt: string): boolean {
  return /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(prompt);
}

export function recoverableCreatedPrompt(
  prompt: string | null,
  result: CreatedSessionInitializationResult,
): string | null {
  if (!prompt?.trim() || result.prompt.status === "submitted") {
    return null;
  }
  return prompt;
}

export function submittedCreatedPrompt(
  prompt: string | null,
  result: CreatedSessionInitializationResult,
): string | null {
  return prompt?.trim() && result.prompt.status === "submitted" ? prompt : null;
}

export interface InitializeCreatedSessionInput {
  readonly machine: string;
  readonly createdId?: string;
  readonly createdSessionIncarnation?: string;
  /** Undefined means an old daemon omitted startup; null means supplied metadata was invalid. */
  readonly createdStartup?: StartupStatus | null;
  /** @deprecated Provider submission no longer varies by UI agent label. */
  readonly agent?: CreateBody["agent"];
  readonly prompt: string | null;
  /** The create request carried the prompt and the daemon delivered it during launch. */
  readonly promptDeliveredAtCreate?: boolean;
  readonly defaultAutoResume: DefaultAutoResumeInitialization;
  /** @deprecated Optional compatibility seam; terminal writes cannot acknowledge provider submission. */
  readonly sendSessionInput?: (machine: string, id: string, body: SendSessionInputBody) => Promise<SendSessionInputResult>;
  /** Versioned provider-control mutation; old daemons reject this route. */
  readonly submitSessionPrompt?: (
    machine: string,
    id: string,
    body: {
      readonly text: string;
      readonly expected_session_incarnation?: string;
    },
  ) => Promise<SendSessionInputResult>;
}

export function defaultAutoResumeForCreate(
  enabled: boolean,
  createBody: Pick<CreateBody, "agent" | "provider_resume_id">,
  setSessionAutoResume: Extract<DefaultAutoResumeInitialization, { enabled: true }>["setSessionAutoResume"],
): DefaultAutoResumeInitialization {
  if (!enabled || isDshAgent(createBody.agent) || createBody.provider_resume_id !== undefined) {
    return { enabled: false };
  }
  return { enabled: true, setSessionAutoResume };
}

async function applyDefaultAutoResume(
  target: CreatedSessionTarget | null,
  preference: DefaultAutoResumeInitialization,
): Promise<AutoResumeInitializationResult> {
  if (!preference.enabled) {
    return { status: "skipped", reason: "disabled" };
  }
  if (!target) {
    return { status: "skipped", reason: "no-session" };
  }
  const result = await preference
    .setSessionAutoResume(target.machine, target.id, true)
    .catch((err: unknown) => ({ ok: false, error: (err as Error).message, outcomeUnknown: true }));
  if (!result.ok) {
    if (result.outcomeUnknown) {
      return {
        status: "unknown",
        session: target,
        error: "Default auto-resume outcome is unknown; the initial prompt was not submitted. Check the session and submit it manually.",
      };
    }
    return {
      status: "failed",
      session: target,
      error: `Default auto-resume could not be enabled: ${result.error ?? "request failed"}`,
    };
  }
  return { status: "enabled", session: target };
}

async function submitCreatedPrompt(
  target: CreatedSessionTarget | null,
  prompt: string | null,
  expectedSessionIncarnation: string | undefined,
  submitSessionPrompt: InitializeCreatedSessionInput["submitSessionPrompt"],
): Promise<CreatedPromptSubmitResult> {
  if (!prompt?.trim()) {
    return { status: "skipped", reason: "blank-prompt" };
  }
  if (!target) {
    return { status: "skipped", reason: "no-session" };
  }
  if (hasUnsafeInitialPromptControl(prompt)) {
    return {
      status: "failed",
      session: target,
      error: "Initial prompts containing unsafe terminal controls were not submitted; copy and submit this retained prompt manually.",
    };
  }
  if (!expectedSessionIncarnation?.trim()) {
    return {
      status: "failed",
      session: target,
      error: "Initial prompt submission requires an authoritative runtime incarnation; copy and submit this retained prompt manually.",
    };
  }
  let result: SendSessionInputResult;
  try {
    result = submitSessionPrompt
      ? await submitSessionPrompt(target.machine, target.id, {
          text: prompt,
          expected_session_incarnation: expectedSessionIncarnation,
        })
      : {
          ok: false,
          error: "Structured prompt submission is unavailable; copy and submit this retained prompt manually.",
        };
  } catch (err) {
    const message = err instanceof CreateLifecycleDeadlineError
      ? "Initial prompt submission outcome is unknown; check the created session before submitting the retained prompt manually."
      : `Initial prompt submission outcome is unknown: ${(err as Error).message}`;
    return { status: "unknown", session: target, error: message };
  }
  if (!result.ok) {
    if (result.outcomeUnknown) {
      return {
        status: "unknown",
        session: target,
        error: "Initial prompt submission outcome is unknown; check the created session before submitting the retained prompt manually.",
      };
    }
    return { status: "failed", session: target, error: result.error ?? "initial prompt submit failed" };
  }
  return { status: "submitted", session: target };
}

export async function initializeCreatedSession({
  machine,
  createdId,
  createdSessionIncarnation,
  createdStartup,
  prompt,
  promptDeliveredAtCreate = false,
  defaultAutoResume,
  submitSessionPrompt,
}: InitializeCreatedSessionInput): Promise<CreatedSessionInitializationResult> {
  if (createdStartup === null || createdStartup?.state === "failed") {
    const reason = createdStartup === null ? "startup-unknown" as const : "startup-failed" as const;
    return {
      autoResume: { status: "skipped", reason },
      prompt: { status: "skipped", reason },
    };
  }
  const target = createdId ? { machine, id: createdId } : null;
  const autoResume = await applyDefaultAutoResume(target, defaultAutoResume);
  const promptResult: CreatedPromptSubmitResult = autoResume.status === "unknown"
    ? { status: "skipped", reason: "auto-resume-outcome-unknown" }
    : promptDeliveredAtCreate && target && prompt?.trim()
      ? { status: "submitted", session: target }
      : await submitCreatedPrompt(
        target,
        prompt,
        createdSessionIncarnation,
        submitSessionPrompt,
      );
  return { autoResume, prompt: promptResult };
}

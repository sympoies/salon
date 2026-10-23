import { createSessionTimeoutMs } from "@agent-console/shared/api";

export const CREATE_LIFECYCLE_REQUEST_TIMEOUT_MS = 15_000;
// A slow create outlasts the edge's daemon budget by the edge profile probe
// (up to 3 s) plus transport margin, so a late success never reads as unknown.
export const CREATE_REQUEST_TIMEOUT_MARGIN_MS = 10_000;
export const MAX_INITIAL_PROMPT_BYTES = 16 * 1024;
export const MAX_CREATE_PROMPT_RECOVERIES = 4;
export const MAX_CREATE_PROMPT_RECOVERY_BYTES = 64 * 1024;

export interface PromptRecoveryCapacityEntry {
  readonly prompt: string;
}

export interface BoundedInitialPromptUpdate {
  readonly prompt: string;
  readonly error: string | null;
}

export class CreateLifecycleDeadlineError extends Error {
  readonly stage: string;

  constructor(stage: string) {
    super(`${stage} timed out; its outcome is unknown`);
    this.name = "CreateLifecycleDeadlineError";
    this.stage = stage;
  }
}

export function requestWithCreateLifecycleDeadline<T>(
  stage: string,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = CREATE_LIFECYCLE_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new CreateLifecycleDeadlineError(stage));
      controller.abort();
    }, timeoutMs);
  });
  const request = Promise.resolve().then(() => operation(controller.signal));
  return Promise.race([request, deadline]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

export function initialPromptByteLength(prompt: string): number {
  return new TextEncoder().encode(prompt).byteLength;
}

export function validateInitialPrompt(prompt: string): string | null {
  if (
    prompt.length <= MAX_INITIAL_PROMPT_BYTES
    && initialPromptByteLength(prompt) <= MAX_INITIAL_PROMPT_BYTES
  ) {
    return null;
  }
  return `Initial prompt is too large (maximum ${MAX_INITIAL_PROMPT_BYTES} UTF-8 bytes).`;
}

export function boundedInitialPromptUpdate(
  currentPrompt: string,
  nextPrompt: string,
): BoundedInitialPromptUpdate {
  const error = validateInitialPrompt(nextPrompt);
  return error ? { prompt: currentPrompt, error } : { prompt: nextPrompt, error: null };
}

export function promptRecoveryCapacityError(
  current: readonly PromptRecoveryCapacityEntry[],
  nextPrompt: string,
): string | null {
  if (current.length >= MAX_CREATE_PROMPT_RECOVERIES) {
    return `Dismiss a retained prompt before creating another session (maximum ${MAX_CREATE_PROMPT_RECOVERIES} retained prompts).`;
  }
  const retainedBytes = current.reduce((total, entry) => total + initialPromptByteLength(entry.prompt), 0);
  if (
    retainedBytes >= MAX_CREATE_PROMPT_RECOVERY_BYTES
    || retainedBytes + initialPromptByteLength(nextPrompt) > MAX_CREATE_PROMPT_RECOVERY_BYTES
  ) {
    return "Dismiss a retained prompt before creating another session; retained prompt storage is at its safe limit.";
  }
  return null;
}

export interface UnknownCreateRecoveryState {
  readonly machine: string;
  readonly creationOutcomeUnknown?: boolean;
  // The last session-list request sequence issued before the incident was
  // retained. Only a later request can prove anything about its outcome.
  readonly listRequestFloor?: number;
  // A later list read answered for the target machine.
  readonly reconciled?: boolean;
  // The user checked that list and chose to allow a separate create.
  readonly acknowledged?: boolean;
}

export interface SessionListMachineOutcome {
  readonly name: string;
  readonly ok: boolean;
}

// Without a create operation identity, a refreshed list cannot prove which
// session (if any) the failed request created, and a machine that answered may
// still not list it yet. After one post-incident refresh the user may
// acknowledge the incident; it stays visible until dismissed.
export function unknownCreateBlocksNewSession(entries: readonly UnknownCreateRecoveryState[]): boolean {
  return entries.some((entry) => entry.creationOutcomeUnknown === true && entry.acknowledged !== true);
}

export function reconcileUnknownCreateRecoveries<T extends UnknownCreateRecoveryState>(
  entries: readonly T[],
  requestSequence: number,
  machines: readonly SessionListMachineOutcome[],
): readonly T[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (
      entry.creationOutcomeUnknown !== true
      || entry.reconciled === true
      || entry.listRequestFloor === undefined
      || requestSequence <= entry.listRequestFloor
      || !machines.some((machine) => machine.name === entry.machine && machine.ok)
    ) {
      return entry;
    }
    changed = true;
    return { ...entry, reconciled: true };
  });
  return changed ? next : entries;
}

export function acknowledgeUnknownCreateRecovery<T extends UnknownCreateRecoveryState & { readonly key: number }>(
  entries: readonly T[],
  key: number,
): readonly T[] {
  const index = entries.findIndex((entry) => entry.key === key && entry.reconciled === true && entry.acknowledged !== true);
  if (index < 0) return entries;
  return entries.map((entry, i) => (i === index ? { ...entry, acknowledged: true } : entry));
}

/** Browser deadline for a create request, longer than the edge's daemon budget for slow create paths. */
export function createRequestTimeoutMs(
  createBody: { readonly agent?: string; readonly codex_account?: string; readonly claude_account?: string; readonly prompt?: string },
): number | undefined {
  const edgeBudget = createSessionTimeoutMs(createBody);
  return edgeBudget === undefined ? undefined : edgeBudget + CREATE_REQUEST_TIMEOUT_MARGIN_MS;
}

import { spawn } from "node:child_process";
import type {
  TitleSummaryDiagnosticReason,
  TitleSummaryRequest,
  TitleSummaryResult,
} from "@agent-console/shared/api";
import {
  canonicalTitleBase,
  emptySessionTitleState,
  normalizeSessionTitleState,
  promptTitleSuffix,
  renderSessionTitleState,
  safeTitleLine,
  stripComposedTitleBase,
  titleActionSegments,
  truncateTitle,
  userSessionTitleState,
  MAX_TITLE_CHARS,
  type SessionTitleState,
} from "@agent-console/shared/title";
import type { TitleSummarizerConfig } from "./config.ts";

const MAX_COMMAND_OUTPUT_BYTES = 4096;
const MAX_CONCURRENT_SUMMARIZER_COMMANDS = 2;
const MAX_QUEUED_SUMMARIZER_COMMANDS = 8;
const MAX_RECENT_OUTPUT_CHARS = 4000;
const MAX_WORK_ITEM_REFERENCES = 2;
const ANSI_OSC_PATTERN = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
const ANSI_CSI_PATTERN = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;
const ANSI_SINGLE_ESCAPE_PATTERN = /\u001B(?![\[\]])[@-_]/g;
const RESIDUAL_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const WORK_ITEM_REFERENCE_PATTERN = /(?:\b(?:issue|pr|pull[\s-]+request)(?:\s*:\s*#?|\s*#|\s+)|#)([1-9]\d{0,9})\b/gi;
const EXPLICIT_WORK_ITEM_REFERENCE_PATTERN = /\b(?:issue|pr|pull[\s-]+request)(?:\s*:\s*#?|\s*#|\s+)([1-9]\d{0,9})\b/gi;
const NUMERIC_HASH_PATTERN = /#([1-9]\d{0,9})\b/g;
const NUMERIC_CREDENTIAL_CONTEXT_PATTERNS = [
  /\b(?:otp|pin|passcode|cvv|cvc|card[\s-]+verification(?:[\s-]+code)?|verification[\s-]+code|one[\s-]+time(?:[\s-]+(?:code|password))?|recovery[\s-]+code)\b(?:\s+(?:is|equals))?\s*(?:[:=]\s*)?#?\d{3,10}\b/i,
  /(?:\buse\s+#?\d{3,10}\b\s+as\s+(?:(?:your|the)\s+)?|#?\d{3,10}\b\s+(?:is|equals)\s+(?:your|the)\s+)(?:otp|pin|passcode|cvv|cvc|card[\s-]+verification(?:[\s-]+code)?|verification[\s-]+code|one[\s-]+time(?:[\s-]+(?:code|password))?|recovery[\s-]+code)\b/i,
] as const;
const NUMERIC_CREDENTIAL_LABEL_PATTERN = /\b(?:otp|pin|passcode|cvv|cvc|card[\s-]+verification(?:[\s-]+code)?|verification[\s-]+code|one[\s-]+time(?:[\s-]+(?:code|password))?|recovery[\s-]+code)\b/i;
const NUMERIC_CREDENTIAL_NUMBER_PATTERN = /(?:^|[^\d])#?\d{3,10}(?!\d)/;
const WEB_URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>]+/gi;
// Each boundary is a negative lookbehind, never a consumed character, so the
// same patterns can both detect a private path and strip exactly the path out of
// a line without eating the word, quote, or glyph in front of it.
const PRIVATE_PATH_PATTERNS = [
  /\bfile:\/\/[^\s"'`<>]+/i,
  /(?<![A-Za-z0-9_./\\-])~[\\/][^\s"'`<>]+/i,
  /(?<![A-Za-z0-9_./\\-])-{1,2}[A-Za-z][A-Za-z0-9_-]*=?(?:\/+|[A-Za-z]:[\\/])[^\s"'`<>]+/,
  /(?<![A-Za-z0-9_./\\])\/+(?:[^/\s"'`<>]+(?:\/+[^\s"'`<>]*)?)/,
  /(?<![A-Za-z0-9_./\\-])[A-Za-z]:[\\/][^\s"'`<>]+/,
  /(?<![A-Za-z0-9_./\\-])\\\\[^\\\s"'`<>]+\\[^\\\s"'`<>]+/,
  /(?<![^\\/])(?:\.ssh|\.local)(?:[\\/]|$)/i,
  /\.internal(?:[\\/]|$)/i,
] as const;
const PRIVATE_PATH_STRIP_PATTERNS = PRIVATE_PATH_PATTERNS.map(
  (pattern) => new RegExp(pattern.source, `${pattern.flags}g`),
);
// Characters that belong to the path or host a match sits inside. `.ssh` and
// `.internal` match a marker segment, so a removed match must take its whole
// surrounding run with it or an internal host label survives. Whitespace,
// quotes, and non-Latin task words are outside the class and are preserved.
const PRIVATE_PATH_RUN_CHAR = /[A-Za-z0-9._~+=@:%\\/-]/;

function hasPrivatePath(value: string, allowLeadingSlashCommand = false): boolean {
  const slashCommand = allowLeadingSlashCommand
    ? value.match(/^\s*\/[A-Za-z][\w-]*(?=\s|$)/)?.[0]
    : undefined;
  const inspected = slashCommand ? value.slice(slashCommand.length) : value;
  const withoutWebUrls = inspected.replace(WEB_URL_PATTERN, "");
  return PRIVATE_PATH_PATTERNS.some((pattern) => pattern.test(withoutWebUrls));
}

function withoutPrivatePaths(value: string): string {
  return PRIVATE_PATH_STRIP_PATTERNS
    .reduce((text, pattern) => withoutMatchedRuns(text, pattern), value)
    .replace(/\s+/g, " ")
    .trim();
}

function withoutMatchedRuns(value: string, pattern: RegExp): string {
  let kept = "";
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    let start = match.index;
    let end = start + match[0].length;
    // A pattern tail stops only at whitespace, so it can swallow task words in a
    // script that needs no spaces. Give back everything past the last path
    // character before taking the run this match sits in.
    while (end > start + 1 && !PRIVATE_PATH_RUN_CHAR.test(value[end - 1] ?? "")) {
      end -= 1;
    }
    while (start > cursor && PRIVATE_PATH_RUN_CHAR.test(value[start - 1] ?? "")) {
      start -= 1;
    }
    while (end < value.length && PRIVATE_PATH_RUN_CHAR.test(value[end] ?? "")) {
      end += 1;
    }
    if (start < cursor) {
      continue;
    }
    kept += `${value.slice(cursor, start)} `;
    cursor = end;
  }
  return kept + value.slice(cursor);
}
let activeSummarizerCommands = 0;
interface SummarizerQueueWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
const summarizerQueue: SummarizerQueueWaiter[] = [];
const SUMMARIZER_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "AGENT_CONSOLE_TITLE_SUMMARIZER_BASE_URL",
  "AGENT_CONSOLE_TITLE_SUMMARIZER_MODEL",
  "AGENT_CONSOLE_TITLE_SUMMARIZER_API_KEY",
  "AGENT_CONSOLE_TITLE_SUMMARIZER_SLOT_ID",
  "AGENT_CONSOLE_TITLE_SUMMARIZER_REQUEST_TIMEOUT_MS",
  "AGENT_CONSOLE_TITLE_SUMMARIZER_MAX_TOKENS",
  "AGENT_CONSOLE_TITLE_SUMMARIZER_TEMPERATURE",
] as const;

export type { TitleSummaryRequest, TitleSummaryResult } from "@agent-console/shared/api";

export type TitleSummarizerCommandRunner = (
  config: TitleSummarizerConfig,
  input: string,
) => Promise<string>;

export interface TitleSummaryEvaluation {
  readonly result: TitleSummaryResult;
  readonly reason: TitleSummaryDiagnosticReason;
}

class TitleSummarizerCommandError extends Error {
  readonly reason: Extract<
    TitleSummaryDiagnosticReason,
    "fallback_busy" | "fallback_timeout" | "fallback_command_error"
  >;

  constructor(
    reason: Extract<
      TitleSummaryDiagnosticReason,
      "fallback_busy" | "fallback_timeout" | "fallback_command_error"
    >,
    message: string,
  ) {
    super(message);
    this.name = "TitleSummarizerCommandError";
    this.reason = reason;
  }
}

export function fallbackTitleSummary(request: TitleSummaryRequest): TitleSummaryResult {
  const currentState = requestTitleState(request);
  const prompt = safePromptSuffix(request.prompt);
  const references = workItemReferences(
    { value: prompt, allowBareReference: true },
    { value: safeRecentOutput(request.recentOutput), allowBareReference: false, newestFirst: true },
    { value: safeContextLine(request.currentTitle), allowBareReference: true },
  );
  const titleState: SessionTitleState = {
    ...currentState,
    references: references.length > 0 ? references : currentState.references,
    activity: prompt,
  };
  return {
    title: renderSessionTitleState(titleState),
    titleState,
    source: "fallback",
  };
}

function requestTitleState(request: TitleSummaryRequest): SessionTitleState {
  return normalizeSessionTitleState(request.titleState)
    ?? userSessionTitleState(safeContextLine(request.baseTitle, true))
    ?? emptySessionTitleState();
}

function promptTitleState(request: TitleSummaryRequest): SessionTitleState {
  const state = requestTitleState(request);
  return {
    ...state,
    topic: safeContextLine(state.topic) ?? null,
    activity: safeContextLine(state.activity) ?? null,
  };
}

function normalizeTitleText(value: string): string | null {
  const hadTerminalControl = RESIDUAL_CONTROL_PATTERN.test(value);
  const normalized = value
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(ANSI_SINGLE_ESCAPE_PATTERN, "");
  if (RESIDUAL_CONTROL_PATTERN.test(normalized)) {
    return null;
  }
  if (
    hadTerminalControl &&
    NUMERIC_CREDENTIAL_LABEL_PATTERN.test(normalized) &&
    NUMERIC_CREDENTIAL_NUMBER_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function isNumericCredentialContext(value: string): boolean {
  return NUMERIC_CREDENTIAL_CONTEXT_PATTERNS.some((pattern) => pattern.test(value));
}

function safePromptSuffix(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeTitleText(value);
  if (normalized === null) {
    return null;
  }
  const suffix = promptTitleSuffix(normalized);
  if (!suffix || isNumericCredentialContext(suffix)) {
    return null;
  }
  if (!hasPrivatePath(suffix)) {
    return suffix;
  }
  // A pasted attachment path or a mentioned file must not cost the whole task
  // line: the words around a path describe the work, so drop only the path and
  // re-check what remains, exactly as an opaque run is already dropped from an
  // otherwise titleable line. A line that was nothing but a path stays vetoed.
  const salvaged = promptTitleSuffix(withoutPrivatePaths(suffix));
  return salvaged && !isNumericCredentialContext(salvaged) && !hasPrivatePath(salvaged)
    ? salvaged
    : null;
}

function safeRecentOutput(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const safeLines = value
    .split(/\r?\n/)
    .map((line) => normalizeTitleText(line))
    .filter((line): line is string => line !== null)
    .map((line) => safeTitleLine(line))
    .filter((line): line is string => line !== null)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .filter((line) => !isNumericCredentialContext(line) && !hasPrivatePath(line));
  if (safeLines.length === 0) {
    return undefined;
  }
  const safe = safeLines.join("\n");
  const chars = Array.from(safe);
  if (chars.length <= MAX_RECENT_OUTPUT_CHARS) {
    return safe;
  }
  return chars.slice(chars.length - MAX_RECENT_OUTPUT_CHARS).join("");
}

function safeContextLine(
  value: string | null | undefined,
  allowSlashCommand = false,
): string | undefined {
  const normalized = typeof value === "string" ? normalizeTitleText(value) : value;
  const line = safeTitleLine(normalized);
  return line && !isNumericCredentialContext(line) && !hasPrivatePath(line, allowSlashCommand)
    ? truncateTitle(line)
    : undefined;
}

/**
 * Repeatedly strip a topic that the activity restates, so `Topic - Topic - doing
 * X` collapses to `doing X` and an activity that is only the topic becomes null.
 */
function withoutComposedBase(base: string | null | undefined, activity: string | null): string | null {
  let value = activity;
  for (let attempts = 0; value && attempts < MAX_TITLE_CHARS; attempts += 1) {
    const next = stripComposedTitleBase(base, value);
    if (next === value) {
      break;
    }
    value = next;
  }
  return value;
}

/**
 * Repair auto-owned state when a model promoted the rendered activity suffix
 * into the topic. Leaving that state intact renders the same activity twice and
 * makes later Retitle requests keep treating the stale compound title as the
 * durable topic.
 */
function withoutTrailingActivity(topic: string | null, activity: string | null): string | null {
  let value = topic;
  for (let attempts = 0; value && activity && attempts < MAX_TITLE_CHARS; attempts += 1) {
    const separator = [" - ", " — ", " – "].find((candidate) =>
      value?.endsWith(`${candidate}${activity}`)
    );
    if (!separator) {
      break;
    }
    const next = value.slice(0, -(separator.length + activity.length)).trim();
    if (!next) {
      break;
    }
    value = next;
  }
  return value;
}

function workItemReferences(
  ...contexts: Array<{
    value: string | null | undefined;
    allowBareReference: boolean;
    newestFirst?: boolean;
  }>
): readonly string[] {
  const references: string[] = [];
  const seen = new Set<string>();
  for (const { value, allowBareReference, newestFirst = false } of contexts) {
    if (!value || references.length >= MAX_WORK_ITEM_REFERENCES) {
      continue;
    }
    const pattern = allowBareReference
      ? WORK_ITEM_REFERENCE_PATTERN
      : EXPLICIT_WORK_ITEM_REFERENCE_PATTERN;
    pattern.lastIndex = 0;
    const matches = [...value.matchAll(pattern)];
    if (newestFirst) {
      matches.reverse();
    }
    for (const match of matches) {
      const number = match[1];
      if (!number) {
        continue;
      }
      const reference = `#${number}`;
      if (!seen.has(reference)) {
        seen.add(reference);
        references.push(reference);
        if (references.length >= MAX_WORK_ITEM_REFERENCES) {
          break;
        }
      }
    }
  }
  return references;
}

function childInput(request: TitleSummaryRequest): Record<string, unknown> {
  return {
    prompt: safePromptSuffix(request.prompt) ?? "",
    base_title: safeContextLine(request.baseTitle, true) ?? null,
    title_state: promptTitleState(request),
    current_title: safeContextLine(request.currentTitle, true),
    recent_output: safeRecentOutput(request.recentOutput),
    agent: safeContextLine(request.agent, true),
    repo_name: safeContextLine(request.repoName, true),
    max_chars: MAX_TITLE_CHARS,
    instruction: "Return strict JSON: {\"topic_action\":\"keep|set|clear\",\"topic\":string|null,\"activity\":string|null}. Keep a user-owned topic. Set or revise an automatic topic only when the session has a clear durable subject; keep no topic while discussion is exploratory. Activity is the concise current action. For an exploratory turn with no stable topic or useful status, return activity null so the title remains unset. Never invent issue or pull-request references, repeat the current topic, include secrets, Markdown, or commentary.",
  };
}

interface ParsedTitleDecision {
  readonly topicAction: "keep" | "set" | "clear";
  readonly topic: string | null;
  readonly activity: string | null;
  readonly legacy: boolean;
}

function parseSummarizerOutput(output: string): ParsedTitleDecision | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }
  let parsedJson = false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    parsedJson = true;
    if (parsed && typeof parsed === "object") {
      const decision = parsed as { topic_action?: unknown; topic?: unknown; activity?: unknown; title?: unknown };
      if (
        (decision.topic_action === "keep" || decision.topic_action === "set" || decision.topic_action === "clear")
        && (typeof decision.topic === "string" || decision.topic === null)
        && (typeof decision.activity === "string" || decision.activity === null)
      ) {
        return {
          topicAction: decision.topic_action,
          topic: typeof decision.topic === "string" ? normalizeTitleText(decision.topic)?.trim() || null : null,
          activity: typeof decision.activity === "string"
            ? normalizeTitleText(decision.activity)?.trim() || null
            : null,
          legacy: false,
        };
      }
      const title = decision.title;
      if (typeof title === "string") {
        return {
          topicAction: "keep",
          topic: null,
          activity: normalizeTitleText(title)?.trim() || null,
          legacy: true,
        };
      }
    }
  } catch {
    if (/^[{[]/.test(trimmed)) {
      return null;
    }
  }
  if (parsedJson) return null;
  const activity = normalizeTitleText(trimmed)?.trim() || null;
  return activity ? { topicAction: "keep", topic: null, activity, legacy: true } : null;
}

export function titleSummarizerChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of SUMMARIZER_ENV_ALLOWLIST) {
    const value = source[name];
    if (typeof value === "string") {
      env[name] = value;
    }
  }
  return env;
}

async function runSummarizerCommand(
  config: TitleSummarizerConfig,
  input: string,
): Promise<string> {
  await acquireSummarizerSlot(config.timeoutMs);
  try {
    return await new Promise((resolve, reject) => {
      const [command, ...args] = config.command;
      if (!command) {
        reject(new TitleSummarizerCommandError("fallback_command_error", "empty summarizer command"));
        return;
      }
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: titleSummarizerChildEnv() });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let terminationError: Error | null = null;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (err: Error | null, value?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (err) {
          reject(err);
        } else {
          resolve(value ?? "");
        }
      };
      const terminate = (error: Error) => {
        if (terminationError || settled) return;
        terminationError = error;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 250);
      };
      const timer = setTimeout(() => {
        terminate(new TitleSummarizerCommandError("fallback_timeout", "title summarizer timed out"));
      }, config.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
          terminate(new TitleSummarizerCommandError(
            "fallback_command_error",
            "title summarizer output exceeded limit",
          ));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (Buffer.byteLength(stderr, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
          terminate(new TitleSummarizerCommandError(
            "fallback_command_error",
            "title summarizer stderr exceeded limit",
          ));
        }
      });
      child.on("error", (err) => finish(
        new TitleSummarizerCommandError("fallback_command_error", err.message),
      ));
      child.on("close", (code) => {
        if (terminationError) {
          finish(terminationError);
        } else if (code === 0) {
          finish(null, stdout);
        } else {
          finish(new TitleSummarizerCommandError("fallback_command_error", `title summarizer exited ${code}`));
        }
      });
      child.stdin.end(input);
    });
  } finally {
    releaseSummarizerSlot();
  }
}

async function acquireSummarizerSlot(timeoutMs: number): Promise<void> {
  if (activeSummarizerCommands < MAX_CONCURRENT_SUMMARIZER_COMMANDS) {
    activeSummarizerCommands += 1;
    return;
  }
  if (summarizerQueue.length >= MAX_QUEUED_SUMMARIZER_COMMANDS) {
    throw new TitleSummarizerCommandError("fallback_busy", "title summarizer queue full");
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: SummarizerQueueWaiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = summarizerQueue.indexOf(waiter);
        if (index >= 0) summarizerQueue.splice(index, 1);
        reject(new TitleSummarizerCommandError("fallback_busy", "title summarizer queue timed out"));
      }, timeoutMs),
    };
    summarizerQueue.push(waiter);
  });
}

function releaseSummarizerSlot(): void {
  const waiter = summarizerQueue.shift();
  if (waiter) {
    clearTimeout(waiter.timer);
    waiter.resolve();
    return;
  }
  activeSummarizerCommands = Math.max(0, activeSummarizerCommands - 1);
}

export async function summarizeTitle(
  config: TitleSummarizerConfig | null | undefined,
  request: TitleSummaryRequest,
  runCommand: TitleSummarizerCommandRunner = runSummarizerCommand,
): Promise<TitleSummaryResult> {
  return (await summarizeTitleWithDiagnostics(config, request, runCommand)).result;
}

export async function summarizeTitleWithDiagnostics(
  config: TitleSummarizerConfig | null | undefined,
  request: TitleSummaryRequest,
  runCommand: TitleSummarizerCommandRunner = runSummarizerCommand,
): Promise<TitleSummaryEvaluation> {
  const fallback = fallbackTitleSummary(request);
  const fallbackResult = (reason: Exclude<TitleSummaryDiagnosticReason, "accepted">): TitleSummaryEvaluation => ({
    result: fallback,
    reason,
  });
  const safePrompt = safePromptSuffix(request.prompt);
  if (!config) {
    return fallbackResult("fallback_not_configured");
  }
  if (!safePrompt) {
    return fallbackResult("fallback_unsafe_prompt");
  }
  let output: string;
  try {
    output = await runCommand(config, JSON.stringify(childInput({ ...request, prompt: safePrompt })));
  } catch (error) {
    return fallbackResult(
      error instanceof TitleSummarizerCommandError ? error.reason : "fallback_command_error",
    );
  }
  try {
    const decision = parseSummarizerOutput(output);
    if (!decision) {
      return fallbackResult("fallback_invalid_output");
    }
    const currentState = requestTitleState(request);
    const safeBase = safeContextLine(request.baseTitle, true) ?? safeContextLine(currentState.topic);
    let activity = decision.activity ? promptTitleSuffix(decision.activity) : null;
    if (decision.activity && !activity) {
      return fallbackResult("fallback_unsafe_activity");
    }
    activity = withoutComposedBase(safeBase, activity);
    if (activity) {
      const unsafeSegment = titleActionSegments(activity).some(
        (segment) => /^(?:-|—|–)(?:\s|$)/.test(segment) || !safeTitleLine(segment),
      );
      if (unsafeSegment) {
        return fallbackResult("fallback_unsafe_activity");
      }
    }
    activity = activity ? safeContextLine(activity) ?? null : null;
    if (activity && isNumericCredentialContext(activity)) {
      return fallbackResult("fallback_unsafe_activity");
    }

    let topic = currentState.topic_source === "auto"
      ? withoutTrailingActivity(currentState.topic, currentState.activity)
      : currentState.topic;
    let topicSource = currentState.topic_source;
    if (currentState.topic_source !== "user") {
      if (decision.topicAction === "clear") {
        topic = null;
        topicSource = "none";
      } else if (decision.topicAction === "set") {
        const proposedTopic = canonicalTitleBase(safeContextLine(decision.topic));
        if (!proposedTopic || isNumericCredentialContext(proposedTopic)) {
          return fallbackResult("fallback_invalid_topic");
        }
        topic = currentState.topic_source === "auto" && proposedTopic === currentState.topic
          ? withoutTrailingActivity(proposedTopic, currentState.activity)
          : proposedTopic;
        topicSource = "auto";
      }
    }
    if (topicSource === "auto") {
      topic = withoutTrailingActivity(topic, activity);
    }
    // A model that ignores "never repeat the topic" would otherwise render
    // `Topic - Topic`. The base strip above only knew the previous topic, so the
    // topic this decision just set has to be stripped from the activity too.
    activity = withoutComposedBase(topic, activity);
    const safeRecentContext = safeRecentOutput(request.recentOutput);
    const references = workItemReferences(
      { value: safePrompt, allowBareReference: true },
      { value: safeRecentContext, allowBareReference: false, newestFirst: true },
      { value: safeContextLine(request.currentTitle, true), allowBareReference: true },
    );
    NUMERIC_HASH_PATTERN.lastIndex = 0;
    const approvedReferences = new Set([...references, ...currentState.references]);
    const hasUnapprovedActivityReference = activity
      ? [...activity.matchAll(NUMERIC_HASH_PATTERN)]
        .some((match) => !approvedReferences.has(`#${match[1]}`))
      : false;
    NUMERIC_HASH_PATTERN.lastIndex = 0;
    const hasUnapprovedChangedTopicReference = topic && topic !== currentState.topic
      ? [...topic.matchAll(NUMERIC_HASH_PATTERN)]
        .some((match) => !approvedReferences.has(`#${match[1]}`))
      : false;
    if (hasUnapprovedActivityReference || hasUnapprovedChangedTopicReference) {
      return fallbackResult("fallback_unapproved_reference");
    }
    const selectedReferences = references.length > 0 ? references : currentState.references;
    if (activity) {
      activity = selectedReferences
        .reduce((value, reference) => value.replaceAll(reference, ""), activity)
        .trim()
        .replace(/\s+/g, " ") || null;
    }
    const titleState: SessionTitleState = {
      topic,
      topic_source: topicSource,
      references: selectedReferences,
      activity,
    };
    const title = renderSessionTitleState(titleState);
    return {
      result: { title, titleState, source: "summarizer" },
      reason: "accepted",
    };
  } catch {
    return fallbackResult("fallback_unknown");
  }
}

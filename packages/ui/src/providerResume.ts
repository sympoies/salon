import type { AgentKind } from "./frames.ts";

export type ProviderResumeAgent = Extract<AgentKind, "codex" | "claude">;

export function isProviderResumeAgent(agent: AgentKind): agent is ProviderResumeAgent {
  return agent === "codex" || agent === "claude";
}

export interface ParsedProviderResume {
  /** Extracted provider session id, or "" when a pasted command carried no usable id. */
  readonly id: string;
  /** Provider detected from a pasted `codex …` / `claude …` command, when present. */
  readonly provider?: ProviderResumeAgent;
}

const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const RESUME_MARKERS = new Set(["resume", "--resume", "-r"]);

function stripSurroundingQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    if ((first === '"' || first === "'") && token[token.length - 1] === first) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/**
 * Accepts either a bare provider session id or a full "copy session command"
 * (the inverse of `resumeCommand` in `format.ts`) and extracts the provider
 * session id. Examples it normalizes:
 *   `codex resume <uuid> --cd /path --no-alt-screen` -> { id: <uuid>, provider: "codex" }
 *   `claude --resume <uuid>`                         -> { id: <uuid>, provider: "claude" }
 *
 * A bare id (no `codex`/`claude` prefix) is returned verbatim so manually
 * entered non-UUID ids keep working. A pasted command that carries no usable id
 * (e.g. `claude --resume` with nothing after it) returns an empty id rather than
 * echoing the command text back as a bogus session id.
 */
export function parseProviderResumeInput(raw: string): ParsedProviderResume {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { id: "" };
  }

  const tokens = trimmed.split(/\s+/);
  const head = tokens[0]?.toLowerCase();
  const provider: ProviderResumeAgent | undefined =
    head === "codex" || head === "claude" ? head : undefined;

  // Provider-aware: take the token immediately after the resume marker
  // (`resume` for codex, `--resume`/`-r` for claude). This wins over a bare
  // UUID scan so a UUID-looking segment in a later `--cd` path can't shadow the
  // real session id.
  if (provider) {
    const markerIndex = tokens.findIndex((token) => RESUME_MARKERS.has(token));
    if (markerIndex !== -1) {
      const candidate = tokens[markerIndex + 1];
      if (candidate && !candidate.startsWith("-")) {
        const unquoted = stripSurroundingQuotes(candidate);
        const embedded = unquoted.match(UUID);
        return { id: embedded ? embedded[0] : unquoted, provider };
      }
    }
  }

  // Fallback: first UUID anywhere in the string.
  const anyUuid = trimmed.match(UUID);
  if (anyUuid) {
    return provider ? { id: anyUuid[0], provider } : { id: anyUuid[0] };
  }

  // A pasted command (provider prefix) with no extractable id yields no id, so
  // it can't be submitted as a bogus resume target. A bare input with no
  // provider prefix passes through verbatim (lenient non-UUID id).
  if (provider) {
    return { id: "", provider };
  }
  return { id: trimmed };
}

export interface ResumePastePlan {
  /** Whether the paste should be intercepted (preventDefault + normalize the field). */
  readonly intercept: boolean;
  /** Normalized session id to set when intercepting. */
  readonly id: string;
  /** Provider to switch the Agent select to, when a command detected one. */
  readonly provider?: ProviderResumeAgent;
  /** Hint to surface after a successful normalization. */
  readonly hint: string | null;
}

export interface ResumeFieldInputPlan {
  /** Whether a full resume command was normalized to its provider session id. */
  readonly normalized: boolean;
  /** Value to store in the controlled resume-id field. */
  readonly value: string;
  /** Provider to switch the Agent select to after normalization. */
  readonly provider?: ProviderResumeAgent;
  /** Hint to surface after normalization. */
  readonly hint: string | null;
}

/**
 * Normalize the resume field from its value alone. Android WebView may deliver
 * a long-press paste as only an input/change event, without a ClipboardEvent,
 * so this path must provide the same command detection as `planResumePaste`.
 */
function planResumeCommandInput(value: string, allowNonUuid: boolean): ResumeFieldInputPlan {
  const parsed = parseProviderResumeInput(value);
  const completeUuid = parsed.id.match(UUID)?.[0] === parsed.id;
  if (!parsed.id || !parsed.provider || (!allowNonUuid && !completeUuid) || parsed.id === value.trim()) {
    return { normalized: false, value, hint: null };
  }
  return {
    normalized: true,
    value: parsed.id,
    provider: parsed.provider,
    hint: `Detected ${parsed.provider ? `${parsed.provider} ` : ""}session ID`,
  };
}

export function planResumeFieldInput(value: string, inputType?: string): ResumeFieldInputPlan {
  return planResumeCommandInput(value, inputType?.startsWith("insertFromPaste") ?? false);
}

/**
 * Decide what to do when text is pasted into the resume-id field. Intercept only
 * when a pasted command was normalized down to a real id; a bare id, unrelated
 * text, or an id-less command fall through to the browser's default paste.
 */
export function planResumePaste(pasted: string): ResumePastePlan {
  const inputPlan = planResumeCommandInput(pasted, true);
  if (!inputPlan.normalized) {
    return { intercept: false, id: parseProviderResumeInput(pasted).id, hint: null };
  }
  return {
    intercept: true,
    id: inputPlan.value,
    provider: inputPlan.provider,
    hint: inputPlan.hint,
  };
}

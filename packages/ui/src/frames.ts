// Control frames sent to the edge attach WebSocket, which forwards them to
// `agent-session serve`'s handle_input: { text?, key?, keys?, resize{cols,rows} }.
// Kept pure + dependency-free so it is unit-testable under `node --test`.

export type SpecialKey =
  | "enter"
  | "escape"
  | "backspace"
  | "c-c"
  | "up"
  | "down"
  | "left"
  | "right"
  | "tab";

export type AgentKind = "codex" | "claude";
export const AGENT_KINDS: readonly AgentKind[] = ["codex", "claude"];

export const PROVIDER_PROMPT_CAPABILITY = "provider-prompt.v1";
const PROVIDER_PROMPT_CAPABILITY_SCHEMA = "agent-session.attach.v1";
const PROVIDER_PROMPT_EVENT_SCHEMA = "agent-session.attach.event.v1";
const MAX_PROVIDER_PROMPT_TEXT_BYTES = 16_384;

export type ProviderPromptProvider = "codex" | "claude";

export interface ProviderPromptCapabilityFrame {
  readonly kind: "capability";
  readonly supported: boolean;
  readonly provider: ProviderPromptProvider | null;
  readonly promptMaxBytes: number;
}

export interface ProviderPromptSubmittedFrame {
  readonly kind: "prompt_submitted";
  readonly eventId: string;
  readonly provider: ProviderPromptProvider;
  readonly submittedAt: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface TerminalInputRejectedFrame {
  readonly kind: "input_rejected";
  readonly code: string;
  readonly retryable: boolean;
}

export type ProviderPromptServerFrame =
  | ProviderPromptCapabilityFrame
  | ProviderPromptSubmittedFrame
  | TerminalInputRejectedFrame
  | { readonly kind: "unknown_control" };

export function textFrame(text: string): string {
  return JSON.stringify({ text });
}

export function keyFrame(key: SpecialKey): string {
  return JSON.stringify({ key });
}

export function resizeFrame(cols: number, rows: number): string {
  return JSON.stringify({ resize: { cols: Math.max(1, Math.floor(cols)), rows: Math.max(1, Math.floor(rows)) } });
}

export function providerPromptSubscriptionFrame(): string {
  return JSON.stringify({ subscribe: [PROVIDER_PROMPT_CAPABILITY] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function provider(value: unknown): ProviderPromptProvider | null {
  return value === "codex" || value === "claude" ? value : null;
}

function nonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function nonEmptyBoundedUtf8String(value: unknown, maxBytes: number): value is string {
  return nonEmptyBoundedString(value, maxBytes)
    && new TextEncoder().encode(value).byteLength <= maxBytes;
}

export function parseProviderPromptServerFrame(text: string): ProviderPromptServerFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.schema_version === PROVIDER_PROMPT_CAPABILITY_SCHEMA
    && value.type === "capability"
    && value.capability === PROVIDER_PROMPT_CAPABILITY
    && typeof value.supported === "boolean"
    && Number.isSafeInteger(value.prompt_max_bytes)
    && Number(value.prompt_max_bytes) > 0
  ) {
    const parsedProvider = provider(value.provider);
    if ((value.supported && parsedProvider) || (!value.supported && value.provider === null)) {
      return {
        kind: "capability",
        supported: value.supported,
        provider: parsedProvider,
        promptMaxBytes: Number(value.prompt_max_bytes),
      };
    }
  }

  if (
    value.schema_version === PROVIDER_PROMPT_EVENT_SCHEMA
    && value.type === "prompt_submitted"
    && nonEmptyBoundedString(value.event_id, 256)
    && provider(value.provider)
    && nonEmptyBoundedString(value.submitted_at, 128)
    && nonEmptyBoundedUtf8String(value.text, MAX_PROVIDER_PROMPT_TEXT_BYTES)
    && typeof value.truncated === "boolean"
  ) {
    return {
      kind: "prompt_submitted",
      eventId: value.event_id,
      provider: provider(value.provider)!,
      submittedAt: value.submitted_at,
      text: value.text,
      truncated: value.truncated,
    };
  }

  if (
    value.schema_version === PROVIDER_PROMPT_EVENT_SCHEMA
    && value.type === "input_rejected"
    && nonEmptyBoundedString(value.code, 128)
    && /^[a-z0-9][a-z0-9-]*$/.test(value.code)
    && typeof value.retryable === "boolean"
  ) {
    return {
      kind: "input_rejected",
      code: value.code,
      retryable: value.retryable,
    };
  }

  if (
    typeof value.schema_version === "string"
    && value.schema_version.startsWith("agent-session.attach.")
  ) {
    return { kind: "unknown_control" };
  }
  return null;
}

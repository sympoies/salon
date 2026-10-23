import type { CodexRuntimeFallbackReason } from "@agent-console/shared/api";

const REASONS: Record<CodexRuntimeFallbackReason, string> = {
  "codex-unavailable": "the Codex CLI could not be checked",
  "codex-version-unrecognized": "the installed Codex version could not be identified",
  "codex-version-too-old": "the installed Codex version is too old",
  "codex-app-server-transport-unavailable": "Codex does not support the required app-server transport",
  "codex-app-server-runtime-dir-unavailable": "the private runtime directory is unavailable",
  "codex-app-server-runtime-dir-unsafe": "the private runtime directory is unsafe",
  "codex-app-server-socket-path-too-long": "the runtime socket path is too long",
  "codex-app-server-runtime-unavailable": "the app-server runtime is unavailable",
};

export function codexRuntimeFallbackReason(reason: CodexRuntimeFallbackReason): string {
  return REASONS[reason];
}

export function codexRuntimeFallbackMessage(reason: CodexRuntimeFallbackReason): string {
  return `Terminal-only mode: structured prompt, resume, and history controls are unavailable because ${codexRuntimeFallbackReason(reason)}.`;
}

import type { SpecialKey } from "./frames.ts";

// The on-screen key bar is the only way to reach these keys on a phone, where
// the software keyboard has no Esc, Ctrl or arrows. Its contents depend on which
// product runs in the pane, so the model lives here rather than inside the
// component: the agent-to-entry rule then has one owner and one test surface.
export type TerminalKeyBarEntry =
  | { readonly kind: "key"; readonly id: string; readonly label: string; readonly key: SpecialKey }
  | { readonly kind: "text"; readonly id: string; readonly label: string; readonly text: string }
  | { readonly kind: "sequence"; readonly id: string; readonly label: string; readonly ariaLabel: string; readonly sequence: string };

export interface TerminalKeyBarLayout {
  /** Always visible, pinned above the screen edge. */
  readonly primary: readonly TerminalKeyBarEntry[];
  /** Revealed by the bar's overflow toggle; empty means no toggle is rendered. */
  readonly overflow: readonly TerminalKeyBarEntry[];
}

// Arrows read left, right, up, down: the horizontal pair is what a prompt line
// needs most, so it sits nearest the thumb. No ^C — it earned its place when the
// bar was the only way to interrupt, but it is not what this bar gets used for,
// and the width is worth more to the keys that are. Ctrl+C from a physical
// keyboard still reaches the session through terminalInput's classifier.
const PRIMARY: readonly TerminalKeyBarEntry[] = Object.freeze([
  { kind: "key", id: "escape", label: "Esc", key: "escape" },
  { kind: "key", id: "tab", label: "Tab", key: "tab" },
  { kind: "key", id: "left", label: "←", key: "left" },
  { kind: "key", id: "right", label: "→", key: "right" },
  { kind: "key", id: "up", label: "↑", key: "up" },
  { kind: "key", id: "down", label: "↓", key: "down" },
  { kind: "key", id: "enter", label: "Enter", key: "enter" },
] as const);

// Slash commands Codex and Claude Code both accept. The text is inserted without
// a trailing Enter: Enter sits one tap away in the primary row, the user gets to
// see what landed on the prompt line, and nothing races the provider's own "/"
// completion menu for the submit.
const SLASH_COMMANDS: readonly TerminalKeyBarEntry[] = Object.freeze([
  { kind: "text", id: "model", label: "/model", text: "/model" },
  { kind: "text", id: "compact", label: "/compact", text: "/compact" },
  { kind: "text", id: "usage", label: "/usage", text: "/usage" },
] as const);

// Codex shows Shift+Left when a queued follow-up question can be answered.
// The daemon's existing literal-input path pastes bytes without bracketed-paste
// markers, so this CSI sequence reaches Codex as the same key as a keyboard tap.
const CODEX_COMMANDS: readonly TerminalKeyBarEntry[] = Object.freeze([
  { kind: "sequence", id: "answer-question", label: "Answer Q", ariaLabel: "Answer queued question (Shift+Left)", sequence: "\x1b[1;2D" },
  ...SLASH_COMMANDS,
]);

const NO_COMMANDS: readonly TerminalKeyBarEntry[] = Object.freeze([] as const);

// Allowlisted, not denylisted. DSH is neither Codex nor Claude Code and has no
// such commands, and a future agent kind must not inherit commands it has never
// been shown to accept; either way the row would only put dead text on the
// prompt line.
const SLASH_COMMAND_AGENTS: ReadonlySet<string> = new Set(["codex", "claude"]);

export function terminalKeyBarLayout(agent: string | null | undefined): TerminalKeyBarLayout {
  return {
    primary: PRIMARY,
    overflow: agent === "codex" ? CODEX_COMMANDS
      : agent !== null && agent !== undefined && SLASH_COMMAND_AGENTS.has(agent) ? SLASH_COMMANDS
      : NO_COMMANDS,
  };
}

import type { SpecialKey } from "./frames.ts";

// These commands replace/select a provider conversation without informing the
// managed session lifecycle. This is a local-input guard, not a PTY parser or
// an authorization boundary. Never infer a draft from rendered terminal output.
const CONTEXT_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  codex: ["/new", "/clear", "/resume", "/fork"],
  claude: ["/clear", "/new", "/reset", "/resume", "/branch", "/teleport", "/tp"],
};
// Provider fact, not provider behavior: Claude Code's slash menu also matches
// command descriptions (`/st` lists /clear), so any of its menu choices may be
// a context command. Codex lists only commands whose names match (#1033).
const MENU_MATCHES_DESCRIPTIONS = new Set(["claude"]);
const MAX_DRAFT_CHARS = 2048;

interface Draft {
  chars: string[];
  cursor: number;
  uncertain: boolean;
  slash: boolean;
  leadingClassified: boolean;
  overflowed: boolean;
  unverifiable: boolean;
  /** A line break was inserted, or Up/Down may have recalled one (#991). */
  multiline: boolean;
  /** Tab completed the slash command; `chars` holds only the typed prefix (#1034). */
  completed: boolean;
  /** Tab or Up/Down chose an item in the slash menu; the typed text is unchanged. */
  selection: boolean;
}
const emptyDraft = (): Draft => ({chars: [], cursor: 0, uncertain: false, slash: false,
  leadingClassified: false, overflowed: false, unverifiable: false, multiline: false, completed: false, selection: false});

export function isBracketedTerminalPaste(text: string): boolean {
  return text.startsWith("\x1b[200~") && text.endsWith("\x1b[201~");
}

/**
 * One text frame that clears the provider draft with edit-only keys (#983).
 * `cleared` is false when the draft cannot be proven empty; Enter stays
 * refused and `message` explains why.
 */
export interface DraftClear { readonly text: string; readonly cleared: boolean; readonly message: string | null }

export interface TerminalContextCommandGuard {
  acceptText(text: string): string | null;
  acceptKey(key: SpecialKey): string | null;
  clearDraft(): DraftClear | null;
  noteNavigation(): void;
  markInputUncertain(): string | null;
  uncertaintyMessage(): string | null;
}

export function createTerminalContextCommandGuard(agent: string | undefined): TerminalContextCommandGuard {
  const commands = agent && Object.hasOwn(CONTEXT_COMMANDS, agent) ? CONTEXT_COMMANDS[agent]! : [];
  let draft = emptyDraft();
  let inputUncertain = false;
  const uncertaintyMessage = () => inputUncertain && commands.length > 0
    ? "The provider draft is uncertain after rejected or unconfirmed input. Enter is blocked. "
      + "Use Console's New session action or the managed role restart flow. "
      + "Clear draft does not confirm that the provider's draft is empty."
    : null;
  const noteNavigation = (next: Draft) => {
    next.slash ||= next.chars.join("").trimStart().startsWith("/");
    next.unverifiable ||= next.overflowed;
    next.uncertain = true;
  };
  // A menu that matches names only lists commands containing the typed prefix
  // in order, so a prefix no context command contains cannot reach one (#1034).
  const reachable = (token: string) => MENU_MATCHES_DESCRIPTIONS.has(agent!) || commands.some(command => {
    let matched = 0;
    for (const char of command) if (char === token[matched]) matched++;
    return matched === token.length;
  });
  const refusal = (next: Draft): string | null => {
    if (commands.length === 0) return null;
    const uncertainty = uncertaintyMessage();
    if (uncertainty) return uncertainty;
    const value = next.chars.join("").trimStart();
    const token = value.split(/\s/, 1)[0] ?? "";
    // A provider's slash menu may complete a prefix on Enter. Unknown edits in
    // such a menu cannot make a previously risky draft safe.
    const command = commands.find(c => c === token || (value === token && token.startsWith("/") && c.startsWith(token)));
    const selected = next.selection && value === token && token.startsWith("/") && reachable(token.toLowerCase());
    if (!command && !selected && !(next.uncertain && (next.slash || next.unverifiable))) return null;
    if (selected && !next.uncertain) {
      return "The selected slash menu item may replace the managed session's provider thread. Enter was not sent. "
        + "Type the command in full (for example /status) instead of choosing it from the menu, or use Clear draft.";
    }
    const subject = next.uncertain ? "This edited slash command" : command;
    return `${subject} may replace the managed session's provider thread. Enter was not sent. `
      + "Use Console's New session action or the managed role restart flow. "
      + "Clear this draft before continuing; type safe commands in full.";
  };
  // While a typed slash token opens the provider's slash menu, Up/Down move
  // only its highlight and Tab completes the highlighted item; the typed text
  // stays as tracked (#1045, #1034). Enter then refuses only while the chosen
  // item may be a context command. Edits after a completion act on text this
  // guard did not see. Same rule for every provider (#1033).
  const chooseInMenu = (next: Draft, completes: boolean) => {
    const value = next.chars.join("");
    if (next.uncertain || next.overflowed || next.multiline || next.completed
      || next.cursor !== next.chars.length || !value.startsWith("/") || /\s/.test(value)) return false;
    next.selection = true;
    next.completed = completes;
    return true;
  };
  const inexact = (next: Draft) => next.overflowed || next.completed;
  // A tracked edit that changes the typed token moves the menu highlight back
  // to the first match, so an earlier menu choice no longer applies; an edit
  // that deletes nothing keeps it (Claude Code 2.1.296 probes). A Tab
  // completion stays inexact.
  const edited = (next: Draft) => { if (!next.completed) next.selection = false; };
  const backspace = (next: Draft) => {
    if (inexact(next)) noteNavigation(next);
    if (next.cursor > 0) {
      edited(next);
      next.chars.splice(--next.cursor, 1);
    }
    if (!next.overflowed) next.leadingClassified = next.chars.some(char => /\S/.test(char));
  };
  const insert = (next: Draft, char: string) => {
    next.multiline ||= char === "\n" || char === "\r";
    if (next.chars.length >= MAX_DRAFT_CHARS) {
      if (!next.overflowed) noteNavigation(next);
      next.overflowed = true;
      // Storage stays bounded, but whitespace cannot hide the first token.
      if (!next.leadingClassified && /\S/.test(char)) {
        next.leadingClassified = true;
        next.slash ||= char === "/";
      }
      return;
    }
    next.chars.splice(next.cursor++, 0, char);
    edited(next);
    next.leadingClassified ||= /\S/.test(char);
    next.slash ||= next.chars.join("").trimStart().startsWith("/");
  };

  return {
    acceptText(text) {
      if (commands.length === 0) return null;
      const next = {...draft, chars: [...draft.chars]};
      const bracketed = isBracketedTerminalPaste(text);
      const content = bracketed ? text.slice(6, -6) : text;
      if (bracketed) {
        // Check the whole paste: storage stops at its bound, a line break may
        // come later (#991).
        next.multiline ||= /[\r\n]/.test(content);
        for (const char of content) {
          insert(next, char);
          if (next.overflowed && next.leadingClassified) break;
        }
      } else {
        for (let index = 0; index < content.length; index++) {
          const char = content[index]!;
          if (char === "\r" || char === "\n") {
            const message = refusal(next);
            if (message) return message; // The entire unsent frame stays unsent.
            Object.assign(next, emptyDraft());
          } else if (char === "\x7f" || char === "\b") backspace(next);
          else if (char === "\x03") Object.assign(next, emptyDraft());
          else if (char === "\x15") {
            if (inexact(next)) noteNavigation(next);
            if (next.cursor > 0) edited(next);
            next.chars.splice(0, next.cursor);
            next.cursor = 0;
            if (!next.overflowed) next.leadingClassified = next.chars.some(char => /\S/.test(char));
          }
          else if (char === "\x01" || char === "\x05") {
            if (inexact(next)) noteNavigation(next);
            next.cursor = char === "\x01" ? 0 : next.chars.length;
          }
          else if (char === "\x1b") {
            const sequence = content.slice(index).match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)/);
            if (sequence) {
              // xterm emits plain horizontal arrows as CSI or SS3 bytes.
              // Track them like the touch key bar's left/right SpecialKeys;
              // history/menu navigation and modified arrows remain uncertain.
              if (/^\x1b(?:\[|O)[CD]$/.test(sequence[0])) {
                if (inexact(next)) noteNavigation(next);
                next.cursor = sequence[0].endsWith("D")
                  ? Math.max(0, next.cursor - 1) : Math.min(next.chars.length, next.cursor + 1);
              } else if (/^\x1b(?:\[|O)[AB]$/.test(sequence[0]) && chooseInMenu(next, false)) {
                // Plain Up/Down over a typed slash token: menu highlight only.
              } else if (!/^\x1b\[\d{1,6};\d{1,6}R$/.test(sequence[0])) {
                noteNavigation(next);
                // Up/Down may recall a multi-line history entry.
                next.multiline ||= /^\x1b(?:\[[\d;]*|O)[AB]$/.test(sequence[0]);
              }
              index += sequence[0].length - 1;
            }
            // Bare Escape dismisses menus; it does not prove the draft cleared.
          } else if (char >= " ") insert(next, char);
          else if (char !== "\t" || !chooseInMenu(next, true)) noteNavigation(next);
        }
      }
      draft = next;
      return null;
    },
    acceptKey(key) {
      if (commands.length === 0) return null;
      if (key === "enter") {
        const message = refusal(draft);
        if (message) return message;
        draft = emptyDraft();
      } else if (key === "c-c") draft = emptyDraft();
      else if (key === "backspace") backspace(draft);
      else if (key === "left" || key === "right") {
        if (inexact(draft)) noteNavigation(draft);
        draft.cursor = key === "left" ? Math.max(0, draft.cursor - 1) : Math.min(draft.chars.length, draft.cursor + 1);
      }
      else if (key !== "escape" && (key !== "tab" || !chooseInMenu(draft, true))
        && ((key !== "up" && key !== "down") || !chooseInMenu(draft, false))) {
        noteNavigation(draft);
        draft.multiline ||= key === "up" || key === "down";
      }
      return null;
    },
    // Ctrl+C quits Codex, and a second one quits Claude, so never use it here
    // (#983). One text frame keeps the keys in order over HTTP (#991). A
    // single-line draft of any length is cleared by Ctrl+E then Ctrl+U (end of
    // line, delete to its start). A tracked multi-line draft is deleted
    // exactly: Right to its end, then one Backspace per character. Any other
    // draft cannot be proven empty, so it stays refused.
    clearDraft() {
      if (commands.length === 0) return null;
      if (!draft.multiline) {
        draft = emptyDraft();
        return {text: "\x05\x15", cleared: true, message: null};
      }
      if (!draft.uncertain && !draft.overflowed) {
        const text = "\x1b[C".repeat(draft.chars.length - draft.cursor) + "\x7f".repeat(draft.chars.length);
        draft = emptyDraft();
        return {text, cleared: true, message: null};
      }
      draft = {...emptyDraft(), uncertain: true, slash: true, unverifiable: true, leadingClassified: true, multiline: true};
      return {text: "\x05\x15", cleared: false, message: "Clear draft could not confirm that this multi-line draft is empty, "
        + "so Enter stays blocked. Use Console's New session action or the managed role restart flow."};
    },
    noteNavigation() { noteNavigation(draft); },
    markInputUncertain() {
      inputUncertain = commands.length > 0;
      return uncertaintyMessage();
    },
    uncertaintyMessage,
  };
}

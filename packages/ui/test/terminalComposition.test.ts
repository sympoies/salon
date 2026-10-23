import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import {
  createTerminalCompositionGuard,
  isImeContinuationKeyCode,
} from "../src/terminalComposition.ts";
import { xtermSource } from "./support/source.ts";

const cleanupStack: Array<() => void> = [];

afterEach(() => {
  while (cleanupStack.length > 0) {
    cleanupStack.pop()?.();
  }
});

function installTextarea(): HTMLTextAreaElement {
  const window = new Window();
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Event: globalThis.Event,
    CompositionEvent: globalThis.CompositionEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Event: window.Event,
    CompositionEvent: window.CompositionEvent,
    KeyboardEvent: window.KeyboardEvent,
  });
  cleanupStack.push(() => {
    Object.assign(globalThis, previous);
    window.close();
  });
  const textarea = window.document.createElement("textarea") as unknown as HTMLTextAreaElement;
  window.document.body.appendChild(textarea as unknown as Node);
  return textarea;
}

function composition(type: "compositionstart" | "compositionend"): CompositionEvent {
  return new CompositionEvent(type, { bubbles: true, data: "" });
}

function keydown(keyCode: number): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, keyCode } as KeyboardEventInit);
}

// A faithful transcription of xterm's CompositionHelper state machine, limited
// to the part that decides whether a keystroke reaches the terminal. Pinning it
// here makes the reported symptom executable: once `isComposing` is stranded
// true, every Android soft-keyboard character (keyCode 229) is swallowed.
function fakeXtermCompositionHelper(textarea: HTMLTextAreaElement) {
  const state = { isComposing: false, delivered: [] as number[] };
  textarea.addEventListener("compositionstart", () => {
    state.isComposing = true;
  });
  textarea.addEventListener("compositionend", () => {
    state.isComposing = false;
  });
  textarea.addEventListener("keydown", (event) => {
    const keyCode = (event as KeyboardEvent).keyCode;
    if (state.isComposing) {
      if (isImeContinuationKeyCode(keyCode)) {
        return;
      }
      state.isComposing = false;
    }
    if (keyCode === 229) {
      return;
    }
    state.delivered.push(keyCode);
  });
  return state;
}

test("isImeContinuationKeyCode matches the key codes xterm keeps swallowing while composing", () => {
  // CapsLock, the IME "composition character", and the three bare modifiers.
  for (const keyCode of [16, 17, 18, 20, 229]) {
    assert.equal(isImeContinuationKeyCode(keyCode), true, `keyCode ${keyCode} should continue composition`);
  }
  // Space/Enter/Backspace are the codes Chrome on Android still reports for
  // real; they are what lets a user accidentally unstick a wedged terminal.
  for (const keyCode of [8, 13, 32, 65]) {
    assert.equal(isImeContinuationKeyCode(keyCode), false, `keyCode ${keyCode} should finalize composition`);
  }
});

test("isImeContinuationKeyCode stays in sync with the installed xterm CompositionHelper", () => {
  const helper = xtermSource("src/browser/input/CompositionHelper.ts");
  assert.match(helper, /ev\.keyCode === 20 \|\| ev\.keyCode === 229/);
  assert.match(helper, /ev\.keyCode === 16 \|\| ev\.keyCode === 17 \|\| ev\.keyCode === 18/);
  // The flag is cleared by compositionend or a finalizing keydown only — never
  // by blur or focus. That is why a stranded composition needs a page reload.
  assert.doesNotMatch(helper, /addEventListener\('blur'/);
  assert.doesNotMatch(helper, /_isComposing = false;[\s\S]{0,80}blur/);
});

test("the guard tracks an in-flight composition", () => {
  const textarea = installTextarea();
  const guard = createTerminalCompositionGuard(textarea);

  assert.equal(guard.isComposing(), false);
  textarea.dispatchEvent(composition("compositionstart"));
  assert.equal(guard.isComposing(), true);
  textarea.dispatchEvent(composition("compositionend"));
  assert.equal(guard.isComposing(), false);
});

test("finalize closes a stranded composition by driving xterm's own compositionend", () => {
  const textarea = installTextarea();
  const xterm = fakeXtermCompositionHelper(textarea);
  const guard = createTerminalCompositionGuard(textarea);

  textarea.dispatchEvent(composition("compositionstart"));
  assert.equal(xterm.isComposing, true);

  assert.equal(guard.finalize(), true);
  assert.equal(guard.isComposing(), false);
  assert.equal(xterm.isComposing, false, "xterm must see a compositionend, not just our tracker");
});

test("finalize is a no-op when nothing is composing so no duplicate commit is emitted", () => {
  const textarea = installTextarea();
  const ends: string[] = [];
  textarea.addEventListener("compositionend", (event) => ends.push(event.type));
  const guard = createTerminalCompositionGuard(textarea);

  assert.equal(guard.finalize(), false);
  assert.deepEqual(ends, []);

  textarea.dispatchEvent(composition("compositionstart"));
  textarea.dispatchEvent(composition("compositionend"));
  assert.equal(guard.finalize(), false);
  assert.equal(ends.length, 1, "a real compositionend must not be followed by a synthetic one");
});

test("a finalizing keydown keeps the tracker aligned with xterm", () => {
  const textarea = installTextarea();
  const guard = createTerminalCompositionGuard(textarea);

  textarea.dispatchEvent(composition("compositionstart"));
  textarea.dispatchEvent(keydown(229));
  assert.equal(guard.isComposing(), true, "the IME composition character continues the composition");

  textarea.dispatchEvent(keydown(32));
  assert.equal(guard.isComposing(), false, "xterm finalizes on Space, so the tracker must too");
  // Already finalized inside xterm: re-firing compositionend here would replay
  // the composed text into the terminal.
  assert.equal(guard.finalize(), false);
});

test("blurring mid-composition without the guard wedges every Android keystroke", () => {
  const textarea = installTextarea();
  const xterm = fakeXtermCompositionHelper(textarea);

  // The reported flow: a composition is live when the pane drops terminal focus
  // (the file chooser hides the keyboard, so TerminalPane blurs xterm). Chrome
  // on Android does not reliably deliver the matching compositionend.
  textarea.dispatchEvent(composition("compositionstart"));
  textarea.blur();

  textarea.dispatchEvent(keydown(229));
  textarea.dispatchEvent(keydown(229));
  assert.deepEqual(xterm.delivered, [], "every soft-keyboard character is swallowed");

  // Space (keyCode 32) is the accidental escape hatch the user found.
  textarea.dispatchEvent(keydown(32));
  assert.deepEqual(xterm.delivered, [32]);
});

test("finalizing before the blur keeps the terminal typeable after an upload", () => {
  const textarea = installTextarea();
  const xterm = fakeXtermCompositionHelper(textarea);
  const guard = createTerminalCompositionGuard(textarea);

  textarea.dispatchEvent(composition("compositionstart"));
  guard.finalize();
  textarea.blur();

  textarea.dispatchEvent(keydown(229));
  assert.equal(xterm.isComposing, false, "no composition is left in flight");
  // 229 alone still carries no character; what matters is that a real key now
  // reaches the terminal instead of being swallowed forever.
  textarea.dispatchEvent(keydown(65));
  assert.deepEqual(xterm.delivered, [65]);
});

test("dispose detaches the guard from the textarea", () => {
  const textarea = installTextarea();
  const guard = createTerminalCompositionGuard(textarea);

  guard.dispose();
  textarea.dispatchEvent(composition("compositionstart"));
  assert.equal(guard.isComposing(), false);
});

test("the guard tolerates a terminal without a helper textarea", () => {
  const guard = createTerminalCompositionGuard(null);

  assert.equal(guard.isComposing(), false);
  assert.equal(guard.finalize(), false);
  guard.dispose();
});

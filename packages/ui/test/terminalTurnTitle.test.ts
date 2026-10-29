import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createProviderPromptTitleSource,
  createTerminalPromptCapture,
} from "../src/terminalTurnTitle.ts";

test("terminal prompt capture emits a prompt only after enter", () => {
  const capture = createTerminalPromptCapture();

  assert.deepEqual(capture.acceptText("fix title"), []);
  assert.deepEqual(capture.acceptText("\r"), ["fix title"]);
});

test("terminal prompt capture handles backspace and filters secret-like prompts", () => {
  const capture = createTerminalPromptCapture();

  assert.deepEqual(capture.acceptText("fix titlx\x7fe\r"), ["fix title"]);
  assert.deepEqual(capture.acceptText("fix titlx"), []);
  assert.deepEqual(capture.acceptKey("backspace"), []);
  assert.deepEqual(capture.acceptText("e"), []);
  assert.deepEqual(capture.acceptKey("enter"), ["fix title"]);
  assert.deepEqual(capture.acceptText("TOKEN=secret-value\r"), []);
  assert.deepEqual(capture.acceptText("psql postgresql://user:pass@host/db\r"), []);
});

test("terminal prompt capture ignores cursor escape sequences instead of appending bytes", () => {
  const capture = createTerminalPromptCapture();

  assert.deepEqual(capture.acceptText("\x1b[A\r"), []);
  assert.deepEqual(capture.acceptText("git status\x1b[D\r"), []);
  assert.deepEqual(capture.acceptKey("up"), []);
  assert.deepEqual(capture.acceptKey("enter"), []);
});

test("terminal prompt capture preserves text across terminal cursor-position reports", () => {
  const capture = createTerminalPromptCapture();

  assert.deepEqual(capture.acceptText("refresh session title"), []);
  assert.deepEqual(capture.acceptText("\x1b[2;"), []);
  assert.deepEqual(capture.acceptText("1R"), []);
  assert.deepEqual(capture.acceptKey("enter"), ["refresh session title"]);
});

test("terminal prompt capture fails closed when special-key enter interrupts an escape", () => {
  for (const suffix of ["\x1b", "\x1b[2;"]) {
    const capture = createTerminalPromptCapture();
    assert.deepEqual(capture.acceptText(`clean title${suffix}`), []);
    assert.deepEqual(capture.acceptKey("enter"), []);
  }
});

test("terminal prompt capture bounds large pasted input before submit", () => {
  const capture = createTerminalPromptCapture();

  assert.deepEqual(capture.acceptText("refresh title ".repeat(10_000)), []);
  const [prompt] = capture.acceptText("\r");
  assert.ok(prompt);
  assert.ok(prompt.length <= 120);
});

test("provider prompt title source holds clean fallback prompts until capability is known", () => {
  type Timer = { callback: () => void; cleared: boolean };
  const timers: Timer[] = [];
  const emitted: Array<{ prompt: string; eventId?: string }> = [];
  const source = createProviderPromptTitleSource<Timer>({
    maxPendingFallbacks: 2,
    providerEventFallbackMs: 50,
    setTimeout: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cleared = true;
    },
    onPrompt: (prompt, eventId) => emitted.push({ prompt, eventId }),
  });

  source.acceptLocal(["first", "second", "third"]);
  assert.deepEqual(emitted, []);
  source.setCapability("pending");
  assert.deepEqual(emitted, []);
  source.setCapability("fallback");
  assert.deepEqual(emitted, [
    { prompt: "second", eventId: undefined },
    { prompt: "third", eventId: undefined },
  ]);

  source.acceptLocal(["direct fallback"]);
  assert.deepEqual(emitted.at(-1), { prompt: "direct fallback", eventId: undefined });

  source.resetConnection();
  source.acceptLocal(["pending with event"]);
  const timersBeforeSupported = timers.length;
  source.setCapability("supported");
  assert.equal(timers.length, timersBeforeSupported + 1, "supported mode arms the bounded per-prompt fallback");
  source.acceptProvider({ eventId: "pp-authoritative", text: "pending with event" });
  assert.equal(timers.at(-1)?.cleared, true, "a matching provider event cancels local fallback");
  assert.deepEqual(emitted.at(-1), { prompt: "pending with event", eventId: "pp-authoritative" });

  source.acceptLocal(["event was dropped"]);
  assert.equal(timers.length, timersBeforeSupported + 2);
  timers.at(-1)!.callback();
  assert.deepEqual(emitted.at(-1), { prompt: "event was dropped", eventId: undefined });

  source.acceptProvider({ eventId: "pp-sensitive", text: "TOKEN=secret-value" });
  assert.equal(emitted.some((item) => item.eventId === "pp-sensitive"), false);
});

test("late provider support deduplicates a clean prompt already emitted by fallback", () => {
  const emitted: Array<{ prompt: string; eventId?: string }> = [];
  const source = createProviderPromptTitleSource({
    onPrompt: (prompt, eventId) => emitted.push({ prompt, eventId }),
  });

  source.setCapability("fallback");
  source.acceptLocal(["same turn"]);
  source.setCapability("supported");
  source.acceptProvider({ eventId: "pp-matching", text: "same turn" });
  source.acceptProvider({ eventId: "pp-matching", text: "same turn" });
  source.acceptProvider({ eventId: "pp-repeated", text: "same turn" });
  source.acceptProvider({ eventId: "pp-provider-only", text: "provider only" });

  assert.deepEqual(emitted, [
    { prompt: "same turn", eventId: undefined },
    { prompt: "same turn", eventId: "pp-repeated" },
    { prompt: "provider only", eventId: "pp-provider-only" },
  ]);
});

test("late provider fallback correlation expires before a later same-text turn", () => {
  type Timer = { callback: () => void; cleared: boolean };
  const timers: Timer[] = [];
  const emitted: Array<{ prompt: string; eventId?: string }> = [];
  const source = createProviderPromptTitleSource<Timer>({
    providerEventFallbackMs: 50,
    setTimeout: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cleared = true;
    },
    onPrompt: (prompt, eventId) => emitted.push({ prompt, eventId }),
  });

  source.setCapability("fallback");
  source.acceptLocal(["repeat"]);
  source.setCapability("supported");
  assert.equal(timers.length, 1, "the emitted fallback correlation has a bounded lifetime");
  timers[0]!.callback();
  source.acceptProvider({ eventId: "pp-later-turn", text: "repeat" });

  assert.deepEqual(emitted, [
    { prompt: "repeat", eventId: undefined },
    { prompt: "repeat", eventId: "pp-later-turn" },
  ]);
});

test("late provider fallback correlation does not cross a connection boundary", () => {
  const emitted: Array<{ prompt: string; eventId?: string }> = [];
  const source = createProviderPromptTitleSource({
    onPrompt: (prompt, eventId) => emitted.push({ prompt, eventId }),
  });

  source.setCapability("fallback");
  source.acceptLocal(["same text on another connection"]);
  source.setCapability("pending");
  source.setCapability("supported");
  source.acceptProvider({ eventId: "pp-new-connection", text: "same text on another connection" });

  assert.deepEqual(emitted, [
    { prompt: "same text on another connection", eventId: undefined },
    { prompt: "same text on another connection", eventId: "pp-new-connection" },
  ]);
});

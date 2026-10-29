import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  terminalKeyBarLayout,
  type TerminalKeyBarEntry,
} from "../src/terminalKeyBar.ts";

function ids(entries: readonly TerminalKeyBarEntry[]): string[] {
  return entries.map((entry) => entry.id);
}

test("the primary row orders the arrows left, right, up, down", () => {
  const { primary } = terminalKeyBarLayout("claude");
  const arrows = ids(primary).filter((id) => ["left", "right", "up", "down"].includes(id));
  assert.deepEqual(arrows, ["left", "right", "up", "down"]);
});

test("the primary row keeps the always-available terminal keys and nothing else", () => {
  const { primary } = terminalKeyBarLayout("claude");
  assert.deepEqual(ids(primary), ["escape", "tab", "left", "right", "up", "down", "enter"]);
  // Every primary entry is a real special key the daemon accepts, so the primary
  // row never depends on which product is running in the pane.
  assert.ok(primary.every((entry) => entry.kind === "key"));
});

test("the bar offers no ^C key", () => {
  // Dropped deliberately: the width is worth more to the keys this bar actually
  // gets used for. c-c stays a supported SpecialKey everywhere else, so Ctrl+C
  // from a physical keyboard still reaches the session via terminalInput.
  for (const agent of ["codex", "claude", undefined]) {
    const layout = terminalKeyBarLayout(agent);
    const all = [...layout.primary, ...layout.overflow];
    assert.ok(all.every((entry) => entry.kind !== "key" || entry.key !== "c-c"));
  }
});

test("codex offers a queued-question answer key before shared slash commands", () => {
  const { overflow } = terminalKeyBarLayout("codex");
  assert.deepEqual(ids(overflow), ["answer-question", "model", "compact", "usage"]);
  assert.deepEqual(overflow[0], {
    kind: "sequence",
    id: "answer-question",
    label: "Answer Q",
    ariaLabel: "Answer queued question (Shift+Left)",
    sequence: "\x1b[1;2D",
  });
  assert.deepEqual(ids(terminalKeyBarLayout("claude").overflow), ["model", "compact", "usage"]);
});

test("codex and claude sessions offer the shared slash commands in the overflow row", () => {
  for (const agent of ["codex", "claude"]) {
    const { overflow } = terminalKeyBarLayout(agent);
    assert.deepEqual(ids(overflow.filter((entry) => entry.kind === "text")), ["model", "compact", "usage"]);
    assert.deepEqual(
      overflow.filter((entry) => entry.kind === "text").map((entry) => entry.text),
      ["/model", "/compact", "/usage"],
    );
  }
});

test("a slash command inserts its text without submitting it", () => {
  // The Enter key sits one tap away in the primary row. Sending Enter here would
  // race the provider's own "/" completion menu, and would hand the turn-title
  // capture a prompt the user never chose to send.
  const { overflow } = terminalKeyBarLayout("claude");
  for (const entry of overflow.filter((entry) => entry.kind === "text")) {
    assert.doesNotMatch(entry.text, /[\r\n]/);
  }
});

test("an unknown or absent agent gets no slash commands", () => {
  // Allowlisted rather than denylisted: a future agent kind must not inherit
  // commands it has never been shown to accept.
  assert.deepEqual(terminalKeyBarLayout(undefined).overflow, []);
  assert.deepEqual(terminalKeyBarLayout(null).overflow, []);
  assert.deepEqual(terminalKeyBarLayout("hermes").overflow, []);
});

test("every entry carries a stable unique id and a visible label", () => {
  for (const agent of ["codex", "claude", undefined]) {
    const layout = terminalKeyBarLayout(agent);
    const all = [...layout.primary, ...layout.overflow];
    assert.equal(new Set(ids(all)).size, all.length, `duplicate id for agent ${agent}`);
    assert.ok(all.every((entry) => entry.label.trim().length > 0));
  }
});

test("the layout reuses one frozen entry list rather than rebuilding per render", () => {
  // The key bar re-renders on every terminal status change; identity stability
  // keeps the button list from remounting under React.
  const first = terminalKeyBarLayout("claude");
  const second = terminalKeyBarLayout("claude");
  assert.equal(first.primary, second.primary);
  assert.equal(first.overflow, second.overflow);
});

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createTerminalLinkRegistry } from "../src/terminalLinkRegistry.ts";

const ST = "\x1b\\";
const link = (url: string, label: string) => `\x1b]8;;${url}${ST}${label}\x1b]8;;${ST}`;

test("registry harvests an OSC 8 target whose visible label is not a URL", () => {
  const registry = createTerminalLinkRegistry();
  registry.ingest(`see ${link("https://example.test/issues/398", "#398")} now\r\n`);

  assert.deepEqual(registry.list(), [{ url: "https://example.test/issues/398", label: "#398" }]);
});

test("registry keeps the target whole when the label is hard-wrapped by the inner TUI", () => {
  // The reason this exists: the label carries real newlines and a continuation
  // indent, so no client-side join can rebuild it — but the URI never wrapped.
  const registry = createTerminalLinkRegistry();
  registry.ingest(
    `\x1b]8;;https://example.test/a/very/long/path?x=1&y=2${ST}` +
      "https://example.test/a/very/long/\r\n  path?x=1&y=2" +
      `\x1b]8;;${ST}`,
  );

  assert.deepEqual(registry.list(), [
    {
      url: "https://example.test/a/very/long/path?x=1&y=2",
      label: "https://example.test/a/very/long/ path?x=1&y=2",
    },
  ]);
});

test("registry survives a sequence split across stream chunks", () => {
  const registry = createTerminalLinkRegistry();
  const whole = link("https://example.test/split", "label");
  for (let cut = 1; cut < whole.length; cut += 1) {
    const registryForCut = createTerminalLinkRegistry();
    registryForCut.ingest(whole.slice(0, cut));
    registryForCut.ingest(whole.slice(cut));
    assert.deepEqual(
      registryForCut.list(),
      [{ url: "https://example.test/split", label: "label" }],
      `a chunk boundary at ${cut} must not lose the link`,
    );
  }
  registry.ingest(whole);
  assert.equal(registry.list().length, 1);
});

test("registry ignores non-http targets and keeps scanning after them", () => {
  const registry = createTerminalLinkRegistry();
  registry.ingest(link("javascript:alert(1)", "bad"));
  registry.ingest(link("file:///etc/passwd", "worse"));
  registry.ingest(link("https://example.test/ok", "good"));

  assert.deepEqual(registry.list(), [{ url: "https://example.test/ok", label: "good" }]);
});

test("registry lists newest first and deduplicates by target", () => {
  const registry = createTerminalLinkRegistry();
  registry.ingest(link("https://example.test/one", "first"));
  registry.ingest(link("https://example.test/two", "second"));
  registry.ingest(link("https://example.test/one", "again"));

  assert.deepEqual(registry.list(), [
    { url: "https://example.test/one", label: "again" },
    { url: "https://example.test/two", label: "second" },
  ]);
});

test("registry bounds how many links it retains", () => {
  const registry = createTerminalLinkRegistry({ maxLinks: 3 });
  for (let i = 0; i < 10; i += 1) {
    registry.ingest(link(`https://example.test/${i}`, `label ${i}`));
  }

  const listed = registry.list();
  assert.equal(listed.length, 3);
  assert.deepEqual(
    listed.map((entry) => entry.url),
    ["https://example.test/9", "https://example.test/8", "https://example.test/7"],
  );
});

test("registry withholds a link until its closing sequence arrives", () => {
  // Offering the open one looks helpful, but a sequence that is never closed
  // stays open forever and adopts every later line as its caption, so untrusted
  // output could pair an arbitrary target with trustworthy-looking text.
  const registry = createTerminalLinkRegistry();
  registry.ingest(`\x1b]8;;https://evil.test/pinned${ST}`);
  registry.ingest("Build succeeded. Review at github.com/exampleOrg/agent-console/pull/402\r\n");

  assert.deepEqual(registry.list(), [], "an unclosed opener is not offered");

  registry.ingest(`\x1b]8;;${ST}`);
  assert.deepEqual(
    registry.list().map((entry) => entry.url),
    ["https://evil.test/pinned"],
    "it is recorded once closed, and only then",
  );
});

test("registry ends an OSC string wherever xterm ends it", () => {
  // A looser terminator set lists a target the terminal never linked, or misses
  // the one it did. xterm ends an OSC on BEL, ST, or any escape, and cancels it
  // outright on CAN/SUB.
  const brokenByEscape = createTerminalLinkRegistry();
  brokenByEscape.ingest(
    `\x1b]8;;https://good.test/x\x1b[1mRelease notes\x1b]8;;${ST}tail text`,
  );
  assert.deepEqual(
    brokenByEscape.list(),
    [{ url: "https://good.test/x", label: "Release notes" }],
    "the escape ends the URI, and the label is the text xterm would have linked",
  );

  for (const cancel of ["\x18", "\x1a"]) {
    const cancelled = createTerminalLinkRegistry();
    // The closing sequence matters: without it the opener would be withheld
    // anyway and the assertion could not tell cancellation from that.
    cancelled.ingest(
      `\x1b]8;;https://evil.test/canceled${cancel}\x07visible words\x1b]8;;${ST}`,
    );
    assert.deepEqual(cancelled.list(), [], "a cancelled sequence creates no link in xterm either");
  }

  const withControls = createTerminalLinkRegistry();
  withControls.ingest(`\x1b]8;;https://good.test/\x01evil\x07label\x1b]8;;${ST}`);
  assert.deepEqual(
    withControls.list(),
    [{ url: "https://good.test/evil", label: "label" }],
    "C0 controls are dropped rather than percent-encoded into a different URL",
  );
});

test("registry steps over styling inside a label without losing the link", () => {
  const registry = createTerminalLinkRegistry();
  registry.ingest(
    `\x1b]8;;https://example.test/styled${ST}\x1b[1;34mbold blue\x1b[0m\x1b]8;;${ST}`,
  );

  assert.deepEqual(registry.list(), [{ url: "https://example.test/styled", label: "bold blue" }]);
});

test("registry does not let an unterminated sequence grow without bound", () => {
  const registry = createTerminalLinkRegistry();
  registry.ingest("\x1b]8;;https://example.test/never-closed");
  for (let i = 0; i < 200; i += 1) {
    registry.ingest("x".repeat(64));
  }
  registry.ingest(link("https://example.test/after", "after"));

  assert.deepEqual(
    registry.list().map((entry) => entry.url),
    ["https://example.test/after"],
    "the stalled sequence is dropped and later links still register",
  );
});

test("registry clears with the terminal", () => {
  const registry = createTerminalLinkRegistry();
  registry.ingest(link("https://example.test/one", "first"));
  registry.clear();

  assert.deepEqual(registry.list(), []);
});

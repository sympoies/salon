import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import type * as Fixture from "./support/sessionHarnessFixture.ts";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const ssr = createUiSsrHarness([{
  name: "terminal-fixture", enforce: "pre",
  resolveId(source) { return source.endsWith("TerminalPane.tsx") ? "\0terminal-fixture" : null; },
  load(id) { return id === "\0terminal-fixture" ? "export function TerminalPane() { return null; }" : null; },
}]);
after(() => ssr.close());
for (const width of [412, 1280, 1440]) for (const view of ["overview", "focused"] as const) {
  test(`${view} ${width}px: usage follows effort inline; focused desktop provider precedes account`, async t => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const fixture = await ssr.loadModule<typeof Fixture>("/test/support/sessionHarnessFixture.ts");
    const rows = readFileSync(new URL("../src/sessionCardRows.css", import.meta.url), "utf8");
    for (const focusedIndex of view === "focused" ? [0, 1] : [0]) {
      const body = fixture.renderSessionHarnessFixture(view, width, focusedIndex);
      const result = measureUiMarkup<{ checks: ReturnType<typeof fixture.measureSessionHarnessLayout> }>(
        `<style>${rows}html,body{margin:0}.session-workspace{height:320px}.mobile-session-list{height:auto}</style>${body}`,
        width, `const result={checks:(${fixture.measureSessionHarnessLayout.toString()})()};`);
      assert.deepEqual(result.checks.filter(check => !check.pass), [], JSON.stringify(result.checks, null, 2));
    }
  });
}

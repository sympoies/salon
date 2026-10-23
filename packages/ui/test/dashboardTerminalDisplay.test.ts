import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveDashboardTerminalDisplay } from "../src/dashboardTerminalDisplay.ts";
import { BASE_TERMINAL_FONT_SIZE } from "../src/terminalFit.ts";

test("Dashboard terminal display keeps list previews and focused sessions at the same font size", () => {
  const preview = resolveDashboardTerminalDisplay({ focusedKey: null });
  const focused = resolveDashboardTerminalDisplay({ focusedKey: "summit:hs-1" });

  assert.equal(preview.fontSize, BASE_TERMINAL_FONT_SIZE);
  assert.equal(focused.fontSize, BASE_TERMINAL_FONT_SIZE);
  assert.equal(preview.fontSize, focused.fontSize);
  assert.equal(preview.readableFit, false);
  assert.equal(focused.readableFit, true);
});

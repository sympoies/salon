import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createTerminalSyntheticMouseSuppressor,
  isSyntheticLinkMouseEvent,
  markSyntheticLinkMouseEvent,
} from "../src/terminalMouse.ts";

test("armed synthetic-mouse suppressor lets marked link-resolution events through", () => {
  const suppressor = createTerminalSyntheticMouseSuppressor({ now: () => 1000 });
  suppressor.arm();

  const makeEvent = () => {
    let stopped = 0;
    const event = {
      type: "mousemove",
      button: 0,
      preventDefault() {},
      stopImmediatePropagation() {
        stopped += 1;
      },
    } as unknown as Event;
    return { event, stopped: () => stopped };
  };

  // Browser-synthesized compatibility events stay suppressed while armed…
  const plain = makeEvent();
  suppressor.handleCapture(plain.event);
  assert.equal(plain.stopped(), 1, "unmarked events are suppressed while armed");

  // …but our own probe/tap events are marked and must reach xterm, or a
  // long-press-armed suppressor would swallow the menu's link disclosure.
  const marked = makeEvent();
  markSyntheticLinkMouseEvent(marked.event);
  assert.equal(isSyntheticLinkMouseEvent(marked.event), true);
  suppressor.handleCapture(marked.event);
  assert.equal(marked.stopped(), 0, "marked synthetic link events pass through");
});

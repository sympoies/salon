import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  REPAIR_MESSAGE_AUTO_DISMISS_MS,
  attentionRepairToast,
  completedRepairToast,
  repairMessageAfterAutoDismiss,
  repairMessageAutoDismissDelay,
} from "../src/repairBanner.ts";

test("repair completion messages auto-dismiss", () => {
  assert.equal(
    repairMessageAutoDismissDelay(completedRepairToast("Checked 2 sessions; nothing to repair.")),
    REPAIR_MESSAGE_AUTO_DISMISS_MS,
  );
  assert.equal(
    repairMessageAutoDismissDelay(completedRepairToast("Status wording can change.")),
    REPAIR_MESSAGE_AUTO_DISMISS_MS,
  );
});

test("repair messages that need attention stay visible", () => {
  assert.equal(repairMessageAutoDismissDelay(null), null);
  assert.equal(
    repairMessageAutoDismissDelay(
      attentionRepairToast("Checked 2 sessions; 1 failed."),
    ),
    null,
  );
  assert.equal(repairMessageAutoDismissDelay(attentionRepairToast("Checked 2 sessions; 1 failed.")), null);
});

test("failed repair messages expose explicit view and dismiss actions", () => {
  assert.deepEqual(attentionRepairToast("Checked 2 sessions; 1 failed."), {
    text: "Checked 2 sessions; 1 failed.",
    intent: "attention",
    actions: ["view_failures", "dismiss"],
  });
  assert.deepEqual(completedRepairToast("Checked 2 sessions; nothing to repair."), {
    text: "Checked 2 sessions; nothing to repair.",
    intent: "complete",
    actions: [],
  });
});

test("repair auto-dismiss clears only the scheduled message", () => {
  const scheduled = completedRepairToast("Checked 2 sessions; nothing to repair.");
  const newer = completedRepairToast("Checked 3 sessions; resumed 1.");

  assert.equal(repairMessageAfterAutoDismiss(scheduled, scheduled), null);
  assert.equal(repairMessageAfterAutoDismiss(newer, scheduled), newer);
  assert.equal(repairMessageAfterAutoDismiss(null, scheduled), null);
});

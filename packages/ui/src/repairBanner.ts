export const REPAIR_MESSAGE_AUTO_DISMISS_MS = 3200;

export type RepairToastIntent = "complete" | "attention";
export type RepairToastAction = "view_failures" | "dismiss";

export interface RepairToastMessage {
  readonly text: string;
  readonly intent: RepairToastIntent;
  readonly actions: readonly RepairToastAction[];
}

export function completedRepairToast(text: string): RepairToastMessage {
  return { text, intent: "complete", actions: [] };
}

export function attentionRepairToast(text: string): RepairToastMessage {
  return { text, intent: "attention", actions: ["view_failures", "dismiss"] };
}

export function repairMessageAutoDismissDelay(message: RepairToastMessage | null): number | null {
  if (message?.intent !== "complete") {
    return null;
  }
  return REPAIR_MESSAGE_AUTO_DISMISS_MS;
}

export function repairMessageAfterAutoDismiss(
  currentMessage: RepairToastMessage | null,
  scheduledMessage: RepairToastMessage,
): RepairToastMessage | null {
  return currentMessage === scheduledMessage ? null : currentMessage;
}

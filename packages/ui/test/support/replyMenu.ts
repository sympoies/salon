import { act } from "react";

// Drives the reply bubble's action menu the ways a person can open it. The menu
// is portalled to the document body, so it is found there.
type EventClass = new (type: string, init?: object) => Event;
const eventClasses = (node: Element) => node.ownerDocument.defaultView as unknown as Record<string, EventClass>;

export function replyBubble(container: Element, text: string): HTMLElement {
  const bubble = [...container.querySelectorAll<HTMLElement>(".history-outgoing-bubble")].find(node => node.textContent?.includes(text));
  if (!bubble) throw new Error(`No reply bubble contains "${text}"`);
  return bubble;
}

export function replyMenuItem(): HTMLButtonElement | undefined {
  return document.querySelector<HTMLButtonElement>('[role="menu"] [role="menuitem"]') ?? undefined;
}

/** Right-click, or the keyboard's context-menu key on the focused bubble. */
export async function openReplyMenu(container: Element, text: string, gesture: "contextmenu" | "keyboard" = "contextmenu") {
  const bubble = replyBubble(container, text), classes = eventClasses(bubble);
  await act(async () => {
    bubble.dispatchEvent(gesture === "contextmenu"
      ? new classes.MouseEvent!("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 24 })
      : new classes.KeyboardEvent!("keydown", { bubbles: true, cancelable: true, key: "ContextMenu" }));
  });
}

/** A touch long press: a touch pointer held down for `holdMs` before release. */
export async function longPressReply(container: Element, text: string, holdMs: number) {
  const bubble = replyBubble(container, text), classes = eventClasses(bubble);
  const init = { bubbles: true, cancelable: true, pointerType: "touch", clientX: 24, clientY: 24 };
  await act(async () => { bubble.dispatchEvent(new classes.PointerEvent!("pointerdown", init)); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, holdMs)); });
  await act(async () => { bubble.dispatchEvent(new classes.PointerEvent!("pointerup", init)); });
}

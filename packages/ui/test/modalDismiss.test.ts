import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createUiSsrHarness } from "./support/ssr.ts";
import { uiSource, uiStyles } from "./support/source.ts";

const ssr = createUiSsrHarness();
const styles = uiStyles();
const createDialogSource = uiSource("CreateDialog.tsx");
const dashboardSource = uiSource("Dashboard.tsx");

after(async () => {
  await ssr.close();
});

interface ModalProps {
  readonly modal?: boolean;
  readonly onClose: () => void;
  readonly busy?: boolean;
  readonly className?: string;
  readonly backdropClassName?: string;
  readonly ariaLabel?: string;
  readonly ariaLabelledby?: string;
  readonly androidBackEntry?: string;
  readonly children?: ReactNode;
}

const cleanupStack: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupStack.length > 0) {
    await cleanupStack.pop()?.();
  }
});

function installDom(): { readonly window: Window; readonly root: Root; readonly container: HTMLElement } {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    KeyboardEvent: globalThis.KeyboardEvent,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  cleanupStack.push(async () => {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  });
  return { window, root, container };
}

async function loadModal() {
  const mod = await ssr.loadModule<{ Modal: ComponentType<ModalProps> }>("/src/Modal.tsx");
  return mod.Modal;
}

test("Modal keeps outside clicks from dismissing and replays an attention pulse", async () => {
  const Modal = await loadModal();
  const { window, root, container } = installDom();
  let closes = 0;
  await act(async () => {
    root.render(
      createElement(
        Modal,
        { onClose: () => { closes += 1; } },
        createElement("button", { type: "button", "data-testid": "inside" }, "Inside"),
      ),
    );
  });
  const backdrop = container.querySelector<HTMLElement>(".modal-backdrop");
  const modal = container.querySelector<HTMLElement>(".modal");
  assert.ok(backdrop);
  assert.ok(modal);
  assert.equal(modal.classList.contains("modal--attention"), false);

  await act(async () => {
    backdrop.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  assert.equal(closes, 0, "outside click must not close the modal");
  assert.equal(modal.classList.contains("modal--attention"), true, "outside click must trigger the attention pulse");
});

test("Modal dismisses on Escape and on inner button-driven close only", async () => {
  const Modal = await loadModal();
  const { window, root, container } = installDom();
  let closes = 0;
  await act(async () => {
    root.render(
      createElement(
        Modal,
        { onClose: () => { closes += 1; } },
        createElement("button", { type: "button", "data-testid": "inside" }, "Inside"),
      ),
    );
  });
  const modal = container.querySelector<HTMLElement>(".modal");
  const inside = container.querySelector<HTMLElement>('[data-testid="inside"]');
  assert.ok(modal);
  assert.ok(inside);

  // A click inside the dialog neither closes it nor triggers the attention pulse.
  await act(async () => {
    inside.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  assert.equal(closes, 0);
  assert.equal(modal.classList.contains("modal--attention"), false);

  // Escape is the standard accessible dismissal and still closes.
  await act(async () => {
    modal.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  assert.equal(closes, 1, "Escape must close the modal");
});

test("Modal ignores outside click and Escape while busy", async () => {
  const Modal = await loadModal();
  const { window, root, container } = installDom();
  let closes = 0;
  await act(async () => {
    root.render(
      createElement(
        Modal,
        { onClose: () => { closes += 1; }, busy: true },
        createElement("button", { type: "button", "data-testid": "inside" }, "Inside"),
      ),
    );
  });
  const backdrop = container.querySelector<HTMLElement>(".modal-backdrop");
  const modal = container.querySelector<HTMLElement>(".modal");
  assert.ok(backdrop);
  assert.ok(modal);

  await act(async () => {
    backdrop.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    modal.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  assert.equal(closes, 0, "a busy modal must not close from backdrop or Escape");
  assert.equal(modal.classList.contains("modal--attention"), false);
});

test("Modal restores its opener on close without stealing an intentional focus handoff", async () => {
  const Modal = await loadModal();
  const { window, root, container } = installDom();
  const opener = window.document.createElement("button");
  const handoff = window.document.createElement("input");
  window.document.body.append(opener, handoff);
  opener.focus();
  await act(async () => root.render(createElement(Modal, { onClose: () => {} }, "Dialog")));
  assert.equal(window.document.activeElement === container.querySelector(".modal"), true);
  await act(async () => root.render(null));
  assert.equal(window.document.activeElement === opener, true, "closing restores the connected opener");

  await act(async () => root.render(createElement(Modal, { onClose: () => {} }, "Dialog")));
  handoff.focus();
  await act(async () => root.render(null));
  assert.equal(window.document.activeElement === handoff, true, "a new session's focus must remain intact");
});

test("responsive modal and dock transitions preserve the focused conversation control", async () => {
  const Modal = await loadModal();
  const { window, root, container } = installDom();
  const opener = window.document.createElement("button");
  window.document.body.append(opener);
  opener.focus();
  const render = (modal: boolean) => createElement(Modal, { onClose: () => {}, modal }, createElement("textarea"));
  await act(async () => root.render(render(true)));
  const input = container.querySelector("textarea");
  assert.ok(input);
  input.focus();
  await act(async () => root.render(render(false)));
  assert.equal(window.document.activeElement === input, true, "docking keeps input focus");
  await act(async () => root.render(render(true)));
  assert.equal(window.document.activeElement === input, true, "returning to modal keeps input focus");
  await act(async () => root.render(null));
  assert.equal(window.document.activeElement === opener, true, "final close restores the opener");
});

test("Modal owns nested Android Back and preserves busy dismissal guards", async () => {
  const Modal = await loadModal();
  const { window, root, container } = installDom();
  Object.defineProperty(window, "__TAURI__", { value: {}, configurable: true });
  const pushed: unknown[] = [];
  const originalPush = window.history.pushState.bind(window.history);
  window.history.pushState = (state, unused, url) => { pushed.push({ agentConsoleBack: (state as { agentConsoleBack: string }).agentConsoleBack }); originalPush(state, unused, url); };
  window.history.back = () => {};
  let parentCloses = 0;
  let childCloses = 0;
  const render = (child: boolean, busy: boolean) => createElement(Modal,
    { onClose: () => { parentCloses += 1; }, androidBackEntry: "page" },
    createElement("button", { type: "button", "data-testid": "parent-opener" }, "Open confirmation"),
    child ? createElement(Modal, { onClose: () => { childCloses += 1; }, busy, androidBackEntry: "confirmation" }, "Confirm") : null,
  );
  await act(async () => root.render(render(false, false)));
  assert.deepEqual(pushed, [{ agentConsoleBack: "page" }]);
  const parentOpener = container.querySelector<HTMLElement>('[data-testid="parent-opener"]');
  assert.ok(parentOpener);
  parentOpener.focus();
  await act(async () => root.render(render(true, true)));
  assert.deepEqual(pushed.at(-1), { agentConsoleBack: "confirmation" });
  await act(async () => window.dispatchEvent(new window.PopStateEvent("popstate", { state: { agentConsoleBack: "page" } })));
  assert.equal(childCloses, 0);
  assert.equal(parentCloses, 0);
  assert.deepEqual(pushed.at(-1), { agentConsoleBack: "confirmation" });
  await act(async () => root.render(render(true, false)));
  await act(async () => window.dispatchEvent(new window.PopStateEvent("popstate", { state: { agentConsoleBack: "page" } })));
  assert.equal(childCloses, 1);
  assert.equal(parentCloses, 0, "Back closes only the top dialog");
  assert.equal(container.querySelectorAll(".modal").length, 2);
  await act(async () => root.render(render(false, false)));
  assert.equal(window.document.activeElement === parentOpener, true, "nested close restores focus into its parent page");
});

test("closing a mounted Android modal consumes its Back entry", async () => {
  const Modal = await loadModal();
  const { window, root } = installDom();
  Object.defineProperty(window, "__TAURI__", { value: {}, configurable: true });
  let backs = 0;
  window.history.back = () => { backs += 1; };
  await act(async () => root.render(createElement(Modal, { onClose: () => {}, androidBackEntry: "new-session" }, "New")));
  await act(async () => root.render(null));
  assert.equal(backs, 1, "Cancel consumes the dialog entry instead of leaving a stale Back target");
});

test("attention animation is defined and neutralized under reduced motion", () => {
  assert.match(styles, /@keyframes modal-attention-shake/);
  assert.match(styles, /\.modal--attention\s*\{/);
  // The shake keyframe is redefined inside a reduced-motion guard so the pulse
  // degrades to a non-translating ring flash instead of moving the dialog.
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?@keyframes modal-attention-shake/,
  );
});

test("both real modals route dismissal through the shared Modal wrapper", () => {
  assert.match(createDialogSource, /<Modal\b/);
  assert.doesNotMatch(createDialogSource, /className="modal-backdrop"/);
  assert.match(dashboardSource, /<Modal\b/);
  assert.match(dashboardSource, /backdropClassName="close-session-backdrop"/);
});

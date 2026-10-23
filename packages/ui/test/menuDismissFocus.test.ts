import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { createElement, useCallback, useRef, useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDismissOnOutside } from "../src/useDismissOnOutside.ts";
import { useMenuFocus } from "../src/useMenuFocus.ts";
import { assertActiveElement, assertNoElement } from "./support/domAssert.ts";
import { uiSource } from "./support/source.ts";

const dashboardSource = uiSource("Dashboard.tsx");
const headerMenuSource = uiSource("HeaderMenu.tsx");
const sessionSlotSource = uiSource("SessionSlot.tsx");
const titleMenuSource = uiSource("SessionTitleMenu.tsx");
const dismissSource = uiSource("useDismissOnOutside.ts");
const menuFocusSource = uiSource("useMenuFocus.ts");

const cleanupStack: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupStack.length > 0) {
    await cleanupStack.pop()?.();
  }
});

function installDom(): {
  readonly window: Window;
  readonly root: Root;
  readonly container: HTMLElement;
  cleanup(): Promise<void>;
} {
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
  let cleaned = false;
  return {
    window,
    root,
    container,
    async cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      await act(async () => {
        root.unmount();
      });
      Object.assign(globalThis, previous);
    },
  };
}

test("menus share outside pointer and Escape dismissal through one hook", () => {
  assert.match(dismissSource, /export function useDismissOnOutside/);
  assert.match(headerMenuSource, /useDismissOnOutside\(open, "\.header-menu",/);
  assert.match(titleMenuSource, /useDismissOnOutside\(open, "\.slot-title-menu",/);
  assert.doesNotMatch(dashboardSource, /shouldCloseSlotMenuFromPointerTarget/);
  assert.doesNotMatch(dashboardSource, /target\?\.closest\("\.header-menu"\)/);
});

test("role=menu widgets use a shared focus and roving keyboard contract", () => {
  assert.match(menuFocusSource, /export function useMenuFocus/);
  assert.match(menuFocusSource, /ArrowDown/);
  assert.match(menuFocusSource, /ArrowUp/);
  assert.match(menuFocusSource, /Home/);
  assert.match(menuFocusSource, /End/);
  assert.match(menuFocusSource, /triggerRef\.current\?\.focus\(\)/);

  assert.match(headerMenuSource, /useMenuFocus\(\{/);
  assert.match(sessionSlotSource, /useMenuFocus\(\{/);
  assert.match(headerMenuSource, /role="menu"[\s\S]*?onKeyDown=\{menuFocus\.onKeyDown\}/);
  assert.match(sessionSlotSource, /role="menu"[\s\S]*?onKeyDown=\{menuFocus\.onKeyDown\}/);
  assert.match(headerMenuSource, /role="menuitem"[\s\S]*?tabIndex=\{-1\}/);
  assert.match(sessionSlotSource, /role="menuitem"[\s\S]*?tabIndex=\{-1\}/);
});

test("menu hooks dismiss outside clicks and manage menu focus", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);

  function Probe() {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const close = useCallback(() => setOpen(false), []);
    useDismissOnOutside(open, ".probe-menu", close);
    const menuFocus = useMenuFocus({ open, menuRef, triggerRef, onClose: close });
    return createElement(
      "section",
      { className: "probe-menu" },
      createElement(
        "button",
        {
          ref: triggerRef,
          type: "button",
          "data-testid": "trigger",
          onClick: () => setOpen((current) => !current),
        },
        "Open",
      ),
      open
        ? createElement(
            "div",
            { ref: menuRef, role: "menu", onKeyDown: menuFocus.onKeyDown, "data-testid": "menu" },
            createElement(
              "div",
              { role: "menuitem", tabIndex: -1, "aria-disabled": "true", "data-testid": "disabled-first" },
              "Disabled first",
            ),
            createElement("button", { role: "menuitem", tabIndex: -1, "data-testid": "first" }, "First"),
            createElement("button", { role: "menuitemcheckbox", tabIndex: -1, "aria-checked": "false", "data-testid": "checkable" }, "Checkable"),
            createElement("button", { role: "menuitem", tabIndex: -1, "data-testid": "hidden", style: { display: "none" } }, "Hidden"),
            createElement(
              "div",
              { role: "menuitem", tabIndex: -1, "aria-disabled": "true", "data-testid": "disabled-middle" },
              "Disabled middle",
            ),
            createElement("button", { role: "menuitem", tabIndex: -1, "data-testid": "second" }, "Second"),
            createElement(
              "div",
              { role: "menuitem", tabIndex: -1, "aria-disabled": "true", "data-testid": "disabled-last" },
              "Disabled last",
            ),
          )
        : null,
    );
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  const trigger = mounted.container.querySelector<HTMLElement>('[data-testid="trigger"]');
  assert.ok(trigger);
  await act(async () => {
    trigger.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await new Promise((resolve) => mounted.window.setTimeout(resolve, 0));
  });
  const first = mounted.container.querySelector<HTMLElement>('[data-testid="first"]');
  const checkable = mounted.container.querySelector<HTMLElement>('[data-testid="checkable"]');
  const second = mounted.container.querySelector<HTMLElement>('[data-testid="second"]');
  assertActiveElement(mounted.window, first);

  await act(async () => {
    first?.dispatchEvent(new mounted.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
  assertActiveElement(mounted.window, checkable);

  await act(async () => {
    checkable?.dispatchEvent(new mounted.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
  assertActiveElement(mounted.window, second);

  await act(async () => {
    second?.dispatchEvent(new mounted.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
  });
  assertActiveElement(mounted.window, checkable);

  await act(async () => {
    checkable?.dispatchEvent(new mounted.window.KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
  });
  assertActiveElement(mounted.window, first);

  await act(async () => {
    first?.dispatchEvent(new mounted.window.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
  });
  assertActiveElement(mounted.window, second);

  await act(async () => {
    second?.dispatchEvent(new mounted.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  assertNoElement(mounted.container, '[data-testid="menu"]');
  assertActiveElement(mounted.window, trigger);

  const reopenedTrigger = mounted.container.querySelector<HTMLElement>('[data-testid="trigger"]');
  assert.ok(reopenedTrigger);
  await act(async () => {
    reopenedTrigger.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await new Promise((resolve) => mounted.window.setTimeout(resolve, 0));
  });
  assert.ok(mounted.container.querySelector('[data-testid="menu"]'));
  await act(async () => {
    mounted.container.querySelector(".probe-menu")?.dispatchEvent(
      new mounted.window.Event("pointerdown", { bubbles: true, cancelable: true }),
    );
  });
  assert.ok(mounted.container.querySelector('[data-testid="menu"]'));

  const outside = mounted.window.document.createElement("button");
  mounted.window.document.body.append(outside);
  await act(async () => {
    outside.dispatchEvent(new mounted.window.Event("pointerdown", { bubbles: true, cancelable: true }));
  });
  assertNoElement(mounted.container, '[data-testid="menu"]');
});

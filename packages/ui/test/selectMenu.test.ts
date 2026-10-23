import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { assertActiveElement, assertNoElement } from "./support/domAssert.ts";
import { makeCssRuleLookup, uiStyles } from "./support/source.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const ssr = createUiSsrHarness();

after(async () => {
  await ssr.close();
});

test("SelectMenu owns rendering, keyboard selection, and outside dismissal", async () => {
  const { SelectMenu } = await ssr.loadModule<{
    SelectMenu: ComponentType<{
      ariaLabel: string;
      value: string;
      options: readonly { value: string; label: string; meta?: string }[];
      onChange: (value: string) => void;
    }>;
  }>("/src/SelectMenu.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    KeyboardEvent: globalThis.KeyboardEvent,
    MouseEvent: globalThis.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let selected = "default";

  try {
    await act(async () => {
      root.render(createElement(SelectMenu, {
        ariaLabel: "Account",
        value: "default",
        options: [
          { value: "default", label: "Default account" },
          { value: "sym", label: "sym", meta: "team" },
        ],
        onChange: (value) => { selected = value; },
      }));
    });
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]');
    assert.ok(trigger);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");

    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    assert.equal(options.length, 2);
    assert.equal(options[0]?.getAttribute("aria-selected"), "true");
    assertActiveElement(window, options[0] ?? null);

    await act(async () => {
      options[0]?.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }));
    });
    assertActiveElement(window, options[1] ?? null);
    await act(async () => {
      options[1]?.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(selected, "sym");
    assertNoElement(container, '[role="listbox"]');
    assertActiveElement(window, trigger);

    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const openListbox = container.querySelector<HTMLElement>('[role="listbox"]');
    assert.ok(openListbox);
    // The panel is positioned by useAnchoredFloating (fixed, anchored to the
    // trigger) rather than a CSS-driven mobile bottom sheet. Assert on props
    // only the computed style sets — the hidden fallback is also `fixed`, so
    // checking position alone would pass even if compute() never ran.
    assert.equal(openListbox.style.position, "fixed");
    assert.notEqual(openListbox.style.visibility, "hidden");
    assert.match(openListbox.style.maxHeight, /^\d+px$/);
    const outside = window.document.createElement("button");
    window.document.body.append(outside);
    await act(async () => {
      outside.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
    });
    assertNoElement(container, '[role="listbox"]');

    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const scrim = container.querySelector<HTMLElement>(".select-menu-scrim");
    assert.ok(scrim);
    await act(async () => {
      scrim.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
    });
    assertNoElement(container, '[role="listbox"]');
    assertActiveElement(window, trigger);

    for (const [key, expectedIndex] of [
      ["Home", 0],
      ["End", 1],
      ["ArrowDown", 1],
      ["ArrowUp", 1],
    ] as const) {
      await act(async () => {
        trigger.dispatchEvent(new window.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }));
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      const keyedOptions = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
      assertActiveElement(window, keyedOptions[expectedIndex] ?? null);
      await act(async () => {
        keyedOptions[expectedIndex]?.dispatchEvent(new window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }));
      });
      assertNoElement(container, '[role="listbox"]');
    }

    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      trigger.focus();
    });
    const alreadyOpenOptions = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    await act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "End",
        bubbles: true,
        cancelable: true,
      }));
    });
    assertActiveElement(window, alreadyOpenOptions[1] ?? null);
    await act(async () => {
      alreadyOpenOptions[1]?.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });

    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const focusedOption = container.querySelector<HTMLButtonElement>('[role="option"]');
    const pointerScrim = container.querySelector<HTMLElement>(".select-menu-scrim");
    assert.ok(focusedOption);
    assert.ok(pointerScrim);
    await act(async () => {
      pointerScrim.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
      focusedOption.blur();
    });
    await act(async () => {
      pointerScrim.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assertNoElement(container, '[role="listbox"]');
    assertActiveElement(window, trigger);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

test("anchored-popover lists are placed inline, never re-pinned by CSS", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  // Positioning is set inline by useAnchoredFloating (fixed, anchored to the
  // trigger) for every viewport, so no rule for either popover list may pin the
  // panel — in particular the old mobile bottom-sheet override that set
  // `position: fixed` + `bottom:`. The selector match tolerates optional
  // whitespace and compound/minified suffixes so a re-added override cannot slip
  // past on formatting alone.
  for (const selector of ["select-menu-options", "workdir-options"]) {
    const rules = css.match(new RegExp(`\\.${selector}\\b[^{}]*\\{[^}]*\\}`, "g"));
    assert.ok(rules && rules.length >= 1, `expected a .${selector} rule`);
    for (const rule of rules) {
      assert.doesNotMatch(rule, /position:/);
      assert.doesNotMatch(rule, /\btop:/);
      assert.doesNotMatch(rule, /\bbottom:/);
    }
  }
});

test("Android Back dismisses SelectMenu before its surrounding view", async () => {
  const { SelectMenu } = await ssr.loadModule<{
    SelectMenu: ComponentType<{
      ariaLabel: string;
      value: string;
      options: readonly { value: string; label: string }[];
      onChange: (value: string) => void;
    }>;
  }>("/src/SelectMenu.tsx");
  const window = new Window({ url: "tauri://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    PopStateEvent: globalThis.PopStateEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  const pushedStates: unknown[] = [];
  const originalPushState = window.history.pushState.bind(window.history);
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    PopStateEvent: window.PopStateEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(window, "__TAURI__", { value: {}, configurable: true });
  window.history.pushState = (data, unused, url) => {
    pushedStates.push(data);
    return originalPushState(data, unused, url);
  };
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(createElement(SelectMenu, {
        ariaLabel: "Account",
        value: "default",
        options: [{ value: "default", label: "Default account" }],
        onChange: () => undefined,
      }));
    });
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]');
    assert.ok(trigger);

    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    assert.equal(pushedStates.length, 1);
    assert.match(String((pushedStates[0] as { agentConsoleBack?: unknown }).agentConsoleBack), /^select-menu-/);

    await act(async () => {
      window.dispatchEvent(new window.PopStateEvent("popstate", { state: null }));
    });
    assertNoElement(container, '[role="listbox"]');
    assert.ok(container.querySelector('[role="combobox"]'));
    assertActiveElement(window, trigger);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    await window.happyDOM.close();
  }
});

test("switching CreateDialog selectors reuses one Android Back entry", async () => {
  const { CreateDialog } = await ssr.loadModule<{
    CreateDialog: ComponentType<{
      machines: readonly string[];
      accountsByProvider: Readonly<Record<"codex" | "claude", Readonly<Record<string, unknown>>>>;
      busy: boolean;
      onCreate: () => void;
      onClose: () => void;
    }>;
  }>("/src/CreateDialog.tsx");
  const window = new Window({ url: "tauri://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    PopStateEvent: globalThis.PopStateEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  const pushedStates: unknown[] = [];
  const backCalls: unknown[] = [];
  const originalPushState = window.history.pushState.bind(window.history);
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    PopStateEvent: window.PopStateEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(window, "__TAURI__", { value: {}, configurable: true });
  window.history.pushState = (data, unused, url) => {
    pushedStates.push(data);
    return originalPushState(data, unused, url);
  };
  window.history.back = () => {
    backCalls.push(window.history.state);
  };
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(createElement(CreateDialog, {
        machines: ["first", "second"],
        accountsByProvider: { codex: { first: { accounts: [] }, second: { accounts: [] } }, claude: {} },
        busy: false,
        onCreate: () => undefined,
        onClose: () => undefined,
      }));
    });
    const dialogBackState = window.history.state;
    pushedStates.length = 0;
    const machineTrigger = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label^="Machine:"]');
    const agentTrigger = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label^="Agent:"]');
    assert.ok(machineTrigger);
    assert.ok(agentTrigger);

    await act(async () => {
      machineTrigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    assert.equal(pushedStates.length, 1);

    await act(async () => {
      agentTrigger.focus();
    });
    assertNoElement(container, '[role="listbox"]');
    assertActiveElement(window, agentTrigger);
    assert.equal(backCalls.length, 1);
    await act(async () => {
      window.history.replaceState(dialogBackState, "");
      window.dispatchEvent(new window.PopStateEvent("popstate", { state: dialogBackState }));
    });
    pushedStates.length = 0;
    backCalls.length = 0;

    await act(async () => {
      machineTrigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    assert.equal(pushedStates.length, 1);

    await act(async () => {
      agentTrigger.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
      agentTrigger.focus();
    });
    await act(async () => {
      agentTrigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    assert.equal(backCalls.length, 0);
    assert.equal(pushedStates.length, 1);
    assert.ok(container.querySelector('[role="listbox"][aria-label="Agent options"]'));
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    await window.happyDOM.close();
  }
});

test("SelectMenu renders decorative leading marks and reserves the slot list-wide", async () => {
  const { SelectMenu } = await ssr.loadModule<{
    SelectMenu: ComponentType<{
      ariaLabel: string;
      value: string;
      options: readonly { value: string; label: string; meta?: string; icon?: ReactNode }[];
      onChange: (value: string) => void;
    }>;
  }>("/src/SelectMenu.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(createElement(SelectMenu, {
        ariaLabel: "Machine",
        value: "maple",
        options: [
          { value: "maple", label: "maple", icon: createElement("span", { className: "probe-mark" }) },
          { value: "m2", label: "m2" },
        ],
        onChange: () => {},
      }));
    });
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]');
    assert.ok(trigger);
    assert.ok(trigger.querySelector(".select-menu-icon .probe-mark"));
    // The mark is decoration only: the combobox name still reads as plain text.
    assert.equal(trigger.getAttribute("aria-label"), "Machine: maple");

    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    assert.equal(options.length, 2);
    assert.ok(options[0]?.querySelector(".select-menu-icon .probe-mark"));
    assert.equal(options[0]?.getAttribute("aria-label"), "maple");
    // An option carrying no mark of its own still reserves the slot, so one
    // unmarked entry cannot leave the rest of the list ragged.
    assert.ok(options[1]?.querySelector(".select-menu-icon"));
    assert.equal(options[1]?.querySelector(".probe-mark")?.tagName ?? null, null);
    // Marks stay out of the option text, so label-based lookups keep working.
    assert.equal(options[1]?.textContent?.trim(), "m2");
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    await window.happyDOM.close();
  }
});

test("SelectMenu leading marks share one fixed-size slot", () => {
  const cssRuleFor = makeCssRuleLookup(uiStyles());
  // Machine and Agent stack directly on top of each other in the New session
  // dialog. A slot that sized to its content would put their trigger labels on
  // different x positions, so the box is fixed and non-shrinking, and every
  // mark rendered into it is pinned to the same size.
  assert.match(cssRuleFor(".select-menu"), /--select-menu-mark: 1\.3rem;/);
  const slot = cssRuleFor(".select-menu-icon");
  assert.match(slot, /flex: none;/);
  assert.match(slot, /width: var\(--select-menu-mark\);/);
  assert.match(slot, /height: var\(--select-menu-mark\);/);
  const marks = cssRuleFor(".select-menu-icon .agent-badge,\n.select-menu-icon .machine-badge");
  assert.match(marks, /width: var\(--select-menu-mark\);/);
  assert.match(marks, /height: var\(--select-menu-mark\);/);
});

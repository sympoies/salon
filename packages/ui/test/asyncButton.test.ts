import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { assertNoElement } from "./support/domAssert.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { uiSource, uiStyles } from "./support/source.ts";

interface AsyncButtonProps {
  readonly onClick?: (event: unknown) => unknown;
  readonly pending?: boolean;
  readonly iconOnly?: boolean;
  readonly className?: string;
  readonly type?: "button" | "submit";
  readonly disabled?: boolean;
  readonly "aria-label"?: string;
  readonly children?: ReactNode;
}

const ssr = createUiSsrHarness();
const styles = uiStyles();

async function loadAsyncButton(): Promise<ComponentType<AsyncButtonProps>> {
  const module = await ssr.loadModule<{ AsyncButton: ComponentType<AsyncButtonProps> }>("/src/AsyncButton.tsx");
  return module.AsyncButton;
}

after(async () => {
  await ssr.close();
});

// Live-render harness (SSR-loaded component + happy-dom client render) for the
// interactive paths that static SSR markup cannot exercise.
const cleanupStack: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanupStack.length > 0) {
    await cleanupStack.pop()?.();
  }
});

function installDom(): { readonly window: Window; readonly root: Root; readonly container: HTMLElement; cleanup(): Promise<void> } {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
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
      if (cleaned) return;
      cleaned = true;
      await act(async () => {
        root.unmount();
      });
      Object.assign(globalThis, previous);
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("uncontrolled AsyncButton delays the spinner, then shows it, and swallows re-clicks", async () => {
  const AsyncButton = await loadAsyncButton();
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);

  const gate = deferred();
  let calls = 0;
  await act(async () => {
    mounted.root.render(
      createElement(AsyncButton, { className: "btn", onClick: () => {
        calls += 1;
        return gate.promise;
      } }, "Refresh"),
    );
  });
  const button = () => mounted.container.querySelector("button");
  assert.equal(button()?.getAttribute("aria-busy"), null);

  await act(async () => {
    button()?.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  // Anti-flicker: the action started, but the spinner is not shown on the first
  // frame — a fast action would resolve before it ever appears.
  assert.equal(button()?.getAttribute("aria-busy"), null, "spinner is delayed, not shown immediately");
  assert.equal(calls, 1);

  // Once the action outlives the show-delay the busy state appears.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 180));
  });
  assert.equal(button()?.getAttribute("aria-busy"), "true", "busy state appears after the show-delay");
  assert.ok(button()?.hasAttribute("disabled"));
  assert.ok(mounted.container.querySelector(".btn-spinner"), "spinner renders while busy");

  // A re-click mid-flight is swallowed by the synchronous in-flight guard.
  await act(async () => {
    button()?.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  assert.equal(calls, 1, "re-click while in flight does not fire the action again");

  // Resolve; the min-visible hold keeps it up briefly, then it clears.
  await act(async () => {
    gate.resolve();
    await gate.promise;
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  assert.equal(button()?.getAttribute("aria-busy"), null, "busy state clears after the min-visible window");
  assertNoElement(mounted.container, ".btn-spinner");
});

test("controlled AsyncButton swallows a click while the parent-owned pending is set", async () => {
  const AsyncButton = await loadAsyncButton();
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);

  let calls = 0;
  await act(async () => {
    mounted.root.render(
      createElement(AsyncButton, { className: "btn", pending: true, onClick: () => (calls += 1) }, "Create"),
    );
  });
  const button = mounted.container.querySelector("button");
  assert.equal(button?.getAttribute("aria-busy"), "true");
  assert.ok(button?.hasAttribute("disabled"));
  await act(async () => {
    button?.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  assert.equal(calls, 0, "handleClick swallows the click while controlled-pending");
});

test("AsyncButton renders a plain, idle button by default", async () => {
  const AsyncButton = await loadAsyncButton();
  const html = renderComponent(AsyncButton, { className: "btn", children: "Refresh" });
  assert.match(html, />Refresh</);
  assert.doesNotMatch(html, /aria-busy/);
  assert.doesNotMatch(html, /btn-spinner/);
  assert.doesNotMatch(html, /disabled/);
});

test("AsyncButton shows the shared busy state when pending is controlled", async () => {
  const AsyncButton = await loadAsyncButton();
  const html = renderComponent(AsyncButton, { className: "btn primary", pending: true, children: "Create" });
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled/);
  assert.match(html, /class="btn-spinner"/);
  // Label is kept beside the spinner (chosen "spinner + keep label" grammar).
  assert.match(html, />Create</);
});

test("AsyncButton merges a caller disabled with the busy state and passes native props through", async () => {
  const AsyncButton = await loadAsyncButton();
  const disabledIdle = renderComponent(AsyncButton, { className: "btn", disabled: true, children: "Go" });
  assert.match(disabledIdle, /disabled/);
  assert.doesNotMatch(disabledIdle, /btn-spinner/);

  const typed = renderComponent(AsyncButton, { type: "submit", "aria-label": "Sign in", children: "Sign in" });
  assert.match(typed, /type="submit"/);
  assert.match(typed, /aria-label="Sign in"/);
});

test("AsyncButton icon-only marks the button so CSS can drop the glyph while busy", async () => {
  const AsyncButton = await loadAsyncButton();
  const html = renderComponent(AsyncButton, { className: "icon", iconOnly: true, pending: true, children: "x" });
  assert.match(html, /is-icon-busy/);
  assert.match(html, /class="btn-spinner"/);
});

test("styles define one shared pending look (spinner + busy button + reduced motion)", () => {
  assert.match(styles, /\.btn-spinner\s*\{[^}]*border-top-color:\s*transparent;[^}]*animation:\s*session-activity-spin/s);
  assert.match(styles, /button\[aria-busy="true"\]\s*\{[^}]*cursor:\s*progress;/s);
  assert.match(styles, /\.is-icon-busy\[aria-busy="true"\]\s*>\s*:not\(\.btn-spinner\)\s*\{[^}]*display:\s*none;/s);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.btn-spinner\s*\{[^}]*animation:\s*none;/s);
  // The non-.btn resume button lays out its spinner + label.
  assert.match(styles, /\.slot-resume\s*\{[^}]*display:\s*inline-flex;/s);
});

test("waiting buttons across the app route through AsyncButton, not ad-hoc patterns", () => {
  // Assert component adoption + the action each one triggers, deliberately NOT
  // exact prop formatting/order (which is brittle to reflow and renames).
  const adopters: ReadonlyArray<readonly [string, RegExp]> = [
    ["UsagePanel.tsx", /AsyncButton[\s\S]*?usageState\.refresh/],
    ["Settings.tsx", /AsyncButton[\s\S]*?signOut\(\)/],
    ["Login.tsx", /<AsyncButton[\s\S]*?type="submit"/],
    ["CreateDialog.tsx", /<AsyncButton[\s\S]*?onClick=\{submit\}/],
  ];
  for (const [file, action] of adopters) {
    assert.match(uiSource(file), /AsyncButton/, `${file} adopts AsyncButton`);
    assert.match(uiSource(file), action, `${file} wires its action through AsyncButton`);
  }

  // The bespoke "…ing" text swaps are retired in favor of the spinner grammar.
  assert.doesNotMatch(uiSource("Login.tsx"), /Signing in…/);
  assert.doesNotMatch(uiSource("CreateDialog.tsx"), /Creating…/);

  // The brand repair trigger uses the shared spinner, not the old is-busy border.
  assert.doesNotMatch(uiSource("BrandTitle.tsx"), /is-busy"/);
  assert.match(uiSource("BrandTitle.tsx"), /btn-spinner/);
});

test("close-session keeps the dialog open during pending and failed delete attempts", () => {
  const dashboard = uiSource("Dashboard.tsx");
  // The dialog owns the shared pending state on its single Delete button, with
  // immediate timings so `deleting` also locks Cancel/backdrop the instant Delete
  // is pressed (the anti-flicker show-delay would otherwise leave them briefly active).
  // Only the timings are pinned here; which handler the button runs is behavior that
  // dashboardBehavior.test.ts owns, so a rename or reflow must not fail this test.
  assert.match(dashboard, /\{ showDelayMs: 0, minVisibleMs: 0 \}/);
  assert.match(dashboard, /pending=\{deleting\}/);
  // Ordering: the kill is awaited BEFORE the dialog is dismissed. Reverting this
  // (dismiss first) would silently drop the pending state — the point of the fix.
  assert.match(dashboard, /const deleted = await closeSession\(session\);\s*if \(deleted\) \{\s*setCloseConfirmSession\(null\);\s*\}/);
  // A failed request returns false after surfacing maintenance context, so the
  // exact session confirmation remains available for retry or recovery.
  assert.match(dashboard, /const closeSession = useCallback\(async[\s\S]*?Promise<boolean>[\s\S]*?return false;/);
});

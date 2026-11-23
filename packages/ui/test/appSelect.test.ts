import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { assertNoElement } from "./support/domAssert.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function mountSelect(runtime: "browser" | "macos" | "android", supportsPicker = true) {
  const window = new Window({ url: "http://localhost" });
  Object.defineProperty(window, "CSS", { value: { supports: () => supportsPicker } });
  const saved = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  if (runtime !== "browser") Object.defineProperty(window, "__TAURI__", { value: {}, configurable: true });
  if (runtime === "android") Object.defineProperty(window.navigator, "userAgent", { value: "Android", configurable: true });
  const ssr = createUiSsrHarness();
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => { await act(async () => root.unmount()); await ssr.close(); Object.assign(globalThis, saved); window.close(); });
  const { AppSelect } = await ssr.loadModule<typeof import("../src/AppSelect.tsx")>("/src/AppSelect.tsx");
  const changes: string[] = [];
  function Harness() {
    const [value, setValue] = useState("b");
    return createElement(AppSelect, { "aria-label": "Pick one", value, onChange: (event) => { changes.push(event.target.value); setValue(event.target.value); } },
      createElement("option", { value: "a" }, "Alpha"),
      createElement("option", { value: "b" }, "Beta"),
      createElement("option", { value: "c", disabled: true }, "Gamma (unavailable)"));
  }
  await act(async () => root.render(createElement(Harness)));
  return { window, container: container as unknown as HTMLElement, changes };
}

test("a browser with customizable select support keeps the native control", async () => {
  const { container } = await mountSelect("browser");
  const select = container.querySelector("select.app-select")!;
  assert.equal(select.getAttribute("aria-label"), "Pick one");
  assert.equal(select.value, "b");
  assertNoElement(container, ".select-menu");
});

for (const [runtime, supportsPicker] of [["browser", false], ["macos", false], ["android", true]] as const) {
  test(`${runtime} uses the themed menu when it cannot use a reliable themed native popup`, async () => {
    const { container, window, changes } = await mountSelect(runtime, supportsPicker);
    assertNoElement(container, "select");
    const trigger = container.querySelector<HTMLButtonElement>(".select-menu button[aria-haspopup]")!;
    assert.ok(trigger, "a themed trigger replaces the select");
    assert.match(trigger.textContent ?? "", /Beta/);
    await act(async () => { trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    assert.deepEqual(options.map((option) => option.textContent), ["Alpha", "Beta", "Gamma (unavailable)"]);
    assert.equal(options[2]!.disabled, true, "a disabled option stays visible but cannot be chosen");
    await act(async () => { options[2]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    assert.deepEqual(changes, []);
    await act(async () => { options[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    assert.deepEqual(changes, ["a"]);
  });
}

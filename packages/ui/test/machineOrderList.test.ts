import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { after, afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ComponentType, ReactNode } from "react";
import { assertNoElement } from "./support/domAssert.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const ssr = createUiSsrHarness();
after(async () => ssr.close());
type ListProps = { machines: readonly string[]; onReorder: (order: readonly string[]) => void; renderActions: (machine: string) => ReactNode };

const ROW_HEIGHT = 40;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function mount(initial: readonly string[]) {
  const { MachineOrderList } = await ssr.loadModule<{ MachineOrderList: ComponentType<ListProps> }>("/src/MachineOrderList.tsx");
  const window = new Window({ url: "https://console.example.test" });
  const previous = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element, HTMLElement: globalThis.HTMLElement, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root: Root = createRoot(container);
  const reorders: string[][] = [];
  function Harness() {
    const [machines, setMachines] = useState(initial);
    return createElement(MachineOrderList, {
      machines,
      onReorder: (order: readonly string[]) => { reorders.push([...order]); setMachines(order); },
      renderActions: (name: string) => createElement("span", null, `color ${name}`),
    });
  }
  cleanups.push(async () => {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, { IS_REACT_ACT_ENVIRONMENT: previous.act });
    await window.happyDOM.close();
  });
  return { window, container, root, reorders, render: () => act(async () => root.render(createElement(Harness))) };
}

type Mounted = ReturnType<typeof mount>;
const rows = (m: Mounted) => [...m.container.querySelectorAll<HTMLElement>("[data-machine]")];
const names = (m: Mounted) => rows(m).map(row => row.dataset.machine);
// Layout is absent in the DOM stand-in: stack the rows so the pointer can hit a target row.
function layout(m: Mounted) {
  rows(m).forEach((row, index) => {
    row.getBoundingClientRect = () => ({ x: 0, y: index * ROW_HEIGHT, left: 0, right: 300, top: index * ROW_HEIGHT, bottom: (index + 1) * ROW_HEIGHT, width: 300, height: ROW_HEIGHT, toJSON() {} }) as DOMRect;
  });
}
function pointer(m: Mounted, type: string, target: Element, y: number, pointerType: string) {
  const event = new m.window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType, isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: 20, clientY: y });
  return act(async () => { target.dispatchEvent(event); });
}
const handle = (m: Mounted, name: string) => m.container.querySelector<HTMLElement>(`[data-machine="${name}"] [data-machine-handle]`)!;
const centre = (index: number) => index * ROW_HEIGHT + ROW_HEIGHT / 2;

for (const pointerType of ["mouse", "pen", "touch"]) {
  test(`dropping a dragged ${pointerType} handle on a target row reorders the list`, async () => {
    const m = await mount(["cedar", "mesa", "summit", "delta"]);
    await m.render(); layout(m);
    const grip = handle(m, "cedar");
    await pointer(m, "pointerdown", grip, centre(0), pointerType);
    await pointer(m, "pointermove", grip, centre(1), pointerType);
    await pointer(m, "pointermove", grip, centre(2), pointerType);
    assert.equal(m.container.querySelectorAll("[data-dragging]").length, 1, "only the dragged row is marked");
    assert.equal(m.container.querySelector("[data-dragging]")?.getAttribute("data-machine"), "cedar");
    assertNoElement(m.container, "[draggable]", "no native drag image is ever created");
    assert.deepEqual(m.reorders, [], "nothing is saved while the pointer is down");
    await pointer(m, "pointerup", grip, centre(2), pointerType);
    assert.deepEqual(m.reorders, [["mesa", "summit", "cedar", "delta"]]);
    assert.deepEqual(names(m), ["mesa", "summit", "cedar", "delta"]);
    assertNoElement(m.container, "[data-dragging]", "drag state clears");
  });
}

test("a move and the release in the same task save the order shown at the release position", async () => {
  const m = await mount(["cedar", "mesa", "summit"]);
  await m.render(); layout(m);
  const grip = handle(m, "cedar");
  await pointer(m, "pointerdown", grip, centre(0), "mouse");
  const event = (type: string, y: number) => new m.window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: 20, clientY: y });
  await act(async () => {
    grip.dispatchEvent(event("pointermove", centre(2)));
    grip.dispatchEvent(event("pointerup", centre(2)));
  });
  assert.deepEqual(m.reorders, [["mesa", "summit", "cedar"]]);
  assert.deepEqual(names(m), ["mesa", "summit", "cedar"]);
});

test("a cancelled drag, or a press without movement, saves nothing", async () => {
  const m = await mount(["cedar", "mesa", "summit"]);
  await m.render(); layout(m);
  const grip = handle(m, "mesa");
  await pointer(m, "pointerdown", grip, centre(1), "mouse");
  await pointer(m, "pointerup", grip, centre(1), "mouse");
  await pointer(m, "pointerdown", grip, centre(1), "mouse");
  await pointer(m, "pointermove", grip, centre(2), "mouse");
  await pointer(m, "pointercancel", grip, centre(2), "mouse");
  assert.deepEqual(m.reorders, []);
  assert.deepEqual(names(m), ["cedar", "mesa", "summit"]);
  assertNoElement(m.container, "[data-dragging]", "drag state clears");
});

test("up and down buttons reorder, are labelled per host and keep focus at the list ends", async () => {
  const m = await mount(["cedar", "mesa", "summit"]);
  await m.render();
  const button = (label: string) => m.container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
  assert.equal(button("Move cedar up").getAttribute("aria-disabled"), "true", "the first host cannot move up");
  assert.equal(button("Move summit down").getAttribute("aria-disabled"), "true", "the last host cannot move down");
  await act(async () => { button("Move mesa up").click(); });
  assert.deepEqual(names(m), ["mesa", "cedar", "summit"]);
  await act(async () => { button("Move cedar down").click(); });
  assert.deepEqual(names(m), ["mesa", "summit", "cedar"]);
  await act(async () => { button("Move mesa up").click(); });
  assert.deepEqual(m.reorders, [["mesa", "cedar", "summit"], ["mesa", "summit", "cedar"]], "a disabled end button does nothing");
  for (const element of m.container.querySelectorAll("button")) assert.notEqual(element.getAttribute("tabindex"), "-1", "every control is keyboard reachable");
});

test("the dragged row has an opaque surface, never the translucent panel behind it", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = css.match(/\.settings-machines \[data-dragging\] \{([^}]*)\}/)?.[1] ?? "";
  const background = rule.match(/background(?:-color)?:\s*var\((--[a-z-]+)\)/)?.[1];
  assert.ok(background, "the dragged row declares a background token");
  const definitions = [...css.matchAll(new RegExp(`${background}:\\s*([^;]+);`, "g"))].map(match => match[1]!.trim());
  assert.ok(definitions.length > 0);
  for (const value of definitions) assert.match(value, /^#[0-9a-fA-F]{6}$/, `${background} is an opaque colour`);
  assert.match(css, /\.machine-order-handle \{[^}]*touch-action: none/, "touch drags start from the handle instead of scrolling");
});

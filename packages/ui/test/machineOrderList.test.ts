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
type Role = { id: string; title: string };
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
const rows = (m: Mounted) => [...m.container.querySelectorAll<HTMLElement>("[data-reorder-key]")];
const names = (m: Mounted) => rows(m).map(row => row.dataset.reorderKey);
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
const handle = (m: Mounted, name: string) => m.container.querySelector<HTMLElement>(`[data-reorder-key="${name}"] [data-reorder-handle]`)!;
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
    assert.equal(m.container.querySelector("[data-dragging]")?.getAttribute("data-reorder-key"), "cedar");
    assertNoElement(m.container, "[draggable]", "no native drag image is ever created");
    assert.deepEqual(m.reorders, [], "nothing is saved while the pointer is down");
    await pointer(m, "pointerup", grip, centre(2), pointerType);
    assert.deepEqual(m.reorders, [["mesa", "summit", "cedar", "delta"]]);
    assert.deepEqual(names(m), ["mesa", "summit", "cedar", "delta"]);
    assertNoElement(m.container, "[data-dragging]", "drag state clears");
  });
}

// Rows with a visible gap between them, positioned by their current place in the list as real layout is.
const GAP = 8;
const PITCH = ROW_HEIGHT + GAP;
function layoutWithGaps(m: Mounted) {
  for (const row of rows(m)) {
    row.getBoundingClientRect = () => {
      const index = rows(m).indexOf(row);
      const top = index * PITCH;
      return { x: 0, y: top, left: 0, right: 300, top, bottom: top + ROW_HEIGHT, width: 300, height: ROW_HEIGHT, toJSON() {} } as DOMRect;
    };
  }
}
const belowRow = (index: number) => index * PITCH + ROW_HEIGHT + 1;
const rowCentre = (index: number) => index * PITCH + ROW_HEIGHT / 2;
const LIST = ["cedar", "mesa", "summit", "delta", "ember"];

// A mouse moves in small steps, so the pointer crosses every inter-row gap on the way.
async function dragThrough(m: Mounted, name: string, fromY: number, toY: number, release = true) {
  const grip = handle(m, name);
  await pointer(m, "pointerdown", grip, fromY, "mouse");
  const direction = toY > fromY ? 1 : -1;
  for (let y = fromY + direction * 3; direction * (toY - y) > 0; y += direction * 3) await pointer(m, "pointermove", grip, y, "mouse");
  await pointer(m, "pointermove", grip, toY, "mouse");
  if (release) await pointer(m, "pointerup", grip, toY, "mouse");
}

for (const [name, from, to] of [["cedar", 0, 1], ["cedar", 0, 3], ["mesa", 1, 4], ["ember", 4, 0], ["delta", 3, 1]] as const) {
  test(`a mouse drag across row gaps moves ${from + 1} to ${to + 1} to the slot under the release point`, async () => {
    const m = await mount(LIST);
    await m.render(); layoutWithGaps(m);
    await dragThrough(m, name, rowCentre(from), rowCentre(to));
    const expected = LIST.filter(host => host !== name);
    expected.splice(to, 0, name);
    assert.deepEqual(m.reorders, [expected]);
    assert.deepEqual(names(m), expected);
  });
}

test("holding the pointer over a gap mid-drag previews the nearest row slot, never the end of the list", async () => {
  const m = await mount(LIST);
  await m.render(); layoutWithGaps(m);
  await dragThrough(m, "cedar", rowCentre(0), belowRow(1), false);
  assert.equal(names(m).indexOf("cedar"), 1, "the preview stays at the slot beside the gap, not at the last slot");
  assert.deepEqual(m.reorders, [], "nothing is saved while the pointer is down");
});

test("releasing over a gap drops the row at the nearest slot", async () => {
  const m = await mount(LIST);
  await m.render(); layoutWithGaps(m);
  await dragThrough(m, "cedar", rowCentre(0), belowRow(1));
  assert.deepEqual(m.reorders, [["mesa", "cedar", "summit", "delta", "ember"]]);
});

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

test("a lost pointer capture does not end the drag, and the release over another element still saves it", async () => {
  const m = await mount(["cedar", "mesa", "summit"]);
  await m.render(); layout(m);
  const grip = handle(m, "cedar");
  await pointer(m, "pointerdown", grip, centre(0), "mouse");
  await pointer(m, "pointermove", grip, centre(1), "mouse");
  await act(async () => { grip.dispatchEvent(new m.window.PointerEvent("lostpointercapture", { bubbles: true, pointerId: 7 })); });
  const elsewhere = m.container.querySelector<HTMLElement>('[data-reorder-key="summit"] .settings-row-label')!;
  await pointer(m, "pointermove", elsewhere, centre(2), "mouse");
  await pointer(m, "pointerup", elsewhere, centre(2), "mouse");
  assert.deepEqual(m.reorders, [["mesa", "summit", "cedar"]]);
});

test("a pointercancel away from the handle leaves no drag state behind", async () => {
  const m = await mount(["cedar", "mesa", "summit"]);
  await m.render(); layout(m);
  const grip = handle(m, "cedar");
  const elsewhere = m.container.querySelector<HTMLElement>('[data-reorder-key="summit"] .settings-row-label')!;
  await pointer(m, "pointerdown", grip, centre(0), "mouse");
  await pointer(m, "pointermove", elsewhere, centre(2), "mouse");
  assert.equal(m.container.querySelectorAll("[data-dragging]").length, 1);
  await pointer(m, "pointercancel", elsewhere, centre(2), "mouse");
  assertNoElement(m.container, "[data-dragging]", "the preview clears");
  assert.deepEqual(names(m), ["cedar", "mesa", "summit"]);
  await pointer(m, "pointermove", elsewhere, centre(2), "mouse");
  await pointer(m, "pointerup", elsewhere, centre(2), "mouse");
  assertNoElement(m.container, "[data-dragging]", "later pointer events do not revive the drag");
  assert.deepEqual(m.reorders, [], "nothing is saved after a cancel");
});

test("ReorderList reorders arbitrary items by key and renders the restore slot after the list", async () => {
  const { ReorderList } = await ssr.loadModule<{ ReorderList: ComponentType<any> }>("/src/ReorderList.tsx");
  const window = new Window({ url: "https://console.example.test" });
  const previous = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element, HTMLElement: globalThis.HTMLElement, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root: Root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, { IS_REACT_ACT_ENVIRONMENT: previous.act });
    await window.happyDOM.close();
  });
  const saved: Role[][] = [];
  const roles: Role[] = [{ id: "plan", title: "Planner" }, { id: "build", title: "Builder" }];
  function Harness() {
    const [items, setItems] = useState(roles);
    return createElement(ReorderList, {
      items, itemKey: (role: Role) => role.id, renderLabel: (role: Role) => role.title, renderActions: (role: Role) => createElement("i", null, role.id),
      onReorder: (next: Role[]) => { saved.push(next); setItems(next); },
      restore: createElement("button", { id: "restore" }, "Restore defaults"),
    });
  }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => { container.querySelector<HTMLElement>('[aria-label="Move build up"]')!.click(); });
  assert.deepEqual(saved, [[roles[1], roles[0]]], "the callback receives the items, not their keys");
  assert.deepEqual([...container.querySelectorAll(".settings-row-label")].map(label => label.textContent), ["Builder", "Planner"]);
  assert.equal(container.lastElementChild?.id, "restore", "the restore slot follows the list");
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

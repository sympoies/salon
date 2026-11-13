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
function pointer(m: Mounted, type: string, target: Element, y: number, pointerType: string, pointerId = 7) {
  const event = new m.window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId, pointerType, isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: 20, clientY: y });
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

test("releasing in the lower half of a gap chooses the next row's slot", async () => {
  const m = await mount(LIST);
  await m.render(); layoutWithGaps(m);
  await dragThrough(m, "cedar", rowCentre(0), 2 * PITCH - 1);
  assert.equal(m.reorders.length, 1);
  assert.equal(m.reorders[0]?.join(","), "mesa,summit,cedar,delta,ember");
  assert.equal(names(m).join(","), "mesa,summit,cedar,delta,ember");
});

test("unequal-height previews keep targeting the slots read before the drag", async () => {
  const m = await mount(LIST);
  await m.render();
  // Moving the tall first row changes the boxes of the shorter rows before it.
  const height = (row: HTMLElement) => row.dataset.reorderKey === "cedar" ? 96 : ROW_HEIGHT;
  for (const row of rows(m)) {
    row.getBoundingClientRect = () => {
      const shown = rows(m);
      const top = shown.slice(0, shown.indexOf(row)).reduce((sum, item) => sum + height(item) + GAP, 0);
      return { x: 0, y: top, left: 0, right: 300, top, bottom: top + height(row), width: 300, height: height(row), toJSON() {} } as DOMRect;
    };
  }
  const grip = handle(m, "cedar");
  await pointer(m, "pointerdown", grip, 48, "mouse");
  await pointer(m, "pointermove", grip, 172, "mouse");
  assert.equal(names(m).join(","), "mesa,summit,cedar,delta,ember");
  assert.equal(rows(m)[0]!.getBoundingClientRect().top, 0, "preview geometry actually changes");
  await pointer(m, "pointermove", grip, 130, "mouse");
  assert.equal(names(m).join(","), "mesa,cedar,summit,delta,ember", "the original second slot still owns this coordinate");
  await pointer(m, "pointermove", grip, 172, "mouse");
  assert.equal(names(m).join(","), "mesa,summit,cedar,delta,ember", "returning to the original third slot is stable");
  assert.equal(m.reorders.length, 0);
  await pointer(m, "pointerup", grip, 172, "mouse");
  assert.equal(m.reorders.length, 1);
  assert.equal(m.reorders[0]?.join(","), "mesa,summit,cedar,delta,ember");
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
  const elsewhere = m.container.querySelector<HTMLElement>('[data-reorder-key="summit"] .reorder-row-label')!;
  await pointer(m, "pointermove", elsewhere, centre(2), "mouse");
  await pointer(m, "pointerup", elsewhere, centre(2), "mouse");
  assert.deepEqual(m.reorders, [["mesa", "summit", "cedar"]]);
});

test("a pointercancel away from the handle leaves no drag state behind", async () => {
  const m = await mount(["cedar", "mesa", "summit"]);
  await m.render(); layout(m);
  const grip = handle(m, "cedar");
  const elsewhere = m.container.querySelector<HTMLElement>('[data-reorder-key="summit"] .reorder-row-label')!;
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

// Counts the document listeners a drag holds: each add without a matching remove of the same function.
const DRAG_EVENTS = ["pointermove", "pointerup", "pointercancel"];
function trackDragListeners(m: Mounted) {
  const target = m.window.document;
  const active = new Set<string>();
  const key = (type: string, listener: unknown) => `${type}:${(listener as { id?: string }).id ??= `l${active.size}-${Math.random()}`}`;
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = ((type: string, listener: any, options?: any) => {
    if (DRAG_EVENTS.includes(type)) active.add(key(type, listener));
    return add(type, listener, options);
  }) as typeof target.addEventListener;
  target.removeEventListener = ((type: string, listener: any, options?: any) => {
    if (DRAG_EVENTS.includes(type)) active.delete(key(type, listener));
    return remove(type, listener, options);
  }) as typeof target.removeEventListener;
  return { count: () => active.size };
}
const press = (m: Mounted, target: Element, y: number, init: PointerEventInit) =>
  act(async () => { target.dispatchEvent(new m.window.PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", clientX: 20, clientY: y, ...init })); });

test("another pointer cannot move, release or cancel the active drag", async () => {
  const m = await mount(["cedar", "mesa", "summit"]);
  await m.render(); layout(m);
  const listeners = trackDragListeners(m);
  const grip = handle(m, "cedar");
  await pointer(m, "pointerdown", grip, centre(0), "touch");
  await pointer(m, "pointermove", grip, centre(2), "touch", 8);
  assertNoElement(m.container, "[data-dragging]", "another pointer cannot start the preview");
  await pointer(m, "pointermove", grip, centre(1), "touch");
  await pointer(m, "pointermove", grip, centre(2), "touch", 8);
  assert.equal(names(m).join(","), "mesa,cedar,summit", "another pointer cannot retarget the preview");
  for (const type of ["pointerup", "pointercancel"]) {
    await pointer(m, type, grip, centre(2), "touch", 8);
    assert.equal(m.reorders.length, 0, `${type} from another pointer cannot save`);
    assert.equal(listeners.count(), 3, `${type} from another pointer cannot detach the active drag`);
    assert.equal(m.container.querySelector("[data-dragging]")?.getAttribute("data-reorder-key"), "cedar");
  }
  await pointer(m, "pointerup", grip, centre(1), "touch");
  assert.equal(m.reorders.length, 1);
  assert.equal(m.reorders[0]?.join(","), "mesa,cedar,summit");
  assert.equal(listeners.count(), 0);
});

for (const direction of [-1, 1]) {
  test(`${direction > 0 ? "a downward" : "an upward"} drag starts at four pixels, not three`, async () => {
    const m = await mount(["cedar", "mesa", "summit"]);
    await m.render(); layout(m);
    const grip = handle(m, direction > 0 ? "cedar" : "mesa");
    // Straddle the slot boundary, so a premature drag would change the order.
    const start = ROW_HEIGHT - direction;
    await pointer(m, "pointerdown", grip, start, "mouse");
    await pointer(m, "pointermove", grip, start + direction * 3, "mouse");
    assertNoElement(m.container, "[data-dragging]", "three pixels remain a press");
    assert.equal(names(m).join(","), "cedar,mesa,summit");
    await pointer(m, "pointerup", grip, start + direction * 3, "mouse");
    assert.equal(m.reorders.length, 0, "releasing below the threshold saves nothing");
    await pointer(m, "pointerdown", grip, start, "mouse");
    await pointer(m, "pointermove", grip, start + direction * 4, "mouse");
    assert.equal(m.container.querySelectorAll("[data-dragging]").length, 1, "four pixels start the preview");
    assert.equal(names(m).join(","), "mesa,cedar,summit");
    await pointer(m, "pointerup", grip, start + direction * 4, "mouse");
    assert.equal(m.reorders.length, 1);
    assert.equal(m.reorders[0]?.join(","), "mesa,cedar,summit");
  });
}

test("the rendered list supplies the selectors styled by ReorderList.css", async () => {
  const m = await mount(["cedar", "mesa", "summit"]);
  await m.render(); layout(m);
  const grip = handle(m, "cedar");
  await pointer(m, "pointerdown", grip, centre(0), "mouse");
  await pointer(m, "pointermove", grip, centre(1), "mouse");
  const css = readFileSync(new URL("../src/ReorderList.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{[^}]*\}/g)];
  assert.ok(rules.length > 0, "the stylesheet has rules");
  for (const rule of rules) {
    for (const selector of rule[1]!.split(",")) {
      assert.ok(m.container.querySelectorAll(selector.trim()).length > 0, `${selector.trim()} styles rendered controls`);
    }
  }
});

test("a drag holds one pointer-move, release and cancel listener on the document and none after a release", async () => {
  const m = await mount(["cedar", "mesa", "summit"]);
  await m.render(); layout(m);
  const listeners = trackDragListeners(m);
  const grip = handle(m, "cedar");
  assert.equal(listeners.count(), 0, "an idle list holds no document listener");
  await pointer(m, "pointerdown", grip, centre(0), "mouse");
  assert.equal(listeners.count(), 3);
  await pointer(m, "pointermove", grip, centre(1), "mouse");
  assert.equal(listeners.count(), 3, "moving adds none");
  await pointer(m, "pointerup", grip, centre(1), "mouse");
  assert.equal(listeners.count(), 0);
});

test("a cancelled drag releases its document listeners", async () => {
  const m = await mount(["cedar", "mesa", "summit"]);
  await m.render(); layout(m);
  const listeners = trackDragListeners(m);
  const grip = handle(m, "cedar");
  await pointer(m, "pointerdown", grip, centre(0), "mouse");
  await pointer(m, "pointermove", grip, centre(1), "mouse");
  await pointer(m, "pointercancel", grip, centre(1), "mouse");
  assert.equal(listeners.count(), 0);
});

test("a second press during a drag replaces the first drag's document listeners", async () => {
  const m = await mount(["cedar", "mesa", "summit"]);
  await m.render(); layout(m);
  const listeners = trackDragListeners(m);
  await pointer(m, "pointerdown", handle(m, "cedar"), centre(0), "mouse");
  await pointer(m, "pointerdown", handle(m, "mesa"), centre(1), "mouse");
  assert.equal(listeners.count(), 3, "the first drag's listeners are removed, not stacked");
  await pointer(m, "pointerup", handle(m, "mesa"), centre(1), "mouse");
  assert.equal(listeners.count(), 0);
  assert.deepEqual(m.reorders, []);
});

test("unmounting mid-drag removes the document listeners and saves nothing", async () => {
  const m = await mount(["cedar", "mesa", "summit"]);
  await m.render(); layout(m);
  const listeners = trackDragListeners(m);
  const grip = handle(m, "cedar");
  await pointer(m, "pointerdown", grip, centre(0), "mouse");
  await pointer(m, "pointermove", grip, centre(2), "mouse");
  assert.equal(listeners.count(), 3);
  await act(async () => m.root.unmount());
  assert.equal(listeners.count(), 0);
  await act(async () => { m.window.document.dispatchEvent(new m.window.PointerEvent("pointerup", { pointerId: 7, isPrimary: true, button: 0, clientX: 20, clientY: centre(2) })); });
  assert.deepEqual(m.reorders, []);
});

for (const [label, init] of [["a secondary button", { isPrimary: true, button: 2, buttons: 2 }], ["a non-primary pointer", { isPrimary: false, button: 0, buttons: 1 }]] as const) {
  test(`${label} press on a handle does not start a drag`, async () => {
    const m = await mount(["cedar", "mesa", "summit"]);
    await m.render(); layout(m);
    const listeners = trackDragListeners(m);
    const grip = handle(m, "cedar");
    await press(m, grip, centre(0), init);
    assert.equal(listeners.count(), 0);
    await pointer(m, "pointermove", grip, centre(2), "mouse");
    assertNoElement(m.container, "[data-dragging]", "no preview starts");
    await pointer(m, "pointerup", grip, centre(2), "mouse");
    assert.deepEqual(m.reorders, []);
    assert.deepEqual(names(m), ["cedar", "mesa", "summit"]);
  });
}

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
  assert.deepEqual([...container.querySelectorAll(".reorder-row-label")].map(label => label.textContent), ["Builder", "Planner"]);
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
  const css = readFileSync(new URL("../src/ReorderList.css", import.meta.url), "utf8");
  const stylesheet = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = css.match(/\.reorder-list \[data-dragging\] \{([^}]*)\}/)?.[1] ?? "";
  const background = rule.match(/background(?:-color)?:\s*var\((--[a-z-]+)\)/)?.[1];
  assert.ok(background, "the dragged row declares a background token");
  const definitions = [...stylesheet.matchAll(new RegExp(`${background}:\\s*([^;]+);`, "g"))].map(match => match[1]!.trim());
  assert.ok(definitions.length > 0);
  for (const value of definitions) assert.match(value, /^#[0-9a-fA-F]{6}$/, `${background} is an opaque colour`);
  assert.match(css, /\.reorder-row \{[^}]*border: 1px solid var\(--border-subtle\);/, "rows use the soft hairline");
  assert.match(css, /\.reorder-handle \{[^}]*touch-action: none/, "touch drags start from the handle instead of scrolling");
});

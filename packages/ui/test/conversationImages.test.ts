import { assertActiveElement, assertNoElement } from "./support/domAssert.ts";
import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createUiSsrHarness } from "./support/ssr.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });
const imageId = (index: number) => `${"a".repeat(16)}.0.${index}.${"b".repeat(32)}`;

async function mountImages() {
  const window = new Window({ url: "http://localhost" });
  const saved = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT, fetch: globalThis.fetch };
  const requests: string[] = [];
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true, fetch: async (path: string) => {
      requests.push(path);
      return path.includes(`.${1}.`) ? new Response(JSON.stringify({ok:false,error:{code:"history-image-deleted"}}),{status:404})
        : new Response(new Uint8Array([137,80,78,71,13,10,26,10]),{headers:{"content-type":"image/png"}});
    } });
  const ssr = createUiSsrHarness();
  const root = createRoot(window.document.body.appendChild(window.document.createElement("div")));
  cleanups.push(async () => { await act(async () => root.unmount()); await ssr.close(); Object.assign(globalThis,saved); window.close(); });
  const { HistoryConversationView } = await ssr.loadModule<typeof import("../src/HistoryConversation.tsx")>("/src/HistoryConversation.tsx");
  const conversation = { session:{ id:"history",machine:"fixture",provider:"codex" },messages:[
    {id:"message",role:"user",text:"Look at these",images:[{id:imageId(0)},{id:imageId(1)}]}
  ],latestMessagePaging:true,loading:false,viewportRef:{current:null} };
  await act(async () => root.render(createElement(HistoryConversationView,{conversation:conversation as never,onJumpToLatest(){}})));
  return {window,requests};
}

test("conversation images show thumbnails and deleted state, with a message-scoped viewer",async () => {
  const {window,requests} = await mountImages();
  const thumbnail = window.document.querySelector<HTMLButtonElement>('[aria-label="Open image 1"]');
  assert.ok(thumbnail,"history renders an inline thumbnail button");
  assert.ok(Boolean(thumbnail.querySelector("img")));
  assert.match(window.document.body.textContent ?? "",/Image deleted/);
  await act(async () => thumbnail.click());
  const viewer = window.document.querySelector('[role="dialog"][aria-label="Conversation images"]');
  assert.ok(viewer,"thumbnail opens the full-screen viewer");
  assert.ok(Boolean(viewer.querySelector("img")));
  const zoom = window.document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;
  await act(async () => zoom.click());
  assert.match(viewer.querySelector<HTMLElement>(".conversation-image-canvas")!.style.transform,/scale\(1.5\)/);
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Fit image"]')!.click());
  const stage = viewer.querySelector(".conversation-image-stage")!;
  const wheel = new window.WheelEvent("wheel",{deltaY:-100,bubbles:true,cancelable:true});
  await act(async () => stage.dispatchEvent(wheel));
  assert.equal(wheel.defaultPrevented,true);
  assert.doesNotMatch(viewer.querySelector<HTMLElement>(".conversation-image-canvas")!.style.transform,/scale\(1\)/);
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Fit image"]')!.click());
  await act(async () => {
    stage.dispatchEvent(new window.PointerEvent("pointerdown",{pointerId:1,clientX:200,clientY:100,bubbles:true}));
    stage.dispatchEvent(new window.PointerEvent("pointermove",{pointerId:1,clientX:195,clientY:200,bubbles:true}));
    stage.dispatchEvent(new window.PointerEvent("pointerup",{pointerId:1,clientX:195,clientY:200,bubbles:true}));
  });
  assert.match(viewer.textContent ?? "",/1 \/ 2/,"vertical drag does not navigate");
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click());
  assert.match(viewer.textContent ?? "",/Image deleted/);
  assertNoElement(viewer,"img");
  await act(async () => viewer.dispatchEvent(new window.KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  assertNoElement(window.document,'[role="dialog"]');
  assert.ok(requests.every(path => path.startsWith("/api/history/sessions/fixture/history/images/")));
});


test("image-only messages survive the HTTP client normalizer",async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ok:true,data:{messages:[{
    id:"only-image",role:"user",text:"",images:[{id:imageId(0),path:"/private"}]
  }]}}))) as typeof fetch;
  const ssr = createUiSsrHarness();
  try {
    const {listHistoryMessages} = await ssr.loadModule<typeof import("../src/api.ts")>("/src/api.ts");
    const result = await listHistoryMessages("fixture","history");
    assert.deepEqual(result.messages,[{id:"only-image",role:"user",text:"",images:[{id:imageId(0)}]}]);
  } finally { await ssr.close(); globalThis.fetch = previous; }
});

test("native Back closes only the image viewer",async () => {
  const {window} = await mountImages();
  Object.defineProperty(window,"__TAURI__",{value:{},configurable:true});
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Open image 1"]')!.click());
  assert.equal(window.history.state.agentConsoleBack,"conversation-images");
  await act(async () => window.dispatchEvent(new window.PopStateEvent("popstate",{state:null})));
  assertNoElement(window.document,'[aria-label="Conversation images"]');
  assert.ok(Boolean(window.document.querySelector(".history-message")));
});

test("pinch zoom does not navigate; a horizontal swipe and outside tap work",async () => {
  const {window} = await mountImages();
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Open image 1"]')!.click());
  const viewer = window.document.querySelector('[aria-label="Conversation images"]')!;
  const stage = viewer.querySelector(".conversation-image-stage")!;
  const pointer = (type: string,id: number,x: number,y=100) => stage.dispatchEvent(new window.PointerEvent(type,{pointerId:id,clientX:x,clientY:y,bubbles:true}));
  await act(async () => {
    pointer("pointerdown",1,100);pointer("pointerdown",2,200);
    pointer("pointermove",2,300);pointer("pointerup",1,100);pointer("pointerup",2,300);
  });
  assert.match(viewer.querySelector<HTMLElement>(".conversation-image-canvas")!.style.transform,/scale\(2\)/);
  assert.match(viewer.textContent ?? "",/1 \/ 2/);
  await act(async () => { pointer("pointerdown",1,100);pointer("pointermove",1,150);pointer("pointerup",1,150); });
  assert.match(viewer.querySelector<HTMLElement>(".conversation-image-canvas")!.style.transform,/translate\(50px, 0px\)/);
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Fit image"]')!.click());
  await act(async () => { pointer("pointerdown",1,300);pointer("pointermove",1,200);pointer("pointerup",1,200); });
  assert.match(viewer.textContent ?? "",/2 \/ 2/);
  assert.match(viewer.textContent ?? "",/Image deleted/);
  await act(async () => {
    pointer("pointerdown",1,10);pointer("pointerup",1,10);
    stage.dispatchEvent(new window.MouseEvent("click",{bubbles:true}));
  });
  assertNoElement(window.document,'[aria-label="Conversation images"]');
});


test("decode failure immediately releases its object URL exactly once",async () => {
  const previous = URL.revokeObjectURL;
  const revoked: string[] = [];
  URL.revokeObjectURL = url => { revoked.push(url); previous(url); };
  cleanups.push(() => { URL.revokeObjectURL = previous; });
  const {window} = await mountImages();
  const thumbnail = window.document.querySelector('[aria-label="Open image 1"]')!;
  const img = thumbnail.querySelector("img")!;
  const url = img.src;
  await act(async () => img.dispatchEvent(new window.Event("error")));
  assert.match(thumbnail.textContent ?? "",/Image unavailable/);
  assert.deepEqual(revoked,[url],"decode failure releases the blob before unmount");
  await cleanups.pop()?.();
  assert.deepEqual(revoked,[url],"unmount does not release the failed URL twice");
});


test("navigation keeps keyboard focus inside the viewer when the selected arrow becomes disabled",async () => {
  const {window} = await mountImages();
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Open image 1"]')!.click());
  const viewer = window.document.querySelector('[aria-label="Conversation images"]')!;
  const next = viewer.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!;
  next.focus();
  await act(async () => next.click());
  assert.equal(next.disabled,true);
  assertActiveElement(window,viewer,"keyboard navigation stays in the dialog after reaching its last image");
  await act(async () => window.document.activeElement!.dispatchEvent(new window.KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true})));
  assert.match(viewer.textContent ?? "",/1 \/ 2/);
  await act(async () => window.document.activeElement!.dispatchEvent(new window.KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  assertNoElement(window.document,'[aria-label="Conversation images"]');
});

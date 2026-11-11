import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { assertNoElement } from "./support/domAssert.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const imageId = (index: number) => `${"a".repeat(16)}.0.${index}.${"b".repeat(32)}`;
const response = () => new Response(new Uint8Array([137,80,78,71]), {headers:{"content-type":"image/png"}});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

interface ObserverRecord { readonly observed: unknown[]; disconnects: number }

async function mount(t: TestContext, count: number, fetchImage: (path: string) => Promise<Response>, observe = false, beforeRender?: (cache: typeof import("../src/conversationImageCache.ts").conversationImageCache) => Promise<void>) {
  const window = new Window({url:"http://localhost"});
  const previous = {window:globalThis.window,document:globalThis.document,HTMLElement:globalThis.HTMLElement,
    IntersectionObserver:globalThis.IntersectionObserver,fetch:globalThis.fetch,IS_REACT_ACT_ENVIRONMENT:globalThis.IS_REACT_ACT_ENVIRONMENT};
  const observers: Array<(visible: boolean) => void> = [];
  const instances: ObserverRecord[] = [];
  Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,fetch:fetchImage,IS_REACT_ACT_ENVIRONMENT:true,
    // Records calls only. It never invokes the callback itself; a test triggers visibility through `observers`.
    IntersectionObserver:observe ? class {
      readonly record: ObserverRecord = {observed:[],disconnects:0};
      constructor(callback: (entries: Array<{isIntersecting:boolean}>) => void) {
        observers.push(visible => callback([{isIntersecting:visible}]));
        instances.push(this.record);
      }
      observe(element: unknown) { this.record.observed.push(element); }
      disconnect() { this.record.disconnects++; }
    } : undefined});
  const ssr = createUiSsrHarness();
  const root = createRoot(window.document.body.appendChild(window.document.createElement("div")));
  let mounted = true;
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } };
  t.after(async () => { await unmount(); await ssr.close(); Object.assign(globalThis,previous); window.close(); });
  const {ConversationImages} = await ssr.loadModule<typeof import("../src/ConversationImages.tsx")>("/src/ConversationImages.tsx");
  const {conversationImageCache: cache} = await ssr.loadModule<typeof import("../src/conversationImageCache.ts")>("/src/conversationImageCache.ts");
  await beforeRender?.(cache);
  await act(async () => { root.render(createElement(ConversationImages,{machine:"fixture",history:"history",images:Array.from({length:count},(_,i) => ({id:imageId(i)}))})); });
  const visibility = async (visible: boolean, index = 0) => { await act(async () => { observers[index]!(visible); await flush(); }); };
  return {window,visibility,observers,instances,cache,unmount};
}

test("loaded image survives leaving and reentering the viewport and the viewer reuses it",async t => {
  let requests = 0;
  const {window,visibility} = await mount(t,1,async () => { requests++; return response(); },true);
  await visibility(true);
  const thumbnail = window.document.querySelector<HTMLButtonElement>(".conversation-image-thumbnail")!;
  const url = thumbnail.querySelector("img")?.src;
  assert.ok(url);
  await visibility(false);
  assert.equal(thumbnail.querySelector("img")?.src,url,"scrolling away keeps the loaded image visible");
  assert.equal(Boolean(thumbnail.querySelector("[role=status]")),false);
  await visibility(true);
  await act(async () => thumbnail.click());
  assert.equal(window.document.querySelector<HTMLImageElement>(".conversation-image-canvas img")?.src,url);
  assert.equal(requests,1,"scrolling back and opening the viewer reuse the loaded bytes");
});

test("a request timeout is retryable instead of being reported as unavailable",async t => {
  let requests = 0;
  const {window} = await mount(t,1,async () => {
    if (++requests === 1) throw new DOMException("Request timed out","TimeoutError");
    return response();
  });
  assert.match(window.document.body.textContent ?? "",/Couldn't load/);
  assert.doesNotMatch(window.document.body.textContent ?? "",/Image unavailable/);
  const retry = [...window.document.querySelectorAll("button")].find(button => button.textContent === "Retry");
  assert.ok(retry);
  await act(async () => { retry.click(); await flush(); });
  assert.equal(requests,2);
  assert.ok(window.document.querySelector(".conversation-image-thumbnail img"));
  assert.equal(Boolean(window.document.querySelector('[role="dialog"]')),false,"Retry does not open the viewer");
});

test("twelve images never send more than three concurrent requests",async t => {
  const pending: Array<() => void> = [];
  let active = 0, maximum = 0, started = 0;
  const {window} = await mount(t,12,() => new Promise(resolve => {
    active++; started++; maximum = Math.max(maximum,active);
    pending.push(() => { active--; resolve(response()); });
  }));
  assert.equal(started,3,"later images wait in the loading queue");
  assert.equal(window.document.querySelectorAll("[role=status]").length,12);
  while (pending.length) await act(async () => { pending.shift()!(); await flush(); });
  assert.equal(started,12);
  assert.equal(maximum,3);
  assert.equal(window.document.querySelectorAll(".conversation-image-thumbnail img").length,12);
});

test("a frame that first renders as an external tile is observed after a cache clear returns it to loading",async t => {
  let permanent = true;
  const refuse = (path: string) => path.includes("/remote-image/")
    ? new Response(JSON.stringify({error:{code:"remote-image-unavailable",reason:"not-image"}}),{status:422})
    : new Response(JSON.stringify({error:{code:"history-image-unavailable",reason:"remote-url-not-fetched"}}),{status:422});
  const {window,visibility,observers,cache} = await mount(t,1,async path => permanent ? refuse(path) : response(),true,async cache => {
    const handle = cache.watch({machine:"fixture",history:"history",image:imageId(0)},() => {});
    t.after(() => handle.unsubscribe());
    handle.setVisible(true); await flush();
    assert.equal(cache.peek({machine:"fixture",history:"history",image:imageId(0)}).state,"unavailable");
  });
  assert.ok(window.document.querySelector(".is-external"),"the first render is the external tile");
  assert.equal(observers.length,0);
  permanent = false;
  await act(async () => { cache.clear(); await flush(); });
  assertNoElement(window.document,".is-external");
  assert.equal(observers.length,1,"the returning thumbnail is observed");
  await visibility(true);
  assert.ok(window.document.querySelector(".conversation-image-thumbnail img"));
});

test("each thumbnail frame is observed once and disconnected across a branch swap and unmount",async t => {
  const target = {machine:"fixture",history:"history",image:imageId(0)};
  const {window,instances,cache,unmount} = await mount(t,1,async () => response(),true);
  const frame = () => window.document.querySelector(".conversation-image-thumbnail:not(.is-external)");
  assert.equal(instances.length,1);
  // Compare by identity: a failed deepEqual would serialize the whole DOM graph.
  assert.ok(instances[0]!.observed.length === 1 && instances[0]!.observed[0] === frame(),"the rendered frame element is observed");
  assert.equal(instances[0]!.disconnects,0);
  const handle = cache.watch(target,() => {});
  t.after(() => handle.unsubscribe());
  await act(async () => { handle.update({state:"unavailable",reason:"remote-url-not-fetched"}); await flush(); });
  assert.ok(window.document.querySelector(".is-external"));
  assert.equal(instances[0]!.disconnects,1,"the frame replaced by the external tile is disconnected");
  assert.equal(instances.length,1,"the external tile has no frame to observe");
  await act(async () => { cache.clear(); await flush(); });
  assertNoElement(window.document,".is-external");
  assert.equal(instances.length,2);
  assert.ok(instances[1]!.observed.length === 1 && instances[1]!.observed[0] === frame(),"the returning frame is observed");
  assert.equal(instances[1]!.disconnects,0);
  await unmount();
  assert.equal(instances.length,2,"detaching a frame never creates an observer");
  assert.deepEqual(instances.map(instance => instance.disconnects),[1,1]);
  assert.ok(instances.every(instance => instance.observed.length === 1 && instance.observed[0]),"no observe call without an element");
});

test("an error tile without a reason offers Retry and no reason text",async t => {
  const {window} = await mount(t,1,async () => new Response("",{status:503}));
  const tile = window.document.querySelector(".conversation-image-thumbnail")!;
  assert.equal(tile.querySelector("[role=status]")?.textContent,"Couldn't load");
  assert.ok([...window.document.querySelectorAll("button")].some(button => button.textContent === "Retry"));
});

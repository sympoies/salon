import { assertActiveElement, assertNoElement } from "./support/domAssert.ts";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createUiSsrHarness } from "./support/ssr.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });
const imageId = (index: number) => `${"a".repeat(16)}.0.${index}.${"b".repeat(32)}`;

async function mountImages(responseFor?: (path: string) => Response, nested = false,
  images: Array<{id:string}> = [{id:imageId(0)},{id:imageId(1)}], messages?: unknown[], uploadSessionId?: string) {
  const window = new Window({ url: "http://localhost" });
  const saved = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT, fetch: globalThis.fetch };
  const requests: string[] = [];
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true, fetch: async (path: string) => {
      requests.push(path);
      if (responseFor) return responseFor(path);
      return path.includes(`.${1}.`) ? new Response(JSON.stringify({ok:false,error:{code:"history-image-deleted"}}),{status:404})
        : new Response(new Uint8Array([137,80,78,71,13,10,26,10]),{headers:{"content-type":"image/png"}});
    } });
  const ssr = createUiSsrHarness();
  const root = createRoot(window.document.body.appendChild(window.document.createElement("div")));
  cleanups.push(async () => { await act(async () => root.unmount()); await ssr.close(); Object.assign(globalThis,saved); window.close(); });
  const { HistoryConversationView } = await ssr.loadModule<typeof import("../src/HistoryConversation.tsx")>("/src/HistoryConversation.tsx");
  const conversation = { session:{ id:"history",machine:"fixture",provider:"codex" },messages:messages ?? [
    {id:"message",role:"user",text:"Look at these",images}
  ],latestMessagePaging:true,loading:false,viewportRef:{current:null} };
  const content = createElement(HistoryConversationView,{conversation:conversation as never,onJumpToLatest(){},...(uploadSessionId ? {uploadSessionId} : {})});
  const { Modal } = await ssr.loadModule<typeof import("../src/Modal.tsx")>("/src/Modal.tsx");
  await act(async () => root.render(nested ? createElement(Modal,{onClose(){},ariaLabel:"Conversation panel",children:content}) : content));
  return {window,requests};
}

test("conversation UI requests images through the opaque quoted-upload selector",async () => {
  const id = `${"a".repeat(16)}.0.u0-0.${"b".repeat(32)}`;
  const {window,requests} = await mountImages(undefined,false,[{id}]);
  await act(async () => {
    window.document.querySelector<HTMLButtonElement>('[aria-label="Open image 1"]')!.click();
    await new Promise(resolve => setTimeout(resolve,0));
  });
  assert.ok(requests.some(path => path === `/api/history/sessions/fixture/history/images/${id}`));
});

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

test("Tab in the image viewer stays above the parent conversation modal",async () => {
  const {window} = await mountImages(undefined,true);
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Open image 1"]')!.click());
  const fit = window.document.querySelector<HTMLButtonElement>('[aria-label="Fit image"]')!;
  fit.focus();
  await act(async () => fit.dispatchEvent(new window.KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true})));
  assertActiveElement(window,fit,"the parent modal must not steal focus before the browser advances Tab inside the viewer");
  await act(async () => fit.dispatchEvent(new window.KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  assertNoElement(window.document,'[aria-label="Conversation images"]');
  assert.ok(window.document.querySelector('[aria-label="Conversation panel"]'));
});

test("download reauthenticates the selected image and saves its exact original bytes and filename",async () => {
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array([137,80,78,71,13,10,26,10]);
  const {window,requests} = await mountImages(() => new Response(bytes,{headers:{"content-type":"image/png","content-disposition":"inline; filename*=UTF-8''original%20plot.png"}}));
  const downloads: Array<{name:string;bytes:Uint8Array}> = [];
  window.HTMLAnchorElement.prototype.click = function () {
    const name = this.download;
    void originalFetch(this.href).then(response => response.arrayBuffer()).then(buffer => downloads.push({name,bytes:new Uint8Array(buffer)}));
  };
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Open image 1"]')!.click());
  const count = requests.length;
  const button = window.document.querySelector<HTMLButtonElement>('[aria-label="Download image"]');
  assert.ok(button,"viewer exposes download");
  await act(async () => button.click());
  assert.equal(requests.length,count + 1,"download uses a fresh authenticated read rather than stale preview bytes");
  assert.deepEqual(downloads,[{name:"original plot.png",bytes}]);
});

test("download derives a safe filename from the validated image MIME when upstream omits one",async () => {
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array([137,80,78,71,13,10,26,10]);
  const {window} = await mountImages(() => new Response(bytes,{headers:{"content-type":"image/png"}}));
  const downloads: Array<{name:string;bytes:Uint8Array}> = [];
  window.HTMLAnchorElement.prototype.click = function () {
    const name = this.download;
    void originalFetch(this.href).then(response => response.arrayBuffer()).then(buffer => downloads.push({name,bytes:new Uint8Array(buffer)}));
  };
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Open image 1"]')!.click());
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Download image"]')!.click());
  assert.deepEqual(downloads,[{name:"image-bbbbbb.png",bytes}]);
});

test("a transient Download failure preserves the shared preview and viewer",async () => {
  let failDownload = false;
  const {window,requests} = await mountImages(() => failDownload
    ? new Response("",{status:503})
    : new Response(new Uint8Array([137,80,78,71]),{headers:{"content-type":"image/png"}}),false,[{id:imageId(0)}]);
  const thumbnail = window.document.querySelector('[aria-label="Open image 1"]')!;
  const url = thumbnail.querySelector("img")?.src;
  assert.ok(url);
  await act(async () => thumbnail.dispatchEvent(new window.MouseEvent("click",{bubbles:true})));
  const count = requests.length;
  failDownload = true;
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Download image"]')!.click());
  assert.equal(thumbnail.querySelector("img")?.src,url,"a transient save error retains the loaded thumbnail URL");
  const viewer = window.document.querySelector('[aria-label="Conversation images"]')!;
  assert.equal(viewer.querySelector("img")?.src,url);
  assert.match(viewer.textContent ?? "",/Image could not be saved/);
  assert.equal(requests.length,count + 1,"only the fresh authenticated download is sent, with no preview refetch");
});

for (const status of [401,404]) test(`download does not save after image read returns ${status}`,async () => {
  let unavailable = false;
  const {window} = await mountImages(() => unavailable
    ? new Response(JSON.stringify({error:{code:status === 404 ? "history-image-deleted" : "unauthorized"}}),{status})
    : new Response(new Uint8Array([137,80,78,71]),{headers:{"content-type":"image/png"}}));
  let downloaded = false;
  window.HTMLAnchorElement.prototype.click = () => { downloaded = true; };
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Open image 1"]')!.click());
  unavailable = true;
  const button = window.document.querySelector<HTMLButtonElement>('[aria-label="Download image"]');
  assert.ok(button,"viewer exposes download");
  await act(async () => button.click());
  assert.equal(downloaded,false);
  assert.match(window.document.querySelector('[aria-label="Conversation images"]')!.textContent ?? "",status === 404 ? /Image deleted/ : /Image unavailable/);
  assert.equal(button.disabled,true);
});

for (const status of ["saved","cancelled","failed"]) test(`Android image save hands original bytes to the native picker and handles ${status}`,async () => {
  const bytes = new Uint8Array([137,80,78,71]);
  const {window} = await mountImages(() => new Response(bytes,{headers:{"content-type":"image/png"}}));
  Object.defineProperty(window,"__TAURI__",{value:{},configurable:true});
  Object.defineProperty(window.navigator,"userAgent",{value:"Android",configurable:true});
  // Authentication is tested above; this test begins after that read and
  // exercises the native save boundary without reaching a real device.
  const ssr = createUiSsrHarness();
  cleanups.push(() => ssr.close());
  const {saveConversationImage} = await ssr.loadModule<typeof import("../src/saveConversationImage.ts")>("/src/saveConversationImage.ts");
  let received: unknown;
  Object.assign(window,{agentConsoleAndroidImageSave:{save(id: string,name: string,mime: string,base64: string) {
    received = {name,mime,bytes:new Uint8Array(Buffer.from(base64,"base64"))};
    window.dispatchEvent(new window.CustomEvent("agent-console-image-save",{detail:{id,status}}));
  }}});
  const saving = saveConversationImage(new Blob([bytes],{type:"image/png"}),"image-bbbbbb.png","blob:unused");
  if (status === "failed") await assert.rejects(saving,/Image save failed/);
  else await saving;
  assert.deepEqual(received,{name:"image-bbbbbb.png",mime:"image/png",bytes});
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

test("the image viewer suppresses the native context menu on its image and surface",async () => {
  const {window} = await mountImages();
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Open image 1"]')!.click());
  const viewer = window.document.querySelector('[aria-label="Conversation images"]')!;
  for (const target of [viewer.querySelector("img")!,viewer.querySelector(".conversation-image-stage")!]) {
    const event = new window.MouseEvent("contextmenu",{bubbles:true,cancelable:true});
    await act(async () => { target.dispatchEvent(event); });
    assert.equal(event.defaultPrevented,true);
  }
  assertNoElement(window.document,'[role="menu"]');
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
  assert.match(thumbnail.textContent ?? "",/Couldn't load/);
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

const attachment = (index: number, ref?: string, origin?: string) =>
  ({id:imageId(index),...(origin ? {origin} : {}),...(ref ? {attachment_ref:ref} : {})});
const mountMessages = (messages: unknown[]) => mountImages(undefined,false,[],messages);
const articles = (window: Window) => [...window.document.querySelectorAll("article")];

test("a user attachment stays in the user bubble", async () => {
  const {window} = await mountMessages([{id:"u",role:"user",text:"Look",images:[attachment(0,"up-1","user_attachment")]}]);
  const [user] = articles(window);
  assert.ok(user!.classList.contains("is-user"));
  assert.ok(user!.querySelector(".history-bubble .conversation-image-thumbnail"));
  assertNoElement(user!,".history-tool-output");
});

test("a tool re-read of a shown user attachment collapses to one line", async () => {
  const {window,requests} = await mountMessages([
    {id:"u",role:"user",text:"Look",images:[attachment(0,"up-1","user_attachment")]},
    {id:"t",role:"user",text:"",images:[attachment(1,"up-1","tool_result")]},
  ]);
  const [, tool] = articles(window);
  assert.equal(tool!.querySelectorAll(".conversation-image-thumbnail").length,0);
  assert.match(tool!.textContent ?? "",/Read attachment/);
  assert.equal(window.document.querySelectorAll(".conversation-image-thumbnail").length,1);
  assert.ok(!requests.some(path => path.includes(imageId(1))),"collapsed re-read is not fetched");
});

test("a tool image without a shown matching attachment is labelled tool output", async () => {
  for (const messages of [
    [{id:"t",role:"user",text:"",images:[attachment(1,"up-9","tool_result")]}],
    [{id:"u",role:"user",text:"Look",images:[attachment(0,"up-1","user_attachment")]},
     {id:"t",role:"assistant",text:"",images:[attachment(1,undefined,"tool_result")]}],
    [{id:"t",role:"assistant",text:"",images:[attachment(1,"up-1","tool_result")]},
     {id:"u",role:"user",text:"Look",images:[attachment(0,"up-1","user_attachment")]}],
  ]) {
    const {window} = await mountMessages(messages);
    const tool = articles(window).find(article => article.getAttribute("data-history-message-id") === "t")!;
    assert.match(tool.querySelector(".history-tool-output")?.textContent ?? "",/Tool output/);
    assert.equal(tool.querySelectorAll(".history-tool-output .conversation-image-thumbnail").length,1);
    assertNoElement(tool,".history-bubble .conversation-image-thumbnail");
    assert.doesNotMatch(tool.textContent ?? "",/Read attachment/);
  }
});

test("images without provenance render in the bubble as before", async () => {
  const {window} = await mountMessages([
    {id:"a",role:"assistant",text:"Chart",images:[attachment(0)]},
    {id:"b",role:"user",text:"Odd",images:[{...attachment(1,"up-1"),origin:"unknown"}]},
  ]);
  for (const article of articles(window)) {
    assert.equal(article.querySelectorAll(".history-bubble .conversation-image-thumbnail").length,1);
    assertNoElement(article,".history-tool-output");
  }
});

// macOS image context menu (#237)
const PNG = new Uint8Array([137,80,78,71,13,10,26,10]);
const pngResponse = (name?: string, mime = "image/png") => new Response(PNG,{headers:{"content-type":mime,...(name ? {"content-disposition":`inline; filename="${name}"`} : {})}});

async function macMenu(options: {name?: string; text?: string; owner?: string; saveFails?: boolean; mime?: string; images?: Array<{id:string}>; index?: number} = {}) {
  const id = imageId(0);
  const {window} = await mountImages(() => pngResponse(options.name,options.mime),false,[{id}],[
    {id:"message",role:"user",text:options.text ?? "Look at this",images:options.images ?? [{id}]},
  ],options.owner);
  const invoked: Array<[string,unknown]> = [];
  const written: Array<{type: string}[]> = [];
  Object.assign(window,{__TAURI_INTERNALS__:{async invoke(command: string,args: unknown) {
    invoked.push([command,args]);
    if (command === "save_conversation_image" && options.saveFails) throw new Error("denied");
  }}});
  Object.defineProperty(window,"__TAURI__",{value:{},configurable:true});
  class FakeClipboardItem { items: Record<string,Blob>; constructor(items: Record<string,Blob>) { this.items = items; } }
  Object.assign(globalThis,{ClipboardItem:FakeClipboardItem});
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis,"navigator");
  cleanups.push(() => { if (previousNavigator) Object.defineProperty(globalThis,"navigator",previousNavigator); else Reflect.deleteProperty(globalThis,"navigator"); });
  Object.defineProperty(globalThis,"navigator",{configurable:true,value:{userAgent:window.navigator.userAgent,clipboard:{async write(items: FakeClipboardItem[]) { written.push(items.map(item => ({type:Object.keys(item.items)[0]!}))); }}}});
  const thumbnail = window.document.querySelector<HTMLButtonElement>(`[aria-label="Open image ${(options.index ?? 0) + 1}"]`)!;
  const event = new window.MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:20,clientY:30});
  await act(async () => { thumbnail.dispatchEvent(event); });
  const menu = () => window.document.querySelector<HTMLElement>('[role="menu"]');
  const items = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].map(item => item.textContent);
  const choose = (label: string) => act(async () => {
    [...menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === label)!.click();
    await new Promise(resolve => setTimeout(resolve,0));
  });
  return {window,event,menu,items,choose,invoked,written};
}

test("the browser keeps its native image menu",async () => {
  const {window} = await mountImages(() => pngResponse());
  const event = new window.MouseEvent("contextmenu",{bubbles:true,cancelable:true});
  await act(async () => { window.document.querySelector('[aria-label="Open image 1"]')!.dispatchEvent(event); });
  assert.equal(event.defaultPrevented,false);
  assertNoElement(window.document,'[role="menu"]');
});

test("the macOS app replaces the native image menu with working actions",async () => {
  const {event,items,menu} = await macMenu();
  assert.equal(event.defaultPrevented,true);
  assert.deepEqual(items(),["Copy image","Save image","Open in image viewer"]);
  assert.ok(menu());
});

test("each macOS image menu item runs its action and closes the menu",async () => {
  const saved = await macMenu({name:"plot.png"});
  await saved.choose("Save image");
  assert.deepEqual(saved.invoked.filter(([command]) => command === "save_conversation_image").map(([,args]) => (args as {name:string;mime:string}).name + " " + (args as {mime:string}).mime),["plot.png image/png"]);
  assertNoElement(saved.window.document,'[role="menu"]');
  const copied = await macMenu();
  await copied.choose("Copy image");
  assert.deepEqual(copied.written,[[{type:"image/png"}]]);
  const opened = await macMenu();
  await opened.choose("Open in image viewer");
  assert.ok(opened.window.document.querySelector('[role="dialog"][aria-label="Conversation images"]'));
});

test("copying a JPEG starts the clipboard write inside the click, before conversion finishes",async () => {
  // WebKit rejects a clipboard write started after an await; the PNG
  // conversion therefore travels as a pending item value.
  Object.assign(globalThis,{createImageBitmap: () => new Promise(() => {})});
  cleanups.push(() => { Reflect.deleteProperty(globalThis,"createImageBitmap"); });
  const jpeg = await macMenu({mime:"image/jpeg"});
  await jpeg.choose("Copy image");
  assert.deepEqual(jpeg.written,[[{type:"image/png"}]],"the write began while the conversion was still pending");
});

test("a failed macOS image save or copy shows visible feedback",async () => {
  const failed = await macMenu({saveFails:true});
  await failed.choose("Save image");
  assert.match(failed.window.document.querySelector('.conversation-images [role="status"].conversation-image-menu-error')?.textContent ?? "",/Image could not be saved/);
});

test("Copy file path copies the exact upload path only for a known attached image",async () => {
  const path = "/state/sessions/s-1/attachments/shot.png";
  const known = await macMenu({name:"shot.png",text:`look\n'${path}'`,owner:"s-1"});
  assert.deepEqual(known.items(),["Copy image","Save image","Open in image viewer","Copy file path"]);
  await known.choose("Copy file path");
  assert.deepEqual(known.invoked.filter(([command]) => command === "write_macos_clipboard_text"),[["write_macos_clipboard_text",{text:path}]]);
  const otherName = await macMenu({name:"other.png",text:`'${path}'`,owner:"s-1"});
  assert.ok(!otherName.items().includes("Copy file path"),"a path for a different file is not offered");
  const foreign = await macMenu({name:"shot.png",text:`'/state/sessions/s-2/attachments/shot.png'`,owner:"s-1"});
  assert.ok(!foreign.items().includes("Copy file path"),"another session's upload is not offered");
  const none = await macMenu({name:"shot.png",text:"no path here",owner:"s-1"});
  assert.ok(!none.items().includes("Copy file path"),"an image without a known path does not offer it");
});

test("outgoing upload paths without selectors use neutral labels", async () => {
  const {window} = await mountImages(undefined, false, [], [
    {id:"pending",role:"user",text:"'/state/sessions/fixture/attachments/12345.png'"},
  ], "fixture");
  const row = window.document.querySelector('[data-history-message-id="pending"]')!;
  assert.equal(row.querySelector('.attachment-chip')?.textContent, '[Image]');
  assert.doesNotMatch(row.textContent ?? '', /12345/);
});

test("history images replace their stored upload path with a thumbnail and neutral label", async () => {
  const {window} = await mountImages(undefined, false, [], [
    {id:"image",role:"user",text:"'/state/sessions/fixture/attachments/12345.png'",images:[{id:imageId(0)}]},
    {id:"caption",role:"user",text:"'/state/sessions/fixture/attachments/12345.png'\nHello",images:[{id:imageId(1)}]},
  ], "fixture");
  for (const row of window.document.querySelectorAll('[data-history-message-id]')) {
    assert.ok(row.querySelector('.history-bubble .conversation-image-thumbnail'));
    assert.equal(row.querySelector('.history-image-label')?.textContent, 'Image');
    assertNoElement(row, '.attachment-chip');
    assert.doesNotMatch(row.textContent ?? '', /12345/);
  }
});

test("standalone history hides represented image upload paths without an upload owner", async () => {
  const {window} = await mountImages(undefined, false, [], [
    {id:"image",role:"user",text:"'/state/sessions/fixture/attachments/12345.png'",images:[{id:imageId(0)}]},
    {id:"caption",role:"user",text:"'/state/sessions/fixture/attachments/12345.png'\nHello",images:[{id:imageId(1)}]},
  ]);
  for (const row of window.document.querySelectorAll('[data-history-message-id]')) {
    assert.ok(row.querySelector('.history-bubble .conversation-image-thumbnail'));
    assert.equal(row.querySelector('.history-image-label')?.textContent, 'Image');
    assert.doesNotMatch(row.textContent ?? '', /12345|\/state\/sessions/);
  }
});


test("outgoing history labels show original names and keep a neutral label for unnamed images", async () => {
  const { window } = await mountImages(undefined, false, [], [
    { id: "named", role: "user", text: "", images: [{ id: imageId(0), original_name: "Design draft.png" }] },
    { id: "unnamed", role: "user", text: "Caption", images: [{ id: imageId(1) }] },
    { id: "multiple", role: "user", text: "Two drafts", images: [
      { id: imageId(2), original_name: "First.png" }, { id: imageId(3), original_name: "Second.png" },
    ] },
  ]);
  assert.deepEqual([...window.document.querySelectorAll(".history-image-label")].map(node => node.textContent),
    ["Design draft.png", "Image", "First.png · Second.png"]);
  assert.equal(window.document.querySelectorAll(".conversation-image-thumbnail").length, 4);
});

for (const [reason,status,expected] of [
  ["outside-allowed-roots",422,"Not shared: outside the session folder · mock.png"],
  ["unknown-reason",422,"Image unavailable"],
  [undefined,422,"Image unavailable"],
  ["outside-allowed-roots",404,"Image deleted"],
] as const) test(`assistant Markdown image refusal: ${status} ${reason ?? "no reason"}`,async () => {
  const source = "/restricted/mock.png";
  const {window,requests} = await mountImages(() => new Response(JSON.stringify({ok:false,error:{
    code:status === 404 ? "history-image-deleted" : "history-image-unavailable",reason,
  }}),{status}),false,[],[{id:"reply",role:"assistant",text:`![](<${source}>)`,images:[{id:imageId(0)}]}]);
  assert.equal(window.document.querySelector('.conversation-image-thumbnail [role="status"]')?.textContent,expected);
  assert.doesNotMatch(window.document.body.innerHTML,/restricted/);
  assert.deepEqual(requests,[`/api/history/sessions/fixture/history/images/${imageId(0)}`]);
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Open image 1"]')!.click());
  assert.equal(window.document.querySelector('.conversation-image-canvas [role="status"]')?.textContent,expected);
  assert.doesNotMatch(window.document.body.innerHTML,/restricted/);
  assertNoElement(window.document,'.conversation-image-retry');
});

test("Markdown refusal names stay with their descriptors when tool images leave the bubble",async () => {
  const {window} = await mountImages(() => new Response(JSON.stringify({error:{
    code:"history-image-unavailable",reason:"outside-allowed-roots",
  }}),{status:422}),false,[],[{id:"reply",role:"assistant",
    text:"![](/restricted/first.png) ![](</restricted/second plot.png>)",
    images:[{id:imageId(0)},{id:imageId(1),origin:"tool_result"}]}]);
  assert.equal(window.document.querySelector('.history-bubble [role="status"]')?.textContent,
    "Not shared: outside the session folder · first.png");
  assert.equal(window.document.querySelector('.history-tool-output [role="status"]')?.textContent,
    "Not shared: outside the session folder · second plot.png");
  assert.doesNotMatch(window.document.body.innerHTML,/restricted/);
});

test("refused remote Markdown images explain the source and open links only on request",async () => {
  const urls = Array.from({length:6},(_,index) => `https://images.example.invalid/chart-${index + 1}.png`);
  const images = urls.map((_,index) => ({id:imageId(index),origin:"tool_result"}));
  const {window,requests} = await mountImages(() => new Response(JSON.stringify({error:{code:"history-image-unavailable"}}),{status:422}),
    false,[],[{id:"remote-result",role:"assistant",text:urls.map(url => `![](<${url}>)`).join("\n"),images}]);
  const group = window.document.querySelector(".history-tool-output");
  assert.ok(group);
  assert.deepEqual([...group.querySelectorAll('[role="status"]')].map(node => node.textContent),
    urls.map(() => "External image, not loaded · https://images.example.invalid"));
  const links = [...group.querySelectorAll<HTMLAnchorElement>("a")];
  assert.deepEqual(links.map(link => link.href),urls);
  assert.ok(links.every(link => link.textContent === "Open link" && link.target === "_blank" && link.rel === "noopener noreferrer"));
  assertNoElement(group,"img, button a");
  assert.deepEqual(requests.map(path => path.split("/").at(-1)).sort(),images.map(image => image.id).sort());
  assert.ok(requests.every(path => path.startsWith("/api/history/sessions/fixture/history/images/")),"rendering never fetches external images");
  const opened: unknown[][] = [];
  window.open = ((...args: unknown[]) => { opened.push(args); return null; }) as never;
  assert.deepEqual(opened,[]);
  const click = new window.MouseEvent("click",{bubbles:true,cancelable:true});
  await act(async () => links[3]!.dispatchEvent(click));
  assert.equal(click.defaultPrevented,true);
  assert.deepEqual(opened,[[urls[3],"_blank","noopener,noreferrer"]]);
  assertNoElement(window.document,'[role="dialog"]');
});

test("remote source links are omitted for unsafe URLs and ambiguous image associations",async () => {
  const {window} = await mountImages(() => new Response(JSON.stringify({error:{code:"history-image-unavailable"}}),{status:422}),false,[],[
    {id:"unsafe",role:"assistant",text:"![](javascript:invalid)",images:[{id:imageId(0),origin:"tool_result"}]},
    {id:"mixed",role:"assistant",text:"![](https://images.example.invalid/chart.png)",
      images:[{id:imageId(1),origin:"tool_result"},{id:imageId(2),origin:"tool_result"}]},
  ]);
  assertNoElement(window.document,".history-tool-output a");
  assert.deepEqual([...window.document.querySelectorAll('.conversation-image-thumbnail [role="status"]')].map(node => node.textContent),
    ["Image unavailable","Image unavailable","Image unavailable"]);
});

test("viewer navigation explains a refused external image beside a readable local image",async () => {
  const {window} = await mountImages(path => path.includes(imageId(0))
    ? new Response(new Uint8Array([137,80,78,71]),{headers:{"content-type":"image/png"}})
    : new Response(JSON.stringify({error:{code:"history-image-unavailable",reason:"remote-url-not-fetched",source_origin:"https://images.example.invalid"}}),{status:422}),
  false,[],[{id:"mixed-sources",role:"assistant",text:"![](/charts/local.png) ![](https://images.example.invalid/remote.png)",
    images:[{id:imageId(0)},{id:imageId(1)}]}]);
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Open image 1"]')!.click());
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click());
  const viewer = window.document.querySelector('[aria-label="Conversation images"]');
  assert.ok(viewer);
  assert.equal(viewer.querySelector('[role="status"]')?.textContent,"External image, not loaded · https://images.example.invalid");
  assert.equal(viewer.querySelector("a")?.href,"https://images.example.invalid/remote.png");
  assert.equal(viewer.querySelector<HTMLButtonElement>('[aria-label="Download image"]')?.disabled,true);
  assertNoElement(viewer,"img");
});

// Mirrors nils-cli f2e8f710's history-file-part-v1.json; no stored-path name inference.
test("delivered file parts show original names while unnamed and absent metadata stay neutral", async () => {
  const descriptor = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/history-file-part-v1.json", import.meta.url), "utf8"));
  const path = "/fixture/sessions/sample/attachments/123-stored.txt";
  const unnamed = { kind: "file", id: "unnamed.file-0-0", bytes: 5 };
  const { window } = await mountImages(undefined, false, [], [
    { id: "message", role: "user", text: `'${path}'`, files: [{ ...descriptor, future_field: true }] },
    { id: "unnamed", role: "user", text: `'${path}'`, files: [unnamed] },
    { id: "mixed", role: "user", text: `'${path}'\n'/fixture/sessions/sample/attachments/other.txt'`, files: [unnamed, descriptor] },
    { id: "absent", role: "user", text: `'${path}'` },
    { id: "partial", role: "user", text: `'${path}'\n'/fixture/sessions/sample/attachments/other.txt'`, files: [descriptor] },
  ], "sample");
  const cards = [...window.document.querySelectorAll(".file-card")];
  assert.deepEqual(cards.map(card => card.querySelector(".file-card-name")?.textContent), ["notes.txt", "Document", "Document", "notes.txt", "Document", "Document", "Document"]);
  assert.doesNotMatch(window.document.body.textContent ?? "", /123-stored|future_field/);
});

test("file metadata from literal code or double-quoted paths never names another upload card", async () => {
  const path = "/fixture/sessions/sample/attachments/missing.txt";
  const hidden = "/fixture/sessions/sample/attachments/hidden.txt";
  const file = { kind: "file", id: "message.file-0-60", original_name: "Hidden notes.txt", bytes: 5 };
  const { window } = await mountImages(undefined, false, [], [
    { id: "code", role: "user", text: `'${path}'\n\`'${hidden}'\``, files: [file] },
    { id: "double", role: "user", text: `'${path}'\n"${hidden}"`, files: [file] },
  ], "sample");
  assert.deepEqual([...window.document.querySelectorAll(".file-card-name")].map(card => card.textContent), ["Document", "Document"]);
});

test("archived History rows show frozen file metadata without a live upload owner", async () => {
  const file = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/history-file-part-v1.json", import.meta.url), "utf8"));
  const path = "/fixture/sessions/sample/attachments/123-stored.txt";
  const { window } = await mountImages(undefined, false, [], [
    { id: "message", role: "user", text: `'${path}'`, files: [file] },
    { id: "unnamed", role: "user", text: `'${path}'`, files: [{ kind: "file", id: "unnamed.file-0-0", bytes: 5 }] },
    { id: "partial", role: "user", text: `'${path}'\n'/fixture/sessions/sample/attachments/other.txt'`, files: [file] },
  ]);
  const cards = [...window.document.querySelectorAll(".file-card")];
  assert.deepEqual(cards.map(card => card.querySelector(".file-card-name")?.textContent), ["notes.txt", "Document", "Document", "Document"]);
  assert.equal(cards[0]?.querySelector(".file-card-details")?.textContent, "Document · 5 B");
  assert.doesNotMatch(window.document.body.textContent ?? "", /123-stored|\/fixture/);
});

for (const associated of [false,true]) for (const sourceOrigin of [undefined,"https://images.example.invalid"]) {
  test(`typed remote refusals render without depending on Markdown or origin (${associated}, ${Boolean(sourceOrigin)})`,async () => {
    const url = "https://images.example.invalid/chart.png";
    const {window,requests} = await mountImages(() => new Response(JSON.stringify({ok:false,error:{
      code:"history-image-unavailable",reason:"remote-url-not-fetched",source_origin:sourceOrigin,extra:"ignored",
    }}),{status:422}),false,[],[{id:"remote",role:"assistant",text:associated ? `![](${url})` : "Remote chart",
      images:[{id:imageId(0),origin:"tool_result"}]}]);
    const tile = window.document.querySelector(".conversation-image-thumbnail");
    assert.ok(tile);
    assert.equal(tile.querySelector('[role="status"]')?.textContent,
      `External image, not loaded${sourceOrigin ? ` · ${sourceOrigin}` : ""}`);
    if (associated) assert.equal(tile.querySelector("a")?.href,url);
    else assertNoElement(tile,"a");
    assertNoElement(tile,"img, .conversation-image-retry");
    assert.deepEqual(requests,[`/api/history/sessions/fixture/history/images/${imageId(0)}`]);
  });
}

test("viewer navigation shows typed remote refusals without Markdown links",async () => {
  const {window} = await mountImages(path => path.includes(imageId(0))
    ? new Response(new Uint8Array([137,80,78,71]),{headers:{"content-type":"image/png"}})
    : new Response(JSON.stringify({error:{code:"history-image-unavailable",reason:"remote-url-not-fetched",
      ...(path.includes(imageId(1)) ? {source_origin:"https://images.example.invalid"} : {})}}),{status:422}),
    false,[{id:imageId(0)},{id:imageId(1)},{id:imageId(2)}]);
  // Keep a readable image as the viewer entry point; refused tiles have no open action.
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Open image 1"]')!.click());
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click());
  const viewer = window.document.querySelector('[aria-label="Conversation images"]');
  assert.ok(viewer);
  assert.equal(viewer.querySelector('[role="status"]')?.textContent,"External image, not loaded · https://images.example.invalid");
  assertNoElement(viewer,"a, img, .conversation-image-retry");
  assert.equal(viewer.querySelector<HTMLButtonElement>('[aria-label="Download image"]')?.disabled,true);
  await act(async () => window.document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click());
  assert.equal(viewer.querySelector('[role="status"]')?.textContent,"External image, not loaded");
  assertNoElement(viewer,"a, img, .conversation-image-retry");
});

for (const associated of [false,true]) test(`invalid remote origins do not become source labels (${associated})`,async () => {
  const origins = ["javascript:alert(1)","https://user:synthetic-password@example.com",
    "https://images.example.invalid/private/chart.png","https://images.example.invalid?query=synthetic",
    "https://images.example.invalid#fragment","https://images.example.invalid:443",
    "HTTPS://images.example.invalid","https://Images.example.invalid"];
  const url = "https://images.example.invalid/chart.png";
  const {window,requests} = await mountImages(path => new Response(JSON.stringify({error:{
    code:"history-image-unavailable",reason:"remote-url-not-fetched",source_origin:origins[Number(path.split(".")[2])],
  }}),{status:422}),false,[],origins.map((_,index) => ({id:`remote-${index}`,role:"assistant",
    text:associated ? `![](${url})` : "Remote chart",images:[{id:imageId(index),origin:"tool_result"}]})));
  const tiles = [...window.document.querySelectorAll(".conversation-image-thumbnail")];
  assert.equal(tiles.length,origins.length);
  assert.deepEqual(tiles.map(tile => tile.querySelector('[role="status"]')?.textContent),origins.map(() => "External image, not loaded"));
  for (const tile of tiles) {
    if (associated) assert.equal(tile.querySelector("a")?.href,url);
    else assertNoElement(tile,"a");
    assertNoElement(tile,"img, .conversation-image-retry");
  }
  assert.equal(requests.length,origins.length);
  assert.ok(requests.every(path => path.startsWith("/api/history/sessions/fixture/history/images/")));
});

test("image-block history copies selector-bound paths for duplicate display names after reload", async () => {
  // Exact descriptor/parts shape frozen by nils-cli 7beccf32; opaque selectors are synthetic.
  const frozen = JSON.parse(readFileSync(new URL("./fixtures/history-image-descriptor-v1.json", import.meta.url), "utf8"));
  assert.deepEqual(frozen.parts[0], {kind:"image", id:"message-1", ref:frozen.images[0].id,
    ...Object.fromEntries(Object.entries(frozen.images[0]).filter(([key]) => key !== "id"))});
  const second = {...frozen.images[0], id:imageId(1), attachment_ref:"upload-second",
    upload_path:"/state/sessions/session-1/attachments/photo 'one' \"two\".png"};
  const images = [frozen.images[0], second];
  for (const index of [0, 1, 1]) {
    const menu = await macMenu({name:"photo 1.png", text:"caption only", images:JSON.parse(JSON.stringify(images)), index});
    assert.ok(menu.items().includes("Copy file path"), "path survives image-block history without a quoted text token");
    await menu.choose("Copy file path");
    assert.deepEqual(menu.invoked.filter(([command]) => command === "write_macos_clipboard_text"),
      [["write_macos_clipboard_text", {text:images[index].upload_path}]]);
  }
});

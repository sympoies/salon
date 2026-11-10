import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { Window } from "happy-dom";
import { ConversationImageCache, type ImageTarget } from "../src/conversationImageCache.ts";
import { fetchConversationImage } from "../src/conversationImageData.ts";

const target = (i: number, machine = "fixture", history = "history"): ImageTarget => ({machine,history,image:`${"a".repeat(16)}.0.${i}.${"b".repeat(32)}`});
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const response = () => new Response(new Uint8Array(4),{headers:{"content-type":"image/png"}});
function setup(t: TestContext, fetchImage: typeof fetch) {
  const window = new Window({url:"http://localhost"});
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
  Object.assign(globalThis,{window,fetch:fetchImage});
  t.after(() => { globalThis.window = previousWindow; globalThis.fetch = previousFetch; window.close(); });
}
function read(image: ImageTarget, signal = new AbortController().signal, visible?: () => boolean) {
  return fetchConversationImage(image.machine,image.history,image.image,signal,visible);
}

test("clearing the cache revokes images and isolates old observers from new reads", async t => {
  const revoked: string[] = [], revoke = URL.revokeObjectURL;
  t.mock.method(URL,"revokeObjectURL",(url: string) => { revoked.push(url); revoke(url); });
  let requests = 0;
  setup(t,async () => { requests++; return response(); });
  const cache = new ConversationImageCache();
  let snapshot = cache.peek(target(0));
  const old = cache.watch(target(0),data => { snapshot = data; });
  old.setVisible(true); await flush();
  const image = cache.peek(target(0)); assert.ok(image.state === "ready");
  cache.clear();
  assert.deepEqual(revoked,[image.url]);
  assert.equal(snapshot.state,"loading");
  const next = cache.watch(target(0),() => {});
  old.unsubscribe();
  next.setVisible(true); await flush();
  assert.equal(requests,2);
  assert.equal(cache.peek(target(0)).state,"ready");
  next.unsubscribe(); cache.clear();
});

test("a mounted observer can reload after a connection change", async t => {
  let requests = 0;
  setup(t,async () => { requests++; return response(); });
  const cache = new ConversationImageCache();
  let snapshot = cache.peek(target(0));
  const handle = cache.watch(target(0),data => { snapshot = data; });
  handle.setVisible(true); await flush();
  assert.equal(snapshot.state,"ready");
  cache.clear();
  cache.reloadVisible(); await flush();
  assert.equal(snapshot.state,"ready","the mounted view loads from the new connection");
  assert.equal(requests,2);
  handle.unsubscribe(); cache.clear();
});

for (const [name,fetchImage,state] of [
  ["not found",async () => new Response("",{status:404}),"unavailable"],
  ["deleted",async () => new Response(JSON.stringify({error:{code:"history-image-deleted"}}),{status:404}),"deleted"],
  ["server error",async () => new Response("",{status:503}),"error"],
  ["network error",async () => { throw new TypeError("Network error"); },"error"],
  ["timeout",async () => { throw new DOMException("Request timed out","TimeoutError"); },"error"],
] as const) test(`${name} has its own image outcome`,async t => {
  setup(t,fetchImage); assert.equal((await read(target(0))).state,state);
});

for (const [name,count,bytes] of [["count",2,100],["bytes",10,8]] as const) test(`LRU eviction by ${name} revokes the oldest blob and keeps active snapshots consistent`,async t => {
  const revoked: string[] = [], revoke = URL.revokeObjectURL;
  t.mock.method(URL,"revokeObjectURL",(url: string) => { revoked.push(url); revoke(url); });
  setup(t,async () => response());
  const cache = new ConversationImageCache(count,bytes);
  const handles: ReturnType<typeof cache.watch>[] = [];
  t.after(() => handles.forEach(handle => handle.unsubscribe()));
  const watch = async (i: number) => {
    const handle = cache.watch(target(i),() => {}); handles.push(handle); handle.setVisible(true); await flush(); return handle;
  };
  const first = await watch(0), second = await watch(1);
  const a = cache.peek(target(0)), b = cache.peek(target(1));
  assert.ok(a.state === "ready" && b.state === "ready");
  first.setVisible(false); first.setVisible(true);
  second.setVisible(false);
  await watch(2);
  assert.deepEqual(revoked,[b.url]);
  assert.equal(cache.peek(target(0)),a); assert.equal(cache.peek(target(1)).state,"loading");
  first.unsubscribe();
  assert.deepEqual(revoked,[b.url],"unmount retains the cached URL");
  await watch(0); assert.equal(cache.peek(target(0)),a);
});

test("visible images survive eviction without another visibility notification",async t => {
  const revoked: string[] = [], revoke = URL.revokeObjectURL;
  t.mock.method(URL,"revokeObjectURL",(url: string) => { revoked.push(url); revoke(url); });
  setup(t,async () => response());
  const cache = new ConversationImageCache(2,8);
  const first = cache.watch(target(0),() => {}); first.setVisible(true); await flush();
  const shown = cache.peek(target(0)); assert.ok(shown.state === "ready");
  const second = cache.watch(target(1),() => {}); second.setVisible(true); await flush(); second.setVisible(false);
  const hidden = cache.peek(target(1)); assert.ok(hidden.state === "ready");
  const third = cache.watch(target(2),() => {});
  t.after(() => { first.unsubscribe(); second.unsubscribe(); third.unsubscribe(); });
  third.setVisible(true); await flush();
  assert.equal(cache.peek(target(0)).state,"ready","a visible viewer retains usable data without toggling visibility");
  assert.equal(cache.peek(target(0)),shown);
  assert.deepEqual(revoked,[hidden.url],"the non-visible image is evicted even though it was loaded more recently");
});

test("a full cache preserves visible images and offers bounded Retry for a new load",async t => {
  let requests = 0;
  setup(t,async () => { requests++; return response(); });
  t.mock.timers.enable({apis:["setTimeout"]});
  const cache = new ConversationImageCache(1,4);
  const first = cache.watch(target(0),() => {}); first.setVisible(true); await flush();
  const shown = cache.peek(target(0)); assert.ok(shown.state === "ready");
  const second = cache.watch(target(1),() => {});
  t.after(() => { first.unsubscribe(); second.unsubscribe(); });
  second.setVisible(true); await flush();
  assert.equal(cache.peek(target(0)).state,"ready","capacity never discards an already displayed image");
  assert.equal(cache.peek(target(0)),shown);
  assert.equal(cache.peek(target(1)).state,"error","a new image gets a Retry action instead of permanent loading");
  t.mock.timers.tick(10000); await flush();
  assert.equal(requests,2,"capacity pressure does not create an automatic fetch loop");
  first.setVisible(false); second.retry(); await flush();
  assert.equal(requests,3);
  assert.equal(cache.peek(target(1)).state,"ready","Retry progresses once a resident image is no longer visible");
  assert.equal(cache.peek(target(0)).state,"loading");
});

test("cache separates machine and history and deduplicates shared viewers",async t => {
  let requests = 0; setup(t,async () => { requests++; return response(); });
  const cache = new ConversationImageCache();
  const handles = [target(0),target(0),target(0,"other"),target(0,"fixture","other")].map(image => {
    const handle = cache.watch(image,() => {}); handle.setVisible(true); return handle;
  });
  t.after(() => handles.forEach(handle => handle.unsubscribe()));
  await flush(); assert.equal(requests,3);
});

test("automatic retries use bounded backoff and a manual retry starts a fresh attempt",async t => {
  let requests = 0, succeed = false;
  setup(t,async () => { requests++; return succeed ? response() : new Response("",{status:503}); });
  t.mock.timers.enable({apis:["setTimeout"]});
  const cache = new ConversationImageCache();
  const states: string[] = [];
  const handle = cache.watch(target(0),data => states.push(data.state)); t.after(() => handle.unsubscribe());
  handle.setVisible(true); await flush(); assert.equal(requests,1); assert.equal(states.at(-1),"error");
  t.mock.timers.tick(999); await flush(); assert.equal(requests,1);
  t.mock.timers.tick(1); await flush(); assert.equal(requests,2);
  t.mock.timers.tick(2999); await flush(); assert.equal(requests,2);
  t.mock.timers.tick(1); await flush(); assert.equal(requests,3);
  handle.setVisible(false); handle.setVisible(true);
  t.mock.timers.tick(60000); await flush(); assert.equal(requests,3,"scrolling does not restart exhausted retries");
  assert.equal(states.at(-1),"error");
  succeed = true; handle.retry(); await flush(); assert.equal(requests,4); assert.equal(states.at(-1),"ready");
});

test("an automatic retry recovers a temporary failure and unmount cancels retry work",async t => {
  let requests = 0; setup(t,async () => ++requests === 2 ? response() : new Response("",{status:503}));
  t.mock.timers.enable({apis:["setTimeout"]});
  const cache = new ConversationImageCache();
  const first = cache.watch(target(0),() => {}); first.setVisible(true); await flush();
  t.mock.timers.tick(1000); await flush(); assert.equal(cache.peek(target(0)).state,"ready");
  const second = cache.watch(target(1),() => {}); second.setVisible(true); await flush(); second.unsubscribe();
  t.mock.timers.tick(10000); await flush(); assert.equal(requests,3); first.unsubscribe();
});

test("queue prefers visible images in FIFO order and cancels an unsent request",async t => {
  const started: number[] = [], finish: Array<() => void> = [];
  setup(t,((path: string) => new Promise<Response>(resolve => {
    started.push(Number(path.split("/").at(-1)!.split(".")[2])); finish.push(() => resolve(response()));
  })) as typeof fetch);
  const requests = [0,1,2,3,4,5].map(i => read(target(i),undefined,() => i !== 3));
  const cancelled = new AbortController(); requests.push(read(target(6),cancelled.signal));
  await flush(); assert.deepEqual(started,[0,1,2]); cancelled.abort();
  finish.shift()!(); await flush(); assert.deepEqual(started,[0,1,2,4]);
  finish.shift()!(); await flush(); assert.deepEqual(started,[0,1,2,4,5]);
  while (finish.length) { finish.shift()!(); await flush(); }
  assert.deepEqual(started,[0,1,2,4,5,3]);
  for (const result of await Promise.all(requests)) if (result.state === "ready") URL.revokeObjectURL(result.url);
});

test("queue wait can exceed fifteen seconds; each timeout starts only when sent",async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  let timeouts = 0;
  t.mock.method(AbortSignal,"timeout",(ms: number) => {
    assert.equal(ms,15000); timeouts++;
    const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException("Timed out","TimeoutError")),ms); return controller.signal;
  });
  const pending: Array<() => void> = [];
  setup(t,((_path: string, init: RequestInit) => new Promise<Response>((resolve,reject) => {
    init.signal!.addEventListener("abort",() => reject(init.signal!.reason),{once:true}); pending.push(() => resolve(response()));
  })) as typeof fetch);
  const requests = Array.from({length:7},(_,i) => read(target(i)));
  await flush(); assert.equal(timeouts,3);
  t.mock.timers.tick(14000); pending.splice(0,3).forEach(resolve => resolve()); await flush(); assert.equal(timeouts,6);
  t.mock.timers.tick(14000); pending.splice(0,3).forEach(resolve => resolve()); await flush(); assert.equal(timeouts,7);
  let finished = false; void requests[6]!.then(() => { finished = true; });
  t.mock.timers.tick(14999); await flush(); assert.equal(finished,false,"a queued image gets its full sent-request timeout");
  t.mock.timers.tick(1); await flush(); assert.equal((await requests[6]!).state,"error");
  for (const result of await Promise.all(requests)) if (result.state === "ready") URL.revokeObjectURL(result.url);
});

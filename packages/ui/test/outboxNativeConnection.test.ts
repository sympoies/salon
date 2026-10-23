import {strict as assert} from "node:assert";
import {test} from "node:test";
import {IDBFactory} from "fake-indexeddb";
import {Window} from "happy-dom";
import type {Plugin} from "vite";
import {makeSession} from "./support/fixtures.ts";
import {createUiSsrHarness} from "./support/ssr.ts";

declare global {
  var __nativeOutboxReady:Promise<void>|undefined;
  var __nativeOutboxLoading:(()=>void)|undefined;
  var __nativeOutboxCalls:unknown[]|undefined;
}
test("#908 native connection change during transport load never sends old queued text to the new server",async()=>{
  const window=new Window({url:"http://tauri.localhost"});
  Object.defineProperty(window.navigator,"locks",{value:{request:async(_name:unknown,_options:unknown,callback:(lock:object)=>unknown)=>callback({})}});
  const globals={window,navigator:window.navigator,document:window.document,localStorage:window.localStorage,indexedDB:new IDBFactory()};
  const saved=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const[key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  let release=()=>{},loaded=()=>{};
  globalThis.__nativeOutboxReady=new Promise<void>(resolve=>{release=resolve;});
  const loading=new Promise<void>(resolve=>{loaded=resolve;});globalThis.__nativeOutboxLoading=loaded;globalThis.__nativeOutboxCalls=[];
  const boundary:Plugin={name:"native-outbox-transport",enforce:"pre",resolveId(id){if(id==="@tauri-apps/plugin-http")return "\0native-outbox-http";},load(id){if(id==="\0native-outbox-http")return `globalThis.__nativeOutboxLoading();await globalThis.__nativeOutboxReady;export async function fetch(url,init){globalThis.__nativeOutboxCalls.push({url,body:init.body});return new Response(JSON.stringify({ok:true,data:{submitted:true,session_incarnation:'inc-1'}}));}`;}};
  const harness=createUiSsrHarness({plugins:[boundary],ssr:{noExternal:["@tauri-apps/plugin-http"]}});
  try{
    const runtime=await harness.loadModule<typeof import("../src/runtime.ts")>("/src/runtime.ts");
    runtime.saveServerUrl("https://fixture-a.invalid");runtime.saveToken("fixture-token-a");
    // This transport-load fixture starts after legacy-principal authentication;
    // outboxNativePrincipal exercises the real auth-status activation path.
    runtime.recordNativeAuthentication(runtime.nativeConnectionConfigGeneration(),true,null);
    const {conversationOutbox}=await harness.loadModule<typeof import("../src/conversationOutbox.ts")>("/src/conversationOutbox.ts");
    const store=conversationOutbox();await store.ready;
    const session=makeSession({machine:"fixture",id:"native-outbox",agent:"claude",session_incarnation:"inc-1",turn_state:{schema_version:"agent-session.turn-state.v1",phase:"idle",revision:2,phase_changed_at:"2030-01-01T00:00:02Z",source:{kind:"provider_hook",provider:"claude",confidence:"authoritative"}}});
    await store.enqueue(session,"private queued fixture text");const delivery=store.deliver(session,true,()=>true);await Promise.race([loading,delivery.then(()=>{throw Error("Delivery finished before transport: "+JSON.stringify(store.items(session)));})]);
    runtime.saveServerUrl("https://fixture-b.invalid");runtime.saveToken("fixture-token-b");release();await delivery;
    assert.deepEqual(globalThis.__nativeOutboxCalls,[]);assert.equal(store.items(session)[0]?.text,"private queued fixture text");
  }finally{
    release();await harness.close();for(const[key,value]of saved)value?Object.defineProperty(globalThis,key,value):Reflect.deleteProperty(globalThis,key);
    delete globalThis.__nativeOutboxReady;delete globalThis.__nativeOutboxLoading;delete globalThis.__nativeOutboxCalls;await window.happyDOM.close();
  }
});

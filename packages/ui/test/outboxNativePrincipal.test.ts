import {strict as assert} from "node:assert";
import {test} from "node:test";
import {IDBFactory} from "fake-indexeddb";
import {Window} from "happy-dom";
import type {Plugin} from "vite";
import {makeSession} from "./support/fixtures.ts";
import {createUiSsrHarness} from "./support/ssr.ts";

declare global { var __principalTransport: ((url:string,init:RequestInit)=>Promise<Response>)|undefined; }

async function nativeQueue(uncertain=false) {
  const window=new Window({url:"http://tauri.localhost"});
  Object.defineProperty(window.navigator,"locks",{value:{request:async(_name:unknown,_options:unknown,callback:(lock:object)=>unknown)=>callback({})}});
  const globals={window,navigator:window.navigator,document:window.document,localStorage:window.localStorage,indexedDB:new IDBFactory()};
  const saved=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const[key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  const calls:{method:string;authorization:string|null;url:string}[]=[];
  let principal="principal-a",pendingAuth:Promise<Response>|undefined,finishAuth=()=>{};
  let attempt:{request_id:string;expected_session_incarnation:string}|undefined;
  const authResponse=()=>new Response(JSON.stringify({authenticated:true,openAccess:false,principal:{id:principal,permissions:[]}}));
  globalThis.__principalTransport=async(url,init)=>{
    if(url.endsWith("/api/auth/status"))return pendingAuth??authResponse();
    const method=init.method??"GET";
    calls.push({method,authorization:new Headers(init.headers).get("Authorization"),url});
    if(method==="POST")attempt=JSON.parse(String(init.body));
    const receipt={request_id:attempt!.request_id,session_id:"native-principal",session_incarnation:attempt!.expected_session_incarnation,outcome:uncertain&&method==="POST"?"unknown":"submitted",code:uncertain&&method==="POST"?"structured-prompt-outcome-unknown":null};
    return new Response(JSON.stringify(receipt.outcome==="unknown"
      ?{ok:false,error:{code:receipt.code,details:{receipt}}}
      :{ok:true,data:{submitted:true,session_incarnation:"inc-1",receipt}}),{status:receipt.outcome==="unknown"?500:200});
  };
  const boundary:Plugin={name:"principal-transport",enforce:"pre",resolveId(id){if(id==="@tauri-apps/plugin-http")return "\0principal-http";},load(id){if(id==="\0principal-http")return "export const fetch=(url,init)=>globalThis.__principalTransport(url,init);";}};
  const harness=createUiSsrHarness({plugins:[boundary],ssr:{noExternal:["@tauri-apps/plugin-http"]}});
  const runtime=await harness.loadModule<typeof import("../src/runtime.ts")>("/src/runtime.ts");
  const storage=await harness.loadModule<typeof import("../src/storage.ts")>("/src/storage.ts");
  const api=await harness.loadModule<typeof import("../src/api.ts")>("/src/api.ts");
  runtime.saveServerUrl("https://fixture-server.invalid");runtime.saveToken("fixture-token-a");
  const status=await api.getAuthStatus();assert.equal(status.authenticated,true);storage.setPrincipalStorageNamespace(status.principal!.id);
  const {conversationOutbox}=await harness.loadModule<typeof import("../src/conversationOutbox.ts")>("/src/conversationOutbox.ts");
  const store=conversationOutbox();await store.ready;
  const session=makeSession({machine:"fixture",id:"native-principal",agent:"claude",session_incarnation:"inc-1",turn_state:{schema_version:"agent-session.turn-state.v1",phase:"idle",revision:2,phase_changed_at:"2030-01-01T00:00:02Z",source:{kind:"provider_hook",provider:"claude",confidence:"authoritative"}}});
  await store.enqueue(session,"old principal fixture task");
  return {runtime,storage,api,store,session,calls,conversationOutbox,
    beginReplacement(){runtime.saveToken("fixture-token-b");principal="root";pendingAuth=new Promise(resolve=>{finishAuth=()=>resolve(authResponse());});return api.getAuthStatus();},
    finishReplacement(){finishAuth();pendingAuth=undefined;},
    async restore(){principal="principal-a";runtime.saveToken("fixture-token-a");const result=await api.getAuthStatus();storage.setPrincipalStorageNamespace(result.principal!.id);},
    async close(){finishAuth();await harness.close();delete globalThis.__principalTransport;for(const[key,value]of saved)value?Object.defineProperty(globalThis,key,value):Reflect.deleteProperty(globalThis,key);await window.happyDOM.close();},
  };
}

test("#908 same-server token replacement keeps the old queue until its own principal is verified",async()=>{
  const h=await nativeQueue();let check:ReturnType<typeof h.api.getAuthStatus>|undefined;
  try{
    const saved=h.store.items(h.session)[0]!;
    check=h.beginReplacement();await h.store.deliver(h.session,true,()=>true);
    assert.deepEqual(h.calls,[],"no old-principal POST while replacement auth is pending");
    h.finishReplacement();const replacement=await check;assert.equal(replacement.principal?.id,"root");
    await h.store.deliver(h.session,true,()=>true);assert.deepEqual(h.calls,[],"verified root does not activate the still-rendered principal-a queue");
    h.storage.setPrincipalStorageNamespace(replacement.principal!.id);assert.equal(h.conversationOutbox().items(h.session).length,0);
    assert.deepEqual(h.store.items(h.session),[saved],"old principal data and attempt IDs remain untouched");
    await h.restore();await h.store.deliver(h.session,true,()=>true);
    assert.equal(h.calls.length,1);assert.equal(h.calls[0]?.authorization,"Bearer fixture-token-a");
    assert.deepEqual(h.store.items(h.session).map(item=>item.state),["delivered"],"delivered; it waits for its transcript turn (#969)");
  }finally{h.finishReplacement();await check;await h.close();}
});

test("#908 uncertain receipt lookup never uses a replacement principal credential",async()=>{
  const h=await nativeQueue(true);let check:ReturnType<typeof h.api.getAuthStatus>|undefined;
  try{
    await h.store.deliver(h.session,true,()=>true);const saved=h.store.items(h.session)[0]!;assert.equal(saved.state,"unknown");h.calls.length=0;
    check=h.beginReplacement();await h.store.reconcile(h.session,true);assert.deepEqual(h.calls,[]);
    h.finishReplacement();const replacement=await check;await h.store.reconcile(h.session,true);assert.deepEqual(h.calls,[]);
    h.storage.setPrincipalStorageNamespace(replacement.principal!.id);await h.store.reconcile(h.session,true);assert.deepEqual(h.calls,[]);assert.deepEqual(h.store.items(h.session),[saved]);
    await h.restore();await h.store.reconcile(h.session,true);
    assert.equal(h.calls.length,1);assert.equal(h.calls[0]?.method,"GET");assert.equal(h.calls[0]?.authorization,"Bearer fixture-token-a");assert.ok(h.calls[0]?.url.includes(saved.requestId));
    assert.deepEqual(h.store.items(h.session).map(item=>item.state),["delivered"],"settled as delivered (#969)");
  }finally{h.finishReplacement();await check;await h.close();}
});

test("#908 an old auth response cannot activate a newer credential generation",async()=>{
  const h=await nativeQueue();let check:ReturnType<typeof h.api.getAuthStatus>|undefined;
  try{
    const saved=h.store.items(h.session)[0]!;
    check=h.beginReplacement();await new Promise(resolve=>setTimeout(resolve,0));
    h.runtime.saveToken("fixture-token-a");h.finishReplacement();const stale=await check;
    assert.equal(stale.authenticated,false);assert.equal(stale.principal,null);
    await h.store.deliver(h.session,true,()=>true);assert.deepEqual(h.calls,[]);assert.deepEqual(h.store.items(h.session),[saved]);
    await h.restore();await h.store.deliver(h.session,true,()=>true);
    assert.equal(h.calls.length,1);assert.equal(h.calls[0]?.authorization,"Bearer fixture-token-a");
  }finally{h.finishReplacement();await check;await h.close();}
});

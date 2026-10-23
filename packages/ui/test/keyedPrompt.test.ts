import {strict as assert} from "node:assert";
import {afterEach,test} from "node:test";
import * as api from "../src/api.ts";
import {jsonResponse,restoreFetch,setFetchMock} from "./fetchHelper.ts";
afterEach(restoreFetch);
const request={text:"queued task",expected_session_incarnation:"inc-1",request_id:"attempt-1",require_idle:true};
const receipt=(outcome="submitted",code:string|null=null)=>({request_id:"attempt-1",session_id:"s1",session_incarnation:"inc-1",outcome,code});
test("keyed prompt preserves the required idle guard and exact matching receipt",async()=>{
  setFetchMock(async(url,init)=>{
    assert.equal(url,"/api/sessions/host-a/s1/prompt/v2");assert.deepEqual(JSON.parse(String(init?.body)),request);
    return jsonResponse({ok:true,data:{submitted:true,session_incarnation:"inc-1",receipt:receipt()}});
  });
  const result=await api.submitSessionPrompt("host-a","s1",request);
  assert.deepEqual((result as {receipt?:unknown}).receipt,receipt());
});
test("keyed prompt cannot accept another request's positive acknowledgement",async()=>{
  setFetchMock(async()=>jsonResponse({ok:true,data:{submitted:true,session_incarnation:"inc-1",receipt:{...receipt(),request_id:"another-attempt"}}}));
  const result=await api.submitSessionPrompt("host-a","s1",request);
  assert.equal(result.ok,false);assert.equal(result.outcomeUnknown,true);
});
test("keyed refusal retains its authoritative non-delivery receipt",async()=>{
  const refused=receipt("refused","busy");
  setFetchMock(async()=>jsonResponse({ok:false,error:{code:"busy",message:"busy",details:{receipt:refused}}},{status:409}));
  const result=await api.submitSessionPrompt("host-a","s1",request);
  assert.equal(result.ok,false);assert.equal(Boolean(result.outcomeUnknown),false);assert.deepEqual((result as {receipt?:unknown}).receipt,refused);
});
test("keyed unknown retains its request-bound receipt without a blind replay",async()=>{
  let calls=0;const unknown=receipt("unknown","structured-prompt-outcome-unknown");
  setFetchMock(async()=>{calls++;return jsonResponse({ok:false,error:{code:unknown.code,details:{receipt:unknown}}},{status:500});});
  const result=await api.submitSessionPrompt("host-a","s1",request);
  assert.equal(result.ok,false);assert.equal(result.outcomeUnknown,true);assert.deepEqual((result as {receipt?:unknown}).receipt,unknown);assert.equal(calls,1);
});
test("keyed receipt lookup uses the exact historical incarnation and receipt identity",async()=>{
  const lookup=(api as unknown as {lookupSessionPromptReceipt?: (machine:string,id:string,requestId:string,incarnation:string)=>Promise<{ok:boolean;receipt?:unknown}>}).lookupSessionPromptReceipt;
  assert.equal(typeof lookup,"function");
  setFetchMock(async(url,init)=>{assert.equal(url,"/api/sessions/host-a/s1/prompt/v2/receipts/attempt-1?expected_session_incarnation=inc-1");assert.equal(init?.method??"GET","GET");return jsonResponse({ok:true,data:{receipt:receipt()}});});
  assert.deepEqual(await lookup!("host-a","s1","attempt-1","inc-1"),{ok:true,receipt:receipt()});
});

test("known queued replies block UI archive/delete before their receipts can be removed",async()=>{
  const {IDBFactory}=await import("fake-indexeddb");
  const {makeSession}=await import("./support/fixtures.ts");
  const saved=Object.getOwnPropertyDescriptor(globalThis,"indexedDB");
  const savedNavigator=Object.getOwnPropertyDescriptor(globalThis,"navigator");
  Object.defineProperty(globalThis,"navigator",{value:{locks:{}},configurable:true});
  Object.defineProperty(globalThis,"indexedDB",{value:new IDBFactory(),configurable:true});
  const {conversationOutbox}=await import("../src/conversationOutbox.ts");
  const store=conversationOutbox(),session=makeSession({machine:"host-a",id:"retained",session_incarnation:"inc-1"});
  await store.enqueue(session,"keep before archive");let calls=0;
  setFetchMock(async()=>{calls++;return jsonResponse({ok:true});});
  try{
    await api.archiveSession("host-a","retained","inc-1");await api.killSession("host-a","retained");assert.equal(calls,0);
  }finally{
    savedNavigator?Object.defineProperty(globalThis,"navigator",savedNavigator):Reflect.deleteProperty(globalThis,"navigator");
    saved?Object.defineProperty(globalThis,"indexedDB",saved):Reflect.deleteProperty(globalThis,"indexedDB");
  }
});

test("keyed options without an incarnation fence are rejected before fetch",async()=>{
  let calls=0;setFetchMock(async()=>{calls++;return jsonResponse({ok:true,data:{submitted:true}});});
  for(const options of [{request_id:"attempt-1"},{require_idle:true},{require_idle:false}]){
    const result=await api.submitSessionPrompt("host-a","s1",{text:"task",...options} as api.SubmitSessionPromptBody);
    assert.equal(result.ok,false);assert.equal(Boolean(result.outcomeUnknown),false);
  }
  assert.equal(calls,0);
});
test("request-ID conflict is a definite refusal, never another payload's receipt",async()=>{
  setFetchMock(async()=>jsonResponse({ok:false,error:{code:"request-id-conflict",details:{receipt:receipt()}}},{status:409}));
  const result=await api.submitSessionPrompt("host-a","s1",request);
  assert.equal(result.ok,false);assert.equal(Boolean(result.outcomeUnknown),false);
  assert.equal(result.refusalCode,"request-id-conflict");assert.equal(result.receipt,undefined);
});
test("unreadable durable state blocks archive and delete without a network request",async()=>{
  const saved=Object.getOwnPropertyDescriptor(globalThis,"indexedDB");
  Object.defineProperty(globalThis,"indexedDB",{value:undefined,configurable:true});
  let calls=0;setFetchMock(async()=>{calls++;return jsonResponse({ok:true});});
  try{
    for(const result of [await api.archiveSession("host-a","unreadable","inc-1"),await api.killSession("host-a","unreadable")]){
      assert.equal(result.ok,false);assert.match(result.error??"",/could not be verified/i);
    }
    assert.equal(calls,0);
  }finally{saved?Object.defineProperty(globalThis,"indexedDB",saved):Reflect.deleteProperty(globalThis,"indexedDB");}
});
test("an older runtime's unsupported keyed prompt is a definite refusal, not an unknown outcome",async()=>{
  setFetchMock(async()=>jsonResponse({ok:false,error:{code:"keyed-prompt-unsupported",message:"This host's agent-session runtime does not support queued replies. The reply was not sent."}},{status:400}));
  const result=await api.submitSessionPrompt("host-a","s1",request);
  assert.equal(result.ok,false);assert.equal(Boolean(result.outcomeUnknown),false);
  assert.equal((result as {refusalCode?:string}).refusalCode,"keyed-prompt-unsupported");
  assert.match(result.error ?? "",/does not support queued replies/);
});

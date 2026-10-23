import type {PromptReceipt} from "@agent-console/shared/prompt-receipt";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { Window } from "happy-dom";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import type { HistoryMessagesResponse, Session } from "../src/types.ts";
import type { ConversationReplyDrafts } from "../src/ConversationComposer.tsx";
import { assertNoElement } from "./support/domAssert.ts";
import { makeSession } from "./support/fixtures.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

type TestResult={ok:boolean;error?:string;outcomeUnknown?:boolean;queued?:boolean;refusalCode?:string;receipt?:PromptReceipt|null};
declare global {
  var __outboxSubmit: ((body:unknown)=>Promise<TestResult>)|undefined;
  var __outboxTranscript: {id:string;role:string;text:string;timestamp?:string}[]|undefined;
  var __outboxHistoryRead: (()=>Promise<HistoryMessagesResponse>)|undefined;
  var __outboxLookup: ((machine:string,id:string,requestId:string,incarnation:string)=>Promise<{ok:boolean;receipt?:PromptReceipt;error?:string}>)|undefined;
  var __outboxInput: ((machine:string,id:string,body:unknown)=>Promise<{ok:boolean;error?:string}>)|undefined;
}

const heldLocks = new Set<string>();
const browserLocks = {async request(name:string,_options:unknown,callback:(lock:object|null)=>unknown) {
  if(heldLocks.has(name))return callback(null);
  heldLocks.add(name);try{return await callback({name});}finally{heldLocks.delete(name);}
}};
const boundary: Plugin = {
  name: "outbox-api", enforce: "pre",
  resolveId(id, importer) {
    if (!importer?.includes("/src/")) return;
    if (id === "./api.ts") return "\0outbox-api";
    if (id === "./SpeechComposer.tsx") return "\0outbox-speech";
    if (id === "./resourceEvents.ts") return "\0outbox-resources";
  },
  load(id) {
    if (id === "\0outbox-api") return `export * from "/src/api.ts?outbox-original";
      export const submitSessionPrompt=async(_machine,id,body)=>{
        const result=await globalThis.__outboxSubmit(body);
        if(!body.request_id)return result;
        const outcome=result.ok?'submitted':result.outcomeUnknown?'unknown':'refused';
        return {...result,receipt:result.receipt===null?undefined:result.receipt??{request_id:body.request_id,session_id:id,session_incarnation:body.expected_session_incarnation,outcome,code:outcome==='submitted'?null:outcome==='unknown'?'structured-prompt-outcome-unknown':result.refusalCode??'provider-refused'}};
      };
      let sharedItems=[];
      export const readSharedOutbox=async()=>({revision:sharedItems.length,items:sharedItems,compose_holds:[]});
      export const admitSharedOutbox=async(target,id,text)=>{
        await globalThis.__outboxSubmit({text,expected_session_incarnation:target.incarnation,request_id:id});
        const item={id,text,session_incarnation:target.incarnation,state:'queued',revision:1,created_at:Date.now(),updated_at:Date.now(),request_id:null,receipt:null,edit_hold:null,error_code:null};
        sharedItems.push(item);return item;
      };
      export const lookupSessionPromptReceipt=(...args)=>globalThis.__outboxLookup(...args);
      export const sendSessionInput=(...args)=>globalThis.__outboxInput(...args);
      export const listHistorySessions=async machine=>({ok:true,truncated:false,latestMessagePaging:true,sessions:[{id:"history",machine,provider:"claude",
        provider_session_id:"fixture-thread",title:"Outbox work",cwd:"/workspace",created_at:"2030-01-01T00:00:00Z",updated_at:"2030-01-01T00:00:00Z",resumable:true}]});
      export const listHistoryMessages=async()=>globalThis.__outboxHistoryRead?globalThis.__outboxHistoryRead():({ok:true,messages:globalThis.__outboxTranscript??[]});`;
    if (id === "\0outbox-resources") return 'export const RESOURCE_RECONCILE_MS=30000;export const resourceEvents={subscribe(_key,_change,health){health(false);return()=>{};}};';
    if (id === "\0outbox-speech") return 'export function SpeechComposer(){return null;}';
  },
};
async function mount(factory = new IDBFactory()) {
  const window = new Window({url:"http://localhost"});
  const globals = {window, navigator:window.navigator, document:window.document, HTMLElement:window.HTMLElement, indexedDB:factory, IS_REACT_ACT_ENVIRONMENT:true};
  const saved = new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for (const [key,value] of Object.entries(globals)) Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  Object.defineProperty(window,"indexedDB",{value:factory,configurable:true});
  Object.defineProperty(window.navigator,"locks",{value:browserLocks,configurable:true});
  const container=window.document.createElement("div");window.document.body.append(container);
  const root=createRoot(container),ssr=createUiSsrHarness([boundary]);
  const {ConversationComposer}=await ssr.loadModule<typeof import("../src/ConversationComposer.tsx")>("/src/ConversationComposer.tsx");
  const {LiveConversationPanel}=await ssr.loadModule<typeof import("../src/LiveConversationPanel.tsx")>("/src/LiveConversationPanel.tsx");
  const {OutgoingReplies}=await ssr.loadModule<typeof import("../src/OutgoingReplies.tsx")>("/src/OutgoingReplies.tsx");
  // #969: replies are bubbles at the end of the conversation; this transcript feeds them.
  let transcript:{id:string;role:"user"|"assistant";text:string;timestamp?:string}[]=[];
  const requests:unknown[]=[];
  const drafts: ConversationReplyDrafts = new Map();
  const queueModule = await ssr.loadModule<typeof import("../src/conversationOutbox.ts")>("/src/conversationOutbox.ts");
  let latestSession: Session;
  let submit: (() => Promise<typeof response>) | undefined;
  let response:TestResult={ok:true};
  const lookups:unknown[]=[];
  let lookup:typeof globalThis.__outboxLookup;
  globalThis.__outboxLookup=async(machine,id,requestId,incarnation)=>{lookups.push({machine,id,requestId,incarnation});return lookup?lookup(machine,id,requestId,incarnation):{ok:true,receipt:{request_id:requestId,session_id:id,session_incarnation:incarnation,outcome:"unknown",code:"structured-prompt-outcome-unknown"}};};
  globalThis.__outboxSubmit=async body=>{requests.push(body);return submit ? submit() : response;};
  // #995: keys sent to the terminal input, such as Clear draft.
  const inputs:unknown[]=[];
  globalThis.__outboxInput=async(machine,id,body)=>{inputs.push({machine,id,body});return {ok:true};};
  const editor=()=>container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to session"]')!;
  const button=(label:string)=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.getAttribute('aria-label')===label||node.textContent===label);
  // #1002 review F1: the tile and the full panel can show one session's replies at once.
  let replyViews=1;
  // #921: the Dashboard's Recover, as the conversation panes pass it.
  let recovery:{onRecover():void;pending:boolean}|undefined;
  // #921: the view's switch to the terminal, where it has one.
  let onTerminal:(()=>void)|undefined;
  let messagesReady=false;
  const render=async(phase:string,revision=1,overrides:Partial<Session>={},background=false,reachable=true)=>{
    // Codex keeps the idle-gated queue the #908 tests cover; #943 tests pass Claude.
    const session=makeSession({machine:"fixture",id:"outbox",agent:"codex",provider_resume:{provider:"codex",session_id:"fixture-thread"},session_incarnation:"inc-1",
      turn_state:{schema_version:"agent-session.turn-state.v1",phase,revision,phase_changed_at:`2030-01-01T00:00:0${revision}Z`,source:{kind:"provider_hook",provider:"codex",confidence:"authoritative"},...(phase==="working"?{current_turn:{started_at:"2030-01-01T00:00:00Z"}}:{})} as never,...overrides});
    latestSession=session;
    function Background(){queueModule.useConversationOutboxDelivery([session],new Set(reachable?["fixture"]:[]),drafts);return null;}
    await act(async()=>root.render(createElement(Fragment,null,...Array.from({length:replyViews},(_,view)=>createElement(OutgoingReplies,{key:`replies-${view}`,session,messages:transcript})),
      background ? createElement(Background) : createElement(ConversationComposer,{session,machineReachable:reachable,replyDrafts:drafts,messages:transcript,messagesReady,recovery,onTerminal,onBusyChange(){},onVoiceOpenChange(){}}))));
    await settle();
  };
  async function settle(){await act(async()=>{for(let i=0;i<20;i++)await new Promise<void>(resolve=>setImmediate(resolve));});}
  // #969: the live panel, whose transcript can prove a reply delivered.
  const renderLivePanel=async()=>{
    await act(async()=>root.render(createElement(LiveConversationPanel,{session:latestSession,machineReachable:true,replyDrafts:drafts,docked:true,onClose(){}})));
    await settle();
  };
  const renderLiveView=async(view:"panel"|"phone"|"tile")=>{
    if(view==="panel")return renderLivePanel();
    if(view==="phone"){
      const {PhoneConversationPane}=await ssr.loadModule<typeof import("../src/PhoneConversationPane.tsx")>("/src/PhoneConversationPane.tsx");
      await act(async()=>root.render(createElement(PhoneConversationPane,{session:latestSession,machineReachable:true,replyDrafts:drafts,swipeEnabled:false,onSwipe(){},refreshRef:{current:null}})));
    }else{
      const {SessionConversationPane}=await ssr.loadModule<typeof import("../src/SessionConversationPane.tsx")>("/src/SessionConversationPane.tsx");
      await act(async()=>root.render(createElement(SessionConversationPane,{session:latestSession,machineReachable:true,replyDrafts:drafts})));
    }
    await settle();
  };
  const refreshLiveHistory=async()=>{
    await act(async()=>window.dispatchEvent(new window.Event("focus")));
    await settle();
  };
  return {factory,container,requests,lookups,inputs,editor,button,render,renderLivePanel,renderLiveView,refreshLiveHistory,settle,queueModule,
    lookup(value:typeof lookup){lookup=value;},session:()=>latestSession,
    replyViews(count:number){replyViews=count;},
    recovery(value:typeof recovery){recovery=value;},
    terminal(value:typeof onTerminal){onTerminal=value;},
    submit(value:typeof submit){submit=value;},
    response(value:typeof response){response=value;},
    async write(text:string){const node=editor(),key=Object.keys(node).find(key=>key.startsWith("__reactProps$"))!;await act(async()=>(node as unknown as Record<string,{onChange(e:{target:{value:string}}):void}>)[key]!.onChange({target:{value:text}}));},
    // Cases below retain the pre-shared local queue for BOTH providers. Seed a
    // historical intention through its storage owner; new producer behavior is
    // exercised by sharedOutboxClient.test.ts, never by this fixture helper.
    async reply(){
      const store=queueModule.conversationOutbox(),items=store.items(latestSession);
      const waiting=items.some(item=>item.state==="queued"||item.state==="dispatching"||(item.state==="refused"&&!item.unconfirmed)
        ||(item.state==="unknown"&&!item.handoff)||(item.state==="refused"&&item.unconfirmed&&queueModule.mayHoldIdlePaste(item,latestSession)));
      const phase=(latestSession.turn_state as {phase?:string})?.phase;
      const direct=phase!=="working"&&phase!=="starting"&&!waiting;
      const node=editor(),key=Object.keys(node).find(key=>key.startsWith("__reactProps$"))!;
      await act(async()=>{
        await store.enqueue(latestSession,node.value.trim(),{direct});
        (node as unknown as Record<string,{onChange(e:{target:{value:string}}):void}>)[key]!.onChange({target:{value:""}});
      });await settle();
    },
    async click(label:string){const node=button(label);assert.equal(Boolean(node),true,`${label} action exists`);await act(async()=>{node!.click();});await settle();},
    // Replies still pending: waiting, sent without proof, or refused. A delivered
    // bubble only waits for its transcript turn (#969).
    queued(){return [...container.querySelectorAll('[aria-label="Your replies"] > article:not([data-status="delivered"])')].map(row=>row.textContent).join("\n");},
    status(text:string){return [...container.querySelectorAll<HTMLElement>('[aria-label="Your replies"] > article')].find(row=>row.textContent?.includes(text))?.dataset.status;},
    async transcript(value:typeof transcript){transcript=value;messagesReady=true;await render(latestSession.turn_state ? (latestSession.turn_state as {phase:string}).phase : "idle",(latestSession.turn_state as {revision:number}).revision,latestSession);},
    async close(){await act(async()=>root.unmount());await ssr.close();delete globalThis.__outboxSubmit;delete globalThis.__outboxLookup;delete globalThis.__outboxInput;delete globalThis.__outboxHistoryRead;for(const[key,value]of saved)value?Object.defineProperty(globalThis,key,value):Reflect.deleteProperty(globalThis,key);await window.happyDOM.close();},
  };
}

test("#908 existing local Codex reply remains Queued, then delivers once after idle without terminal fallback (#638)",async()=>{
  const h=await mount();try{
    await h.render("working");await h.write("next task");
    assert.equal(h.button("Send reply")?.disabled,false,"busy Send accepts a queued reply");
    await h.reply();assert.equal(h.status("next task"),"queued");assert.equal(h.editor().value,"");assert.equal(h.requests.length,0);
    const attempt=h.queueModule.conversationOutbox().items(h.session())[0]!.requestId;
    await h.render("idle",2);assert.equal(h.requests.length,1);
    assert.deepEqual(h.requests[0],{text:"next task",expected_session_incarnation:"inc-1",request_id:attempt,require_idle:true});assert.equal(h.queued(),"");
    await h.render("idle",2);assert.equal(h.requests.length,1);
  }finally{await h.close();}
});
test("#908 reload while queued retains the message and delivers it once",async()=>{
  const factory=new IDBFactory();let h=await mount(factory);try{
    await h.render("working");await h.write("survive reload");await h.reply();assert.match(h.queued(),/survive reload/);
    await h.close();h=await mount(factory);await h.render("working");assert.equal(h.status("survive reload"),"queued");
    await h.render("idle",2);assert.equal(h.requests.length,1);assert.equal(h.queued(),"");
  }finally{await h.close();}
});
test("#908 definite delivery refusal keeps the queued item and offers safe retry",async()=>{
  const h=await mount();try{
    h.response({ok:false,error:"Delivery refused"});await h.render("working");await h.write("keep this");await h.reply();assert.match(h.queued(),/keep this/);
    await h.render("idle",2);assert.equal(h.requests.length,1);assert.match(h.queued(),/Delivery refused/);assert.match(h.queued(),/keep this/);
    h.response({ok:true});await h.click("Retry reply");assert.equal(h.requests.length,2);assert.equal(h.queued(),"");
  }finally{await h.close();}
});
test("#908 concurrent durable claims across clients dispatch only once",async()=>{
  const h=await mount();try{
    await h.render("working");await h.write("one claim");await h.reply();
    const first=h.queueModule.conversationOutbox();
    const second=new h.queueModule.ConversationOutbox(first.namespace);await second.ready;
    const idle={...h.session(),turn_state:{...h.session().turn_state,phase:"idle",phase_changed_at:"2030-01-01T00:00:02Z"}} as Session;
    await act(async()=>{await Promise.all([first.deliver(idle,true,()=>true),second.deliver(idle,true,()=>true)]);});
    assert.equal(h.requests.length,1);
  }finally{await h.close();}
});
test("#908 unknown delivery survives reload without automatic or Retry replay",async()=>{
  const factory=new IDBFactory();let h=await mount(factory);try{
    h.response({ok:false,outcomeUnknown:true});await h.render("working");await h.write("uncertain");await h.reply();
    await h.render("idle",2);assert.equal(h.requests.length,1);assert.equal(h.status("uncertain"),"sent");
    await h.close();h=await mount(factory);await h.render("idle",2);assert.match(h.queued(),/uncertain/);assert.equal(h.requests.length,0);
    assert.equal(Boolean(h.button("Retry reply")),false);await h.render("working",3);await h.render("idle",4);assert.equal(h.requests.length,0);
  }finally{await h.close();}
});
test("#908 a persisted dispatch claim is not reclaimed after a reload before ACK",async()=>{
  const factory=new IDBFactory();let h=await mount(factory);let finish:(value:{ok:boolean})=>void=()=>{};
  try{
    h.submit(()=>new Promise(resolve=>{finish=resolve;}));await h.render("working");await h.write("in flight");await h.reply();await h.render("idle",2);
    assert.equal(h.requests.length,1);await h.close();h=await mount(factory);await h.render("idle",2);
    assert.match(h.queued(),/in flight/);assert.equal(h.requests.length,0);assert.equal(Boolean(h.button("Retry reply")),false);
    finish({ok:true});await h.settle();assert.equal(h.requests.length,0);
  }finally{await h.close();}
});
test("#908 FIFO sends one per idle transition and waits for an empty composer",async()=>{
  const h=await mount();try{
    await h.render("working");await h.write("first");await h.reply();await h.write("second");await h.reply();
    await h.write("drafting");await h.render("idle",2);assert.equal(h.requests.length,0);
    await h.write("");await h.settle();assert.equal(h.requests.length,1);assert.match(h.queued(),/second/);
    await h.render("idle",2);assert.equal(h.requests.length,1);await h.render("working",3);assert.equal(h.requests.length,1);
    await h.render("idle",4);assert.equal(h.requests.length,2);assert.equal(h.queued(),"");
  }finally{await h.close();}
});
test("#908 replacement incarnation retains the queued item and refuses dispatch",async()=>{
  const h=await mount();try{
    await h.render("working");await h.write("old target");await h.reply();await h.render("idle",2,{session_incarnation:"inc-2"});
    assert.equal(h.requests.length,0);assert.match(h.queued(),/old target/);assert.match(h.queued(),/restarted/);
  }finally{await h.close();}
});
test("#908 Dashboard delivery hook flushes after the composer view unmounts",async()=>{
  const h=await mount();try{
    await h.render("working");await h.write("background");await h.reply();await h.render("working",1,{},true);
    assert.equal(h.requests.length,0);await h.render("idle",2,{},true);assert.equal(h.requests.length,1);
  }finally{await h.close();}
});

test("#908 guard changes while waiting for storage prevent provider dispatch",async()=>{
  const h=await mount();try{
    await h.render("working");await h.write("stay queued");await h.reply();
    const idle={...h.session(),turn_state:{...h.session().turn_state,phase:"idle",phase_changed_at:"2030-01-01T00:00:02Z"}} as Session;
    let allowed=true;
    await act(async()=>{const pending=h.queueModule.conversationOutbox().deliver(idle,true,()=>allowed);allowed=false;await pending;});
    assert.equal(h.requests.length,0);assert.match(h.queued(),/stay queued/);
  }finally{await h.close();}
});

test("#908 busy receipt keeps FIFO item and rotates only its definitely refused attempt after fresh idle",async()=>{
  const h=await mount();try{
    h.response({ok:false,refusalCode:"busy",error:"The session is busy."});await h.render("working");await h.write("busy race");await h.reply();
    const initial=h.queueModule.conversationOutbox().items(h.session())[0]!;
    await h.render("idle",2);assert.equal(h.requests.length,1);assert.match(h.queued(),/busy race/);assert.equal(Boolean(h.button("Retry reply")),false);
    await h.render("idle",2);assert.equal(h.requests.length,1);h.response({ok:true});await h.render("working",3);await h.render("idle",4);
    assert.equal(h.requests.length,2);const attempts=h.requests as {request_id:string}[];
    assert.equal(attempts[0]!.request_id,initial.requestId);assert.notEqual(attempts[0]!.request_id,attempts[1]!.request_id);assert.equal(h.queued(),"");
  }finally{await h.close();}
});
test("#908 reload reconciles a lost positive ACK through lookup without a second POST",async()=>{
  const factory=new IDBFactory();let h=await mount(factory);try{
    h.response({ok:false,outcomeUnknown:true});await h.render("working");await h.write("find receipt");await h.reply();await h.render("idle",2);
    const attempt=(h.requests[0] as {request_id:string}).request_id;await h.close();h=await mount(factory);
    h.lookup(async(_m,id,requestId,incarnation)=>({ok:true,receipt:{request_id:requestId,session_id:id,session_incarnation:incarnation,outcome:"submitted",code:null}}));
    await h.render("idle",2);assert.equal(h.requests.length,0);assert.equal(h.queued(),"");assert.deepEqual(h.lookups,[{machine:"fixture",id:"outbox",requestId:attempt,incarnation:"inc-1"}]);
  }finally{await h.close();}
});
test("#908 missing receipt never rotates an uncertain attempt or authorizes replay",async()=>{
  const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});h.lookup(async()=>({ok:false,error:"No receipt yet"}));
    await h.render("working");await h.write("retain unknown");await h.reply();await h.render("idle",2);
    const attempt=h.queueModule.conversationOutbox().items(h.session())[0]!.requestId;
    await h.render("working",3);await h.render("idle",4);
    assert.equal(h.requests.length,1);assert.equal(h.queueModule.conversationOutbox().items(h.session())[0]!.requestId,attempt);assert.match(h.queued(),/retain unknown/);
  }finally{await h.close();}
});
test("#908 positive provider-queued receipt is accepted once without another attempt",async()=>{
  const h=await mount();try{
    h.response({ok:true,queued:true});await h.render("working");await h.write("guarded race acknowledged");await h.reply();await h.render("idle",2);
    assert.equal(h.queued(),"");await h.render("working",3);await h.render("idle",4);assert.equal(h.requests.length,1);
  }finally{await h.close();}
});

// #969: an uncertain idle attempt needs no action and shows no warning (#973:
// it no longer holds the next reply either).
test("#908 an uncertain idle attempt asks nothing of the owner",async()=>{
  const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});await h.render("working");
    await h.write("uncertain first");await h.reply();await h.write("next task");await h.reply();
    await h.render("idle",2);assert.equal(h.requests.length,2,"the next reply follows in the same idle period (#973 G2)");
    assert.equal(h.status("uncertain first"),"sent","a plain bubble, no warning");
    for(const label of ["Check queued delivery","Check delivery","I checked the session; remove"])assert.equal(Boolean(h.button(label)),false,`no ${label} button`);
    assert.doesNotMatch(h.container.textContent??"",/Delivery uncertain|Delivery may have happened/);
  }finally{await h.close();}
});
test("#908 reconnect looks up an uncertain attempt again without replaying it",async()=>{
  const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});await h.render("working");await h.write("reconnect receipt");await h.reply();await h.render("idle",2);
    const before=h.lookups.length;assert.equal(before,1);
    h.lookup(async(_m,id,requestId,incarnation)=>({ok:true,receipt:{request_id:requestId,session_id:id,session_incarnation:incarnation,outcome:"submitted",code:null}}));
    await h.render("idle",2,{},false,false);await h.render("idle",2);
    assert.equal(h.lookups.length,before+1);assert.equal(h.requests.length,1);assert.equal(h.queued(),"");
  }finally{await h.close();}
});
test("#908 conflicting request key retains the current text without looking up a different payload",async()=>{
  const h=await mount();try{
    h.response({ok:false,refusalCode:"request-id-conflict",receipt:null,error:"Request identifier conflict"});
    await h.render("working");await h.write("current text");await h.reply();await h.render("idle",2);
    const first=(h.requests[0] as {request_id:string}).request_id;
    assert.equal(h.lookups.length,0);assert.match(h.queued(),/current text/);assert.ok(h.button("Retry reply"));
    h.response({ok:true});await h.click("Retry reply");assert.equal(h.requests.length,2);assert.notEqual((h.requests[1] as {request_id:string}).request_id,first);assert.equal(h.queued(),"");
  }finally{await h.close();}
});

test("#908 another window cannot reconcile a conflicting request while POST is pending",async()=>{
  const h=await mount();let finish:(value:TestResult)=>void=()=>{};
  try{
    h.submit(()=>new Promise(resolve=>{finish=resolve;}));await h.render("working");await h.write("current conflicting text");await h.reply();await h.render("idle",2);
    const first=h.queueModule.conversationOutbox(),second=new h.queueModule.ConversationOutbox(first.namespace);await second.ready;
    h.lookup(async(_m,id,requestId,incarnation)=>({ok:true,receipt:{request_id:requestId,session_id:id,session_incarnation:incarnation,outcome:"submitted",code:null}}));
    await act(async()=>{await second.reconcile(h.session(),true);});assert.equal(h.lookups.length,0);
    finish({ok:false,refusalCode:"request-id-conflict",receipt:null,error:"Conflict"});await h.settle();
    await second.verifyQueuedReplies("fixture","outbox");await act(async()=>{await second.reconcile(h.session(),true);});
    assert.equal(h.lookups.length,0);assert.equal(second.items(h.session())[0]?.state,"refused");assert.equal(second.items(h.session())[0]?.text,"current conflicting text");
  }finally{finish({ok:false,receipt:null});await h.settle();await h.close();}
});


for(const background of [false,true])test(`#908 ${background?'Dashboard':'composer'} delayed claim consumes the latest idle epoch once`,async()=>{
  const h=await mount();let release=()=>{};try{
    await h.render("working");await h.write("first");await h.reply();await h.write("second");await h.reply();
    const gate=new Promise<void>(resolve=>{release=resolve;});let held=false,first=true;
    Object.defineProperty(navigator,"locks",{configurable:true,value:{async request(_name:string,_options:unknown,callback:(lock:object|null)=>unknown){
      if(held)return callback(null);held=true;try{if(first){first=false;await gate;}return await callback({});}finally{held=false;}
    }}});
    const oldIdle={...h.session(),turn_state:{...h.session().turn_state,phase:"idle",phase_changed_at:"2030-01-01T00:00:02Z"}} as Session;
    let pending:Promise<void>;
    await act(async()=>{pending=h.queueModule.conversationOutbox().deliver(oldIdle,true,()=>true);});
    await h.render("working",3,{},background);await h.render("idle",4,{},background);await act(async()=>{release();await pending;});await h.settle();
    assert.equal(h.requests.length,1,"one task in the current idle epoch");assert.match(h.queued()||h.queueModule.conversationOutbox().items(h.session())[0]?.text||"",/second/);
    await h.render("working",5,{},background);await h.render("idle",6,{},background);assert.equal(h.requests.length,2);
    assert.equal(h.queueModule.conversationOutbox().items(h.session()).filter(item=>item.state!=="delivered").length,0,"only delivered bubbles remain");
  }finally{release();await h.settle();await h.close();}
});

test("#908 an older runtime without keyed prompts marks the reply Not sent once, with no lookup or unkeyed resend",async()=>{
  const h=await mount();try{
    h.response({ok:false,refusalCode:"keyed-prompt-unsupported",receipt:null,error:"This host's agent-session runtime does not support queued replies. The reply was not sent; send it when the session is idle."});
    await h.render("working");await h.write("reply for an older host");await h.reply();await h.render("idle",2);
    assert.equal(h.requests.length,1);assert.equal(h.lookups.length,0);
    assert.equal(h.queueModule.conversationOutbox().items(h.session())[0]?.state,"refused");
    assert.equal(h.status("reply for an older host"),"refused");assert.match(h.container.textContent??"",/does not support queued replies/);
    await h.render("idle",3);assert.equal(h.requests.length,1,"no automatic resend on the next idle transition");assert.equal(h.lookups.length,0);
    assert.ok(h.requests.every(body=>typeof (body as {request_id?:unknown}).request_id==="string"),"never an unkeyed replay");
  }finally{await h.close();}
});

// #953: a controllable clock for the hand-off grace window. Long timers
// (1 s and more) are held until advance(); short ones run as usual.
function graceClock(start=1_800_000_000_000){
  const realNow=Date.now,realTimeout=globalThis.setTimeout;let now=start;const due:{at:number;run:()=>void}[]=[];
  Date.now=()=>now;
  globalThis.setTimeout=((run:()=>void,delay=0,...args:unknown[])=>{
    if(delay<1000)return realTimeout(run,delay,...args);
    due.push({at:now+delay,run});return 0;
  }) as unknown as typeof setTimeout;
  return {
    async advance(ms:number,settle:()=>Promise<void>){
      now+=ms;
      for(const timer of due.splice(0)){if(timer.at<=now)await act(async()=>{timer.run();});else due.push(timer);}
      await settle();
    },
    restore(){Date.now=realNow;globalThis.setTimeout=realTimeout;},
  };
}
// #943: boundary-time prompts (mailbox reminders, chat relays) start the next
// turn before a remote client can use an idle moment, so a Claude reply that
// only waits for idle can stay queued forever.
type PromptBody={text:string;request_id:string;require_idle?:boolean};
const claude={agent:"claude",provider_resume:{provider:"claude",session_id:"fixture-thread"}} as Partial<Session>;
test("#943 a busy Claude session that keeps taking boundary prompts still receives the queued reply",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.submit(async()=>(h.requests.at(-1) as PromptBody).require_idle
      ? {ok:false,refusalCode:"busy",error:"The session is busy."} : {ok:true,queued:true});
    await h.render("idle",1,claude);
    await act(async()=>h.queueModule.conversationOutbox().enqueue(h.session(),"steady reply"));await h.settle();
    assert.equal(h.requests.length,1);assert.equal((h.requests[0] as PromptBody).require_idle,true,"an idle attempt keeps the idle guard");
    assert.match(h.queued(),/steady reply/,"a lost idle race keeps the reply");
    await h.render("working",2,claude);await clock.advance(5000,h.settle);
    await h.render("idle",3,claude);await h.render("working",4,claude);
    assert.equal(h.queued(),"","the reply left the queue");
    const handoffs=(h.requests as PromptBody[]).filter(body=>!body.require_idle);
    assert.equal(handoffs.length,1,"handed to the busy session exactly once");
    assert.deepEqual(handoffs[0],{text:"steady reply",expected_session_incarnation:"inc-1",request_id:handoffs[0]!.request_id});
    assert.notEqual(handoffs[0]!.request_id,(h.requests[0] as PromptBody).request_id,"the refused attempt is not reused");
  }finally{await h.close();clock.restore();}
});
test("#943 a reply handed to a busy Claude session cannot be cancelled and stays a plain bubble",async()=>{
  const clock=graceClock();const h=await mount();try{
    let finish:(value:{ok:boolean;queued?:boolean})=>void=()=>{};
    h.submit(()=>new Promise(resolve=>{finish=resolve;}));
    await h.render("working",1,claude);await h.write("while you work");await h.reply();
    await clock.advance(5000,h.settle);
    assert.equal(h.requests.length,1);assert.equal((h.requests[0] as PromptBody).require_idle,undefined);
    assert.equal(h.status("while you work"),"sent","handed off: a plain bubble");
    assertNoElement(h.container,'[aria-label="Your replies"] button[aria-haspopup="menu"]');
    await act(async()=>finish({ok:true,queued:true}));await h.settle();
    assert.equal(h.status("while you work"),"delivered","still a plain bubble once delivered");assert.equal(h.queued(),"");assert.equal(h.requests.length,1);
  }finally{await h.close();clock.restore();}
});
test("#943 a Codex reply observed idle before the grace ends keeps the idle guard",async()=>{
  const h=await mount();try{
    await h.render("working",1);await h.write("codex later");await h.reply();
    assert.equal(h.requests.length,0);assert.equal(h.status("codex later"),"queued");
    await h.render("idle",2);assert.equal(h.requests.length,1);
    assert.equal((h.requests[0] as PromptBody).require_idle,true);assert.equal(h.queued(),"");
  }finally{await h.close();}
});

// #969 (was #942's one-line rows): each waiting reply is the owner's own bubble
// with a clock, and its menu cancels only that reply.
test("legacy local replies are immutable bubbles without delivery badges or action menus",async()=>{
  const h=await mount();try{
    await h.render("working",1);
    await h.write("first queued reply that is long enough to wrap on a phone screen");await h.reply();
    await h.write("second reply");await h.reply();
    const rows=()=>[...h.container.querySelectorAll<HTMLElement>('[aria-label="Your replies"] > article')];
    assert.equal(rows().length,2);
    for(const row of rows()){
      assert.equal(row.dataset.status,"queued");assert.equal(row.getAttribute("aria-label"),"You");
      assertNoElement(row,'.history-outgoing-status, [aria-haspopup="menu"]');
      assertNoElement(row,'[role="menu"]');
    }
    assertNoElement(h.container,".conversation-queued-replies");
    assert.equal(rows().length,2);assert.match(h.queued(),/second reply/);assert.match(h.queued(),/first queued/);
    assert.equal(h.requests.length,0);
  }finally{await h.close();}
});

// #953 (owner option B): a reply for a busy Claude session waits a 5 s grace
// window with a working X before it is handed to the session's own queue.
test("#953 a reply that is not cancelled is handed off after 5 s, keyed and without the idle guard",async()=>{
  const clock=graceClock();const h=await mount();try{
    await h.render("working",1,claude);await h.write("after grace");await h.reply();
    const attempt=h.queueModule.conversationOutbox().items(h.session())[0]!.requestId;
    await clock.advance(4999,h.settle);assert.equal(h.requests.length,0,"not before 5 s");
    await clock.advance(1,h.settle);
    assert.deepEqual(h.requests,[{text:"after grace",expected_session_incarnation:"inc-1",request_id:attempt}]);
    assert.equal(h.queued(),"","the receipt clears the row");
    await clock.advance(10000,h.settle);assert.equal(h.requests.length,1,"delivered once");
  }finally{await h.close();clock.restore();}
});
test("#953 an idle Claude session takes the queued reply at once, without the grace delay",async()=>{
  const clock=graceClock();const h=await mount();try{
    await h.render("working",1,claude);await h.write("when idle");await h.reply();
    assert.equal(h.requests.length,0);
    await h.render("idle",2,claude);
    assert.equal(h.requests.length,1,"no grace for an idle session");
    assert.equal((h.requests[0] as PromptBody).require_idle,true);
  }finally{await h.close();clock.restore();}
});

// #957: two replies sent moments apart to a busy Claude session. The first is
// handed off; the second must follow it into Claude's own queue instead of
// waiting for the turn boundary, where an idle-guarded paste races Claude
// submitting its queue and can leave the text in Claude's input.
test("#957 two replies queued for a busy Claude session are both handed off in order, never as an idle attempt",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:true,queued:true});
    await h.render("working",1,claude);
    await h.write("first reply");await h.reply();
    await h.write("second reply");await h.reply();
    assert.equal(h.requests.length,0,"both wait out the grace window");
    await clock.advance(5000,h.settle);
    const bodies=h.requests as PromptBody[];
    assert.deepEqual(bodies.map(body=>[body.text,body.require_idle]),[["first reply",undefined],["second reply",undefined]],"both handed off, in order");
    assert.equal(h.queued(),"");
    await h.render("idle",2,claude);await h.render("working",3,claude);await clock.advance(10000,h.settle);
    assert.equal(h.requests.length,2,"each delivered once; no idle-guarded attempt at the turn boundary");
  }finally{await h.close();clock.restore();}
});

// #957 (tool-call turn): the daemon can report a hand-off as unknown although
// Claude took it. That reply is never sent again, so it must not hold back the
// replies queued behind it, in the same turn or after it ends.
test("#957 an uncertain hand-off does not hold back the next reply for a busy Claude session",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.submit(async()=>h.requests.length===1?{ok:false,outcomeUnknown:true}:{ok:true,queued:true});
    await h.render("working",1,claude);
    await h.write("first reply");await h.reply();
    await h.write("second reply");await h.reply();
    await clock.advance(5000,h.settle);
    const bodies=h.requests as PromptBody[];
    assert.deepEqual(bodies.map(body=>[body.text,body.require_idle]),[["first reply",undefined],["second reply",undefined]],"the second reply follows the uncertain hand-off");
    assert.match(h.queued(),/first reply/,"the uncertain reply stays listed for the owner");
    assert.doesNotMatch(h.queued(),/second reply/);
    await h.render("idle",2,claude);await h.render("working",3,claude);await clock.advance(10000,h.settle);
    assert.equal(h.requests.length,2,"neither reply is sent again");
  }finally{await h.close();clock.restore();}
});
test("#957 after a reload, the reply behind an uncertain hand-off goes out once when the session is idle",async()=>{
  const factory=new IDBFactory();const clock=graceClock();let h=await mount(factory);try{
    let release:()=>void=()=>{};
    h.submit(()=>new Promise(resolve=>{release=()=>resolve({ok:false,outcomeUnknown:true});}));
    await h.render("working",1,claude);
    await h.write("first reply");await h.reply();
    await clock.advance(5000,h.settle);
    await h.write("second reply");await h.reply();
    await act(async()=>release());await h.settle();
    assert.equal(h.requests.length,1,"the second reply is still inside its grace window");
    await h.close();h=await mount(factory);h.response({ok:true});
    await h.render("idle",2,claude);
    const bodies=h.requests as PromptBody[];
    assert.deepEqual(bodies.map(body=>[body.text,body.require_idle]),[["second reply",true]],"sent once, with the idle guard");
    assert.match(h.queued(),/first reply/);assert.doesNotMatch(h.queued(),/second reply/);
  }finally{await h.close();clock.restore();}
});
test("#957 after a reload, a hand-off behind an uncertain one is looked up and cleared by its receipt",async()=>{
  const factory=new IDBFactory();const clock=graceClock();let h=await mount(factory);try{
    h.submit(()=>h.requests.length===1?Promise.resolve({ok:false,outcomeUnknown:true}):new Promise(()=>{}));
    await h.render("working",1,claude);
    await h.write("first reply");await h.reply();
    await h.write("second reply");await h.reply();
    await clock.advance(5000,h.settle);
    assert.equal(h.requests.length,2,"both handed off; the second POST is still pending");
    const second=(h.requests[1] as PromptBody).request_id;
    // A reload ends the pending POST and releases the page's Web Locks.
    await h.close();heldLocks.clear();h=await mount(factory);
    h.lookup(async(_m,id,requestId,incarnation)=>requestId===second
      ?{ok:true,receipt:{request_id:requestId,session_id:id,session_incarnation:incarnation,outcome:"submitted",code:null}}
      :{ok:true,receipt:{request_id:requestId,session_id:id,session_incarnation:incarnation,outcome:"unknown",code:"structured-prompt-outcome-unknown"}});
    await h.render("working",1,claude);
    assert.ok((h.lookups as {requestId:string}[]).some(lookup=>lookup.requestId===second),"the later hand-off is looked up");
    assert.match(h.queued(),/first reply/);assert.doesNotMatch(h.queued(),/second reply/,"its receipt clears it");
    assert.equal(h.requests.length,0,"nothing is sent again");
  }finally{await h.close();clock.restore();}
});

// #969 A: the transcript proves delivery. A reply already handed to the session
// counts as delivered when its exact text is a later user turn, so an uncertain
// row clears on its own and stops holding back the next reply. Never resends.
const userTurn=(id:string,text:string,at:number)=>({id,role:"user" as const,text,timestamp:new Date(at).toISOString()});
test("#969 an uncertain hand-off clears once its text is a user turn in the transcript",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("working",1,claude);await h.write("check the build");await h.reply();
    await clock.advance(5000,h.settle);
    assert.equal(h.requests.length,1);assert.match(h.queued(),/check the build/,"uncertain after the unknown receipt");
    const outbox=h.queueModule.conversationOutbox();
    await act(async()=>outbox.confirmFromTranscript(h.session(),[userTurn("u1","check   the build\n",Date.now()+2000)]));await h.settle();
    assert.equal(h.queued(),"","the transcript turn clears the row");
    assert.equal(h.requests.length,1,"nothing is sent again");
  }finally{await h.close();clock.restore();}
});
test("#969 a transcript turn from before the attempt, or a reply never sent, is not proof",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("working",1,claude);await h.write("same words");await h.reply();
    await clock.advance(5000,h.settle);
    const outbox=h.queueModule.conversationOutbox();
    await act(async()=>outbox.confirmFromTranscript(h.session(),[userTurn("old","same words",Date.now()-10*60_000),{id:"no-time",role:"user",text:"same words"}]));await h.settle();
    assert.match(h.queued(),/same words/,"an older turn or one without a time does not clear it");
    await h.render("working",2);await h.write("not yet sent");await h.reply();
    await act(async()=>outbox.confirmFromTranscript(h.session(),[userTurn("u2","not yet sent",Date.now()+1000)]));await h.settle();
    assert.equal(h.status("not yet sent"),"queued","a reply that was never attempted stays queued");
  }finally{await h.close();clock.restore();}
});
test("#969 one transcript turn confirms only one of two identical replies",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("working",1,claude);
    await h.write("ok");await h.reply();await h.write("ok");await h.reply();
    await clock.advance(5000,h.settle);
    assert.equal(h.requests.length,2,"both handed off (uncertain hand-offs do not block)");
    const outbox=h.queueModule.conversationOutbox();
    await act(async()=>outbox.confirmFromTranscript(h.session(),[userTurn("u1","ok",Date.now()+1000)]));await h.settle();
    assert.equal(outbox.items(h.session()).length,1,"one turn, one reply");
    await act(async()=>outbox.confirmFromTranscript(h.session(),[userTurn("u1","ok",Date.now()+1000)]));await h.settle();
    assert.equal(outbox.items(h.session()).length,1,"the same turn never confirms a second reply");
    await act(async()=>outbox.confirmFromTranscript(h.session(),[userTurn("u1","ok",Date.now()+1000),userTurn("u3","ok",Date.now()+3000)]));await h.settle();
    assert.equal(outbox.items(h.session()).length,0,"a second turn confirms the second reply");
  }finally{await h.close();clock.restore();}
});
test("#969 an uncertain idle attempt seen in the transcript stops holding back the next reply",async()=>{
  const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});await h.render("working");
    await h.write("uncertain first");await h.reply();await h.write("next task");await h.reply();
    await h.render("idle",2);
    assert.deepEqual((h.requests as PromptBody[]).map(body=>body.text),["uncertain first","next task"],"the next reply follows in the same idle period (#973 G2)");
    const outbox=h.queueModule.conversationOutbox();
    await act(async()=>outbox.confirmFromTranscript(h.session(),[userTurn("u1","uncertain first",Date.now()+1000)]));await h.settle();
    assert.doesNotMatch(h.queued(),/uncertain first/);
    h.response({ok:true});await h.render("working",3);await h.render("idle",4);
    assert.equal(h.requests.length,2,"nothing is sent again");
  }finally{await h.close();}
});
test("#969 the Conversation panel clears an uncertain row from the session transcript on its own",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("working",1,claude);await h.write("from the panel");await h.reply();
    await clock.advance(5000,h.settle);
    assert.match(h.queued(),/from the panel/);
    globalThis.__outboxTranscript=[userTurn("u1","from the panel",Date.now()+1500)];
    await h.renderLivePanel();
    for(let i=0;i<20&&h.queued()!=="";i++)await h.settle();
    assert.equal(h.queued(),"","the panel's transcript clears the row without any button");
    assert.equal(h.requests.length,1);
  }finally{delete globalThis.__outboxTranscript;await h.close();clock.restore();}
});

// #969 B: replies are the owner's bubbles at the end of the conversation.
test("#969 a reply's bubble is marked Queued, then plain, and gives way to its transcript turn without a duplicate",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("working",1,claude);await h.write("bubble please");await h.reply();
    assert.equal(h.status("bubble please"),"queued","marked Queued while it waits");
    await clock.advance(5000,h.settle);
    assert.equal(h.status("bubble please"),"sent","a plain bubble once handed off");
    await h.transcript([userTurn("u1","bubble please",Date.now()+1000)]);
    assert.equal(h.status("bubble please"),undefined,"the transcript turn replaces the bubble");
  }finally{await h.close();clock.restore();}
});
test("#969 a submitted reply stays a plain bubble until its transcript turn arrives",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:true,queued:true});
    await h.render("working",1,claude);await h.write("queued in claude");await h.reply();
    await clock.advance(5000,h.settle);
    assert.equal(h.status("queued in claude"),"delivered","kept while Claude holds it in its queue");
    assertNoElement(h.container,'[data-status="delivered"] .history-outgoing-status');
    await h.transcript([userTurn("u1","queued in claude",Date.now()+30_000)]);
    assert.equal(h.status("queued in claude"),undefined,"the transcript turn replaces the bubble; the live reader then settles it");
  }finally{await h.close();clock.restore();}
});
test("#969 a delivered bubble the transcript never shows leaves after a later turn completes",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:true,queued:true});
    await h.render("working",1,claude);await h.write("rewritten by the provider");await h.reply();
    await clock.advance(5000,h.settle);
    assert.equal(h.status("rewritten by the provider"),"delivered");
    const iso=(offset:number)=>new Date(Date.now()+offset).toISOString();
    await h.render("idle",2,{...claude,turn_state:{schema_version:"agent-session.turn-state.v1",phase:"idle",revision:2,phase_changed_at:iso(-1000),
      source:{kind:"provider_hook",provider:"claude",confidence:"authoritative"},last_turn:{started_at:iso(-60_000-90_000),completed_at:iso(-1000),outcome:"completed"}} as never});
    assert.equal(h.status("rewritten by the provider"),"delivered","the turn that was running when it was sent does not count");
    await h.render("idle",3,{...claude,turn_state:{schema_version:"agent-session.turn-state.v1",phase:"idle",revision:3,phase_changed_at:iso(2000),
      source:{kind:"provider_hook",provider:"claude",confidence:"authoritative"},last_turn:{started_at:iso(1000),completed_at:iso(2000),outcome:"completed"}} as never});
    assert.equal(h.status("rewritten by the provider"),undefined,"a turn that began after it has completed");
    assert.equal(h.requests.length,1,"nothing is sent again");
  }finally{await h.close();clock.restore();}
});
test("a definite refusal shows a concise error with Retry and a new attempt identity",async()=>{
  const h=await mount();try{
    h.response({ok:false,refusalCode:"session-not-running",receipt:undefined});
    await h.render("working");await h.write("please retry");await h.reply();
    h.response({ok:false,error:"Refused by the provider."});await h.render("idle",2);
    assert.equal(h.status("please retry"),"refused");
    assert.match(h.container.querySelector('[data-status="refused"] [role="alert"]')?.textContent??"",/Refused by the provider/);
    assertNoElement(h.container,".history-outgoing-status");
    const first=(h.requests[0] as PromptBody).request_id;
    h.response({ok:true});await h.click("Retry reply");
    assert.equal(h.requests.length,2);assert.notEqual((h.requests[1] as PromptBody).request_id,first,"a new attempt ID");
  }finally{await h.close();}
});
test("#969 a delivered bubble does not make the next idle reply wait behind it",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:true,queued:true});
    await h.render("working",1,claude);await h.write("earlier");await h.reply();
    await clock.advance(5000,h.settle);assert.equal(h.status("earlier"),"delivered");
    h.response({ok:true});await h.render("idle",2,claude);
    await h.write("right now");await h.reply();
    assert.equal(h.requests.length,2,"sent at once");
    assert.equal((h.requests[1] as PromptBody).require_idle,undefined,"as a direct reply, without the idle guard");
  }finally{await h.close();clock.restore();}
});
// #969 B2: a reply to an idle session is a bubble too. It keeps the direct
// send's semantics (keyed, no idle guard), and an uncertain one locks nothing.
for(const agent of [claude,{}] as Partial<Session>[])test(`#969 an idle ${agent.agent??"codex"} reply shows as a bubble at once and goes out keyed without the idle guard`,async()=>{
  const h=await mount();try{
    let finish:(value:{ok:boolean})=>void=()=>{};
    h.submit(()=>new Promise(resolve=>{finish=resolve;}));
    await h.render("idle",1,agent);await h.write("straight away");await h.reply();
    assert.equal(h.editor().value,"","the composer clears");
    assert.equal(h.status("straight away"),"sent","a plain bubble while the send is in flight");
    assert.equal(h.requests.length,1);
    const body=h.requests[0] as PromptBody;
    assert.equal(typeof body.request_id,"string","keyed");assert.equal(body.require_idle,undefined,"no idle guard, as a direct send");
    await act(async()=>finish({ok:true}));await h.settle();
    assert.equal(h.status("straight away"),"delivered","still a plain bubble once delivered");
  }finally{await h.close();}
});
// Like the old direct send, two replies in the same idle period both go out at
// once; the one-guarded-attempt-per-idle fence is for queued replies (#993 F1).
test("#969 two direct replies in the same idle period both go out at once, keyed without the idle guard",async()=>{
  const h=await mount();try{
    await h.render("idle",1);
    await h.write("first direct");await h.reply();
    assert.equal(h.requests.length,1);assert.equal(h.status("first direct"),"delivered");
    await h.write("second direct");await h.reply();
    assert.equal(h.requests.length,2,"the second reply is not held for another idle transition");
    assert.equal(h.status("second direct"),"delivered");
    for(const body of h.requests as PromptBody[]){assert.equal(typeof body.request_id,"string");assert.equal(body.require_idle,undefined);}
  }finally{await h.close();}
});
// A direct reply skips the idle guard only while the session is idle. A Retry
// after the session turned busy keeps Codex's native idle guard (#976).
test("#969 a Retry of a direct Codex reply while the session works keeps the idle guard",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,error:"Refused by the provider."});
    await h.render("idle",1);await h.write("try again later");await h.reply();
    assert.equal(h.status("try again later"),"refused");
    assert.equal((h.requests[0] as PromptBody).require_idle,undefined,"sent while idle, as a direct reply");
    h.response({ok:true});await h.render("working",2);await h.click("Retry reply");await clock.advance(5000,h.settle);
    assert.equal(h.requests.length,2,"the Retry goes out");
    assert.equal((h.requests[1] as PromptBody).require_idle,true,"a busy Codex session gets the idle guard");
  }finally{await h.close();clock.restore();}
});
test("#969 an uncertain idle reply stays a plain bubble and never locks the composer",async()=>{
  const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("idle",1,claude);await h.write("maybe sent");await h.reply();
    assert.equal(h.status("maybe sent"),"sent","a plain bubble");
    assert.equal(Boolean(h.button("I checked the session")),false,"nothing to confirm by hand");
    h.response({ok:true});await h.render("idle",2,claude);
    await h.write("next one");assert.equal(h.button("Send reply")?.disabled,false,"the next reply can be sent");
  }finally{await h.close();}
});
// #995 (maintainer decision A): a reply is never merged into an owner draft in
// the terminal input. The daemon refuses a direct reply before dispatch
// (nils-cli#2622), and the bubble shows the draft state.
const draftRefusal={ok:false,refusalCode:"composer-not-empty",error:"The queued reply was refused (composer-not-empty)."};
for(const provider of ["claude","codex"] as const){
  const agent=provider==="claude"?claude:{};
  test(`#995 ${provider}: a reply refused for a terminal draft says to clear it in the terminal, offers Retry only, and is not resent`,async()=>{
    const clock=graceClock();const h=await mount();try{
      h.response(draftRefusal);
      await h.render("idle",1,agent);await h.write("not merged");await h.reply();
      assert.equal(h.status("not merged"),"refused");
      assert.match(h.container.textContent??"",/Terminal has a draft, so this reply was not sent\. Clear it in the terminal, then Retry\./);
      assert.equal(Boolean(h.button("Retry reply")),true,"Retry is offered");
      // #1000 review F1: the daemon's key route has no idle or incarnation
      // fence, so Console sends no keys to clear the draft.
      assert.equal(Boolean(h.button("Clear terminal draft")),false,"no Clear draft without a guarded key route");
      assert.deepEqual(h.inputs,[],"the draft is untouched");
      await h.render("idle",2,agent);await clock.advance(60_000,h.settle);
      assert.equal(h.requests.length,1,"never resent on its own");
    }finally{await h.close();clock.restore();}
  });
  test(`#995 ${provider}: after the owner clears the terminal, Retry delivers the reply once`,async()=>{
    const h=await mount();try{
      h.response(draftRefusal);
      await h.render("idle",1,agent);await h.write("after the clear");await h.reply();
      h.response({ok:true});await h.click("Retry reply");
      assert.equal(h.requests.length,2);
      const retry=h.requests[1] as PromptBody;
      assert.notEqual(retry.request_id,(h.requests[0] as PromptBody).request_id,"a fresh attempt the daemon checks again");
      assert.equal(h.status("after the clear"),"delivered");
      await h.render("idle",2,agent);assert.equal(h.requests.length,2,"delivered once");
      assert.deepEqual(h.inputs,[],"no keys were sent");
    }finally{await h.close();}
  });
}
test("#995 a draft refusal never sends keys to the terminal, whatever the session does next",async()=>{
  const h=await mount();try{
    h.response(draftRefusal);
    await h.render("idle",1,claude);await h.write("wait for idle");await h.reply();
    for(const [phase,revision] of [["working",2],["needs_input",3],["idle",4]] as const){
      await h.render(phase,revision,claude);
      assert.equal(Boolean(h.button("Clear terminal draft")),false,`no Clear draft while ${phase}`);
    }
    assert.deepEqual(h.inputs,[]);
  }finally{await h.close();}
});
test("#995 a reply refused because the terminal input cannot be read says so, with Retry and no Clear draft",async()=>{
  const h=await mount();try{
    h.response({ok:false,refusalCode:"composer-unobservable",error:"The queued reply was refused (composer-unobservable)."});
    await h.render("idle",1,claude);await h.write("cannot see the input");await h.reply();
    assert.equal(h.status("cannot see the input"),"refused");
    assert.match(h.container.textContent??"",/cannot read the terminal input/);
    assert.equal(Boolean(h.button("Retry reply")),true);
    assert.equal(Boolean(h.button("Clear terminal draft")),false,"an unreadable input cannot be proven cleared");
  }finally{await h.close();}
});
test("#995 an unknown refusal code keeps the daemon's own message, even one named like an object key",async()=>{
  const h=await mount();try{
    h.response({ok:false,refusalCode:"constructor",error:"The queued reply was refused (constructor)."});
    await h.render("idle",1,claude);await h.write("odd code");await h.reply();
    assert.match(h.container.textContent??"",/The queued reply was refused \(constructor\)\./);
  }finally{await h.close();}
});
// #994: a paste left unsubmitted in an idle session starts no later turn that
// could disprove it, so the bubble turns Not confirmed after a bounded wait.
test("#994 an uncertain reply to a session that stays idle becomes Not confirmed after a bounded wait, never resent",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("idle",1,claude);await h.write("left in the input");await h.reply();
    const wait=h.queueModule.UNCERTAIN_IDLE_REPLY_MS;
    await clock.advance(wait-1000,h.settle);
    assert.equal(h.status("left in the input"),"sent","a plain bubble while it may still arrive");
    await clock.advance(1000,h.settle);
    assert.equal(h.status("left in the input"),"refused");
    assert.match(h.container.textContent??"",/Not confirmed in the conversation/);
    assert.equal(Boolean(h.button("Retry reply")),true,"Retry is offered");
    await h.render("idle",1,claude);await clock.advance(wait,h.settle);
    assert.equal(h.requests.length,1,"never resent");
    await act(async()=>h.queueModule.conversationOutbox().confirmFromTranscript(h.session(),[userTurn("late","left in the input",Date.now())]));await h.settle();
    assert.equal(h.status("left in the input"),undefined,"a late transcript turn still clears it");
  }finally{await h.close();clock.restore();}
});
test("#994 an uncertain idle reply that a turn may have taken waits for that turn's transcript",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("idle",1,claude);await h.write("taken by a turn");await h.reply();
    await h.render("working",2,claude);await h.render("idle",3,claude);
    await clock.advance(2*h.queueModule.UNCERTAIN_IDLE_REPLY_MS,h.settle);
    assert.equal(h.status("taken by a turn"),"sent","the later turn's transcript decides it (#973)");
  }finally{await h.close();clock.restore();}
});
// The paste may still sit in the input while that idle phase lasts, so neither
// the next reply nor a Retry may paste on top of it (#973 N1).
test("#994 after an idle Not confirmed, the next reply and a Retry keep the idle guard",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("idle",1,claude);await h.write("maybe left over");await h.reply();
    await clock.advance(h.queueModule.UNCERTAIN_IDLE_REPLY_MS,h.settle);
    assert.equal(h.status("maybe left over"),"refused");
    h.response({ok:false,refusalCode:"busy",error:"The session is busy."});
    await h.write("after it");await h.reply();
    await h.click("Retry reply");
    const later=(h.requests as PromptBody[]).slice(1);
    assert.deepEqual(later.map(body=>body.text),["after it","maybe left over"]);
    assert.ok(later.every(body=>body.require_idle===true),"never a plain paste on top of the leftover");
  }finally{await h.close();clock.restore();}
});
// #1004: Claude Code shows an uploaded image path as "[Image #N]" in the user
// turn, so a delivered screenshot reply never matched its transcript, turned
// Not confirmed, and Retry sent it again.
const imageReply="'/sessions/fixture/attachments/20261018-234300-shot one.png'\nwhat is on this screen";
test("#1004 a busy Claude screenshot reply is proven by its [Image #N] turn and never turns Not confirmed",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("working",1,claude);await h.write(imageReply);await h.reply();
    await clock.advance(5000,h.settle);
    assert.equal(h.requests.length,1,"handed to the busy session");
    const outbox=h.queueModule.conversationOutbox();
    await h.render("idle",2,laterTurn(2,1000,60_000));
    await act(async()=>outbox.confirmFromTranscript(h.session(),[userTurn("shot","[Image #1] what is on this screen",Date.now()+2000)]));await h.settle();
    assert.equal(h.status("what is on this screen"),undefined,"its transcript turn proves it");
    assert.equal(Boolean(h.button("Retry reply")),false,"no Retry to send it twice");
  }finally{await h.close();clock.restore();}
});
test("#1004 image paths in a reply match [Image #N] in the proving turn",async()=>{
  const h=await mount();try{
    const {transcriptProof}=h.queueModule,at=Date.now();
    const reply=(id:string,text:string)=>({id,text,requestId:id,incarnation:"inc-1",state:"unknown" as const,attemptedAt:at});
    const proven=(text:string,turn:string)=>transcriptProof([reply("r",text)],[userTurn("t",turn,at+1000)]).has("r");
    assert.equal(proven(imageReply,"[Image #1] what is on this screen"),true,"path and text");
    assert.equal(proven(imageReply,imageReply),true,"a literal path still proves it");
    // #1005 review F1: an image-only reply has no text to tie it to a turn, so
    // only a turn naming its source proves it.
    assert.equal(proven("'/a/shot.png'\n","[Image #3]"),false,"an image-only reply needs its source");
    assert.equal(proven("'/a/shot.png'\n","[Image #3] [Image: source: /a/shot.png]"),true,"an image-only reply with its source");
    assert.equal(proven("'/a/one.png'\n'/a/two.jpg'\nboth","[Image #1][Image #2] both"),true,"two images");
    // A non-queued Claude turn also names the image's source path.
    assert.equal(proven(imageReply,"[Image #494] [Image: source: /sessions/fixture/attachments/20261018-234300-shot one.png] what is on this screen"),true,"with its source");
    assert.equal(proven(imageReply,"[Image #7] [Image: source: /a/other.png] what is on this screen"),false,"a different image's source");
    assert.equal(proven("'/a/one.png'\n'/a/two.jpg'\nboth","[Image #1] [Image: source: /a/two.jpg] [Image #2] [Image: source: /a/one.png] both"),false,"images in another order");
    assert.equal(proven("'/a/one.png'\n'/a/two.jpg'\nboth","[Image #1] [Image: source: /a/one.png] [Image #2] [Image: source: /a/two.jpg] both"),true,"images in order");
    assert.equal(proven(imageReply,"[Image #1] something else"),false,"other text proves nothing");
    assert.equal(proven(imageReply,"[Image #1]"),false,"the text part is missing");
    assert.equal(proven("what is on this screen","[Image #1] what is on this screen"),false,"an image the reply did not carry");
  }finally{await h.close();}
});
// #1005 review F1: of two pending screenshot replies, the turn naming one
// source proves only that one.
test("#1004 a turn naming one image's source proves only that reply",async()=>{
  const h=await mount();try{
    const {transcriptProof}=h.queueModule,at=Date.now();
    const reply=(id:string,text:string)=>({id,text,requestId:id,incarnation:"inc-1",state:"unknown" as const,attemptedAt:at});
    const proof=transcriptProof([reply("x","'/a/x.png' describe"),reply("y","'/a/y.png' describe")],
      [userTurn("t","[Image #1] [Image: source: /a/y.png] describe",at+1000)]);
    assert.deepEqual([...proof.keys()],["y"]);
  }finally{await h.close();}
});
// #1005 review F1 (generation 2): a source-less "[Image #N]" cannot tell two
// pending replies with different images and the same text apart, so it proves
// neither; one pending reply stays provable by its own text.
test("#1004 a source-less image turn proves no reply when several different images share its text",async()=>{
  const h=await mount();try{
    const {transcriptProof}=h.queueModule,at=Date.now();
    const reply=(id:string,text:string)=>({id,text,requestId:id,incarnation:"inc-1",state:"unknown" as const,attemptedAt:at});
    const turn=[userTurn("t","[Image #7] describe",at+1000)];
    assert.deepEqual([...transcriptProof([reply("a","'/a/not-delivered.png' describe"),reply("b","'/a/other.png' describe")],turn).keys()],[],"two candidates");
    assert.deepEqual([...transcriptProof([reply("a","'/a/one.png' describe"),reply("b","'/a/two.png' describe"),reply("c","'/a/three.png' describe")],turn).keys()],[],"three candidates");
    assert.deepEqual([...transcriptProof([reply("a","'/a/only.png' describe")],turn).keys()],["a"],"a single candidate stays provable");
    assert.deepEqual([...transcriptProof([reply("a","'/a/not-delivered.png' describe"),reply("b","'/a/other.png' describe")],
      [userTurn("t","[Image #7] [Image: source: /a/other.png] describe",at+1000)]).keys()],["b"],"a named source still decides");
  }finally{await h.close();}
});
// #1005 review F2: a proven part is stored as the transcript text it used, so
// the turn can grow with the next reply, and the same turn cannot prove a
// second identical image reply.
test("#1004 a proven image reply spends the transcript text it matched",async()=>{
  const h=await mount();try{
    const {transcriptProof}=h.queueModule,at=Date.now();
    const reply=(id:string,text:string)=>({id,text,requestId:id,incarnation:"inc-1",state:"unknown" as const,attemptedAt:at});
    const first=transcriptProof([reply("first","'/a/first.png' old caption")],[userTurn("t","[Image #1] old caption",at+1000)]);
    assert.equal(first.size,1);
    const spent=[...first.values()];
    const grown=transcriptProof([reply("next","next message")],[userTurn("t","[Image #1] old captionnext message",at+1000)],spent);
    assert.equal(grown.has("next"),true,"the spent part covers its placeholder");
    const again=transcriptProof([reply("dup","'/a/first.png' old caption")],[userTurn("t","[Image #1] old caption",at+1000)],spent);
    assert.equal(again.has("dup"),false,"one turn proves one image reply");
  }finally{await h.close();}
});
// #971 review F1: a turn that proved one reply stays spent after a reload.
test("#969 after a reload, the turn that proved one reply does not prove a second identical reply",async()=>{
  const factory=new IDBFactory();const clock=graceClock();let h=await mount(factory);try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("working",1,claude);
    await h.write("ok");await h.reply();await h.write("ok");await h.reply();
    await clock.advance(5000,h.settle);
    assert.equal(h.requests.length,2);
    const turn=[userTurn("u1","ok",Date.now()+1000)];
    await act(async()=>h.queueModule.conversationOutbox().confirmFromTranscript(h.session(),turn));await h.settle();
    assert.equal(h.queueModule.conversationOutbox().items(h.session()).length,1);
    await h.close();heldLocks.clear();h=await mount(factory);await h.render("working",1,claude);
    await act(async()=>h.queueModule.conversationOutbox().confirmFromTranscript(h.session(),turn));await h.settle();
    assert.equal(h.queueModule.conversationOutbox().items(h.session()).length,1,"the spent turn proves nothing after the reload");
  }finally{await h.close();clock.restore();}
});
// #971 review F2: an identical message sent before the attempt is never proof.
test("#969 a turn from shortly before the attempt does not prove it",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("working",1,claude);await h.write("yes");await h.reply();
    await clock.advance(5000,h.settle);
    const attempted=h.queueModule.conversationOutbox().items(h.session())[0]!.attemptedAt!;
    await act(async()=>h.queueModule.conversationOutbox().confirmFromTranscript(h.session(),[userTurn("earlier","yes",attempted-30_000)]));await h.settle();
    assert.match(h.queued(),/yes/,"a 'yes' answered 30 s earlier is a different reply");
  }finally{await h.close();clock.restore();}
});

// #973 review: an unproven uncertain reply never vanishes silently, never
// blocks the next reply, and always has an exit, also for rows stored by an
// earlier build without attemptedAt.
const laterTurn=(revision:number,startOffset:number,completeOffset:number)=>({...claude,turn_state:{schema_version:"agent-session.turn-state.v1",phase:"idle",revision,
  phase_changed_at:new Date(Date.now()+completeOffset).toISOString(),source:{kind:"provider_hook",provider:"claude",confidence:"authoritative"},
  last_turn:{started_at:new Date(Date.now()+startOffset).toISOString(),completed_at:new Date(Date.now()+completeOffset).toISOString(),outcome:"completed"}} as never});
test("#973 a stored uncertain row without attemptedAt can be proven and does not hold the queue",async()=>{
  const h=await mount();try{
    await h.render("idle",1,claude);
    const outbox=h.queueModule.conversationOutbox();
    await act(async()=>(outbox as unknown as {change(s:Session,edit:(q:{items:unknown[]})=>void):Promise<void>}).change(h.session(),queue=>{
      queue.items.push({id:"legacy",requestId:"legacy",text:"old reply",incarnation:"inc-1",state:"unknown",handoff:true});}));await h.settle();
    assert.equal(h.status("old reply"),"sent");
    h.response({ok:true});await h.write("new reply");await h.reply();await h.render("idle",2,claude);
    assert.equal((h.requests as PromptBody[]).some(body=>body.text==="new reply"),true,"the legacy row does not hold the new reply");
    // N3: a row without any time is stamped when first seen; a later turn proves it.
    await act(async()=>outbox.confirmFromTranscript(h.session(),[]));
    await act(async()=>outbox.confirmFromTranscript(h.session(),[userTurn("u1","old reply",Date.now()+1000)]));await h.settle();
    assert.equal(h.status("old reply"),undefined,"proven from the transcript");
  }finally{await h.close();}
});
test("#973 an uncertain reply is a plain bubble until a later turn's transcript lacks it, then Not confirmed with Retry; never resent on its own",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("working",1,claude);await h.write("did it arrive");await h.reply();
    await clock.advance(5000,h.settle);assert.equal(h.status("did it arrive"),"sent");
    const outbox=h.queueModule.conversationOutbox();
    assert.equal(outbox.hasQueuedReplies("fixture","outbox"),true,"Archive and Delete still protect it");
    await h.render("idle",2,laterTurn(2,1000,60_000));
    assert.equal(h.status("did it arrive"),"sent","a later turn alone proves nothing either way");
    await act(async()=>outbox.confirmFromTranscript(h.session(),[userTurn("u0","something else",Date.now()+30_000),
      {id:"a1",role:"assistant",text:"done",timestamp:new Date(Date.now()+59_000).toISOString()}]));await h.settle();
    assert.equal(h.status("did it arrive"),"refused","not in the transcript read after that turn: it does not vanish");
    assert.match(h.container.textContent??"",/Not confirmed in the conversation/);assert.ok(h.button("Retry reply"));
    assert.equal(outbox.hasQueuedReplies("fixture","outbox"),true,"still protected");
    await h.render("working",3,claude);await clock.advance(10_000,h.settle);await h.render("idle",4,claude);
    assert.equal(h.requests.length,1,"never resent on its own");
    h.response({ok:true});await h.click("Retry reply");await h.render("working",5,claude);await clock.advance(5000,h.settle);
    assert.equal(h.requests.length,2,"resent only on Retry");
  }finally{await h.close();clock.restore();}
});
test("#973 an uncertain idle attempt does not hold back the next reply",async()=>{
  const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});await h.render("working");
    await h.write("uncertain first");await h.reply();await h.write("next task");await h.reply();
    await h.render("idle",2);
    assert.deepEqual((h.requests as PromptBody[]).map(body=>body.text),["uncertain first","next task"],"the next reply follows in the same idle period (#973 G2)");
    h.response({ok:true});await h.render("working",3);await h.render("idle",4);
    assert.equal(h.requests.length,2,"nothing is sent again");
    assert.equal(h.status("uncertain first"),"sent","the uncertain one stays a plain bubble");
  }finally{await h.close();}
});
// #973 (automated review thread): an uncertain reply does not make the
// composer queue the next idle reply behind it.
test("#973 with an uncertain reply present, a reply to the idle session goes straight out",async()=>{
  const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});await h.render("working");
    await h.write("uncertain first");await h.reply();await h.render("idle",2);
    assert.equal(h.status("uncertain first"),"sent");
    h.response({ok:true});await h.render("idle",3);
    await h.write("straight out");await h.reply();
    assert.equal(h.requests.length,2,"sent at once, not queued behind the uncertain reply");
    assert.equal((h.requests[1] as {text:string}).text,"straight out");
  }finally{await h.close();}
});

// #973 delta review and owner change (only Queued is a visible status).
test("#973 N1: while an uncertain idle paste may sit in the input, the next reply goes queued with the idle guard",async()=>{
  const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});await h.render("working");
    await h.write("maybe pasted");await h.reply();await h.render("idle",2);
    assert.equal(h.status("maybe pasted"),"sent");
    h.response({ok:false,refusalCode:"busy",error:"The session is busy."});
    await h.render("idle",3);await h.write("after it");await h.reply();
    const sent=(h.requests as PromptBody[]).filter(body=>body.text==="after it");
    assert.ok(sent.every(body=>body.require_idle===true&&typeof body.request_id==="string"),"never a plain paste on top of the leftover");
    assert.equal(h.status("after it"),"queued","held while the input is not empty");
  }finally{await h.close();}
});
test("#973 N2: a reply shown as Not confirmed that Claude takes late is cleared by its turn, leaving no Retry",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("working",1,claude);await h.write("late arrival");await h.reply();
    await clock.advance(5000,h.settle);
    const outbox=h.queueModule.conversationOutbox();
    await h.render("idle",2,laterTurn(2,1000,60_000));
    await act(async()=>outbox.confirmFromTranscript(h.session(),[{id:"a1",role:"assistant",text:"done",timestamp:new Date(Date.now()+59_000).toISOString()}]));await h.settle();
    assert.equal(h.status("late arrival"),"refused","not confirmed yet");
    await act(async()=>outbox.confirmFromTranscript(h.session(),[userTurn("late","late arrival",Date.now()+70_000)]));await h.settle();
    assert.equal(h.status("late arrival"),undefined,"its transcript turn clears it");
    assert.equal(Boolean(h.button("Retry reply")),false,"no Retry left to double-send");
    await h.render("idle",3,claude);await h.render("working",4,claude);await clock.advance(10_000,h.settle);
    assert.equal(h.requests.length,1,"never resent");
  }finally{await h.close();clock.restore();}
});
// Claude Code joins inputs queued during a turn into one user turn, without a
// separator: a mailbox nudge and the owner's reply, or two replies (#969).
test("#969 a reply merged with other queued input into one user turn is proven, and the merge proves each reply once",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("working",1,claude);
    await h.write("first reply");await h.reply();await h.write("second reply");await h.reply();
    await h.write("ok");await h.reply();
    await clock.advance(5000,h.settle);for(let i=0;i<5&&h.requests.length<3;i++)await h.settle();
    assert.equal(h.requests.length,3,"all three handed off");
    const outbox=h.queueModule.conversationOutbox();
    await act(async()=>outbox.confirmFromTranscript(h.session(),[
      userTurn("merged","Mailbox: 2030-01-01T09:00:00Z; agent-session message inboxfirst replysecond reply",Date.now()+60_000),
      userTurn("look","please look at this",Date.now()+61_000)]));await h.settle();
    assert.equal(h.status("first reply"),undefined,"proven inside a merged turn");
    assert.equal(h.status("second reply"),undefined,"the same merged turn proves the second reply too");
    assert.equal(h.status("ok"),"sent","'ok' inside 'look' is not a queued input");
    await act(async()=>outbox.confirmFromTranscript(h.session(),[
      userTurn("merged","Mailbox: 2030-01-01T09:00:00Z; agent-session message inboxfirst replysecond reply",Date.now()+60_000)]));await h.settle();
    assert.equal(outbox.items(h.session()).length,1,"spent parts of a turn prove nothing again");
  }finally{await h.close();clock.restore();}
});
test("#973 N3: a stored row without any time is not proven by an older identical turn",async()=>{
  const h=await mount();try{
    await h.render("idle",1,claude);
    const outbox=h.queueModule.conversationOutbox();
    await act(async()=>(outbox as unknown as {change(s:Session,edit:(q:{items:unknown[]})=>void):Promise<void>}).change(h.session(),queue=>{
      queue.items.push({id:"timeless",requestId:"timeless",text:"yes",incarnation:"inc-1",state:"unknown",handoff:true});}));await h.settle();
    await act(async()=>outbox.confirmFromTranscript(h.session(),[userTurn("yesterday","yes",Date.now()-86_400_000)]));await h.settle();
    assert.equal(h.status("yes"),"sent","a day-old 'yes' proves nothing");
    await act(async()=>outbox.confirmFromTranscript(h.session(),[userTurn("now","yes",Date.now()+1000)]));await h.settle();
    assert.equal(h.status("yes"),undefined,"a turn after it was first seen does");
  }finally{await h.close();}
});
test("normal replies stay plain before and after handoff without persistent delivery badges",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:true,queued:true});
    await h.render("working",1,claude);await h.write("plain later");await h.reply();
    assertNoElement(h.container,".history-outgoing-status");
    assert.doesNotMatch(h.queued(),/Queued/);
    await clock.advance(5000,h.settle);
    assertNoElement(h.container,'[aria-label="Your replies"] .history-outgoing-status');
    assert.doesNotMatch(h.container.textContent??"",/\bSent\b|Delivered|Uncertain/);
  }finally{await h.close();clock.restore();}
});

// #973 review G1: a partial match proves a reply only when the whole user turn
// is made of known pieces: this browser's replies, spent parts, or the
// daemon's mailbox nudge. Short replies are never proven by unrelated turns.
test("#973 G1: short replies are not proven by unrelated turns that start or end with them",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("working",1,claude);
    for(const text of ["ok","1","y","go","proceed."]){await h.write(text);await h.reply();}
    await clock.advance(5000,h.settle);for(let i=0;i<5&&h.requests.length<5;i++)await h.settle();
    assert.equal(h.requests.length,5);
    const outbox=h.queueModule.conversationOutbox();
    const at=Date.now()+30_000;
    await act(async()=>outbox.confirmFromTranscript(h.session(),[userTurn("t1","okay, now run the full test suite",at),
      userTurn("t2","1. fix the parser first",at+1),userTurn("t3","yes please do that",at+2),userTurn("t4","go ahead and merge",at+3),
      userTurn("t5","Read your mailbox and proceed.",at+4)]));await h.settle();
    assert.deepEqual(["ok","1","y","go","proceed."].map(text=>h.status(text)),["sent","sent","sent","sent","sent"],"none of them is proven");
    await act(async()=>outbox.confirmFromTranscript(h.session(),[userTurn("t6","Mailbox: 2030-01-01T09:00:00Z; agent-session message inboxok",at+5),
      userTurn("t7","goproceed.",at+6)]));await h.settle();
    assert.equal(h.status("ok"),undefined,"a mailbox nudge plus the reply is the whole turn");
    assert.equal(h.status("go"),undefined,"two of this browser's replies make the whole turn");
    assert.equal(h.status("proceed."),undefined);
    assert.equal(h.status("y"),"sent");
  }finally{await h.close();clock.restore();}
});
// #973 review G2: an uncertain idle paste does not use up the idle period, so
// the reply queued behind it goes out while the session stays idle.
test("#973 G2: the reply queued behind an uncertain idle paste goes out in the same idle period",async()=>{
  const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});await h.render("working");
    await h.write("maybe pasted");await h.reply();await h.render("idle",2);
    assert.equal(h.requests.length,1);
    h.response({ok:true});await h.write("then this");await h.reply();
    for(let i=0;i<5&&h.requests.length<2;i++)await h.settle();
    const sent=(h.requests as PromptBody[]).filter(body=>body.text==="then this");
    assert.equal(sent.length,1,"sent while the session stays idle");
    assert.equal(sent[0]!.require_idle,true,"with the idle guard, so a leftover paste would be refused as busy");
  }finally{await h.close();}
});
// #973 review G1 (second round): a turn that proved two identical replies stays
// spent twice, across a repeated check and a reload, so a third is not proven.
test("#973 G1: a turn that proved two of three identical replies never proves the third, also after a reload",async()=>{
  const factory=new IDBFactory();const clock=graceClock();let h=await mount(factory);try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("working",1,claude);
    for(let i=0;i<3;i++){await h.write("ok");await h.reply();}
    await clock.advance(5000,h.settle);for(let i=0;i<5&&h.requests.length<3;i++)await h.settle();
    assert.equal(h.requests.length,3);
    const turn=[userTurn("t1","ok ok",Date.now()+30_000)];
    await act(async()=>h.queueModule.conversationOutbox().confirmFromTranscript(h.session(),turn));await h.settle();
    assert.equal(h.queueModule.conversationOutbox().items(h.session()).length,1,"two of three proven");
    await act(async()=>h.queueModule.conversationOutbox().confirmFromTranscript(h.session(),turn));await h.settle();
    assert.equal(h.queueModule.conversationOutbox().items(h.session()).length,1,"a repeated check does not prove the third");
    await h.close();heldLocks.clear();h=await mount(factory);await h.render("working",1,claude);
    await act(async()=>h.queueModule.conversationOutbox().confirmFromTranscript(h.session(),turn));await h.settle();
    assert.equal(h.queueModule.conversationOutbox().items(h.session()).length,1,"nor does a check after a reload");
    assert.equal(h.status("ok"),"sent","the third stays visible");
  }finally{await h.close();clock.restore();}
});

// #976: a hook snapshot may stay Working after an interruption. The daemon's
// require_idle admission checks the native Codex thread before delivery.
test("#976 a stale Working snapshot does not prevent native idle admission after an interruption",async()=>{
  const clock=graceClock();const h=await mount();try{
    await h.render("working");
    await h.render("working",1,{turn_state:{...h.session().turn_state,
      last_turn:{started_at:new Date(Date.now()-60_000).toISOString(),completed_at:new Date(Date.now()-30_000).toISOString(),outcome:"interrupted"}}} as Partial<Session>);
    await h.write("after interruption");await h.reply();
    const attempt=h.queueModule.conversationOutbox().items(h.session())[0]!.requestId;
    await clock.advance(4999,h.settle);assert.equal(h.requests.length,0,"the cancellation grace stays usable");
    await clock.advance(1,h.settle);
    assert.equal(h.requests.length,1,"native idle admission is attempted despite the stale phase");
    assert.deepEqual(h.requests[0],{text:"after interruption",expected_session_incarnation:"inc-1",request_id:attempt,require_idle:true});
    assert.equal(h.status("after interruption"),"delivered");
    await clock.advance(20_000,h.settle);assert.equal(h.requests.length,1,"confirmed input is never resent");
  }finally{await h.close();clock.restore();}
});

test("#976 definite busy refusals retry at most once per 5 seconds without a phase change",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,refusalCode:"busy",error:"The session is busy or terminal input is in use."});
    await h.render("working");await h.write("wait for native idle");await h.reply();
    await clock.advance(5000,h.settle);assert.equal(h.requests.length,1);
    const first=(h.requests[0] as PromptBody).request_id;
    await h.render("working",1);await h.settle();assert.equal(h.requests.length,1,"renders cannot spin a retry");
    h.response({ok:true});await clock.advance(4999,h.settle);assert.equal(h.requests.length,1);
    await clock.advance(1,h.settle);assert.equal(h.requests.length,2,"a safe refused attempt may retry in the same phase");
    const retry=h.requests[1] as PromptBody;
    assert.notEqual(retry.request_id,first,"a definite refusal gets a fresh attempt key");
    assert.equal(retry.require_idle,true);assert.equal(h.status("wait for native idle"),"delivered");
    await clock.advance(20_000,h.settle);assert.equal(h.requests.length,2);
  }finally{await h.close();clock.restore();}
});

test("#976 a fresh idle after an interrupt bypasses busy backoff and delivers only once",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,refusalCode:"busy"});await h.render("working");
    await h.write("first safe idle");await h.reply();await clock.advance(5000,h.settle);
    assert.equal(h.requests.length,1);
    h.response({ok:true});await h.render("idle",2);
    assert.equal(h.requests.length,2,"the observed idle does not wait out the busy timer");
    assert.equal((h.requests[1] as PromptBody).require_idle,true);
    await h.render("idle",2);await clock.advance(20_000,h.settle);assert.equal(h.requests.length,2);
  }finally{await h.close();clock.restore();}
});

test("#976 a guarded attempt with an uncertain outcome is never retried by the busy timer",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});await h.render("working");
    await h.write("one uncertain attempt");await h.reply();await clock.advance(5000,h.settle);
    assert.equal(h.requests.length,1);
    const attempt=(h.requests[0] as PromptBody).request_id;
    await clock.advance(30_000,h.settle);await h.render("idle",2);await h.render("working",3);
    assert.equal(h.requests.length,1,"neither timers nor phase changes replay uncertain input");
    assert.equal(h.queueModule.conversationOutbox().items(h.session())[0]!.requestId,attempt);
  }finally{await h.close();clock.restore();}
});

test("a busy admission does not expose obsolete reply actions or internal idle instructions",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,refusalCode:"busy",error:"The session is busy or terminal input is in use."});
    await h.render("working");await h.write("explain the hold");await h.reply();await h.render("idle",2);
    assert.equal(h.status("explain the hold"),"queued");
    assertNoElement(h.container,'[aria-haspopup="menu"], [role="menu"], .history-outgoing-status');
    assert.doesNotMatch(h.container.textContent??"",/terminal input is in use/);
    assert.equal(h.status("explain the hold"),"queued","the explanation does not add a normal bubble status");
  }finally{await h.close();clock.restore();}
});

test("#976 native idle admission keeps two queued replies in order while the reported phase stays Working",async()=>{
  const clock=graceClock();const h=await mount();let nativeIdle=true;const accepted:string[]=[];
  try{
    h.submit(async()=>{
      const body=h.requests.at(-1) as PromptBody;
      if(!nativeIdle)return {ok:false,refusalCode:"busy"};
      nativeIdle=false;accepted.push(body.text);return {ok:true};
    });
    await h.render("working");
    for(const text of ["first native turn","second native turn"]){await h.write(text);await h.reply();}
    await clock.advance(5000,h.settle);assert.deepEqual(accepted,["first native turn"]);
    assert.equal(h.requests.length,2,"the next reply is guarded and definitely refused while the native turn is active");
    nativeIdle=true;await clock.advance(5000,h.settle);
    assert.deepEqual(accepted,["first native turn","second native turn"]);
    assert.ok((h.requests as PromptBody[]).every(body=>body.require_idle===true));
    assert.equal(new Set((h.requests as PromptBody[]).map(body=>body.request_id)).size,3);
    await clock.advance(20_000,h.settle);assert.equal(h.requests.length,3,"neither accepted reply is replayed");
  }finally{await h.close();clock.restore();}
});

test("#976 a Console draft still holds a guarded Codex attempt while the reported phase stays Working",async()=>{
  const clock=graceClock();const h=await mount();try{
    await h.render("working");await h.write("queued work");await h.reply();await h.write("manual draft");
    await clock.advance(5000,h.settle);assert.equal(h.requests.length,0);
    assert.equal(h.editor().value,"manual draft","automatic delivery never clears the owner's draft");
    await h.write("");await h.settle();assert.equal(h.requests.length,1);
    assert.equal((h.requests[0] as PromptBody).require_idle,true);
  }finally{await h.close();clock.restore();}
});

test("#976 idle-guarded Claude Retry recovers through a 60-second busy lag without a new phase",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});await h.render("working",1,claude);
    await h.write("retry after completion");await h.reply();await clock.advance(5000,h.settle);
    assert.equal(h.requests.length,1);
    await clock.advance(60_000,h.settle);
    await h.render("idle",2,laterTurn(2,-59_000,-1000));
    await act(async()=>h.queueModule.conversationOutbox().confirmFromTranscript(h.session(),[
      userTurn("other","another task",Date.now()-30_000),
      {id:"answer",role:"assistant",text:"done",timestamp:new Date(Date.now()-1000).toISOString()},
    ]));await h.settle();
    assert.equal(h.status("retry after completion"),"refused","the completed turn did not confirm the earlier attempt");
    h.response({ok:false,refusalCode:"busy"});await h.click("Retry reply");
    assert.equal(h.requests.length,2);assert.equal((h.requests[1] as PromptBody).require_idle,true);
    assert.equal(h.status("retry after completion"),"queued");
    for(let i=0;i<11;i++){
      await clock.advance(4999,h.settle);assert.equal(h.requests.length,2+i,"no busy-loop before the backoff");
      await clock.advance(1,h.settle);assert.equal(h.requests.length,3+i,"a definite busy receipt can retry in the same idle phase");
    }
    h.response({ok:true});await clock.advance(5000,h.settle);
    assert.equal(h.requests.length,14,"delivered after 60 seconds without another phase notification");
    const retries=(h.requests as PromptBody[]).slice(1);
    assert.ok(retries.every(body=>body.require_idle===true));
    assert.equal(new Set((h.requests as PromptBody[]).map(body=>body.request_id)).size,14,"every definite refusal gets a fresh persisted key");
    assert.equal(h.status("retry after completion"),"delivered");
    await clock.advance(20_000,h.settle);assert.equal(h.requests.length,14,"neither the uncertain original nor the delivered retry replays");
  }finally{await h.close();clock.restore();}
});

test("#976 idle-guarded Claude N1 resumes after busy without replaying its uncertain predecessor",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});await h.render("working",1,claude);
    await h.write("uncertain predecessor");await h.reply();await h.render("idle",2,claude);
    const original=(h.requests[0] as PromptBody).request_id;
    assert.equal((h.requests[0] as PromptBody).require_idle,true,"the uncertain idle paste triggers N1 guarded queuing");
    h.response({ok:false,refusalCode:"busy"});
    await h.write("guarded follower");await h.reply();assert.equal(h.requests.length,2);
    const busy=h.requests[1] as PromptBody;assert.equal(busy.require_idle,true);
    h.response({ok:true});await clock.advance(4999,h.settle);assert.equal(h.requests.length,2);
    await clock.advance(1,h.settle);assert.equal(h.requests.length,3);
    const retry=h.requests[2] as PromptBody;assert.equal(retry.text,"guarded follower");assert.equal(retry.require_idle,true);
    assert.notEqual(retry.request_id,busy.request_id);assert.equal(h.status("guarded follower"),"delivered");
    assert.equal(h.queueModule.conversationOutbox().items(h.session()).find(item=>item.text==="uncertain predecessor")?.requestId,original);
    await clock.advance(20_000,h.settle);assert.equal(h.requests.length,3,"uncertain and delivered inputs are never resent");
  }finally{await h.close();clock.restore();}
});

test("#976 an uncertain receipt lookup cannot shorten a follower's same-phase busy backoff",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});await h.render("working",1,claude);
    await h.write("uncertain before reconnect");await h.reply();await h.render("idle",2,claude);
    h.response({ok:false,refusalCode:"busy"});await h.write("bounded follower");await h.reply();
    assert.equal(h.requests.length,2);await clock.advance(1000,h.settle);
    const outbox=h.queueModule.conversationOutbox(),lookups=h.lookups.length;
    h.response({ok:true});
    await act(async()=>{await outbox.reconcile(h.session(),false);await outbox.reconcile(h.session(),true);});await h.settle();
    assert.ok(h.lookups.length>lookups,"reconnect rechecks the uncertain predecessor's receipt");
    assert.equal(h.requests.length,2,"releasing the consumed-idle epoch does not release the follower's five-second backoff");
    await clock.advance(3999,h.settle);assert.equal(h.requests.length,2);
    await clock.advance(1,h.settle);assert.equal(h.requests.length,3);
    assert.equal((h.requests[2] as PromptBody).require_idle,true);
  }finally{await h.close();clock.restore();}
});

test("#980 F1 two windows with different snapshots preserve busy backoff",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,refusalCode:"busy"});await h.render("working",1);
    await h.write("shared cadence");await h.reply();await clock.advance(5000,h.settle);
    const old=h.session(),first=h.queueModule.conversationOutbox();
    await h.render("idle",2);assert.equal(h.requests.length,2);
    const current=h.session(),other=new h.queueModule.ConversationOutbox(first.namespace);await other.ready;
    const start=Date.now();
    for(let i=0;i<5;i++){
      await act(async()=>other.deliver(old,true,()=>true));await h.settle();
      await act(async()=>first.deliver(current,true,()=>true));await h.settle();
    }
    assert.equal(Date.now(),start,"alternating windows advance no fake time");
    assert.equal(h.requests.length,2,"a stale working observation cannot defeat the current idle backoff");
    await h.render("idle",3);assert.equal(h.requests.length,3,"a genuinely newer idle releases once");
    for(let i=0;i<3;i++){
      await act(async()=>other.deliver(current,true,()=>true));await h.settle();
      assert.equal(h.requests.length,3+i,"an older idle never moves the shared fence backward");
      await clock.advance(4999,h.settle);assert.equal(h.requests.length,3+i);
      await clock.advance(1,h.settle);assert.equal(h.requests.length,4+i,"same-phase retries continue at five seconds");
    }
    assert.ok((h.requests as PromptBody[]).every(body=>body.require_idle===true));
    assert.equal(new Set((h.requests as PromptBody[]).map(body=>body.request_id)).size,h.requests.length);
  }finally{await h.close();clock.restore();}
});

test("#980 F1 newer working and same-phase progress do not bypass busy backoff",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,refusalCode:"busy"});await h.render("working",1);
    await h.write("phase progress");await h.reply();await clock.advance(5000,h.settle);
    await h.render("working",2);
    assert.equal(h.requests.length,1,"a newer working phase cannot release the busy timer");
    await h.render("idle",3);assert.equal(h.requests.length,2,"a newer idle can release it once");
    await h.render("idle",4,{turn_state:{...h.session().turn_state,revision:4}} as Partial<Session>);
    assert.equal(h.requests.length,2,"a progress revision in the same idle phase does not release it again");
    await clock.advance(4999,h.settle);assert.equal(h.requests.length,2);
    await clock.advance(1,h.settle);assert.equal(h.requests.length,3);
  }finally{await h.close();clock.restore();}
});

test("#980 F1 an observed attention phase fences stale working after backoff expires",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,refusalCode:"busy"});await h.render("working",1);
    await h.write("wait for attention");await h.reply();await clock.advance(5000,h.settle);
    const old=h.session(),first=h.queueModule.conversationOutbox();
    const other=new h.queueModule.ConversationOutbox(first.namespace);await other.ready;
    await h.render("needs_input",2,{turn_state:{...h.session().turn_state,phase:"needs_input",revision:2,
      phase_changed_at:"2030-01-01T00:00:02Z",current_turn:{started_at:"2030-01-01T00:00:00Z",
        attention:{kind:"approval",requested_at:"2030-01-01T00:00:02Z",pending_count:1}}}} as Partial<Session>);
    await clock.advance(5000,h.settle);
    await act(async()=>other.deliver(old,true,()=>true));await h.settle();
    assert.equal(h.requests.length,1,"a stale window cannot dispatch after another window observed attention");
    h.response({ok:true});await h.render("idle",3);assert.equal(h.requests.length,2);
    assert.equal(h.status("wait for attention"),"delivered");
  }finally{await h.close();clock.restore();}
});

// #921: a failed turn shows why in the conversation, with a one-tap resend.
const failedTurn=(revision:number,lastTurn:Record<string,unknown>={},extra:Partial<Session>={})=>({...extra,turn_state:{schema_version:"agent-session.turn-state.v1",phase:"idle",revision,
  phase_changed_at:`2030-01-01T00:00:0${revision}Z`,source:{kind:"provider_hook",provider:"codex",confidence:"authoritative"},
  last_turn:{completed_at:`2030-01-01T00:00:0${revision}Z`,outcome:"failed",...lastTurn}} as never});
const autoResume=(state:string)=>({auto_resume:{schema_version:"agent-session.auto-resume.v1",supported:true,enabled:true,state,scheduled_at:"2030-01-01T01:00:00Z"} as never});
const stuckCard=(h:Awaited<ReturnType<typeof mount>>)=>h.container.querySelector(".conversation-stuck")?.textContent??"";

test("#921 a turn that failed at model capacity offers Resend, which sends the last message once",async()=>{
  const h=await mount();try{
    await h.render("idle",1,failedTurn(1,{provider_failure_kind:"provider_capacity"},claude));
    await h.transcript([{id:"u1",role:"user",text:"earlier"},{id:"a1",role:"assistant",text:"done"},{id:"u2",role:"user",text:"build the report"}]);
    assert.match(stuckCard(h),/model was at capacity/i,"the card names the cause");
    await h.click("Resend");
    assert.equal(h.requests.length,1);
    const body=h.requests[0] as PromptBody&{expected_session_incarnation:string};
    assert.equal(body.text,"build the report");assert.equal(body.expected_session_incarnation,"inc-1");
    assert.equal(body.require_idle,undefined,"sent like a direct reply");
    assert.ok(!h.button("Resend"),"no second resend while the first is tracked");
    await h.render("idle",1,failedTurn(1,{provider_failure_kind:"provider_capacity"},claude));assert.equal(h.requests.length,1);
  }finally{await h.close();}
});

test("#921 after a partial answer the card offers Continue instead of a resend",async()=>{
  const h=await mount();try{
    await h.render("idle",1,failedTurn(1,{},claude));
    await h.transcript([{id:"u1",role:"user",text:"build the report"},{id:"a1",role:"assistant",text:"Starting on the report"}]);
    assert.match(stuckCard(h),/last turn failed/i);assert.ok(!h.button("Resend"));
    await h.click("Continue");
    assert.equal((h.requests[0] as PromptBody).text,"Continue");
  }finally{await h.close();}
});

test("#921 while auto-resume is pending, capacity offers Resend now and other failures wait for it",async()=>{
  const h=await mount();try{
    await h.render("idle",1,failedTurn(1,{provider_failure_kind:"provider_capacity"},autoResume("scheduled")));
    await h.transcript([{id:"u1",role:"user",text:"build the report"}]);
    assert.match(stuckCard(h),/auto-resume will retry/i);assert.ok(h.button("Resend now"),"resend now is offered");
    await h.render("idle",2,failedTurn(2,{},autoResume("scheduled")));
    assert.match(stuckCard(h),/auto-resume will continue/i);
    assert.ok(!h.button("Resend now"));assert.ok(!h.button("Resend"));assert.equal(h.requests.length,0);
  }finally{await h.close();}
});

test("#921 no resend for a sign-in failure or an image message, and no card after a completed turn",async()=>{
  const h=await mount();try{
    await h.render("idle",1,failedTurn(1,{provider_failure_kind:"authentication"}));
    await h.transcript([{id:"u1",role:"user",text:"build the report"}]);
    assert.match(stuckCard(h),/sign in/i);assert.ok(!h.button("Resend"));
    await h.render("idle",2,failedTurn(2,{provider_failure_kind:"provider_capacity"}));
    await h.transcript([{id:"u1",role:"user",text:"[Image #1] what is this?"}]);
    assert.match(stuckCard(h),/model was at capacity/i);assert.ok(!h.button("Resend"),"an image is not resent as its placeholder");
    await h.render("idle",3,failedTurn(3,{outcome:"completed"}));
    assert.equal(stuckCard(h),"");
    await h.render("idle",4,failedTurn(4,{provider_failure_kind:"provider_capacity"}));
    await h.transcript([{id:"u1",role:"user",text:"build the report",timestamp:"2030-01-01T00:00:03Z"},{id:"u2",role:"user",text:"try again",timestamp:"2030-01-01T00:00:05Z"}]);
    assert.equal(stuckCard(h),"","a message sent after the failure hides the card");
    await h.render("working",4);assert.equal(stuckCard(h),"");
  }finally{await h.close();}
});

test("#921 no card during an active turn or a terminal question, no action over a draft, and armed waits like scheduled",async()=>{
  const h=await mount();try{
    const failed={completed_at:"2030-01-01T00:00:01Z",outcome:"failed",provider_failure_kind:"provider_capacity"};
    const turn=(phase:string,revision:number,current:Record<string,unknown>)=>({turn_state:{schema_version:"agent-session.turn-state.v1",phase,revision,
      phase_changed_at:`2030-01-01T00:00:0${revision}Z`,source:{kind:"provider_hook",provider:"codex",confidence:"authoritative"},
      last_turn:failed,current_turn:{started_at:`2030-01-01T00:00:0${revision}Z`,...current}} as never});
    await h.render("working",2,turn("working",2,{}));
    await h.transcript([{id:"u1",role:"user",text:"build the report"}]);
    assert.equal(stuckCard(h),"","a working turn shows no stuck card");assert.ok(!h.button("Resend"));
    await h.render("needs_input",3,turn("needs_input",3,{attention:{kind:"approval",requested_at:"2030-01-01T00:00:03Z",pending_count:1,certainty:"exact"}}));
    assert.equal(stuckCard(h),"","a terminal question shows no stuck card");assert.ok(!h.button("Resend"));
    await h.render("idle",4,failedTurn(4,{provider_failure_kind:"provider_capacity"}));
    assert.ok(h.button("Resend"),"the idle failed turn offers Resend");
    await h.write("my own next message");
    assert.match(stuckCard(h),/model was at capacity/i);assert.ok(!h.button("Resend"),"no resend while the input holds a draft");
    await h.write("");
    await h.render("idle",5,failedTurn(5,{},autoResume("armed")));
    assert.match(stuckCard(h),/auto-resume will continue/i);assert.ok(!h.button("Resend"),"armed auto-resume waits like scheduled");
    assert.equal(h.requests.length,0);
  }finally{await h.close();}
});

test("#921 a stopped session offers Recover in the conversation, through the Dashboard's resume",async()=>{
  const h=await mount();try{
    let recovered=0;
    h.recovery({onRecover(){recovered++;},pending:false});
    const stopped={status:"stopped",resumable:true} as Partial<Session>;
    await h.render("idle",1,stopped);
    assert.match(stuckCard(h),/this session stopped/i);
    assert.ok(!/return to the terminal/i.test(h.container.textContent??""),"the card replaces the terminal hint");
    await h.click("Recover");assert.equal(recovered,1);assert.equal(h.requests.length,0,"Recover sends no prompt");
    h.recovery({onRecover(){recovered++;},pending:true});await h.render("idle",1,stopped);
    assert.equal(h.button("Recover")?.getAttribute("aria-busy"),"true","the Dashboard's pending resume shows on the button");
  }finally{await h.close();}
});

test("#921 no Recover card for a running, non-resumable, failed-startup or unreachable session, or without the Dashboard's resume",async()=>{
  const h=await mount();try{
    h.recovery({onRecover(){},pending:false});
    await h.render("idle",1,{status:"stopped",resumable:false} as Partial<Session>);
    assert.equal(stuckCard(h),"","not resumable: the terminal hint stays");assert.ok(!h.button("Recover"));
    await h.render("idle",2,{status:"stopped",resumable:true,startup:{schema_version:"agent-session.startup.v1",state:"failed",stage:"proxy",started_at:"2030-01-01T00:00:00Z",
      failure_code:"proxy-start-failed",message:"failed",occurred_at:"2030-01-01T00:00:01Z",retry_safe:true}} as Partial<Session>);
    assert.equal(stuckCard(h),"","a failed startup keeps its own Retry in the session view");
    await h.render("idle",3,{status:"stopped",resumable:true} as Partial<Session>,false,false);
    assert.equal(stuckCard(h),"","an unreachable machine cannot recover");
    await h.render("idle",4,{status:"running"} as Partial<Session>);
    assert.ok(!h.button("Recover"));
    h.recovery(undefined);await h.render("idle",5,{status:"stopped",resumable:true} as Partial<Session>);
    assert.equal(stuckCard(h),"","without the Dashboard's resume there is nothing to offer");
  }finally{await h.close();}
});

// #921: a turn that keeps working with no sign of activity may be stuck.
const MINUTE=60_000;
const workingSince=(revision:number,at:number)=>({turn_state:{schema_version:"agent-session.turn-state.v1",phase:"working",revision,
  phase_changed_at:new Date(at).toISOString(),source:{kind:"provider_hook",provider:"codex",confidence:"authoritative"},
  current_turn:{started_at:new Date(at).toISOString()}} as never});

test("#921 a turn working with no activity for 15 min shows Possibly stuck with how long, and sends nothing",async()=>{
  const clock=graceClock();const h=await mount();try{
    const start=Date.now();
    await h.render("working",1,workingSince(1,start));
    await h.transcript([{id:"u1",role:"user",text:"build the report",timestamp:new Date(start-5*MINUTE).toISOString()}]);
    assert.equal(stuckCard(h),"","a turn that just started is not stuck");
    await clock.advance(14*MINUTE,h.settle);
    await h.render("working",1,workingSince(1,start));
    assert.equal(stuckCard(h),"","14 minutes without activity is not yet stuck, even on a fresh render");
    await clock.advance(1*MINUTE,h.settle);
    assert.match(stuckCard(h),/^Possibly stuck: no activity for 15 min\./);
    await clock.advance(3*MINUTE,h.settle);
    assert.match(stuckCard(h),/no activity for 18 min/,"the card keeps counting");
    assert.match(stuckCard(h),/Check the terminal/,"without a terminal switch the card points to the terminal");
    assert.ok(!h.button("Open terminal"));
    assert.equal(h.requests.length,0,"nothing is sent or interrupted");
  }finally{await h.close();clock.restore();}
});

test("#921 new activity clears Possibly stuck: a turn state revision, a newer message, or the turn ending",async()=>{
  const clock=graceClock();const h=await mount();try{
    const start=Date.now();
    await h.render("working",1,workingSince(1,start));
    await clock.advance(16*MINUTE,h.settle);
    assert.match(stuckCard(h),/Possibly stuck/);
    await h.render("working",2,workingSince(2,start));
    assert.equal(stuckCard(h),"","a new turn state revision is activity, even with an old phase time");
    await clock.advance(16*MINUTE,h.settle);
    assert.match(stuckCard(h),/Possibly stuck/);
    await h.transcript([{id:"a1",role:"assistant",text:"still going",timestamp:new Date(Date.now()).toISOString()}]);
    assert.equal(stuckCard(h),"","a newer transcript message is activity");
    await clock.advance(16*MINUTE,h.settle);
    assert.match(stuckCard(h),/Possibly stuck/);
    await h.render("idle",3);
    assert.ok(!/Possibly stuck/.test(stuckCard(h)),"an idle session is not silent");
    const starting=workingSince(4,start) as {turn_state:Record<string,unknown>};
    await h.render("starting",4,{turn_state:{...starting.turn_state,phase:"starting"} as never});
    await clock.advance(16*MINUTE,h.settle);
    await h.render("starting",4,{turn_state:{...starting.turn_state,phase:"starting"} as never});
    assert.equal(stuckCard(h),"","only a working turn can be silent");
  }finally{await h.close();clock.restore();}
});

test("#921 a page opened on a long-silent turn shows Possibly stuck at once",async()=>{
  const clock=graceClock();const h=await mount();try{
    const start=Date.now();
    await h.render("working",1,workingSince(1,start-40*MINUTE));
    await h.transcript([{id:"u1",role:"user",text:"build the report",timestamp:new Date(start-41*MINUTE).toISOString()}]);
    assert.match(stuckCard(h),/no activity for 40 min/,"opening the page is not activity");
  }finally{await h.close();clock.restore();}
});

test("#921 Possibly stuck offers Open terminal through the view's switch",async()=>{
  const clock=graceClock();const h=await mount();try{
    let opened=0;
    h.terminal(()=>{opened++;});
    const start=Date.now();
    await h.render("working",1,workingSince(1,start));
    await clock.advance(15*MINUTE,h.settle);
    assert.ok(!/Check the terminal/.test(stuckCard(h)),"the button replaces the pointer");
    await h.click("Open terminal");
    assert.equal(opened,1);assert.equal(h.requests.length,0);
  }finally{await h.close();clock.restore();}
});

for(const timestampKind of ["missing","older"] as const){
  test(`#921 review F1 a newly observed message with ${timestampKind} timestamp clears silence after hydration`,async()=>{
    const clock=graceClock();const h=await mount();try{
      const start=Date.now();
      await h.render("working",1,workingSince(1,start));
      const initial={id:"u1",role:"user" as const,text:"build the report",timestamp:new Date(start-5*MINUTE).toISOString()};
      await h.transcript([initial]);
      await clock.advance(16*MINUTE,h.settle);
      assert.match(stuckCard(h),/no activity for 16 min/);
      const answer={id:"a1",role:"assistant" as const,text:"still going",
        ...(timestampKind==="older"?{timestamp:new Date(start-1*MINUTE).toISOString()}:{})};
      await h.transcript([initial,answer]);
      assert.equal(stuckCard(h),"","receiving a new message is activity regardless of its timestamp");
      await clock.advance(15*MINUTE,h.settle);
      assert.match(stuckCard(h),/no activity for 15 min/,"silence is measured from receipt");
      await h.transcript([{...initial},{...answer}]);
      assert.match(stuckCard(h),/no activity for 15 min/,"polling identical messages is not activity");
    }finally{await h.close();clock.restore();}
  });
}

test("#921 review F1 initial history hydration is not activity, including an empty conversation",async()=>{
  const clock=graceClock();const h=await mount();try{
    const start=Date.now();
    await h.render("working",1,workingSince(1,start-40*MINUTE));
    await clock.advance(1*MINUTE,h.settle);
    await h.transcript([]);
    assert.match(stuckCard(h),/no activity for 41 min/,"an empty initial snapshot does not reset silence");
    await h.transcript([{id:"a1",role:"assistant",text:"first live message"}]);
    assert.equal(stuckCard(h),"","a first live message after the empty snapshot is activity");
  }finally{await h.close();clock.restore();}
});

test("#921 review F1 delayed untimestamped history hydration does not hide a silent turn",async()=>{
  const clock=graceClock();const h=await mount();try{
    const start=Date.now();
    await h.render("working",1,workingSince(1,start-40*MINUTE));
    await clock.advance(1*MINUTE,h.settle);
    await h.transcript([{id:"a1",role:"assistant",text:"old history without a timestamp"}]);
    assert.match(stuckCard(h),/no activity for 41 min/);
  }finally{await h.close();clock.restore();}
});

for(const view of ["panel","phone","tile"] as const){
  for(const initiallyEmpty of [false,true]){
    test(`#921 R3 ${view}: failed initial history then ${initiallyEmpty?"empty":"old"} successful retry remains hydration`,async()=>{
      const clock=graceClock();const h=await mount();let reads=0;
      let history:HistoryMessagesResponse["messages"]=initiallyEmpty?[]:[{id:"old-answer",role:"assistant",text:"Previously recorded progress."}];
      globalThis.__outboxHistoryRead=async()=>++reads===1
        ? {ok:false,messages:[],error:"Fixture history read failed"}:{ok:true,messages:history};
      const refresh=()=>view==="panel"?h.click("Refresh conversation"):h.refreshLiveHistory();
      try{
        const start=Date.now();await h.render("working",1,workingSince(1,start-40*MINUTE));
        await h.renderLiveView(view);
        assert.equal(reads,1);
        assert.match(h.container.textContent??"",/Fixture history read failed/);
        assert.match(stuckCard(h),/no activity for 40 min/);
        await refresh();
        assert.equal(reads,2,"retry succeeds through the real history reader");
        assert.ok(!h.container.textContent?.includes("Fixture history read failed"));
        if(!initiallyEmpty)assert.match(h.container.textContent??"",/Previously recorded progress/);
        assert.match(stuckCard(h),/no activity for 40 min/,"first successful retry is history hydration, not activity");
        history=[...history,{id:"new-answer",role:"assistant",text:"New live progress."}];
        await refresh();
        assert.match(h.container.textContent??"",/New live progress/);
        assert.equal(stuckCard(h),"","a genuinely new message after successful hydration still clears silence");
        assert.equal(h.requests.length,0);
      }finally{await h.close();clock.restore();}
    });
  }
}

test("busy admission keeps the immutable message visible without a badge or cancellation action",async()=>{
  const clock=graceClock();const h=await mount();let finish:((value:TestResult)=>void)|undefined;
  try{
    h.submit(()=>new Promise(resolve=>{finish=resolve;}));
    await h.render("working");await h.write("stable queued reply");await h.reply();
    await clock.advance(5000,h.settle);
    assert.equal(h.requests.length,1);
    assertNoElement(h.container,'[aria-label="Queued"]');
    assert.match(h.queued(),/stable queued reply/);
    assert.equal(h.button("Cancel"),undefined,"an in-flight claim cannot be cancelled");
    await act(async()=>{finish!({ok:false,refusalCode:"busy"});});await h.settle();
    assertNoElement(h.container,'[aria-label="Queued"]');
    await clock.advance(5000,h.settle);assert.equal(h.requests.length,2);
    assertNoElement(h.container,'[aria-label="Queued"]');
    assert.match(h.queued(),/stable queued reply/);
    await act(async()=>{finish!({ok:true});});await h.settle();
    assertNoElement(h.container,'[aria-label="Queued"]');
    assert.equal(h.status("stable queued reply"),"delivered");
    await clock.advance(15000,h.settle);assert.equal(h.requests.length,2,"only the refused attempt may retry");
  }finally{finish?.({ok:false,outcomeUnknown:true});await h.settle();await h.close();clock.restore();}
});

// #1043: Claude records a typed prompt that carried a paste as the whole user
// turn wrapped in <pasted_content id="…">, framed by newlines (a de-identified
// shape from a normal Claude Code transcript). The wrapper is markup, not text.
const pasteWrapped=(text:string,id="a1b2")=>`\n\n<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">\n`;
test("#1043 a paste-wrapped transcript turn proves the reply it wraps",async()=>{
  const h=await mount();try{
    const {transcriptProof}=h.queueModule,at=Date.now();
    const reply=(id:string,text:string)=>({id,text,requestId:id,incarnation:"inc-1",state:"unknown" as const,attemptedAt:at});
    const proven=(text:string,turn:string)=>transcriptProof([reply("r",text)],[userTurn("t",turn,at+1000)]).has("r");
    assert.equal(proven("check   the build",pasteWrapped("check the build")),true,"the wrapped turn proves it");
    assert.equal(proven("two\nlines",pasteWrapped("two\nlines")),true,"a multi-line paste");
    assert.equal(proven("check the build",pasteWrapped("check the build","a1b2").replace(/(<\/pasted_content id=")a1b2/,"$1ffff")),false,"ids that differ are not one wrapper");
    assert.equal(proven("check the build",`typed first ${pasteWrapped("check the build")}`),false,"text outside the wrapper proves nothing");
    assert.equal(proven("check the build",pasteWrapped(pasteWrapped("check the build","c3d4"))),false,"only one outer wrapper is removed");
    assert.equal(proven("check the build",pasteWrapped("check the build and more")),false,"other text proves nothing");
  }finally{await h.close();}
});
test("#1043 a sent message and its paste-wrapped transcript turn show one bubble and no tags",async()=>{
  const clock=graceClock();const h=await mount();try{
    h.response({ok:false,outcomeUnknown:true});
    await h.render("working",1,claude);await h.write("check the build");await h.reply();
    await clock.advance(5000,h.settle);
    assert.match(h.queued(),/check the build/,"the local entry shows while it is unproven");
    globalThis.__outboxTranscript=[userTurn("u1",pasteWrapped("check the build"),Date.now()+1500)];
    await h.renderLivePanel();
    for(let i=0;i<20&&h.queued()!=="";i++)await h.settle();
    const bubbles=[...h.container.querySelectorAll<HTMLElement>("article.history-message.is-user")];
    assert.equal(bubbles.length,1,"one user bubble");
    assert.equal(bubbles[0]!.querySelector(".history-bubble")?.textContent,"check the build");
    assert.doesNotMatch(h.container.textContent??"",/pasted_content/,"no wrapper tags");
    assert.equal(h.requests.length,1,"nothing is sent again");
  }finally{delete globalThis.__outboxTranscript;await h.close();clock.restore();}
});

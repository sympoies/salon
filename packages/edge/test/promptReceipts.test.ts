import {strict as assert} from "node:assert";
import {after,before,test} from "node:test";
import {createServer as createHttpServer,type Server as HttpServer} from "node:http";
import type {Server} from "node:net";
import {createEdgeServer} from "../src/server.ts";
import {closeServers,listenOnLoopback,loginCookie,makeEdgeConfig} from "./support.ts";
let edge:Server,daemon:HttpServer,base="",cookie="";
const calls:{method:string;url:string;auth:string;body:unknown}[]=[];
const receipt=(outcome="submitted",code:string|null=null)=>({request_id:"attempt-1",session_id:"s1",session_incarnation:"inc-1",outcome,code});
let status=200,payload:unknown={ok:true,data:{submitted:true,session_incarnation:"inc-1",receipt:receipt()}};
before(async()=>{
  daemon=createHttpServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const raw=Buffer.concat(chunks).toString();calls.push({method:req.method??"",url:req.url??"",auth:String(req.headers.authorization??""),body:raw?JSON.parse(raw):null});
    res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(payload));
  });
  const upstream=await listenOnLoopback(daemon);
  edge=createEdgeServer(makeEdgeConfig({openAccess:false,clientToken:"client-secret",machines:[{name:"host-a",url:upstream.base,token:"fixture-upstream"}]}));
  ({base}=await listenOnLoopback(edge));cookie=await loginCookie(base);
});
after(()=>closeServers(edge,daemon));
const submit=(body:unknown,origin=base)=>fetch(`${base}/api/sessions/host-a/s1/prompt/v2`,{method:"POST",headers:{cookie,origin,"content-type":"application/json"},body:JSON.stringify(body)});
const keyed={text:"queued task",expected_session_incarnation:"inc-1",request_id:"attempt-1",require_idle:true};
const lookup=()=>fetch(`${base}/api/sessions/host-a/s1/prompt/v2/receipts/attempt-1?expected_session_incarnation=inc-1`,{headers:{cookie}});
test("edge forwards keyed idle-only prompts with daemon-owned auth and projects their receipt",async()=>{
  calls.length=0;status=200;payload={ok:true,data:{submitted:true,session_incarnation:"inc-1",receipt:{...receipt(),private_debug:"must-not-leak"}}};
  const response=await submit(keyed);assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,data:{submitted:true,session_incarnation:"inc-1",receipt:receipt()}});
  assert.deepEqual(calls,[{method:"POST",url:"/sessions/s1/prompt/v2",auth:"Bearer fixture-upstream",body:keyed}]);
});
test("edge receipt lookup preserves exact historical incarnation and typed not-found",async()=>{
  calls.length=0;status=200;payload={ok:true,data:{receipt:receipt()}};
  let response=await lookup();assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,data:{receipt:receipt()}});
  assert.equal(calls[0]?.url,"/sessions/s1/prompt/v2/receipts/attempt-1?expected_session_incarnation=inc-1");
  status=404;payload={ok:false,error:{code:"prompt-receipt-not-found",message:"private detail"}};
  response=await lookup();assert.equal(response.status,404);const body=await response.json() as {error:{code:string}};assert.equal(body.error.code,"prompt-receipt-not-found");assert.doesNotMatch(JSON.stringify(body),/private detail/);
});
test("edge preserves request-bound refused and unknown receipts without leaking daemon details",async()=>{
  for(const [outcome,code,http]of [["refused","busy",409],["unknown","structured-prompt-outcome-unknown",500]]as const){
    status=http;payload={ok:false,error:{code,message:"must-not-leak",details:{receipt:receipt(outcome,code),debug:"must-not-leak"}}};
    const response=await submit(keyed);assert.equal(response.status,http);const body=await response.json() as {error:{details:{receipt:unknown}}};
    assert.deepEqual(body.error.details.receipt,receipt(outcome,code));assert.doesNotMatch(JSON.stringify(body),/must-not-leak/);
  }
});
test("edge keeps auth CSRF and keyed-body validation before any daemon dispatch",async()=>{
  calls.length=0;const unauthorized=await fetch(`${base}/api/sessions/host-a/s1/prompt/v2/receipts/attempt-1?expected_session_incarnation=inc-1`);assert.equal(unauthorized.status,401);
  assert.equal((await submit(keyed,"https://different.invalid")).status,403);
  for(const extra of [{request_id:""},{request_id:"x".repeat(129)},{request_id:"unsafe\nkey"},{require_idle:"true"},{require_idle:null},{extra:true}])assert.equal((await submit({...keyed,...extra})).status,400);
  assert.equal(calls.length,0);
});
test("edge rejects mismatched or malformed keyed acknowledgements",async()=>{
  for(const change of [{request_id:"other"},{session_id:"other"},{session_incarnation:"other"},{code:"busy"}]){
    status=200;payload={ok:true,data:{submitted:true,session_incarnation:"inc-1",receipt:{...receipt(),...change},debug:"must-not-leak"}};
    const response=await submit(keyed);assert.equal(response.status,502);assert.doesNotMatch(await response.text(),/must-not-leak/);
  }
});

test("edge accepts the independent optional keyed and idle flags from the v2 contract",async()=>{
  for(const options of [{request_id:"attempt-1"},{require_idle:true},{require_idle:false},{request_id:"attempt-1",require_idle:false}]){
    calls.length=0;status=200;payload={ok:true,data:{submitted:true,session_incarnation:"inc-1",receipt:receipt()}};
    const body={text:"optional flags",expected_session_incarnation:"inc-1",...options};
    const response=await submit(body);assert.equal(response.status,200);assert.deepEqual(calls[0]?.body,body);
  }
});
test("an older runtime without keyed prompts yields a definite unsupported refusal, while fenced replies still pass",async()=>{
  // agent-session before the keyed contract rejects unknown v2 fields with 400 invalid-json-body before provider dispatch.
  calls.length=0;status=400;payload={ok:false,error:{code:"invalid-json-body",message:"unknown field `request_id`"}};
  const refused=await submit(keyed);assert.equal(refused.status,400);
  const body=await refused.json() as {ok:boolean;error:{code:string;message:string}};
  assert.equal(body.ok,false);assert.equal(body.error.code,"keyed-prompt-unsupported");
  assert.match(body.error.message,/does not support queued replies/);
  assert.equal(calls.length,1);
  calls.length=0;status=200;payload={ok:true,data:{submitted:true,session_incarnation:"inc-1"}};
  const fenced=await submit({text:"fenced reply",expected_session_incarnation:"inc-1"});assert.equal(fenced.status,200);
  assert.deepEqual(calls.map(call=>call.body),[{text:"fenced reply",expected_session_incarnation:"inc-1"}]);
});

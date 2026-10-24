import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer } from "node:http";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, loginCookie, makeEdgeConfig } from "./support.ts";

const image = `${"a".repeat(16)}.0.0.${"b".repeat(32)}`;
test("history images use authenticated proxy bytes and preserve only explicit deleted errors",async () => {
  const seen: Array<{path:string;authorization: string | undefined}> = [];
  const png = Buffer.from([137,80,78,71,13,10,26,10]);
  const daemon = createServer((req,res) => {
    seen.push({path:req.url ?? "",authorization:req.headers.authorization});
    if (req.url?.includes("/deleted/")) {
      res.writeHead(404,{"content-type":"application/json"});
      res.end(JSON.stringify({error:{code:"history-image-deleted",message:"/private/path"}}));
    } else if (req.url?.includes("/old/")) { res.writeHead(404);res.end("route missing"); }
    else if (req.url?.includes("/oversized/")) { res.writeHead(200,{"content-type":"image/png","content-length":9 * 1024 * 1024});res.end(); }
    else if (req.url?.includes("/failure/")) { res.writeHead(500);res.end("private upstream failure"); }
    else if (req.url?.includes("/misconfigured/")) { res.writeHead(401);res.end("private upstream auth"); }
    else if (req.url?.includes("/redirect/")) { res.writeHead(302,{location:"https://example.invalid/image.png"});res.end(); }
    else if (req.url?.includes("/unsupported/")) { res.writeHead(200,{"content-type":"image/svg+xml"});res.end("<svg/>"); }
    else if (req.url?.includes("/encoded/")) { res.writeHead(200,{"content-type":"image/png","content-disposition":"inline; filename*=UTF-8''O%27Reilly%20%281%29%2A.png"});res.end(png); }
    else { res.writeHead(200,{"content-type":"image/png","content-disposition":"inline; filename*=UTF-8''original%20plot.png","set-cookie":"upstream=private"});res.end(png); }
  });
  const {base:upstream} = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({openAccess:false,clientToken:"client-secret",machines:[{name:"fixture",url:upstream,token:"daemon-secret"}]}));
  const {base} = await listenOnLoopback(edge);
  try {
    const path = (history: string,id = image) => `${base}/api/history/sessions/fixture/${history}/images/${id}`;
    assert.equal((await fetch(path("history"))).status,401);
    assert.equal(seen.length,0);
    const cookie = await loginCookie(base);
    const response = await fetch(path("history"),{headers:{cookie}});
    assert.equal(response.status,200);
    assert.equal(response.headers.get("content-type"),"image/png");
    assert.equal(response.headers.get("content-disposition"),"inline; filename*=UTF-8''original%20plot.png");
    assert.equal(response.headers.get("cache-control"),"private, no-store");
    assert.equal(response.headers.get("set-cookie"),null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
    assert.equal(seen[0]?.authorization,"Bearer daemon-secret");
    assert.equal(seen[0]?.path,`/history/sessions/history/images/${image}`);
    const encodedName = await fetch(path("encoded"),{headers:{cookie}});
    assert.equal(encodedName.headers.get("content-disposition"),"inline; filename*=UTF-8''O%27Reilly%20%281%29%2A.png");
    assert.equal(seen[1]?.path,`/history/sessions/encoded/images/${image}`);
    const uploadReference = `${"a".repeat(16)}.0.u0-0.${"b".repeat(32)}`;
    const uploadedImage = await fetch(path("history", uploadReference),{headers:{cookie}});
    assert.equal(uploadedImage.status,200);
    assert.deepEqual(Buffer.from(await uploadedImage.arrayBuffer()),png);
    assert.equal(seen[2]?.authorization,"Bearer daemon-secret");
    assert.equal(seen[2]?.path,`/history/sessions/history/images/${uploadReference}`);
    const deleted = await fetch(path("deleted"),{headers:{cookie}});
    assert.equal(deleted.status,404);
    assert.deepEqual(await deleted.json(),{ok:false,error:{code:"history-image-deleted",message:"Image deleted"}});
    for (const history of ["old","oversized","unsupported"]) {
      const response = await fetch(path(history),{headers:{cookie}});
      assert.equal(response.status,422,history);
      assert.equal((await response.json() as {error:{code:string}}).error.code,"history-image-unavailable");
    }
    for (const history of ["failure","misconfigured","redirect"]) {
      const response = await fetch(path(history),{headers:{cookie}});
      assert.equal(response.status,502,history);
      assert.deepEqual(await response.json(),{ok:false,error:{code:"history-image-read-failed",message:"Image service unavailable"}});
    }
    const count = seen.length;
    assert.equal((await fetch(path("history","invalid-selector"),{headers:{cookie}})).status,422);
    assert.equal((await fetch(path("history",`${"a".repeat(16)}.0.u0-.${"b".repeat(32)}`),{headers:{cookie}})).status,422);
    assert.equal(seen.length,count);
  } finally { edge.closeAllConnections();daemon.closeAllConnections(); await Promise.all([new Promise<void>(r=>edge.close(()=>r())),new Promise<void>(r=>daemon.close(()=>r()))]); }
});


test("closing an image client cancels a pending upstream transfer",async () => {
  let started!: () => void;
  let closed!: () => void;
  const upstreamStarted = new Promise<void>(resolve => { started = resolve; });
  const upstreamClosed = new Promise<void>(resolve => { closed = resolve; });
  const daemon = createServer((_req,res) => {
    res.on("close",closed);
    res.writeHead(200,{"content-type":"image/png"});
    res.write(Buffer.from([137,80,78,71,13,10,26,10]));
    started();
  });
  const {base:upstream} = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({openAccess:true,machines:[{name:"fixture",url:upstream}]}));
  const {base} = await listenOnLoopback(edge);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = fetch(`${base}/api/history/sessions/fixture/history/images/${image}`,{signal:controller.signal}).catch(() => null);
  try {
    await Promise.race([upstreamStarted, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("image proxy did not contact daemon")),1000); })]);
    clearTimeout(timer);
    controller.abort();
    await response;
    const cancelled = await Promise.race([
      upstreamClosed.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false),1000); }),
    ]);
    assert.equal(cancelled,true,"the abandoned daemon transfer closes before the proxy timeout");
  } finally {
    clearTimeout(timer);
    controller.abort();
    edge.closeAllConnections();daemon.closeAllConnections();
    await Promise.all([new Promise<void>(r=>edge.close(()=>r())),new Promise<void>(r=>daemon.close(()=>r()))]);
  }
});

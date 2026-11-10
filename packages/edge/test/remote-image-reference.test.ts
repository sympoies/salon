import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEdgeServer } from "../src/server.ts";
import { defaults } from "../src/remoteImage/service.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

const image = `${"a".repeat(16)}.0.0.${"b".repeat(32)}`;
test("remote image reference fetches only the daemon-selected URL", async () => {
  let daemonCalls = 0; const fetched: string[] = [];
  const daemon = createServer((req, res) => {
    daemonCalls++;
    if (req.url?.includes("/local/")) { res.writeHead(200, {"content-type":"image/png"}); res.end("local"); return; }
    if (req.url?.includes("/failure/")) { res.writeHead(500); res.end(); return; }
    res.writeHead(422, {"content-type":"application/json"});
    res.end(JSON.stringify({error:{code:"history-image-unavailable",reason:req.url?.includes("/outside/") ? "outside-allowed-roots" : "remote-url-not-fetched", ...(req.url?.includes("/missing/") ? {} : {source_url:"https://example.invalid/image?x=(nested)"})}}));
  });
  const upstream = await listenOnLoopback(daemon); const dir = mkdtempSync(join(tmpdir(), "remote-reference-"));
  const edge = createEdgeServer(makeEdgeConfig({machines:[{name:"fixture",url:upstream.base}],remoteImage:{...defaults,stateDir:dir}}), {
    remoteImageFetch: async url => { fetched.push(url); return {ok:true,contentType:"image/png",bytes:Buffer.from("remote")}; },
  });
  const {base} = await listenOnLoopback(edge);
  const request = (history:string) => fetch(`${base}/api/history/sessions/fixture/${history}/remote-image/${image}`);
  try {
    const response = await fetch(`${base}/api/history/sessions/fixture/history/remote-image/${image}?url=${encodeURIComponent("https://example.invalid/attacker")}`); assert.equal(response.status,200); assert.equal(await response.text(),"remote");
    assert.deepEqual(fetched,["https://example.invalid/image?x=(nested)"]);
    const missing = await request("missing"); assert.equal(missing.status,422);
    assert.equal((await missing.json() as {error:{code:string}}).error.code,"history-image-unavailable");
    const outside = await request("outside"); assert.equal(outside.status,422);
    assert.equal((await outside.json() as {error:{reason:string}}).error.reason,"outside-allowed-roots");
    await request("local"); await request("failure"); assert.equal(fetched.length,1); assert.equal(daemonCalls,5);
  } finally { edge.closeAllConnections(); daemon.closeAllConnections(); await Promise.all([edge,daemon].map(s => new Promise<void>(r => s.close(() => r())))); rmSync(dir,{recursive:true,force:true}); }
});

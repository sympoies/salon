import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, loginCookie, makeEdgeConfig } from "./support.ts";

test("remote history image fetch requires authentication and refuses blocked destinations", async () => {
  const edge = createEdgeServer(makeEdgeConfig({openAccess:false,clientToken:"client-secret",machines:[{name:"fixture",url:"http://fixture.invalid"}]}));
  const {base} = await listenOnLoopback(edge);
  const endpoint = `${base}/api/history/sessions/fixture/history/remote-image`;
  const request = (url: string, cookie?: string) => fetch(endpoint, {method:"POST",headers:{"content-type":"application/json",...(cookie ? {cookie} : {})},body:JSON.stringify({url})});
  try {
    assert.equal((await request("https://127.0.0.1/image.png")).status,401);
    const cookie = await loginCookie(base);
    for (const url of ["https://127.0.0.1/image.png", "https://10.0.0.1/image.png", "https://169.254.1.1/image.png", "https://100.64.0.1/image.png", "https://[::1]/image.png"]) {
      const response = await request(url,cookie);
      assert.equal(response.status,422,url);
      assert.equal((await response.json() as {error:{reason:string}}).error.reason,"blocked-address");
    }
    const crossOrigin = await fetch(endpoint,{method:"POST",headers:{cookie,origin:"https://other.invalid","content-type":"application/json"},body:JSON.stringify({url:"https://example.invalid/image.png"})});
    assert.equal(crossOrigin.status,403);
  } finally {
    edge.closeAllConnections();
    await new Promise<void>(resolve => edge.close(() => resolve()));
  }
});

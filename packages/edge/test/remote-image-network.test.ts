import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyRemoteAddress, sniffRemoteImage } from "../src/remoteImages.ts";

test("remote address policy rejects unsafe ranges, including mapped IPv4", () => {
  for (const address of ["0.0.0.0", "127.0.0.1", "169.254.2.3", "10.2.3.4", "172.16.1.1", "192.168.1.1", "100.64.0.1", "224.0.0.1", "::", "::1", "fe80::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.2.3.4"]) {
    assert.notEqual(classifyRemoteAddress(address),"public",address);
  }
  for (const address of ["10.2.3.4", "172.16.1.1", "192.168.1.1", "100.64.0.1", "fc00::1", "::ffff:10.2.3.4"]) {
    assert.equal(classifyRemoteAddress(address),"internal",address);
  }
  for (const address of ["127.0.0.1", "169.254.2.3", "::1", "fe80::1", "ff02::1"]) {
    assert.equal(classifyRemoteAddress(address),"blocked",address);
  }
  assert.equal(classifyRemoteAddress("192.0.2.1"),"public");
  assert.equal(classifyRemoteAddress("2001:db8::1"),"public");
});

test("only recognized raster signatures are accepted", () => {
  assert.equal(sniffRemoteImage(Buffer.from([137,80,78,71,13,10,26,10])),"image/png");
  assert.equal(sniffRemoteImage(Buffer.from([255,216,255,224])),"image/jpeg");
  assert.equal(sniffRemoteImage(Buffer.from("GIF89a")),"image/gif");
  assert.equal(sniffRemoteImage(Buffer.from("RIFF....WEBP")),"image/webp");
  assert.equal(sniffRemoteImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")),undefined);
  assert.equal(sniffRemoteImage(Buffer.from("not an image")),undefined);
});

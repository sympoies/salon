import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyAddress, decideTarget, parseAllowList, parseRemoteImageUrl } from "../src/remoteImage/address.ts";

test("classifies IPv4, IPv6 and embedded IPv4 ranges", () => {
  const cases: [string, string][] = [
    ["0.0.0.0", "unspecified"], ["0.1.2.3", "unspecified"], ["240.0.0.1", "reserved"], ["127.0.0.1", "loopback"], ["169.254.1.1", "link-local"],
    ["10.0.0.1", "private"], ["172.16.0.1", "private"], ["192.168.0.1", "private"],
    ["100.64.0.1", "cgnat"], ["224.0.0.1", "multicast"], ["255.255.255.255", "broadcast"],
    ["192.0.2.1", "documentation"], ["198.51.100.1", "documentation"], ["203.0.113.1", "documentation"],
    ["198.18.0.1", "benchmark"], ["8.8.8.8", "public"],
    ["::", "unspecified"], ["::1", "loopback"], ["fe80::1", "link-local"],
    ["fc00::1", "unique-local"], ["ff02::1", "multicast"], ["2001:db8::1", "documentation"],
    ["2001:2::1", "benchmark"], ["2606:4700:4700::1111", "public"],
    ["::ffff:10.0.0.1", "private"], ["::ffff:0.1.2.3", "unspecified"],
    ["64:ff9b::7f00:1", "loopback"], ["64:ff9b:1::a00:1", "reserved"],
    ["2002:7f00:1::1", "loopback"], ["2001::1", "reserved"],
    ["fec0::1", "reserved"], ["100::1", "reserved"], ["::127.0.0.1", "loopback"],
    ["::ffff:192.0.2.1", "documentation"], ["::ffff:8.8.8.8", "public"],
  ];
  for (const [ip, expected] of cases) assert.equal(classifyAddress(ip), expected, ip);
  assert.throws(() => classifyAddress("not-an-ip"));
});

test("parses only safe absolute HTTP URLs and normalizes literal hosts", () => {
  for (const raw of ["http://user@example.com", "http://example.com\\@evil.example", "ftp://example.com", "/relative", "http://", "http://%ff"]) {
    assert.throws(() => parseRemoteImageUrl(raw), raw);
  }
  for (const raw of ["http://2130706433/a", "http://0177.0.0.1/a", "http://127.1/a"]) {
    const parsed = parseRemoteImageUrl(raw);
    assert.equal(parsed.host, "127.0.0.1");
    assert.equal(parsed.isIpLiteral, true);
  }
  assert.deepEqual(parseRemoteImageUrl("HTTPS://Example.COM/path"), { scheme: "https", host: "example.com", port: 443, isIpLiteral: false });
});

test("allow-list admission applies to every resolved address and exact port", () => {
  const url = parseRemoteImageUrl("https://images.example:8443/a");
  const listed = parseAllowList(["images.example:8443"]);
  assert.equal(decideTarget(url, ["10.0.0.1"], listed).allowed, true);
  assert.equal(decideTarget(url, ["10.0.0.1"], []).allowed, false);
  assert.equal(decideTarget(url, ["127.0.0.1"], listed).allowed, false);
  assert.equal(decideTarget(url, ["8.8.8.8", "10.0.0.1"], []).allowed, false);
  assert.equal(decideTarget(url, ["8.8.8.8"], []).address, "8.8.8.8");
  assert.equal(decideTarget(url, [], listed).allowed, false);
  const literal = parseRemoteImageUrl("http://10.0.0.1:8080/a");
  assert.equal(decideTarget(literal, ["10.0.0.1"], []).allowed, false);
  assert.equal(decideTarget(literal, ["10.0.0.1"], parseAllowList(["10.0.0.1:8080"])).allowed, true);
  assert.equal(decideTarget(literal, ["10.0.0.1"], parseAllowList(["10.0.0.1:8081"])).allowed, false);
  assert.equal(decideTarget(parseRemoteImageUrl("http://images.example"), ["8.8.8.8"], []).allowed, false);
});

test("allow-list rejects malformed entries and wildcard or CIDR matching", () => {
  for (const entry of ["*.example.com", "10.0.0.0/8", "https://example.com", "user@example.com", "example.com:0", "example.com:65536", "example.com/path", ""]) {
    assert.throws(() => parseAllowList([entry]), entry);
  }
});

test("local-use NAT64 prefixes are refused regardless of embedded layout", () => {
  for (const ip of ["64:ff9b:1:1234:7f:0:100:0", "64:ff9b:1:808:8:800::"]) {
    assert.equal(classifyAddress(ip), "reserved");
    assert.equal(decideTarget(parseRemoteImageUrl("https://images.example"), [ip], []).allowed, false);
  }
});

test("IPv6 documentation prefix and boundaries are classified and refused", () => {
  for (const ip of ["3fff::1", "3fff:fff:ffff::1"]) {
    assert.equal(classifyAddress(ip), "documentation");
    for (const allow of [[], parseAllowList(["images.example"])]) {
      assert.equal(decideTarget(parseRemoteImageUrl("https://images.example"), [ip], allow).allowed, false);
    }
  }
  assert.equal(classifyAddress("3fff:1000::1"), "public");
});

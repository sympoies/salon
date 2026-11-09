import { isIP } from "node:net";

export type AddressClass = "public" | "loopback" | "unspecified" | "link-local" | "private" | "cgnat" | "unique-local" | "multicast" | "broadcast" | "documentation" | "benchmark" | "reserved";
export type RemoteImageUrl = { scheme: "http" | "https"; host: string; port: number; isIpLiteral: boolean };
export type AllowListEntry = { host: string; port: number | null };
export type TargetDecision = { allowed: boolean; address: string | null; reason: string };

function validName(host: string): boolean {
  return host.length <= 253 && host.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

export function parseRemoteImageUrl(raw: string): RemoteImageUrl {
  if (raw.includes("\\") || /[\u0000-\u0020\u007f]/.test(raw) || !/^https?:\/\//i.test(raw)) throw new Error("Invalid remote image URL");
  const authority = raw.slice(raw.indexOf("//") + 2).split(/[/?#]/, 1)[0] ?? "";
  if (authority.includes("@")) throw new Error("Userinfo is not allowed");
  const url = new URL(raw);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) throw new Error("Invalid remote image URL");
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const literal = isIP(host) !== 0;
  if (!literal && !validName(host)) throw new Error("Invalid host");
  const scheme = url.protocol === "https:" ? "https" : "http";
  return { scheme, host, port: url.port ? Number(url.port) : scheme === "https" ? 443 : 80, isIpLiteral: literal };
}

export function parseAllowList(config: readonly string[]): AllowListEntry[] {
  return config.map((entry) => {
    if (!entry || /[\s\\/@?#*%]/.test(entry)) throw new Error("Invalid allow-list entry");
    const match = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(entry);
    if (!match) throw new Error("Invalid allow-list entry");
    const port = match[2] === undefined ? null : Number(match[2]);
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("Invalid allow-list port");
    const parsed = parseRemoteImageUrl(`http://${match[1]}/`);
    return { host: parsed.host, port };
  });
}

function ipv4Class(n: number): AddressClass {
  const inRange = (base: number, bits: number) => (n >>> (32 - bits)) === (base >>> (32 - bits));
  if (inRange(0, 8)) return "unspecified";
  if (inRange(0x7f000000, 8)) return "loopback";
  if (inRange(0xa9fe0000, 16)) return "link-local";
  if (inRange(0x0a000000, 8) || inRange(0xac100000, 12) || inRange(0xc0a80000, 16)) return "private";
  if (inRange(0x64400000, 10)) return "cgnat";
  if (n === 0xffffffff) return "broadcast";
  if (inRange(0xf0000000, 4)) return "reserved";
  if (inRange(0xe0000000, 4)) return "multicast";
  if (inRange(0xc0000200, 24) || inRange(0xc6336400, 24) || inRange(0xcb007100, 24)) return "documentation";
  if (inRange(0xc6120000, 15)) return "benchmark";
  return "public";
}

function ipv6Words(ip: string): number[] {
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split("::");
  const first = left ? left.split(":").map((part) => parseInt(part, 16)) : [];
  const last = right ? right.split(":").map((part) => parseInt(part, 16)) : [];
  return right === undefined ? first : [...first, ...Array<number>(8 - first.length - last.length).fill(0), ...last];
}

export function classifyAddress(ip: string): AddressClass {
  const version = isIP(ip);
  if (version === 4) return ipv4Class(ip.split(".").reduce((n, octet) => (n * 256 + Number(octet)) >>> 0, 0));
  if (version !== 6) throw new Error("Invalid IP address");
  const words = ipv6Words(ip);
  const first = words[0]!;
  const firstFiveZero = words.slice(0, 5).every((word) => word === 0);
  if (firstFiveZero && words[5] === 0 && words[6] === 0 && words[7] === 0) return "unspecified";
  if (firstFiveZero && words[5] === 0 && words[6] === 0 && words[7] === 1) return "loopback";
  if (firstFiveZero && (words[5] === 0 || words[5] === 0xffff)) return ipv4Class((words[6]! * 65536 + words[7]!) >>> 0);
  if (first === 0x64 && words[1] === 0xff9b && words[2] === 1) return "reserved";
  if (first === 0x64 && words[1] === 0xff9b && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0) return ipv4Class((words[6]! * 65536 + words[7]!) >>> 0);
  if (first === 0x2002) return ipv4Class((words[1]! * 65536 + words[2]!) >>> 0);
  if ((first === 0x2001 && words[1] === 0) || (first & 0xffc0) === 0xfec0 || (first === 0x100 && words[1] === 0 && words[2] === 0 && words[3] === 0)) return "reserved";
  if ((first & 0xffc0) === 0xfe80) return "link-local";
  if ((first & 0xfe00) === 0xfc00) return "unique-local";
  if ((first & 0xff00) === 0xff00) return "multicast";
  if ((first === 0x2001 && words[1] === 0xdb8) || (first === 0x3fff && (words[1]! & 0xf000) === 0)) return "documentation";
  if (words[0] === 0x2001 && words[1] === 2 && words[2] === 0) return "benchmark";
  return "public";
}

export function decideTarget(url: RemoteImageUrl, resolvedAddresses: readonly string[], allowList: readonly AllowListEntry[]): TargetDecision {
  const listed = allowList.some((entry) => entry.host === url.host && (entry.port === url.port || (entry.port === null && url.port === (url.scheme === "https" ? 443 : 80))));
  const deny = (reason: string): TargetDecision => ({ allowed: false, address: null, reason });
  if (url.isIpLiteral && !listed) return deny("IP literal is not allow-listed");
  if (!listed && url.scheme !== "https") return deny("HTTPS is required");
  if (!resolvedAddresses.length) return deny("No resolved addresses");
  for (const address of resolvedAddresses) {
    let kind: AddressClass;
    try { kind = classifyAddress(address); } catch { return deny("Invalid resolved address"); }
    if (kind !== "public" && !(listed && (kind === "private" || kind === "cgnat" || kind === "unique-local"))) return deny(`Blocked address: ${kind}`);
  }
  return { allowed: true, address: resolvedAddresses[0]!, reason: "allowed" };
}

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

async function fixture(allowedMachines?: string[], machineNames = { source: "summit", destination: "cedar" }) {
  const sourceName = machineNames.source;
  const destinationName = machineNames.destination;
  const dir = mkdtempSync(join(tmpdir(), "relay-test-"));
  const db = join(dir, "access.sqlite");
  const state = { writes: 0, loseResponse: false, badReceipt: false, destinationMode: "advisory", destinationAvailable: true as boolean | undefined, destinationSupported: true, destinationStatus: "running" as unknown, destinationStartup: undefined as unknown, destinationError: "", destinationErrorStatus: 409, destinationErrorDetails: undefined as unknown, destinationIncarnation: "dest-inc", sourceIncarnation: "src-inc", seen: {} as Record<string, unknown> };
  const source = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer source-operator");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, data: { coordination: { remote_messaging_supported: true }, sessions: [
      { id: "source", session_incarnation: state.sourceIncarnation, status: "running", coordination_mode: "advisory", coordination_available: true },
      { id: "unowned", session_incarnation: "unknown-inc", coordination_mode: "advisory", coordination_available: true },
    ] } }));
  });
  const dest = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer dest-operator");
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") {
      res.end(JSON.stringify({ ok: true, data: { coordination: { remote_messaging_supported: state.destinationSupported }, sessions: [
        { id: "destination", session_incarnation: state.destinationIncarnation, status: state.destinationStatus, startup: state.destinationStartup, coordination_mode: state.destinationMode, coordination_available: state.destinationAvailable },
        { id: "other-user", session_incarnation: "other-inc", coordination_mode: "advisory", coordination_available: true },
      ] } }));
      return;
    }
    assert.equal(req.url, "/coordination/messages/receive/v1");
    assert.equal(req.headers["x-agent-session-relay-token"], "dest-ingress");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    state.seen = JSON.parse(Buffer.concat(chunks).toString());
    if (state.destinationError) {
      res.writeHead(state.destinationErrorStatus);
      res.end(JSON.stringify({ ok: false, error: { code: state.destinationError, message: "private-upstream-error-sentinel", body: "private-response-sentinel", details: state.destinationErrorDetails } }));
      return;
    }
    state.writes++;
    if (state.loseResponse) { req.socket.destroy(); return; }
    res.end(JSON.stringify({ schema_version: "agent-session.remote-delivery.v1", message_id: state.badReceipt ? "wrong-id" : state.seen.message_id, state: "delivered", recipient: state.seen.to, persisted_at_epoch: Math.floor(Date.now() / 1000), private_body: "private-response-sentinel" }));
  });
  const srcAddr = await listenOnLoopback(source);
  const dstAddr = await listenOnLoopback(dest);
  const access = new AccessStore(db);
  access.claimSession({ principalId: "tess", machine: sourceName, sessionId: "source", incarnation: "src-inc" });
  access.claimSession({ principalId: "tess", machine: destinationName, sessionId: "destination", incarnation: "dest-inc" });
  access.claimSession({ principalId: "dana", machine: destinationName, sessionId: "other-user", incarnation: "other-inc" });
  access.close();
  const edge = createEdgeServer(makeEdgeConfig({
    openAccess: false, multiUser: true, accessDbPath: db,
    principals: [
      { id: "tess", token: "browser-tess", machines: allowedMachines ?? [sourceName, destinationName], permissions: ["debug"] },
      { id: "dana", token: "browser-dana", machines: [destinationName], permissions: [] },
    ],
    machines: [ { name: sourceName, url: srcAddr.base, token: "source-operator" }, { name: destinationName, url: dstAddr.base, token: "dest-operator" } ],
    ...{ coordinationRelays: [ { machine: sourceName, token: "source-relay", ingress_token: "source-ingress" }, { machine: destinationName, token: "dest-relay", ingress_token: "dest-ingress" } ] },
  }));
  const { base } = await listenOnLoopback(edge);
  const now = Math.floor(Date.now() / 1000);
  const envelope = {
    schema_version: "agent-session.remote-message.v1", message_id: "7f502746-1a36-45b6-83aa-484f370e280a",
    from: { machine: sourceName, session_id: "source", session_incarnation: "src-inc" },
    to: { machine: destinationName, session_id: "destination", session_incarnation: "dest-inc" },
    body: "private-message-sentinel", body_sha256: createHash("sha256").update("private-message-sentinel").digest("hex"),
    created_at_epoch: now, expires_at_epoch: now + 3600, reply_depth: 0,
  };
  return { state, base, envelope, cleanup: async () => {
    await Promise.all([edge, source, dest].map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
    rmSync(dir, { recursive: true, force: true });
  } };
}
async function send(base: string, envelope: unknown, token = "source-relay") {
  const response = await fetch(`${base}/api/coordination/relay/v1`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(envelope) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test("daemon relay accepts native flat coordination availability with separate ingress auth and receipt", async () => {
  const f = await fixture();
  try {
    const result = await send(f.base, f.envelope);
    assert.equal(result.status, 200);
    assert.equal(result.body.state, "delivered");
    assert.equal(JSON.stringify(result.body).includes("private-response-sentinel"), false);
    assert.deepEqual(f.state.seen, f.envelope);
    assert.equal(f.state.writes, 1);
  } finally { await f.cleanup(); }
});

function forwardedEnvelope(base: Awaited<ReturnType<typeof fixture>>["envelope"], count = 1) {
  const originalSender = { machine: "historical-host", session_id: "original", session_incarnation: "stopped-inc" };
  const participants = Array.from({ length: count + 1 }, (_, index) =>
    index === count ? base.to : index === count - 1 ? base.from
      : { machine: "historical-host", session_id: `hop-${index}`, session_incarnation: `old-${index}` });
  const originalId = "11111111-1111-4111-8111-111111111111";
  return { ...base, schema_version: "agent-session.remote-message.v2", category: "progress",
    forwarding: {
      attestation: "forwarder", original_message_id: originalId, original_sender: originalSender,
      original_recipient: participants[0], original_created_at_epoch: base.created_at_epoch - 10,
      original_expires_at_epoch: base.expires_at_epoch, body_sha256: base.body_sha256,
      hops: Array.from({ length: count }, (_, index) => ({
        source_message_id: index === 0 ? originalId : "22222222-2222-4222-8222-222222222222",
        source_revision: 1, forwarder: participants[index], recipient: participants[index + 1],
        forwarded_at_epoch: base.created_at_epoch - count + index + 1,
      })),
    },
  };
}

test("v2 relays every category and bounded forwarding provenance unchanged with historical origins", async () => {
  const f = await fixture();
  try {
    for (const category of ["uncategorized", "progress", "handoff", "blocker", "decision", "report"]) {
      const packet = { ...f.envelope, schema_version: "agent-session.remote-message.v2", category };
      assert.equal((await send(f.base, packet)).status, 200);
      assert.deepEqual(f.state.seen, packet);
    }
    for (const count of [1, 8]) {
      const packet = forwardedEnvelope(f.envelope, count);
      assert.equal((await send(f.base, packet)).status, 200);
      assert.deepEqual(f.state.seen, packet);
      const { category: _category, ...uncategorized } = packet;
      assert.equal((await send(f.base, uncategorized)).status, 200);
      assert.deepEqual(f.state.seen, uncategorized);
    }
    assert.equal(f.state.writes, 10);
  } finally { await f.cleanup(); }
});

test("v2 preserves historical service origin without admitting direct service or hybrid origins", async () => {
  const f = await fixture();
  try {
    const packet = forwardedEnvelope(f.envelope);
    const original_sender = { machine: "historical-host", service_id: "monitor.service", service_generation: "generation-1" };
    const service = { ...packet, forwarding: { ...packet.forwarding, original_sender } };
    assert.equal((await send(f.base, service)).status, 200);
    assert.deepEqual(f.state.seen, service);
    for (const origin of [
      { ...original_sender, service_id: "x".repeat(129) }, { ...original_sender, service_generation: "" },
      { ...original_sender, service_generation: "x".repeat(129) }, { ...original_sender, service_id: "bad:service" },
      { ...original_sender, service_generation: "é" }, { ...original_sender, machine: "" },
      { ...original_sender, session_id: "hybrid", session_incarnation: "hybrid-inc" },
      { ...original_sender, service_generation: 1 }, { ...original_sender, unknown: true },
    ]) assert.equal((await send(f.base, { ...service, forwarding: { ...service.forwarding, original_sender: origin } })).status, 400);
    assert.equal((await send(f.base, { ...service, from: original_sender })).status, 400);
    assert.equal(f.state.writes, 1);
  } finally { await f.cleanup(); }
});

test("v2 rejects invalid extensions and v1 keeps its exact field contract before writes", async () => {
  const f = await fixture();
  try {
    const v2 = { ...f.envelope, schema_version: "agent-session.remote-message.v2", category: "progress" };
    for (const packet of [
      { ...v2, category: undefined }, { ...v2, category: null, forwarding: null },
      { ...v2, category: "unknown" }, { ...v2, category: "x".repeat(128 * 1024) },
      { ...v2, category: 1 }, { ...v2, unknown: true }, { ...v2, forwarding: [] },
      { ...v2, from: { ...v2.from, service_id: "hybrid" } },
      { ...v2, schema_version: "agent-session.remote-service-message.v2" },
      { ...v2, schema_version: "agent-session.remote-message.v3" },
      { ...f.envelope, category: "progress" }, { ...f.envelope, forwarding: null },
      { ...v2, body: "x".repeat(16 * 1024 + 1) },
    ]) assert.equal((await send(f.base, packet)).status, 400);
    assert.equal(f.state.writes, 0);
  } finally { await f.cleanup(); }
});

test("v2 rejects spoofed forwarding chains, loops, expanded expiry and malformed bounded metadata", async () => {
  const f = await fixture();
  try {
    const packet = forwardedEnvelope(f.envelope);
    const root = packet.forwarding;
    const hop = root.hops[0]!;
    const invalidRoots: unknown[] = [
      { ...root, attestation: "authenticated" }, { ...root, unknown: true },
      { ...root, original_message_id: "not-a-uuid" },
      { ...root, original_sender: { ...root.original_sender, machine: "x".repeat(129) } },
      { ...root, original_sender: { ...root.original_sender, extra: true } },
      { ...root, original_recipient: { ...root.original_recipient, session_incarnation: "spoof" } },
      { ...root, original_created_at_epoch: -1 },
      { ...root, original_created_at_epoch: packet.created_at_epoch + 120 },
      { ...root, original_expires_at_epoch: root.original_created_at_epoch + 7 * 24 * 3600 + 1 },
      { ...root, original_expires_at_epoch: packet.expires_at_epoch - 1 },
      { ...root, body_sha256: "0".repeat(64) }, { ...root, hops: [] },
      forwardedEnvelope(f.envelope, 9).forwarding,
      ...[
        { ...hop, source_message_id: "33333333-3333-4333-8333-333333333333" },
        { ...hop, source_revision: 0 }, { ...hop, source_revision: 1.5 },
        { ...hop, source_revision: Number.MAX_SAFE_INTEGER + 1 },
        { ...hop, forwarder: { ...hop.forwarder, session_incarnation: "spoof" } },
        { ...hop, recipient: { ...hop.recipient, session_incarnation: "spoof" } },
        { ...hop, forwarded_at_epoch: root.original_created_at_epoch - 1 },
        { ...hop, forwarded_at_epoch: packet.created_at_epoch + 120 },
        { ...hop, unknown: true },
      ].map(value => ({ ...root, hops: [value] })),
    ];
    for (const key of Object.keys(root)) {
      const incomplete = { ...root } as Record<string, unknown>;
      delete incomplete[key];
      invalidRoots.push(incomplete);
    }
    for (const forwarding of invalidRoots) {
      assert.equal((await send(f.base, { ...packet, forwarding })).status, 400, JSON.stringify(forwarding));
    }
    const multi = forwardedEnvelope(f.envelope, 2);
    assert.equal((await send(f.base, { ...multi, forwarding: { ...multi.forwarding, hops: [
      multi.forwarding.hops[0], { ...multi.forwarding.hops[1], forwarder: multi.forwarding.original_recipient },
    ] } })).status, 400);
    assert.equal((await send(f.base, { ...multi, forwarding: { ...multi.forwarding, hops: [
      { ...multi.forwarding.hops[0], forwarded_at_epoch: packet.created_at_epoch + 1 }, multi.forwarding.hops[1],
    ] } })).status, 400);
    for (const original_sender of [packet.to, { ...packet.to, session_incarnation: "prior-incarnation" }]) {
      assert.equal((await send(f.base, { ...packet, forwarding: { ...root, original_sender } })).status, 400);
    }
    const self = { ...packet, to: packet.from, forwarding: { ...root, hops: [{ ...hop, recipient: packet.from }] } };
    assert.equal((await send(f.base, self)).status, 400);
    const spoofedMachine = { ...packet, from: { ...packet.from, machine: "cedar" }, forwarding: {
      ...root, original_recipient: { ...packet.from, machine: "cedar" },
      hops: [{ ...hop, forwarder: { ...packet.from, machine: "cedar" } }],
    } };
    assert.equal((await send(f.base, spoofedMachine)).status, 403);
    assert.equal((await send(f.base, { ...packet, to: { ...packet.to, session_id: "other-user", session_incarnation: "other-inc" },
      forwarding: { ...root, hops: [{ ...hop, recipient: { ...packet.to, session_id: "other-user", session_incarnation: "other-inc" } }] },
    })).status, 403);
    assert.equal(f.state.writes, 0);
  } finally { await f.cleanup(); }
});

// The received copy is carried locally by the preceding forwarding controller;
// the resumed recipient then appends a fresh final hop to the wire chain.
function transferredEnvelope(base: Awaited<ReturnType<typeof fixture>>["envelope"], counts = [1]) {
  const packet = forwardedEnvelope(base, counts.length + 1);
  const root = packet.forwarding;
  root.original_recipient.machine = base.from.machine;
  const hops = root.hops.map((hop, index) => {
    hop.forwarder.machine = base.from.machine;
    if (index === counts.length) return { ...hop, recipient_transfers: [] };
    const finalRecipient = { ...hop.recipient, machine: base.from.machine };
    const recipient = { ...finalRecipient, session_incarnation: `before-${index}` };
    let from = recipient;
    const recipient_transfers = Array.from({ length: counts[index]! }, (_, transferIndex) => {
      const to = { ...finalRecipient, session_incarnation: transferIndex === counts[index]! - 1
        ? finalRecipient.session_incarnation : `carry-${index}-${transferIndex}` };
      const transfer = { message_id: root.hops[index + 1]!.source_message_id, from, to,
        controller: { ...hop.forwarder }, source_revision: transferIndex + 1,
        transferred_at_epoch: hop.forwarded_at_epoch };
      from = to;
      return transfer;
    });
    root.hops[index + 1]!.source_revision = counts[index]! + 1;
    return { ...hop, recipient, recipient_transfers };
  });
  return { ...packet, forwarding: { ...root, hops } };
}

test("v2 preserves authorized historical recipient carries and the authenticated source clock unchanged", async () => {
  const f = await fixture();
  try {
    for (const counts of [[1], [8], [4, 4]]) {
      const packet = transferredEnvelope(f.envelope, counts);
      // A delayed ingress must not replace the source/root creation epoch.
      packet.forwarding.original_created_at_epoch = f.envelope.created_at_epoch - 3600;
      assert.equal((await send(f.base, packet)).status, 200);
      assert.deepEqual(f.state.seen, packet);
    }
    const packet = forwardedEnvelope(f.envelope);
    const empty = { ...packet, forwarding: { ...packet.forwarding,
      hops: packet.forwarding.hops.map(hop => ({ ...hop, recipient_transfers: [] })) } };
    assert.equal((await send(f.base, empty)).status, 200);
    assert.deepEqual(f.state.seen, empty);
    const service = { ...packet, forwarding: { ...packet.forwarding, original_sender: {
      machine: "user@historical-host", service_id: "monitor.service", service_generation: "generation-1",
    } } };
    assert.equal((await send(f.base, service)).status, 200);
    assert.deepEqual(f.state.seen, service);
    assert.equal(f.state.writes, 5);
  } finally { await f.cleanup(); }
});

test("v2 rejects malformed, spoofed, discontinuous and globally oversized recipient transfers", async () => {
  const f = await fixture();
  try {
    const packet = transferredEnvelope(f.envelope, [2]);
    const root = packet.forwarding;
    const hop = root.hops[0]!;
    const transfer = hop.recipient_transfers[0]!;
    const other = hop.recipient_transfers[1]!;
    const invalidTransfers: unknown[] = [null, [],
      { ...transfer, message_id: "not-a-uuid" }, { ...transfer, unknown: true },
      { ...transfer, from: { ...transfer.from, session_incarnation: "spoof" } },
      { ...transfer, to: { ...transfer.to, session_id: "different" } },
      { ...transfer, to: { ...transfer.to, machine: "remote-host" } },
      { ...transfer, to: transfer.from },
      { ...transfer, controller: { ...transfer.controller, session_incarnation: "spoof" } },
      { ...transfer, from: { ...transfer.from, unknown: true } },
      { ...transfer, to: { ...transfer.to, session_incarnation: "" } },
      { ...transfer, controller: { ...transfer.controller, machine: "x".repeat(129) } },
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null].map(source_revision => ({ ...transfer, source_revision })),
      ...[hop.forwarded_at_epoch - 1, f.envelope.created_at_epoch + 120,
        Number.MAX_SAFE_INTEGER + 1, 1.5, "1", null].map(transferred_at_epoch => ({ ...transfer, transferred_at_epoch })),
    ];
    for (const key of Object.keys(transfer)) {
      const incomplete = { ...transfer } as Record<string, unknown>;
      delete incomplete[key];
      invalidTransfers.push(incomplete);
    }
    const invalidRoots: unknown[] = invalidTransfers.map(value => ({ ...root,
      hops: [{ ...hop, recipient_transfers: [value, other] }, root.hops[1]] }));
    for (const recipient_transfers of [null, {}, "transfers"])
      invalidRoots.push({ ...root, hops: [{ ...hop, recipient_transfers }, root.hops[1]] });
    for (const value of [
      { ...other, message_id: "33333333-3333-4333-8333-333333333333" },
      { ...other, source_revision: transfer.source_revision },
      { ...other, source_revision: transfer.source_revision - 1 },
      { ...other, from: transfer.from },
      { ...other, transferred_at_epoch: transfer.transferred_at_epoch - 1 },
    ]) invalidRoots.push({ ...root, hops: [{ ...hop, recipient_transfers: [transfer, value] }, root.hops[1]] });
    for (const next of [
      { ...root.hops[1], source_message_id: "33333333-3333-4333-8333-333333333333" },
      { ...root.hops[1], source_revision: other.source_revision },
      { ...root.hops[1], forwarder: hop.recipient },
      { ...root.hops[1], forwarded_at_epoch: hop.forwarded_at_epoch - 1 },
      // The final hop cannot claim a local carry, even when structurally valid.
      { ...root.hops[1], recipient_transfers: [{ ...transfer, from: packet.to,
        to: { ...packet.to, session_incarnation: "replacement" }, controller: packet.from,
        transferred_at_epoch: packet.created_at_epoch }] },
    ]) invalidRoots.push({ ...root, hops: [hop, next] });
    // Structurally continuous remote controller guidance cannot authorize carry.
    const remoteController = { ...hop.forwarder, machine: "remote-host" };
    invalidRoots.push({ ...root, original_recipient: remoteController, hops: [{ ...hop,
      forwarder: remoteController, recipient_transfers: hop.recipient_transfers.map(t => ({ ...t, controller: remoteController })),
    }, root.hops[1]] });
    invalidRoots.push(transferredEnvelope(f.envelope, [9]).forwarding,
      transferredEnvelope(f.envelope, [5, 4]).forwarding);
    // Carry history does not bypass participant loop detection across incarnations.
    invalidRoots.push({ ...root, hops: [hop, { ...root.hops[1], recipient: { ...root.original_recipient, session_incarnation: "new" } }] });
    for (const forwarding of invalidRoots)
      assert.equal((await send(f.base, { ...packet, forwarding })).status, 400, JSON.stringify(forwarding));
    // This otherwise-continuous same-machine terminal claim must fail on the
    // ingress rule itself, before live ownership checks could reject its target.
    const localTarget = { ...packet.to, machine: packet.from.machine };
    const terminal = { ...packet, to: localTarget, forwarding: { ...root, hops: [hop, {
      ...root.hops[1], recipient: localTarget, recipient_transfers: [{ ...transfer,
        from: localTarget, to: { ...localTarget, session_incarnation: "replacement" },
        controller: packet.from, transferred_at_epoch: packet.created_at_epoch,
      }],
    }] } };
    assert.equal((await send(f.base, terminal)).status, 400);
    for (const schema_version of ["agent-session.remote-message.v1", "agent-session.remote-message.v2"]) {
      assert.equal((await send(f.base, { ...packet, schema_version, remote_created_at_epoch: packet.created_at_epoch })).status, 400);
    }
    assert.equal(f.state.writes, 0);
  } finally { await f.cleanup(); }
});

test("browser credential cannot invoke daemon relay or discovery", async () => {
  const f = await fixture();
  try {
    assert.equal((await send(f.base, f.envelope, "browser-tess")).status, 401);
    const peers = await fetch(`${f.base}/api/coordination/peers/v1?source_session_id=source&source_incarnation=src-inc`, { headers: { authorization: "Bearer browser-tess" } });
    assert.equal(peers.status, 401);
    assert.equal(f.state.writes, 0);
  } finally { await f.cleanup(); }
});

test("origin spoof, cross-principal, unknown owner and stale incarnation fail before writes", async () => {
  const f = await fixture();
  try {
    assert.equal((await send(f.base, { ...f.envelope, from: { ...f.envelope.from, machine: "cedar" } })).status, 403);
    assert.equal((await send(f.base, { ...f.envelope, to: { ...f.envelope.to, session_id: "other-user", session_incarnation: "other-inc" } })).status, 403);
    assert.equal((await send(f.base, { ...f.envelope, from: { ...f.envelope.from, session_id: "unowned", session_incarnation: "unknown-inc" } })).status, 403);
    assert.equal((await send(f.base, { ...f.envelope, to: { ...f.envelope.to, session_incarnation: "old-inc" } })).status, 409);
    f.state.destinationIncarnation = "replacement-inc";
    assert.equal((await send(f.base, f.envelope)).status, 409);
    f.state.destinationIncarnation = "dest-inc";
    f.state.sourceIncarnation = "replacement-source";
    assert.equal((await send(f.base, f.envelope)).status, 409);
    assert.equal(f.state.writes, 0);
  } finally { await f.cleanup(); }
});

test("peer discovery accepts native flat coordination availability and returns only current allowed same-owner identities", async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.base}/api/coordination/peers/v1?source_session_id=source&source_incarnation=src-inc`, { headers: { authorization: "Bearer source-relay" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { schema_version: string; peers: unknown[] };
    assert.equal(body.schema_version, "agent-session.remote-peers.v1");
    assert.deepEqual(body.peers, [
      { machine: "summit", session_id: "source", session_incarnation: "src-inc", runtime_status: "running", messaging_supported: true, messaging_unavailable_reason: null },
      { machine: "cedar", session_id: "destination", session_incarnation: "dest-inc", runtime_status: "running", messaging_supported: true, messaging_unavailable_reason: null },
    ]);
  } finally { await f.cleanup(); }
});

test("peer diagnostics separate runtime state from mailbox availability without exposing raw startup errors", async () => {
  const f = await fixture();
  try {
    const cases = [
      { status: "stopped", available: false, supported: true, mode: "advisory", runtime: "stopped", reason: "coordination-unavailable" },
      { status: "running", available: true, supported: false, mode: "advisory", runtime: "running", reason: "daemon-unsupported" },
      { status: "running", available: true, supported: true, mode: "off", runtime: "running", reason: "coordination-disabled" },
      { status: undefined, available: false, supported: true, mode: "advisory", runtime: "unknown", reason: "coordination-unavailable" },
      { status: "private-status-sentinel", available: true, supported: true, mode: "advisory", runtime: "unknown", reason: null },
      { status: "stopped", available: true, supported: true, mode: "advisory", runtime: "stopped", reason: null },
    ];
    for (const row of cases) {
      Object.assign(f.state, { destinationStatus: row.status, destinationAvailable: row.available, destinationSupported: row.supported, destinationMode: row.mode });
      const response = await fetch(`${f.base}/api/coordination/peers/v1?source_session_id=source&source_incarnation=src-inc`, { headers: { authorization: "Bearer source-relay" } });
      assert.equal(response.status, 200);
      const body = await response.json() as { peers: Array<Record<string, unknown>> };
      const peer = body.peers.find(p => p.machine === "cedar")!;
      assert.equal(peer.runtime_status, row.runtime);
      assert.equal(peer.messaging_unavailable_reason, row.reason);
      assert.equal(peer.messaging_supported, row.reason === null);
      assert.equal(JSON.stringify(body).includes("private-status-sentinel"), false);
    }
    for (const code of ["runtime-helper-unavailable", "provider-client-exited", "private-failure-sentinel"]) {
      f.state.destinationStartup = { state: "failed", failure_code: code, message: "private-provider-sentinel", extra: "private-extra-sentinel" };
      const response = await fetch(`${f.base}/api/coordination/peers/v1?source_session_id=source&source_incarnation=src-inc`, { headers: { authorization: "Bearer source-relay" } });
      const body = await response.json() as { peers: Array<Record<string, unknown>> };
      assert.equal(body.peers.find(p => p.machine === "cedar")?.startup_failure_code, code === "private-failure-sentinel" ? undefined : code);
      assert.equal(JSON.stringify(body).includes("private-"), false);
    }
    f.state.destinationStartup = { state: "ready", failure_code: "provider-client-exited" };
    const response = await fetch(`${f.base}/api/coordination/peers/v1?source_session_id=source&source_incarnation=src-inc`, { headers: { authorization: "Bearer source-relay" } });
    const body = await response.json() as { peers: Array<Record<string, unknown>> };
    assert.equal(body.peers.find(p => p.machine === "cedar")?.startup_failure_code, undefined);
    assert.equal(f.state.writes, 0);
  } finally { await f.cleanup(); }
});

test("destination response loss remains delivery-unknown and never a false delivered receipt", async () => {
  const f = await fixture();
  try {
    f.state.loseResponse = true;
    const result = await send(f.base, f.envelope);
    assert.equal(result.status, 502);
    assert.deepEqual(result.body, { ok: false, error: { code: "delivery-unknown", message: "remote delivery result is unknown" } });
    assert.equal(f.state.writes, 1);
  } finally { await f.cleanup(); }
});

test("invalid digest, oversized body, arbitrary routing and expired message do not write", async () => {
  const f = await fixture();
  try {
    assert.equal((await send(f.base, { ...f.envelope, body_sha256: "0".repeat(64) })).status, 400);
    const body = "x".repeat(16 * 1024 + 1);
    assert.equal((await send(f.base, { ...f.envelope, body, body_sha256: createHash("sha256").update(body).digest("hex") })).status, 400);
    assert.equal((await send(f.base, { ...f.envelope, url: "https://arbitrary.example.test" })).status, 400);
    assert.equal((await send(f.base, { ...f.envelope, to: { ...f.envelope.to, machine: "unknown" } })).status, 403);
    assert.equal((await send(f.base, { ...f.envelope, created_at_epoch: 1, expires_at_epoch: 2 })).status, 410);
    assert.equal(f.state.writes, 0);
  } finally { await f.cleanup(); }
});

test("relay errors and message content never enter browser debug projections", async () => {
  const f = await fixture();
  try {
    await send(f.base, f.envelope);
    await send(f.base, { ...f.envelope, body_sha256: "private-error-sentinel" });
    const response = await fetch(`${f.base}/api/debug/events`, { headers: { authorization: "Bearer browser-tess" } });
    assert.equal(response.status, 200);
    const debug = await response.text();
    for (const value of ["private-message-sentinel", "private-error-sentinel", "source-relay", "dest-ingress", "/api/coordination/"]) assert.equal(debug.includes(value), false);
  } finally { await f.cleanup(); }
});

test("configured principal machine grants fence relay and discovery", async () => {
  const f = await fixture(["summit"]);
  try {
    const result = await send(f.base, f.envelope);
    assert.equal(result.status, 403);
    assert.equal(f.state.writes, 0);
    const response = await fetch(`${f.base}/api/coordination/peers/v1?source_session_id=source&source_incarnation=src-inc`, { headers: { authorization: "Bearer source-relay" } });
    const body = await response.json() as { peers: Array<{ machine: string }> };
    assert.deepEqual(body.peers.map(p => p.machine), ["summit"]);
  } finally { await f.cleanup(); }
});

test("unsupported or unavailable coordination is projected and rejected before writes", async () => {
  const f = await fixture();
  try {
    for (const update of [{ destinationMode: "off" }, { destinationMode: "advisory", destinationAvailable: false }, { destinationAvailable: undefined }, { destinationAvailable: true, destinationSupported: false }]) {
      Object.assign(f.state, update);
      assert.equal((await send(f.base, f.envelope)).status, 422);
      const response = await fetch(`${f.base}/api/coordination/peers/v1?source_session_id=source&source_incarnation=src-inc`, { headers: { authorization: "Bearer source-relay" } });
      const body = await response.json() as { peers: Array<{ machine: string; messaging_supported: boolean }> };
      assert.equal(body.peers.find(p => p.machine === "cedar")?.messaging_supported, false);
    }
    assert.equal(f.state.writes, 0);
  } finally { await f.cleanup(); }
});

test("known destination errors retain bounded code and malformed receipts remain ambiguous", async () => {
  const f = await fixture();
  try {
    f.state.destinationError = "session-incarnation-conflict";
    const result = await send(f.base, { ...f.envelope, reply_to: null });
    assert.equal(result.status, 409);
    assert.deepEqual(result.body, { ok: false, error: { code: "session-incarnation-conflict", message: "destination rejected remote message" } });
    assert.equal(JSON.stringify(result.body).includes("private-upstream-error-sentinel"), false);
    f.state.destinationError = "";
    f.state.badReceipt = true;
    assert.equal((await send(f.base, f.envelope)).status, 502);
  } finally { await f.cleanup(); }
});

test("destination coordination authentication rejection stays a terminal bounded 401", async () => {
  const f = await fixture();
  try {
    f.state.destinationError = "coordination-unauthorized";
    f.state.destinationErrorStatus = 401;
    const result = await send(f.base, f.envelope);
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { ok: false, error: { code: "coordination-unauthorized", message: "destination rejected remote message" } });
    assert.equal(f.state.writes, 0);
  } finally { await f.cleanup(); }
});

test("destination quota refusals preserve only the five public detail fields", async () => {
  const f = await fixture(undefined, { source: "fixture-source", destination: "fixture-destination" });
  try {
    const details = { quota: "recipient-messages", count: 256, limit: 256, host: "fixture-destination", side: "destination" };
    f.state.destinationError = "quota-exceeded";
    f.state.destinationErrorStatus = 429;
    f.state.destinationErrorDetails = { ...details, message: "private-detail-sentinel", body: "private-message-sentinel", session_id: "private-id-sentinel", pending: 42 };
    const result = await send(f.base, f.envelope);
    assert.equal(result.status, 429);
    assert.deepEqual(result.body, { ok: false, error: { code: "quota-exceeded", message: "destination rejected remote message", details } });
    assert.equal(f.state.writes, 0);
    assert.deepEqual(f.state.seen, f.envelope);
  } finally { await f.cleanup(); }
});

test("destination quota details keep bounded strings and unsigned safe integers", async () => {
  const f = await fixture();
  try {
    f.state.destinationError = "quota-exceeded";
    f.state.destinationErrorDetails = { quota: "q".repeat(128), count: 0, limit: Number.MAX_SAFE_INTEGER, host: "é".repeat(64), side: "destination" };
    const result = await send(f.base, f.envelope);
    assert.deepEqual(result.body, { ok: false, error: { code: "quota-exceeded", message: "destination rejected remote message", details: f.state.destinationErrorDetails } });
    f.state.destinationErrorDetails = { quota: [], count: 2, limit: -1, host: "é".repeat(65), side: { private: true }, unknown: "private-detail-sentinel" };
    assert.deepEqual((await send(f.base, f.envelope)).body, { ok: false, error: { code: "quota-exceeded", message: "destination rejected remote message", details: { count: 2 } } });
  } finally { await f.cleanup(); }
});

test("destination quota refusals omit absent malformed and empty filtered details", async () => {
  const f = await fixture();
  try {
    f.state.destinationError = "quota-exceeded";
    for (const details of [undefined, null, [], "private-detail-sentinel", {}, { unknown: "private-detail-sentinel" },
      { quota: true, count: -1, limit: 1.5, host: "x".repeat(129), side: [] }, { count: Number.MAX_SAFE_INTEGER + 1 }]) {
      f.state.destinationErrorDetails = details;
      assert.deepEqual((await send(f.base, f.envelope)).body, { ok: false, error: { code: "quota-exceeded", message: "destination rejected remote message" } });
    }
  } finally { await f.cleanup(); }
});

test("destination nonquota errors never forward details and unknown codes stay ambiguous", async () => {
  const f = await fixture();
  try {
    f.state.destinationErrorDetails = { quota: "recipient-messages", count: 256, limit: 256, host: "fixture-destination", side: "destination" };
    for (const code of ["session-incarnation-conflict", "rate-limited"]) {
      f.state.destinationError = code;
      const result = await send(f.base, f.envelope);
      assert.equal(result.status, 409);
      assert.deepEqual(result.body, { ok: false, error: { code, message: "destination rejected remote message" } });
    }
    f.state.destinationError = "private-unknown-code";
    const result = await send(f.base, f.envelope);
    assert.equal(result.status, 502);
    assert.deepEqual(result.body, { ok: false, error: { code: "delivery-unknown", message: "remote delivery result is unknown" } });
  } finally { await f.cleanup(); }
});

test("configured user@host identities support discovery and envelopes with exact inventory binding", async () => {
  const f = await fixture(undefined, { source: "user@summit", destination: "user@cedar" });
  try {
    const peers = await fetch(`${f.base}/api/coordination/peers/v1?source_session_id=source&source_incarnation=src-inc`, { headers: { authorization: "Bearer source-relay" } });
    assert.equal(peers.status, 200);
    assert.deepEqual((await peers.json() as { peers: unknown[] }).peers, [
      { machine: "user@summit", session_id: "source", session_incarnation: "src-inc", runtime_status: "running", messaging_supported: true, messaging_unavailable_reason: null },
      { machine: "user@cedar", session_id: "destination", session_incarnation: "dest-inc", runtime_status: "running", messaging_supported: true, messaging_unavailable_reason: null },
    ]);
    assert.equal((await send(f.base, f.envelope)).status, 200);
    assert.equal((await send(f.base, { ...f.envelope, from: { ...f.envelope.from, machine: "other@summit" } })).status, 403);
    assert.equal((await send(f.base, { ...f.envelope, to: { ...f.envelope.to, machine: "other@cedar" } })).status, 403);
    assert.equal(f.state.writes, 1);
  } finally { await f.cleanup(); }
});

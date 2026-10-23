import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import { claimSessionOwner, importErrorMessage, importOwner, importProviderOwner, parseImportArgs } from "../scripts/import-owner.ts";
import { closeServers, listenOnLoopback, makeEdgeConfig } from "./support.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "agent-console-import-owner-"));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

test("scoped repair flags require one exact value per identity and support check mode", () => {
  const flags = [
    "--principal", "tess", "--machine", "summit",
    "--repair-session", "session-1", "--expected-old-incarnation", "old",
    "--expected-current-incarnation", "new",
  ];
  assert.deepEqual(parseImportArgs(["--principal", "tess"]), { principalId: "tess" });
  assert.deepEqual(parseImportArgs(flags), {
    principalId: "tess",
    repair: {
      machine: "summit", sessionId: "session-1",
      expectedOldIncarnation: "old", expectedCurrentIncarnation: "new", checkOnly: false,
    },
  });
  assert.equal(parseImportArgs([...flags, "--check"]).repair?.checkOnly, true);
  for (const invalid of [
    flags.slice(0, -2), [...flags, "--principal", "dana"],
    [...flags, "--check", "--check"], [...flags, "--unknown", "value"],
    ["--principal", "tess", "--check"],
  ]) assert.throws(() => parseImportArgs(invalid), /exact scoped repair arguments are required/);
  const invalidCli = spawnSync(process.execPath, [
    new URL("../scripts/import-owner.ts", import.meta.url).pathname,
    "--principal", "tess", "--check",
  ], { encoding: "utf8" });
  assert.equal(invalidCli.status, 2);
  assert.deepEqual(JSON.parse(invalidCli.stderr), {
    ok: false, error: "exact scoped repair arguments are required",
  });
});

test("importOwner validates and idempotently assigns exact live and history identities", async () => {
  const daemon = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") {
      res.end(JSON.stringify({ ok: true, data: { sessions: [{
        id: "existing-1",
        session_incarnation: "existing-inc-1",
        provider_resume: { provider: "codex", session_id: "provider-1" },
      }] } }));
      return;
    }
    if (req.url === "/history/sessions?limit=100") {
      res.end(JSON.stringify({ ok: true, data: { sessions: [{
        id: "history-1",
        provider: "codex",
        provider_session_id: "provider-1",
      }] } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false }));
  });
  const address = await listenOnLoopback(daemon);
  const statePath = join(tempRoot, "import.sqlite");
  const config = makeEdgeConfig({
    openAccess: false,
    multiUser: true,
    accessDbPath: statePath,
    machines: [{ name: "summit", url: address.base, token: "upstream" }],
    principals: [{ id: "tess", token: "client", machines: ["summit"], permissions: [] }],
  });
  try {
    const first = await importOwner(config, "tess");
    const second = await importOwner(config, "tess");
    assert.deepEqual(first, { principals: 1, machines: 1, liveSessions: 1, historySessions: 1 });
    assert.deepEqual(second, first);
    const store = new AccessStore(statePath);
    assert.equal(store.ownsSession("tess", "summit", "existing-1", "existing-inc-1"), true);
    assert.equal(store.ownsHistory("tess", "summit", "history-1"), true);
    store.close();
  } finally {
    closeServers(daemon);
  }
});

test("importOwner validates every history page before granting any ownership", async () => {
  const daemon = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") {
      res.end(JSON.stringify({ ok: true, data: { sessions: [{
        id: "live-before-invalid-page",
        session_incarnation: "live-incarnation",
        provider_resume: { provider: "codex", session_id: "live-provider" },
      }] } }));
      return;
    }
    if (req.url === "/history/sessions?limit=100") {
      res.end(JSON.stringify({ ok: true, data: {
        sessions: [{
          id: "history-before-invalid-page",
          provider: "codex",
          provider_session_id: "history-provider",
        }],
        next_cursor: "next-page",
      } }));
      return;
    }
    if (req.url === "/history/sessions?limit=100&cursor=next-page") {
      res.end(JSON.stringify({ ok: true, data: { sessions: [{ id: "malformed" }] } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false }));
  });
  const address = await listenOnLoopback(daemon);
  const statePath = join(tempRoot, "invalid-later-page.sqlite");
  const config = makeEdgeConfig({
    openAccess: false,
    multiUser: true,
    accessDbPath: statePath,
    machines: [{ name: "summit", url: address.base, token: "upstream" }],
    principals: [{ id: "tess", token: "client", machines: ["summit"], permissions: [] }],
  });
  try {
    await assert.rejects(importOwner(config, "tess"), /history inventory lacks an exact identity/);
    const store = new AccessStore(statePath);
    assert.equal(
      store.ownsSession("tess", "summit", "live-before-invalid-page", "live-incarnation"),
      false,
    );
    assert.equal(store.ownsProvider("tess", "summit", "codex", "live-provider"), false);
    assert.equal(store.ownsHistory("tess", "summit", "history-before-invalid-page"), false);
    store.close();
  } finally {
    closeServers(daemon);
  }
});

test("a scoped owner repair advances only an already owned session with the same provider", async () => {
  const daemon = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/history/sessions?limit=100") {
      res.end(JSON.stringify({ ok: true, data: { sessions: [] } }));
      return;
    }
    if (req.url === "/sessions") {
      res.end(JSON.stringify({ ok: true, data: { sessions: [
        {
          id: "recover-me", status: "running", session_incarnation: "new-inc",
          provider_resume: { provider: "codex", session_id: "tess-provider" },
        },
        {
          id: "dana-session", status: "running", session_incarnation: "dana-inc",
          provider_resume: { provider: "claude", session_id: "dana-provider" },
        },
        {
          id: "unmatched-provider", status: "running", session_incarnation: "unmatched-new",
          provider_resume: { provider: "codex", session_id: "not-owned-provider" },
        },
        {
          id: "different-owned-provider", status: "running", session_incarnation: "different-new",
          provider_resume: { provider: "codex", session_id: "tess-provider" },
        },
      ] } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false }));
  });
  const address = await listenOnLoopback(daemon);
  const statePath = join(tempRoot, "scoped-repair.sqlite");
  const config = makeEdgeConfig({
    openAccess: false,
    multiUser: true,
    accessDbPath: statePath,
    machines: [{ name: "summit", url: address.base, token: "upstream" }],
    principals: [
      { id: "tess", token: "tess-client", machines: ["summit"], permissions: [] },
      { id: "dana", token: "dana-client", machines: ["summit"], permissions: [] },
    ],
  });
  const store = new AccessStore(statePath);
  store.claimSession({ principalId: "tess", machine: "summit", sessionId: "recover-me", incarnation: "old-inc" });
  store.claimProvider("tess", "summit", "codex", "tess-provider");
  store.claimSession({ principalId: "dana", machine: "summit", sessionId: "dana-session", incarnation: "dana-inc" });
  store.claimProvider("dana", "summit", "claude", "dana-provider");
  store.claimSession({ principalId: "tess", machine: "summit", sessionId: "unmatched-provider", incarnation: "unmatched-old" });
  store.claimSession({
    principalId: "tess", machine: "summit", sessionId: "different-owned-provider",
    incarnation: "different-old", provider: "codex", providerSessionId: "original-provider",
  });
  store.claimProvider("tess", "summit", "codex", "original-provider");
  store.close();
  try {
    const checked = await importOwner(config, "tess", {
      machine: "summit", sessionId: "recover-me",
      expectedOldIncarnation: "old-inc", expectedCurrentIncarnation: "new-inc",
      checkOnly: true,
    });
    assert.deepEqual(checked, {
      principals: 1, machines: 1, liveSessions: 1, historySessions: 0, repairMode: "check",
    });
    const before = new AccessStore(statePath);
    assert.equal(before.ownsSession("tess", "summit", "recover-me", "old-inc"), true);
    before.close();
    await assert.rejects(importOwner(config, "tess", {
      machine: "summit", sessionId: "recover-me",
      expectedOldIncarnation: "old-inc", expectedCurrentIncarnation: "wrong-inc",
    }), /daemon session runtime changed/);
    await assert.rejects(importOwner(config, "tess", {
      machine: "summit", sessionId: "unmatched-provider",
      expectedOldIncarnation: "unmatched-old", expectedCurrentIncarnation: "unmatched-new",
    }), /session and provider ownership do not match/);
    for (const checkOnly of [true, false]) {
      await assert.rejects(importOwner(config, "tess", {
        machine: "summit", sessionId: "different-owned-provider",
        expectedOldIncarnation: "different-old", expectedCurrentIncarnation: "different-new",
        checkOnly,
      }), /session ownership changed during repair/);
    }
    const result = await importOwner(config, "tess", {
      machine: "summit", sessionId: "recover-me",
      expectedOldIncarnation: "old-inc", expectedCurrentIncarnation: "new-inc",
    });
    assert.deepEqual(result, {
      principals: 1, machines: 1, liveSessions: 1, historySessions: 0, repairMode: "apply",
    });
    const after = new AccessStore(statePath);
    assert.equal(after.ownsSession("tess", "summit", "recover-me", "new-inc"), true);
    assert.equal(after.ownsSession("dana", "summit", "dana-session", "dana-inc"), true);
    assert.equal(after.ownsSession("tess", "summit", "unmatched-provider", "unmatched-old"), true);
    assert.equal(after.ownsSession("tess", "summit", "different-owned-provider", "different-old"), true);
    after.close();
    await assert.rejects(importOwner(config, "tess", {
      machine: "summit", sessionId: "recover-me",
      expectedOldIncarnation: "old-inc", expectedCurrentIncarnation: "new-inc",
    }), /session and provider ownership do not match/);
  } finally {
    closeServers(daemon);
  }
});

test("scoped provider import flags require the exact machine, provider and thread", () => {
  assert.deepEqual(parseImportArgs([
    "--principal", "tess", "--machine", "cedar", "--import-provider", "codex",
    "--provider-session-id", "thread-1", "--check",
  ]), {
    principalId: "tess",
    providerImport: { machine: "cedar", provider: "codex", providerSessionId: "thread-1", checkOnly: true },
  });
  assert.throws(() => parseImportArgs([
    "--principal", "tess", "--import-provider", "codex",
  ]));
});

test("provider import keeps safe operator diagnostics without exposing unknown errors", () => {
  assert.equal(importErrorMessage(new Error("machine is not allowed for principal"), "provider"),
    "machine is not allowed for principal");
  assert.equal(importErrorMessage(new Error("exact provider history was not found"), "provider"),
    "exact provider history was not found");
  assert.equal(importErrorMessage(new Error("secret-bearing unexpected failure"), "provider"),
    "ownership import failed");
});

test("exact provider import checks without writes and grants only the verified thread", async () => {
  let liveRequests = 0;
  let filteredHistoryRequests = 0;
  const daemon = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") {
      liveRequests += 1;
      res.writeHead(503);
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    const url = new URL(req.url ?? "", "http://daemon.test");
    assert.equal(url.pathname, "/history/sessions");
    assert.equal(url.searchParams.get("provider"), "codex");
    filteredHistoryRequests += 1;
    if (url.searchParams.get("q") === "missing") {
      res.end(JSON.stringify({ ok: true, data: { sessions: [] } }));
      return;
    }
    assert.equal(url.searchParams.get("q"), "thread-target");
    res.end(JSON.stringify({ ok: true, data: { sessions: [
        { id: "history-target", provider: "codex", provider_session_id: "thread-target" },
        { id: "history-unrelated", provider: "codex", provider_session_id: "thread-unrelated" },
      ] } }));
  });
  const address = await listenOnLoopback(daemon);
  const statePath = join(tempRoot, "scoped-provider.sqlite");
  const config = makeEdgeConfig({
    multiUser: true, openAccess: false, accessDbPath: statePath,
    machines: [{ name: "cedar", url: address.base, token: "upstream" }],
    principals: [
      { id: "tess", token: "client", machines: ["cedar"], permissions: [] },
      { id: "dana", token: "other", machines: ["cedar"], permissions: [] },
      { id: "denied", token: "denied", machines: [], permissions: [] },
    ],
  });
  const scope = { machine: "cedar", provider: "codex", providerSessionId: "thread-target" };
  const store = new AccessStore(statePath);
  try {
    await importProviderOwner(config, "tess", { ...scope, checkOnly: true });
    assert.equal(store.ownsProvider("tess", "cedar", "codex", "thread-target"), false);
    assert.equal(store.ownsHistory("tess", "cedar", "history-target"), false);
    await assert.rejects(importProviderOwner(config, "denied", scope), /machine is not allowed/);
    await assert.rejects(importProviderOwner(config, "tess", { ...scope, providerSessionId: "missing" }), /exact provider history/);
    await importProviderOwner(config, "tess", scope);
    await importProviderOwner(config, "tess", scope);
    assert.equal(store.ownsProvider("tess", "cedar", "codex", "thread-target"), true);
    assert.equal(store.ownsHistory("tess", "cedar", "history-target"), true);
    assert.equal(store.ownsProvider("tess", "cedar", "codex", "thread-unrelated"), false);
    assert.equal(store.ownsHistory("tess", "cedar", "history-unrelated"), false);
    await assert.rejects(importProviderOwner(config, "dana", { ...scope, checkOnly: true }));
    await assert.rejects(importProviderOwner(config, "dana", scope));
    assert.equal(store.ownsProvider("tess", "cedar", "codex", "thread-target"), true);
    assert.equal(store.ownsHistory("dana", "cedar", "history-target"), false);
    assert.equal(liveRequests, 0);
    assert.ok(filteredHistoryRequests > 0);
  } finally {
    store.close();
    closeServers(daemon);
  }
});

test("scoped session claim flags require the exact machine, session and incarnation", () => {
  const flags = [
    "--principal", "tess", "--machine", "summit",
    "--claim-session", "dispatched", "--expected-incarnation", "inc-1",
  ];
  assert.deepEqual(parseImportArgs([...flags, "--check"]), {
    principalId: "tess",
    sessionClaim: { machine: "summit", sessionId: "dispatched", expectedIncarnation: "inc-1", checkOnly: true },
  });
  for (const invalid of [
    flags.slice(0, -2), [...flags, "--expected-old-incarnation", "old"],
    ["--principal", "tess", "--machine", "summit", "--claim-session", "dispatched"],
  ]) assert.throws(() => parseImportArgs(invalid), /exact scoped repair arguments are required/);
  assert.equal(importErrorMessage(new Error("session is already owned by another principal"), "claim"),
    "session is already owned by another principal");
  assert.equal(importErrorMessage(new Error("secret-bearing unexpected failure"), "claim"),
    "ownership claim failed");
});

test("a scoped session claim grants one running unowned session and never takes another owner's", async () => {
  let historyRequests = 0;
  const daemon = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") {
      res.end(JSON.stringify({ ok: true, data: { sessions: [
        {
          id: "dispatched", status: "running", session_incarnation: "inc-1",
          provider_resume: { provider: "claude", session_id: "dispatched-provider" },
        },
        { id: "neighbour", status: "running", session_incarnation: "neighbour-inc" },
        { id: "dana-session", status: "running", session_incarnation: "dana-inc" },
        { id: "stopped", status: "stopped", session_incarnation: "stopped-inc" },
      ] } }));
      return;
    }
    historyRequests += 1;
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false }));
  });
  const address = await listenOnLoopback(daemon);
  const statePath = join(tempRoot, "scoped-claim.sqlite");
  const config = makeEdgeConfig({
    openAccess: false, multiUser: true, accessDbPath: statePath,
    machines: [{ name: "summit", url: address.base, token: "upstream" }],
    principals: [
      { id: "tess", token: "tess-client", machines: ["summit"], permissions: [] },
      { id: "dana", token: "dana-client", machines: ["summit"], permissions: [] },
      { id: "denied", token: "denied", machines: [], permissions: [] },
    ],
  });
  const store = new AccessStore(statePath);
  store.claimSession({ principalId: "dana", machine: "summit", sessionId: "dana-session", incarnation: "dana-inc" });
  const scope = { machine: "summit", sessionId: "dispatched", expectedIncarnation: "inc-1" };
  try {
    assert.deepEqual(await claimSessionOwner(config, "tess", { ...scope, checkOnly: true }), {
      principals: 1, machines: 1, liveSessions: 1, historySessions: 0, repairMode: "check",
    });
    assert.equal(store.sessionGrant("summit", "dispatched"), undefined);
    await assert.rejects(claimSessionOwner(config, "denied", scope), /machine is not allowed for principal/);
    await assert.rejects(claimSessionOwner(config, "tess", { ...scope, expectedIncarnation: "inc-0" }),
      /daemon session runtime changed/);
    await assert.rejects(claimSessionOwner(config, "tess", {
      machine: "summit", sessionId: "stopped", expectedIncarnation: "stopped-inc",
    }), /daemon session runtime changed/);
    await assert.rejects(claimSessionOwner(config, "tess", { ...scope, sessionId: "missing" }),
      /exact daemon session was not found/);
    await assert.rejects(claimSessionOwner(config, "tess", {
      machine: "summit", sessionId: "dana-session", expectedIncarnation: "dana-inc",
    }), /session is already owned by another principal/);
    assert.deepEqual(await claimSessionOwner(config, "tess", scope), {
      principals: 1, machines: 1, liveSessions: 1, historySessions: 0, repairMode: "apply",
    });
    await claimSessionOwner(config, "tess", scope);
    assert.equal(store.ownsSession("tess", "summit", "dispatched", "inc-1"), true);
    assert.equal(store.ownsProvider("tess", "summit", "claude", "dispatched-provider"), true);
    assert.equal(store.sessionGrant("summit", "neighbour"), undefined);
    assert.equal(store.ownsSession("dana", "summit", "dana-session", "dana-inc"), true);
    await assert.rejects(claimSessionOwner(config, "dana", scope), /session is already owned by another principal/);
    assert.equal(historyRequests, 0);
  } finally {
    store.close();
    closeServers(daemon);
  }
});

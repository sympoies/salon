import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { OutboxError, OutboxStore } from "../src/outboxStore.ts";

const target = { principalId: "principal-a", machine: "machine-a", sessionId: "session-a", incarnation: "incarnation-a" };
const binding = { delegationId: "delegation-a", callerMachine: "caller-machine", callerSessionId: "caller-session", callerIncarnation: "caller-incarnation", retryUntilEpoch: 2_000_000_000 };

test("a stop fence refuses pending work from another principal without exposing it", t => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-stop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new OutboxStore(join(dir, "state.sqlite"));
  const second = new OutboxStore(join(dir, "state.sqlite"));
  t.after(() => { first.close(); second.close(); });
  second.admit({ ...target, principalId: "private-principal" }, "intent-a", "private-message", "generation-a");
  assert.throws(() => first.beginStop(target, "operation-a", binding), (error: unknown) => {
    assert.ok(error instanceof OutboxError);
    assert.equal(error.code, "outbox-pending-replies");
    assert.doesNotMatch(JSON.stringify(error), /private-principal|private-message/);
    return true;
  });
});

test("stop fence persists, excludes lifecycle operations, and becomes an incarnation block", t => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-stop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  let first = new OutboxStore(path);
  const second = new OutboxStore(path);
  assert.deepEqual(first.beginStop(target, "operation-a", binding), { state: "pending" });
  assert.deepEqual(first.resolveStop(target, "operation-a", "unknown"), { state: "unknown" });
  first.close();
  first = new OutboxStore(path);
  t.after(() => { first.close(); second.close(); });
  assert.deepEqual(first.stopReceipt(target, "operation-a"), { state: "unknown" });
  const other = { ...target, principalId: "principal-b" };
  assert.throws(() => second.admit(other, "intent-a", "message", "generation"), /outbox-lifecycle-pending/);
  for (const operation of ["archive", "delete", "maintenance-delete"] as const)
    assert.throws(() => second.beginLifecycle(target.machine, target.sessionId, target.incarnation, operation), /outbox-lifecycle-pending/);
  assert.throws(() => second.beginStop(other, "operation-a", binding), /operation-id-conflict/);
  assert.throws(() => second.beginStop(other, "operation-b", binding), /session-stop-busy/);
  assert.throws(() => second.stopReceipt(other, "operation-a"), /stop-operation-not-found/);
  assert.equal(second.releaseLifecycle(second.lifecycle(target.machine, target.sessionId)!), false);
  assert.deepEqual(first.resolveStop(target, "operation-a", "stopped", { stopResult: "exited" }), { state: "stopped" });
  assert.throws(() => second.admit(other, "intent-b", "message", "generation"), /outbox-lifecycle-pending/);
  assert.equal(second.admit({ ...other, incarnation: "incarnation-b" }, "intent-c", "message", "generation").created, true);
});

test("a proven refusal releases only its own fence and retry remains blocked", t => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-stop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new OutboxStore(join(dir, "state.sqlite"));
  const second = new OutboxStore(join(dir, "state.sqlite"));
  t.after(() => { first.close(); second.close(); });
  first.admit(target, "intent-a", "message", "generation");
  const candidate = first.candidate(target)!;
  first.refuse(candidate, "refused");
  const refused = first.get(target, "intent-a")!;
  second.beginStop(target, "operation-a", binding);
  assert.throws(() => first.actOnRefused(target, "intent-a", { operation: "retry_refused", base_revision: refused.revision }, "generation"), /outbox-lifecycle-pending/);
  assert.throws(() => second.resolveStop({ ...target, principalId: "principal-b" }, "operation-a", "refused", { code: "session-mailbox-not-empty" }), /stop-operation-not-found/);
  assert.deepEqual(second.resolveStop(target, "operation-a", "refused", { code: "session-mailbox-not-empty" }), { state: "refused" });
  assert.equal(first.actOnRefused(target, "intent-a", { operation: "retry_refused", base_revision: refused.revision }, "generation").state, "queued");
});

test("pending rows for other target triples do not prevent stop", t => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-stop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new OutboxStore(join(dir, "state.sqlite"));
  const second = new OutboxStore(join(dir, "state.sqlite"));
  t.after(() => { first.close(); second.close(); });
  for (const [index, other] of [{ ...target, machine: "machine-b" }, { ...target, sessionId: "session-b" },
    { ...target, incarnation: "incarnation-b" }].entries()) second.admit(other, `intent-${index}`, "message", "generation");
  assert.deepEqual(first.beginStop(target, "operation-a", binding), { state: "pending" });
});


test("legacy queued rows do not stop the fence, and extension admission is blocked", t => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-stop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  const first = new OutboxStore(path);
  const second = new OutboxStore(path);
  t.after(() => { first.close(); second.close(); });
  first.admit(target, "legacy", "message", "generation");
  const db = new DatabaseSync(path);
  db.prepare("UPDATE outbox_items SET native_handoff=0 WHERE id=?").run("legacy");
  db.close();
  assert.deepEqual(second.beginStop(target, "operation-a", binding), { state: "pending" });
  const other = { ...target, principalId: "principal-b" };
  assert.throws(() => first.admitExtensionInput(
    { principalId: other.principalId, extensionId: "extension-a", channel: "channel-a", inputId: "input-a" },
    { target: other, source: { label: "source", prefix: "" }, grant: { routeKey: "route", permission: "send" } },
    "message", "generation", null), /outbox-lifecycle-pending/);
});

test("stop and competing writers serialize across connections", async t => {
  const { Worker } = await import("node:worker_threads");
  for (const action of ["admit", "retry", "claim", "archive", "delete", "maintenance-delete"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "outbox-stop-race-"));
    const path = join(dir, "state.sqlite");
    const setup = new OutboxStore(path);
    if (action === "retry" || action === "claim") {
      setup.admit(target, "intent-a", "message", "generation");
      if (action === "retry") setup.refuse(setup.candidate(target)!, "refused");
    }
    setup.close();
    const barrier = new SharedArrayBuffer(4);
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { OutboxStore } = await import(workerData.module);
        const store = new OutboxStore(workerData.path);
        let candidate = workerData.action === 'claim' ? store.candidate(workerData.target) : undefined;
        const barrier = new Int32Array(workerData.barrier);
        Atomics.add(barrier, 0, 1); Atomics.notify(barrier, 0);
        while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, 1);
        try {
          let result;
          if (workerData.stop) result = store.beginStop(workerData.target, 'operation-a', workerData.binding);
          else if (workerData.action === 'admit') result = store.admit(workerData.target, 'intent-a', 'message', 'generation');
          else if (workerData.action === 'retry') result = store.actOnRefused(workerData.target, 'intent-a',
            { operation: 'retry_refused', base_revision: store.get(workerData.target, 'intent-a').revision }, 'generation');
          else if (workerData.action === 'claim') result = store.claim(candidate);
          else result = store.beginLifecycle(workerData.target.machine, workerData.target.sessionId, workerData.target.incarnation, workerData.action);
          parentPort.postMessage({ ok: Boolean(result) });
        } catch (error) { parentPort.postMessage({ ok: false, code: error.code }); }
        finally { store.close(); }
      })().catch(error => { throw error; });`;
    const run = (stop: boolean) => new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
      const worker = new Worker(source, { eval: true, workerData: { path, target, action, stop, barrier, binding,
        module: new URL("../src/outboxStore.ts", import.meta.url).href } });
      let result: { ok: boolean; code?: string };
      worker.once("message", value => { result = value; });
      worker.once("error", reject);
      worker.once("exit", code => code === 0 ? resolve(result!) : reject(new Error(`worker exited ${code}`)));
    });
    try {
      const [stop, competing] = await Promise.all([run(true), run(false)]);
      assert.notEqual(stop.ok, competing.ok, `${action}: exactly one writer may acquire or dispatch`);
      if (!stop.ok) assert.ok(["outbox-pending-replies", "outbox-lifecycle-pending"].includes(stop.code!), `${action}: ${stop.code}`);
      if (!competing.ok && action !== "claim") assert.equal(competing.code, "outbox-lifecycle-pending", action);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});


test("an unreadable store returns a fixed durability refusal", t => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-stop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  writeFileSync(path, "private-canary is not a database");
  assert.throws(() => new OutboxStore(path), (error: unknown) => {
    assert.ok(error instanceof OutboxError);
    assert.equal(error.code, "outbox-durability-unavailable");
    assert.equal(error.status, 503);
    assert.doesNotMatch(JSON.stringify(error), /private-canary/);
    return true;
  });
});


test("pending work and admission blocks match the complete target exactly", t => {
  const variants = [
    { ...target, incarnation: "incarnation-" }, { ...target, incarnation: "incarnation-a-extra" },
    { ...target, incarnation: "INCARNATION-A" }, { ...target, incarnation: "incarnation-a " },
    { ...target, machine: "machine-a-extra" }, { ...target, machine: "MACHINE-A" },
    { ...target, sessionId: "session-a-extra" }, { ...target, sessionId: "SESSION-A" },
  ];
  for (const [index, other] of variants.entries()) {
    const dir = mkdtempSync(join(tmpdir(), "outbox-stop-exact-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const first = new OutboxStore(join(dir, "state.sqlite"));
    const second = new OutboxStore(join(dir, "state.sqlite"));
    t.after(() => { first.close(); second.close(); });
    first.admit({ ...other, principalId: "principal-b" }, `pending-${index}`, "message", "generation");
    assert.deepEqual(second.beginStop(target, `operation-${index}`, binding), { state: "pending" });
    second.resolveStop(target, `operation-${index}`, "stopped", { stopResult: "exited" });
    assert.equal(first.admit(other, `new-${index}`, "message", "generation").created, true);
  }
});

test("unknown work of another principal prevents stop", t => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-stop-unknown-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new OutboxStore(join(dir, "state.sqlite"));
  const second = new OutboxStore(join(dir, "state.sqlite"));
  t.after(() => { first.close(); second.close(); });
  const other = { ...target, principalId: "principal-b" };
  first.admit(other, "intent-a", "message", "generation");
  const attempt = first.claim(first.candidate(other)!)!;
  first.settle(attempt, {});
  assert.equal(first.get(other, "intent-a")!.state, "unknown");
  assert.throws(() => second.beginStop(target, "operation-a", binding), /outbox-pending-replies/);
});

test("an active fence blocks claiming a different incarnation across connections", t => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-stop-claim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new OutboxStore(join(dir, "state.sqlite"));
  const second = new OutboxStore(join(dir, "state.sqlite"));
  t.after(() => { first.close(); second.close(); });
  const newer = { ...target, principalId: "principal-b", incarnation: "incarnation-b" };
  first.admit(newer, "intent-a", "message", "generation");
  const candidate = first.candidate(newer)!;
  assert.ok(candidate);
  second.beginStop(target, "operation-a", binding);
  assert.equal(first.claim(candidate), undefined);
  second.resolveStop(target, "operation-a", "refused", { code: "session-mailbox-not-empty" });
  assert.equal(first.claim(candidate)?.item.state, "sending");
});

test("receipt access and operation replay bind exact issuer and target", t => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-stop-receipt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new OutboxStore(join(dir, "state.sqlite"));
  t.after(() => store.close());
  assert.deepEqual(store.beginStop(target, "operation-a", binding), { state: "pending" });
  for (const other of [
    { ...target, principalId: "PRINCIPAL-A" }, { ...target, principalId: "principal-a-extra" },
    { ...target, machine: "MACHINE-A" }, { ...target, sessionId: "SESSION-A" },
    { ...target, incarnation: "INCARNATION-A" }, { ...target, incarnation: "incarnation-a-extra" },
    { ...target, incarnation: "incarnation-a " },
  ]) {
    assert.throws(() => store.stopReceipt(other, "operation-a"), /stop-operation-not-found/);
    assert.throws(() => store.beginStop(other, "operation-a", binding), /operation-id-conflict/);
  }
  assert.deepEqual(store.resolveStop(target, "operation-a", "stopped", { stopResult: "exited" }), { state: "stopped" });
  assert.deepEqual(store.beginStop(target, "operation-a", binding), { state: "stopped" });
  assert.throws(() => store.resolveStop(target, "operation-a", "refused", { code: "session-mailbox-not-empty" }), /operation-id-conflict/);
});

test("a retained stop block rejects a new operation while the original receipt replays", t => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-stop-replay-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new OutboxStore(join(dir, "state.sqlite"));
  const second = new OutboxStore(join(dir, "state.sqlite"));
  t.after(() => { first.close(); second.close(); });
  first.beginStop(target, "operation-a", binding);
  first.resolveStop(target, "operation-a", "stopped", { stopResult: "exited" });
  assert.throws(() => second.beginStop(target, "operation-b", binding), /outbox-lifecycle-pending/);
  assert.throws(() => second.beginStop({ ...target, principalId: "principal-b" }, "operation-c", binding),
    /outbox-lifecycle-pending/);
  assert.deepEqual(second.beginStop(target, "operation-a", binding), { state: "stopped" });
  const variants = [
    { ...target, incarnation: "incarnation-b" }, { ...target, incarnation: "incarnation-" },
    { ...target, incarnation: "incarnation-a-extra" }, { ...target, incarnation: "INCARNATION-A" },
    { ...target, incarnation: "incarnation-a " }, { ...target, machine: "machine-b" },
    { ...target, sessionId: "session-b" },
  ];
  for (const [index, other] of variants.entries()) {
    const id = `near-miss-${index}`;
    assert.deepEqual(second.beginStop(other, id, binding), { state: "pending" });
    assert.deepEqual(second.resolveStop(other, id, "refused", { code: "session-mailbox-not-empty" }), { state: "refused" });
  }
});

test("a stop operation binds its full tuple and deadline and records its outcome", t => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-stop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new OutboxStore(join(dir, "state.sqlite"));
  t.after(() => store.close());
  store.beginStop(target, "operation-a", binding);
  for (const changed of [{ delegationId: "delegation-b" }, { callerMachine: "other" }, { callerSessionId: "other" }, { callerIncarnation: "other" }, { retryUntilEpoch: binding.retryUntilEpoch + 1 }])
    assert.throws(() => store.beginStop(target, "operation-a", { ...binding, ...changed }), /operation-id-conflict/, JSON.stringify(changed));
  assert.deepEqual(store.stopOperation(target, "operation-a"), { state: "pending", stopResult: null, code: null, ...binding });
  assert.deepEqual(store.resolveStop(target, "operation-a", "stopped", { stopResult: "already_stopped" }), { state: "stopped" });
  assert.deepEqual(store.stopOperation(target, "operation-a"), { state: "stopped", stopResult: "already_stopped", code: null, ...binding });
  assert.throws(() => store.resolveStop(target, "operation-a", "stopped", { stopResult: "exited" }), /operation-id-conflict/);
});

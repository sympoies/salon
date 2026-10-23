import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ServerResponse } from "node:http";
import { forwardArchiveDaemon, forwardCreateDaemon, forwardSessionAccountDaemon, forwardSessionDeleteDaemon, forwardHistoryResumeDaemon } from "../src/daemonEnvelope.ts";

test("archive and delete safely explain child-guard refusal without exposing daemon details", () => {
  for (const forward of [forwardArchiveDaemon, forwardSessionDeleteDaemon]) {
    let status = 0;
    let payload = "";
    const response = {
      writeHead(code: number) { status = code; },
      end(value: string) { payload = value; },
    } as unknown as ServerResponse;
    forward(response, {
      status: 409,
      body: { ok: false, error: {
        code: "session-has-live-children",
        message: "private output: pass --orphan-children",
        details: { children: [{ session_id: "private-child" }], scope: "local" },
      } },
    }, "s1");
    assert.equal(status, 409);
    assert.deepEqual(JSON.parse(payload), {
      ok: false,
      error: {
        code: "session-has-live-children",
        message: "this session still has child sessions; close them before archiving or deleting it",
      },
    });
  }
});

test("termination verification failures retain safe reason-specific guidance", () => {
  for (const [reason, expected] of [
    ["verification-failed", "the recorded session runtime could not be verified; inspect Maintenance before retrying"],
    ["session-still-running", "the recorded session runtime is still live; retry, or resolve the runtime from Maintenance"],
    ["process-still-running", "the recorded session runtime is still live; retry, or resolve the runtime from Maintenance"],
    ["runtime-identity-mismatch", "the recorded session runtime identity changed; refresh Maintenance before retrying"],
    ["unknown-future-reason", "the recorded session runtime could not be stopped safely; inspect Maintenance before retrying"],
  ]) {
    let payload = "";
    const response = {
      writeHead() {},
      end(value: string) { payload = value; },
    } as unknown as ServerResponse;
    const daemon = {
      status: 500,
      body: { ok: false, error: { code: "session-termination-failed", message: "private host output", details: { reason, tmux_session: "private-target" } } },
    };
    forwardSessionDeleteDaemon(response, daemon, "s1");
    const body = JSON.parse(payload);
    assert.equal(body.error.message, expected);
    assert.equal(body.error.code, "session-termination-failed");
    assert.doesNotMatch(payload, /private|unknown-future/);
    forwardHistoryResumeDaemon(response, daemon);
    assert.equal(JSON.parse(payload).error.message, expected);
  }
});

test("history resume forwards the live session that already owns the conversation", () => {
  let status = 0;
  let payload = "";
  const response = {
    writeHead(code: number) { status = code; },
    end(value: string) { payload = value; },
  } as unknown as ServerResponse;
  forwardHistoryResumeDaemon(response, {
    status: 409,
    body: {
      ok: false,
      error: { code: "history-session-live", message: "private daemon text", details: { id: "20261001-031921-claude" } },
    },
  });
  assert.equal(status, 409);
  assert.deepEqual(JSON.parse(payload), {
    ok: false,
    error: {
      code: "history-session-live",
      message: "this conversation is already open; switching to its live session",
      live_session_id: "20261001-031921-claude",
    },
  });

  for (const id of ["../escape", "", 42, "a".repeat(200)]) {
    forwardHistoryResumeDaemon(response, {
      status: 409,
      body: { ok: false, error: { code: "history-session-live", details: { id } } },
    });
    assert.equal(JSON.parse(payload).error.live_session_id, undefined, `unsafe id ${String(id)}`);
  }
});

// #712: an unlisted daemon code still names the cause in History; the daemon's
// own message stays private.
test("#712 history resume keeps an unlisted daemon error code without its private message", () => {
  let payload = "";
  let status = 0;
  const response = {
    writeHead(code: number) { status = code; },
    end(value: string) { payload = value; },
  } as unknown as ServerResponse;
  forwardHistoryResumeDaemon(response, {
    status: 500,
    body: { ok: false, error: { code: "coordination-runtime-unverified", message: "private host output", details: { reason: "private-reason" } } },
  });
  const body = JSON.parse(payload);
  assert.equal(status, 500);
  assert.equal(body.error.code, "coordination-runtime-unverified");
  assert.equal(body.error.message, "session history resume failed");
  assert.doesNotMatch(payload, /private/);
  forwardHistoryResumeDaemon(response, { status: 500, body: { ok: false, error: { code: "Not A Slug!", message: "private" } } });
  assert.equal(JSON.parse(payload).error.code, undefined, "only a well-formed code is forwarded");
});

// #712 (coordinator): every lifecycle route shares the rule, so create,
// archive, delete and account switch also name an unlisted cause.
test("#712 create, archive, delete and account switch keep an unlisted daemon error code", () => {
  const daemon = { status: 500, body: { ok: false, error: { code: "coordination-runtime-unverified", message: "private host output", details: { reason: "private-reason" } } } };
  for (const [route, forward, fallback] of [
    ["create", (res: ServerResponse) => forwardCreateDaemon(res, { agent: "claude" }, daemon), "session creation failed"],
    ["archive", (res: ServerResponse) => forwardArchiveDaemon(res, daemon, "s1"), "session archive failed"],
    ["delete", (res: ServerResponse) => forwardSessionDeleteDaemon(res, daemon, "s1"), "session delete failed"],
    ["account switch", (res: ServerResponse) => forwardSessionAccountDaemon(res, daemon, "work", "inc-1"), "account switch failed"],
  ] as const) {
    let payload = "";
    const response = { writeHead() {}, end(value: string) { payload = value; } } as unknown as ServerResponse;
    forward(response);
    const body = JSON.parse(payload);
    assert.equal(body.error.code, "coordination-runtime-unverified", route);
    assert.equal(body.error.message, fallback, route);
    assert.doesNotMatch(payload, /private/, route);
  }
});

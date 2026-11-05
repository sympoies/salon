import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ActivitySseDecoder, type ActivityStreamEvent, type ActivityTurnState } from "@agent-console/shared/activity";
import { AccessStore } from "../src/accessStore.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

const waiting: ActivityTurnState = {
  schema_version: "agent-session.turn-state.v1",
  phase: "waiting",
  phase_changed_at: "2026-10-01T00:00:04Z",
  revision: 2,
  source: { kind: "provider_hook", provider: "claude", confidence: "authoritative" },
  last_turn: { completed_at: "2026-10-01T00:00:04Z", outcome: "completed" },
};
const starting: ActivityTurnState = {
  schema_version: waiting.schema_version, source: waiting.source,
  phase: "starting", phase_changed_at: "2026-10-01T00:00:00Z", revision: 1,
};
const freshWaiting: ActivityTurnState = {
  schema_version: waiting.schema_version, source: waiting.source,
  phase: "waiting", phase_changed_at: waiting.phase_changed_at, revision: 2,
};

for (const listState of [undefined, starting, freshWaiting]) {
  test(`owned activity keeps stream state when the session list state is ${listState === freshWaiting ? "fresh idle" : listState ? "older" : "absent"}`,
    { timeout: 15000 }, async t => {
      const root = mkdtempSync(join(tmpdir(), "activity-ownership-"));
      const statePath = join(root, "access.sqlite");
      const streamState = listState === freshWaiting ? freshWaiting : waiting;
      const sessions = [
        { id: "first-session", session_incarnation: "first-inc", agent: "claude", status: "running" },
        { id: "second-session", session_incarnation: "second-inc", agent: "claude", status: "running" },
        { id: "unowned-session", session_incarnation: "unowned-inc", agent: "claude", status: "running" },
        { id: "reused-session", session_incarnation: "replacement-inc", agent: "claude", status: "running" },
      ].map(session => ({ ...session, ...(listState ? { turn_state: listState } : {}) }));
      const access = new AccessStore(statePath);
      for (const [principalId, sessionId, incarnation] of [
        ["first", "first-session", "first-inc"],
        ["second", "second-session", "second-inc"],
        ["first", "reused-session", "previous-inc"],
      ] as const) access.claimSession({ principalId, machine: "hub", sessionId, incarnation });
      access.close();
      const daemon = createServer((req, res) => {
        if (req.url === "/sessions") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, data: { sessions } }));
          return;
        }
        assert.equal(req.url, "/activity/events");
        res.writeHead(200, { "content-type": "text/event-stream" });
        let sequence = 0;
        // Subscribers finish their independent ownership reads at different
        // times. Keep publishing so each can observe both projection types.
        const timer = setInterval(() => {
          sequence += 1;
          const type = sequence % 2 ? "snapshot" : "reset";
          res.write(`id: fixture-boot:${sequence}\nevent: ${type}\ndata: ${JSON.stringify({
            schema_version: "agent-session.activity-stream.event.v1", type,
            stream_id: "fixture-boot", sequence, machine: "daemon-local",
            observed_at: "2026-10-01T00:00:04Z",
            sessions: sessions.map(session => ({ id: session.id, turn_state: streamState })),
          })}\n\n`);
        }, 20);
        res.on("close", () => clearInterval(timer));
      });
      const { base: daemonBase } = await listenOnLoopback(daemon);
      const edge = createEdgeServer(makeEdgeConfig({
        openAccess: false, multiUser: true, accessDbPath: statePath,
        principals: ["first", "second"].map(id => ({ id, token: `${id}-token`, machines: ["hub"], permissions: [] })),
        machines: [{ name: "hub", url: daemonBase, token: "daemon-token" }],
      }));
      const { base } = await listenOnLoopback(edge);
      const controller = new AbortController();
      const readActivity = async (principal: string): Promise<ActivityStreamEvent[]> => {
        const response = await fetch(`${base}/api/activity/events?machines=hub`, {
          headers: { authorization: `Bearer ${principal}-token` }, signal: AbortSignal.any([controller.signal, t.signal]),
        });
        assert.equal(response.status, 200);
        assert.ok(response.body);
        const reader = response.body.getReader();
        const decoder = new ActivitySseDecoder();
        const text = new TextDecoder();
        const events: ActivityStreamEvent[] = [];
        try {
          while (!events.some(event => event.type === "snapshot" && event.stream_id === "fixture-boot")
            || !events.some(event => event.type === "reset")) {
            const chunk = await reader.read();
            assert.equal(chunk.done, false);
            events.push(...decoder.push(text.decode(chunk.value, { stream: true })));
          }
          return events;
        } finally {
          await reader.cancel().catch(() => {});
        }
      };
      try {
        if (listState === freshWaiting) {
          for (const principal of ["first", "second"]) {
            const response = await fetch(`${base}/api/sessions`, {
              headers: { authorization: `Bearer ${principal}-token` },
            });
            assert.equal(response.status, 200);
            const body = await response.json() as { data: { sessions: Array<{ id: string; turn_state: unknown }> } };
            assert.deepEqual(body.data.sessions.map(session => ({ id: session.id, turn_state: session.turn_state })),
              [{ id: `${principal}-session`, turn_state: freshWaiting }],
              "the list must retain pre-first-turn waiting and hide other identities");
          }
        }
        const results = await Promise.all([readActivity("first"), readActivity("second")]);
        for (const [index, principal] of ["first", "second"].entries()) {
          const events = results[index]!;
          const initial = events.find(event => event.stream_id.startsWith("edge-initial-"));
          assert.ok(initial);
          assert.deepEqual(initial.sessions, [{ id: `${principal}-session`, turn_state: listState ?? null }]);
          const upstream = events.filter(event => event.stream_id === "fixture-boot");
          assert.ok(upstream.some(event => event.type === "snapshot"));
          assert.ok(upstream.some(event => event.type === "reset"));
          for (const event of upstream) {
            assert.equal(event.machine, "hub");
            assert.deepEqual(event.sessions?.map(session => session.id), [`${principal}-session`],
              "other principals, unowned sessions and replaced incarnations must stay hidden");
            assert.deepEqual(event.sessions?.[0]?.turn_state, streamState,
              "the ownership lookup must not replace the authoritative event state");
          }
        }
      } finally {
        controller.abort();
        edge.closeAllConnections();
        daemon.closeAllConnections();
        await Promise.all([edge, daemon].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
        rmSync(root, { recursive: true, force: true });
      }
    });
}

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ATTENTION_ALERTS_STORAGE_KEY,
  attentionAlertFor,
  createAttentionAlertTracker,
  deliverAttentionAlerts,
  loadAttentionAlerts,
  saveAttentionAlerts,
  type AttentionAlert,
  type AttentionAlertEnvironment,
} from "../src/attentionAlerts.ts";
import type { StorageLike } from "../src/storage.ts";
import type { Session } from "../src/types.ts";
import { makeSession } from "./support/fixtures.ts";
import { uiSource } from "./support/source.ts";

function memoryStorage(): StorageLike & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function working(id = "hs-1"): Session {
  return makeSession({
    id,
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "working",
      phase_changed_at: "2026-07-10T12:08:00Z",
      revision: 3,
      source: { kind: "provider_hook", provider: "codex", confidence: "observed" },
      current_turn: { provider_turn_id: "turn-1", started_at: "2026-07-10T12:07:46Z" },
    },
  });
}

function needsInput(
  id = "hs-1",
  requestedAt = "2026-07-10T12:09:18Z",
  certainty: "exact" | "conservative" = "exact",
): Session {
  return makeSession({
    id,
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "needs_input",
      phase_changed_at: requestedAt,
      revision: 4,
      source: { kind: "provider_hook", provider: "codex", confidence: "observed" },
      current_turn: {
        provider_turn_id: "turn-1",
        started_at: "2026-07-10T12:07:46Z",
        attention: { kind: "approval", requested_at: requestedAt, pending_count: 1, certainty },
      },
    },
  });
}

function done(id = "hs-1", completedAt = "2026-07-10T12:10:00Z", turn = "turn-1"): Session {
  return makeSession({
    id,
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "waiting",
      phase_changed_at: completedAt,
      revision: 5,
      source: { kind: "provider_hook", provider: "codex", confidence: "observed" },
      last_turn: { provider_turn_id: turn, outcome: "completed", completed_at: completedAt },
    },
  });
}

test("attention alerts are off until the device preference is enabled", () => {
  const storage = memoryStorage();
  assert.equal(loadAttentionAlerts(storage), false);
  assert.equal(saveAttentionAlerts(true, storage), true);
  assert.equal(storage.values.get(ATTENTION_ALERTS_STORAGE_KEY), "1");
  assert.equal(loadAttentionAlerts(storage), true);
  storage.values.set(ATTENTION_ALERTS_STORAGE_KEY, "yes");
  assert.equal(loadAttentionAlerts(storage), false);
});

test("only exact input requests and completed turns of running sessions are alertable", () => {
  assert.equal(attentionAlertFor(working()), null);
  assert.equal(attentionAlertFor(needsInput("hs-1", "2026-07-10T12:09:18Z", "conservative")), null);
  assert.equal(attentionAlertFor({ ...needsInput(), status: "stopped" }), null);
  assert.equal(attentionAlertFor({ ...done(), session_incarnation: undefined }), null);

  const input = attentionAlertFor(needsInput());
  assert.equal(input?.kind, "needs-input");
  assert.equal(input?.sessionKey, "summit/hs-1");
  assert.equal(input?.title, "Test session");

  const completed = attentionAlertFor(done());
  assert.equal(completed?.kind, "completed");
  assert.notEqual(completed?.key, input?.key);
});

test("the tracker alerts once per new request or completion after the first snapshot", () => {
  const tracker = createAttentionAlertTracker();
  // An empty initial list must not prime the tracker, or the first real load
  // would alert for every session that was already Done.
  assert.deepEqual(tracker.observe([]), []);
  assert.deepEqual(tracker.observe([done("hs-1"), working("hs-2")]), []);

  const request = tracker.observe([done("hs-1"), needsInput("hs-2")]);
  assert.deepEqual(request.map((alert) => [alert.kind, alert.sessionKey]), [["needs-input", "summit/hs-2"]]);
  assert.deepEqual(tracker.observe([done("hs-1"), needsInput("hs-2")]), []);

  const second = tracker.observe([done("hs-1"), needsInput("hs-2", "2026-07-10T12:11:00Z")]);
  assert.equal(second.length, 1);

  const completed = tracker.observe([done("hs-1"), done("hs-2", "2026-07-10T12:12:00Z", "turn-2")]);
  assert.deepEqual(completed.map((alert) => [alert.kind, alert.sessionKey]), [["completed", "summit/hs-2"]]);

  const later = tracker.observe([done("hs-1", "2026-07-10T12:13:00Z", "turn-3"), done("hs-2", "2026-07-10T12:12:00Z", "turn-2")]);
  assert.deepEqual(later.map((alert) => alert.sessionKey), ["summit/hs-1"]);
});

test("a session first seen in an alertable state does not alert", () => {
  const tracker = createAttentionAlertTracker();
  tracker.observe([working("hs-1")]);
  // A newly enabled machine or newly listed session arrives already Done.
  assert.deepEqual(tracker.observe([working("hs-1"), done("hs-9")]), []);
  assert.deepEqual(tracker.observe([working("hs-1"), done("hs-9")]), []);
});

function environment(overrides: Partial<AttentionAlertEnvironment> = {}) {
  const calls = { sounds: 0, notifications: [] as { title: string; body: string; tag: string }[] };
  const env: AttentionAlertEnvironment = {
    hidden: false,
    focusedSessionKey: null,
    notificationPermission: "granted",
    playSound: () => {
      calls.sounds += 1;
    },
    notify: (title, body, tag) => {
      calls.notifications.push({ title, body, tag });
    },
    ...overrides,
  };
  return { env, calls };
}

const inputAlert: AttentionAlert = { key: "k1", kind: "needs-input", sessionKey: "summit/hs-1", title: "Fix login" };
const doneAlert: AttentionAlert = { key: "k2", kind: "completed", sessionKey: "summit/hs-2", title: "Write docs" };

test("delivery plays one sound per batch and notifies only while hidden", () => {
  const visible = environment();
  assert.equal(deliverAttentionAlerts([inputAlert, doneAlert], visible.env), 2);
  assert.equal(visible.calls.sounds, 1);
  assert.deepEqual(visible.calls.notifications, []);

  const hidden = environment({ hidden: true });
  deliverAttentionAlerts([inputAlert, doneAlert], hidden.env);
  assert.equal(hidden.calls.sounds, 1);
  assert.deepEqual(hidden.calls.notifications, [
    { title: "Needs input", body: "Fix login", tag: "k1" },
    { title: "Done", body: "Write docs", tag: "k2" },
  ]);

  const denied = environment({ hidden: true, notificationPermission: "denied" });
  deliverAttentionAlerts([inputAlert], denied.env);
  assert.equal(denied.calls.sounds, 1);
  assert.deepEqual(denied.calls.notifications, []);
});

test("delivery skips the session the user is already looking at", () => {
  const focused = environment({ focusedSessionKey: "summit/hs-1" });
  assert.equal(deliverAttentionAlerts([inputAlert], focused.env), 0);
  assert.equal(focused.calls.sounds, 0);

  // Once the console is hidden, the focused session is no longer being watched.
  const hidden = environment({ hidden: true, focusedSessionKey: "summit/hs-1" });
  assert.equal(deliverAttentionAlerts([inputAlert], hidden.env), 1);
  assert.equal(hidden.calls.notifications.length, 1);
});

test("the dashboard observes every session snapshot and delivers only when enabled", () => {
  const dashboard = uiSource("Dashboard.tsx");
  const app = uiSource("App.tsx");
  assert.match(dashboard, /const alerts = tracker\.observe\(sessions\);\s*if \(!attentionAlertsRef\.current \|\| alerts\.length === 0\) return;/);
  assert.match(dashboard, /focusedSessionKey: focusedKeyForAlertsRef\.current/);
  assert.match(dashboard, /\}, \[sessions\]\);/);
  assert.match(app, /attentionAlerts=\{attentionAlerts\}/);
  assert.match(app, /if \(enabled\) void requestBrowserNotificationPermission\(\);/);
});

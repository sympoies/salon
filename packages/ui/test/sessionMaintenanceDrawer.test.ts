import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import type { ComponentType } from "react";
import type { SessionMaintenancePreview } from "@agent-console/shared/maintenance";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { makeSession } from "./support/fixtures.ts";

const ssr = createUiSsrHarness();

const session = makeSession({
  id: "b2-codex",
  machine: "summit",
  agent: "codex",
  cwd: "/home/runner/repo",
});

/** The B2 dead end: no tmux target, unprovable process ownership. */
const recordOnlyPreview: SessionMaintenancePreview = {
  schema_version: "agent-session.session-maintenance.v2",
  session_id: session.id,
  operation: "delete",
  state: "blocked",
  session_incarnation: "launch-b2",
  session_generation: 1,
  issue: {
    kind: "runtime_identity_unavailable",
    operation: "delete",
    retryable: false,
    preserves_session_metadata: true,
    message: "the recorded runtime identity is unavailable",
  },
  boundary: { kind: "unknown", safe_process_count: 0 },
  preservation: {
    session_metadata_retained_until_success: true,
    provider_conversation_retained: true,
    destructive_scope: "verified_recorded_runtime_only",
  },
  actions: [
    {
      id: "retry_delete",
      label: "Retry delete",
      destructive: true,
      requires_confirmation: true,
      preserves_session_metadata: false,
    },
    {
      id: "remove_console_record",
      label: "Remove from Console only",
      destructive: true,
      requires_confirmation: true,
      preserves_session_metadata: false,
      terminates_runtime: false,
      may_leave_runtime_running: true,
    },
  ],
  preview_digest: `sha256:${"b".repeat(64)}`,
};

after(async () => {
  await ssr.close();
});

async function renderDrawer(preview: SessionMaintenancePreview): Promise<string> {
  const [{ SessionMaintenanceDrawer }, { createSessionMaintenanceIncident }] = await Promise.all([
    ssr.loadModule<{ SessionMaintenanceDrawer: ComponentType<Record<string, unknown>> }>(
      "/src/SessionMaintenanceDrawer.tsx",
    ),
    ssr.loadModule<{ createSessionMaintenanceIncident: (...args: never[]) => unknown }>(
      "/src/sessionMaintenance.ts",
    ),
  ]);
  const incident = (createSessionMaintenanceIncident as unknown as (
    ...args: unknown[]
  ) => { readonly key: string })(session, "delete", "delete failed", preview);
  return renderComponent(SessionMaintenanceDrawer, {
    incidents: [incident],
    selectedKey: incident.key,
    busy: false,
    pendingActionId: null,
    onSelectedKeyChange: () => {},
    onClose: () => {},
    onRefresh: () => {},
    onAction: () => {},
    onCopyDiagnostics: () => {},
    onCopyNextPrompt: () => {},
    onDismissIncident: () => {},
  });
}

const healthyStoppedPreview: SessionMaintenancePreview = {
  ...recordOnlyPreview,
  state: "healthy",
  issue: null,
  boundary: { kind: "none", safe_process_count: 0 },
  actions: [recordOnlyPreview.actions[0]!],
};

test("a healthy stopped preview replaces the stale failure with provider-aware recovery guidance", async () => {
  const markup = await renderDrawer(healthyStoppedPreview);

  assert.match(markup, /<dt>Provider<\/dt><dd class="maintenance-provider">codex<\/dd>/);
  assert.match(markup, /Current inspection found no live runtime/);
  assert.match(markup, /Retry delete to remove the stopped session record/);
  assert.match(markup, /class="maintenance-ready"/);
  assert.doesNotMatch(markup, />delete failed</);
  assert.match(markup, /Removes the stopped session record\. No process will be signaled\./);
  assert.doesNotMatch(markup, /Changes or terminates the verified recorded runtime/);
});

test("the record-only action states what it does not do and never reads as a force kill", async () => {
  const markup = await renderDrawer(recordOnlyPreview);

  assert.match(markup, /Remove from Console only/);
  assert.match(markup, /unverified process may still be running/);
  assert.match(markup, /Console stops managing it/);
  assert.match(markup, /Confirm removal without stopping anything/);
  // The wording must not promise a termination that never happens.
  for (const forbidden of [/force kill/i, /force delete/i]) {
    assert.doesNotMatch(markup, forbidden, String(forbidden));
  }
  // The row is marked so styling and tests can tell the two classes apart.
  assert.match(markup, /data-terminates-runtime="false"/);
  // Retry delete keeps its own copy in the same drawer.
  assert.match(markup, /Changes or terminates the verified recorded runtime\./);
  assert.doesNotMatch(markup, /home\/runner/);
});

test("a v1 preview renders no record-only action and no successor-only copy", async () => {
  const markup = await renderDrawer({
    ...recordOnlyPreview,
    schema_version: "agent-session.session-maintenance.v1",
    actions: [recordOnlyPreview.actions[0]!],
  });

  assert.doesNotMatch(markup, /Remove from Console only/);
  assert.doesNotMatch(markup, /unverified process may still be running/);
  assert.doesNotMatch(markup, /data-terminates-runtime/);
  assert.match(markup, /Retry delete/);
});

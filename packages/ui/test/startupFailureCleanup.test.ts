import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import type { ComponentType } from "react";
import type { Plugin } from "vite";
import { normalizeStartupStatus, type StartupFailureStatus } from "@agent-console/shared/api";
import type { SessionSlotProps } from "../src/SessionSlot.tsx";
import { startupCleanupCaveat } from "../src/startupFailure.ts";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

function terminalPaneMockPlugin(): Plugin {
  const mockId = "\0startup-failure-cleanup-terminal-pane-mock";
  return {
    name: "startup-failure-cleanup-terminal-pane-mock",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.endsWith("TerminalPane.tsx") && importer?.includes("/src/")) {
        return mockId;
      }
      return null;
    },
    load(id) {
      return id === mockId ? "export function TerminalPane() { return null; }" : null;
    },
  };
}

const ssr = createUiSsrHarness([terminalPaneMockPlugin()]);

const failedStartup: StartupFailureStatus = {
  schema_version: "agent-session.startup.v1",
  state: "failed",
  stage: "tmux",
  started_at: "2026-08-01T02:00:00Z",
  failure_code: "terminal-runtime-create-failed",
  message: "The terminal runtime could not be created.",
  occurred_at: "2026-08-01T02:00:04Z",
  retry_safe: true,
};

after(async () => ssr.close());

async function renderFailedSlot(startup: StartupFailureStatus): Promise<string> {
  const module = await ssr.loadModule<{ SessionSlot: ComponentType<SessionSlotProps> }>(
    "/src/SessionSlot.tsx",
  );
  return renderComponent(module.SessionSlot, makeSessionSlotProps({
    session: makeSession({ id: "failed-codex", status: "stopped", startup }),
  }));
}

test("startupCleanupCaveat speaks only for the two producer cleanup states", () => {
  assert.equal(startupCleanupCaveat(undefined), null);
  const pending = startupCleanupCaveat({ state: "pending", reason: "process_boundary_live" });
  const blocked = startupCleanupCaveat({ state: "blocked", reason: "runtime_identity_unavailable" });
  for (const caveat of [pending, blocked]) {
    assert.match(caveat!, /unverified process may still be running/);
    assert.match(caveat!, /session record was kept/);
  }
  // The reason code is a diagnostic, never user-facing copy.
  assert.doesNotMatch(pending!, /process_boundary_live/);
  assert.notEqual(pending, blocked);
});

test("a failed launch shows the primary error first and the cleanup caveat beside it", async () => {
  const withoutCleanup = await renderFailedSlot(failedStartup);
  assert.match(withoutCleanup, /The terminal runtime could not be created\./);
  assert.doesNotMatch(withoutCleanup, /startup-failure-cleanup/);

  const withCleanup = await renderFailedSlot({
    ...failedStartup,
    cleanup: { state: "blocked", reason: "runtime_identity_unavailable" },
  });
  // The startup failure stays primary: cleanup never replaces it.
  assert.match(withCleanup, /The terminal runtime could not be created\./);
  assert.match(withCleanup, /class="startup-failure-cleanup" data-cleanup-state="blocked"/);
  assert.match(withCleanup, /unverified process may still be running/);
  assert.doesNotMatch(withCleanup, /runtime_identity_unavailable/);
});

test("Codex runtime fallback explains terminal-only controls without replacing the startup error", async () => {
  const { SessionSlot } = await ssr.loadModule<{ SessionSlot: ComponentType<SessionSlotProps> }>("/src/SessionSlot.tsx");
  const ready = {
    schema_version: "agent-session.startup.v1", state: "ready", stage: "initial_connection",
    started_at: "2026-08-01T02:00:00Z",
  };
  const startup = normalizeStartupStatus({ ...ready, runtime_fallback: "codex-app-server-runtime-dir-unsafe" });
  assert.ok(startup);
  const html = renderComponent(SessionSlot, makeSessionSlotProps({ session: makeSession({ startup }) }));
  assert.match(html, /Terminal-only mode/);
  assert.match(html, /structured prompt, resume, and history controls are unavailable/);
  assert.match(html, /private runtime directory is unsafe/);
  assert.doesNotMatch(html, /codex-app-server-runtime-dir-unsafe/);

  const failed = normalizeStartupStatus({ ...failedStartup, runtime_fallback: "codex-app-server-runtime-dir-unsafe" });
  assert.ok(failed && failed.state === "failed");
  const failureHtml = await renderFailedSlot(failed);
  assert.ok(failureHtml.indexOf(failedStartup.message) < failureHtml.indexOf("Terminal-only mode"));

  for (const session of [makeSession({ startup: normalizeStartupStatus(ready)! }), makeSession({ agent: "claude", startup })]) {
    assert.doesNotMatch(renderComponent(SessionSlot, makeSessionSlotProps({ session })), /Terminal-only mode/);
  }
});

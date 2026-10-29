import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findHistoryEntry } from "../src/historyResumeById.ts";
import type { HistorySession, HistorySessionsResponse } from "../src/types.ts";

function historySession(overrides: Partial<HistorySession> = {}): HistorySession {
  return {
    id: "history-1",
    machine: "maple",
    provider: "codex",
    provider_session_id: "provider-1",
    agent_profile: "custom-codex",
    cwd: "/work",
    created_at: "2026-09-24T00:00:00Z",
    updated_at: "2026-09-24T00:00:00Z",
    resumable: true,
    ...overrides,
  };
}

function lister(sessions: HistorySession[], calls: unknown[] = []) {
  return async (machine: string, options: { readonly q?: string; readonly limit?: number }) => {
    calls.push({ machine, ...options });
    return { ok: true, sessions, truncated: false } satisfies HistorySessionsResponse;
  };
}

test("findHistoryEntry locates a live session by its exact provider id under any profile", async () => {
  const result = await findHistoryEntry(
    "maple",
    { providerSessionId: "codex-1", label: "Codex" },
    async () => ({
      ok: true,
      truncated: false,
      latestMessagePaging: true,
      sessions: [
        historySession({ id: "prefix", provider: "codex", provider_session_id: "codex-10", agent_profile: undefined }),
        historySession({ id: "exact", provider: "codex", provider_session_id: "codex-1", agent_profile: undefined, resumable: false }),
      ],
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.session.id, "exact");
  assert.equal(result.ok && result.latestMessagePaging, true);
});

test("findHistoryEntry reports a miss with the same wording as resume by ID", async () => {
  assert.deepEqual(
    await findHistoryEntry("maple", { providerSessionId: "codex-1", label: "Codex" }, lister([])),
    { ok: false, error: "No Codex session with ID codex-1 is in maple history." },
  );
});

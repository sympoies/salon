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
    { ok: false, error: "No Codex session with ID codex-1 is in maple history.", notFound: true },
  );
});

// A live session's lookup passes no profile, so a history row without an agent_profile still matches;
// a lookup that names a profile only matches an entry under it.
test("findHistoryEntry matches a row with no agent_profile for a live session but not for a profile lookup", async () => {
  const rows = [historySession({ id: "bare", provider: "claude", provider_session_id: "claude-1", agent_profile: undefined })];
  const live = await findHistoryEntry("maple", { providerSessionId: "claude-1", label: "Claude" }, lister(rows));
  assert.equal(live.ok && live.session.id, "bare");
  assert.deepEqual(
    await findHistoryEntry("maple", { providerSessionId: "claude-1", agentProfile: "work", label: "Claude" }, lister(rows)),
    { ok: false, error: "No Claude session with ID claude-1 is in maple history.", notFound: true },
  );
});

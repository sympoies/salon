import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findHistoryEntry, resolveHistoryResumeTarget } from "../src/historyResumeById.ts";
import type { HistorySession, HistorySessionsResponse } from "../src/types.ts";

function historySession(overrides: Partial<HistorySession> = {}): HistorySession {
  return {
    id: "history-1",
    machine: "maple",
    provider: "dsh",
    provider_session_id: "dsh-session-1",
    agent_profile: "dsh-workbench",
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

test("resolveHistoryResumeTarget searches history by the provider session id", async () => {
  const calls: unknown[] = [];
  const result = await resolveHistoryResumeTarget(
    "maple",
    { agentProfile: "dsh-workbench", providerSessionId: "dsh-session-1", label: "DSH" },
    lister([historySession()], calls),
  );

  assert.deepEqual(result, { ok: true, historyId: "history-1" });
  assert.deepEqual(calls, [{ machine: "maple", q: "dsh-session-1", limit: 50 }]);
});

test("resolveHistoryResumeTarget matches the exact id and profile only", async () => {
  const result = await resolveHistoryResumeTarget(
    "maple",
    { agentProfile: "dsh-workbench", providerSessionId: "dsh-session-1", label: "DSH" },
    lister([
      historySession({ id: "prefix", provider_session_id: "dsh-session-10" }),
      historySession({ id: "other-profile", agent_profile: "other-dsh" }),
      historySession({ id: "exact" }),
    ]),
  );

  assert.deepEqual(result, { ok: true, historyId: "exact" });
});

test("resolveHistoryResumeTarget explains a missing or non-resumable session", async () => {
  const target = { agentProfile: "dsh-workbench", providerSessionId: "dsh-session-1", label: "DSH" };

  assert.deepEqual(await resolveHistoryResumeTarget("maple", target, lister([])), {
    ok: false,
    error: "No DSH session with ID dsh-session-1 is in maple history.",
  });
  assert.deepEqual(
    await resolveHistoryResumeTarget("maple", target, lister([historySession({ resumable: false })])),
    { ok: false, error: "DSH session dsh-session-1 is in history but cannot be resumed." },
  );
  assert.deepEqual(
    await resolveHistoryResumeTarget("maple", target, async () => ({
      ok: false,
      error: "history unavailable",
      sessions: [],
      truncated: false,
    })),
    { ok: false, error: "history unavailable" },
  );
});

test("resolveHistoryResumeTarget follows the history cursor past a truncated page", async () => {
  const calls: unknown[] = [];
  const pages: Record<string, { sessions: HistorySession[]; nextCursor?: string }> = {
    first: {
      sessions: [historySession({ id: "near", provider_session_id: "dsh-session-10" })],
      nextCursor: "page-2",
    },
    "page-2": { sessions: [historySession({ id: "exact" })] },
  };
  const result = await resolveHistoryResumeTarget(
    "maple",
    { agentProfile: "dsh-workbench", providerSessionId: "dsh-session-1", label: "DSH" },
    async (machine, options) => {
      calls.push({ machine, ...options });
      const page = pages[options.cursor ?? "first"]!;
      return { ok: true, truncated: false, ...page };
    },
  );

  assert.deepEqual(result, { ok: true, historyId: "exact" });
  assert.deepEqual(calls, [
    { machine: "maple", q: "dsh-session-1", limit: 50 },
    { machine: "maple", q: "dsh-session-1", limit: 50, cursor: "page-2" },
  ]);
});

test("resolveHistoryResumeTarget does not report an incomplete search as missing", async () => {
  const target = { agentProfile: "dsh-workbench", providerSessionId: "dsh-session-1", label: "DSH" };
  let pages = 0;

  assert.deepEqual(
    await resolveHistoryResumeTarget("maple", target, async () => ({ ok: true, truncated: true, sessions: [] })),
    {
      ok: false,
      error: "The maple history scan limit was reached before DSH session dsh-session-1 was found.",
    },
  );
  assert.deepEqual(
    await resolveHistoryResumeTarget("maple", target, async () => {
      pages += 1;
      return { ok: true, truncated: false, sessions: [], nextCursor: `page-${pages + 1}` };
    }),
    { ok: false, error: "Too many history entries match dsh-session-1; paste the full DSH session ID." },
  );
  assert.equal(pages, 10);
});

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

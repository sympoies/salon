import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  projectArchiveDaemonData,
  projectHistoryMessagesDaemonData,
  projectHistorySessionsDaemonData,
  projectHistoryStarDaemonData,
} from "../src/daemonEnvelope.ts";

const session = {
  id: "h-abc",
  provider: "codex",
  provider_session_id: "provider-1",
  title: "Release follow-up",
  prompt_preview: "legacy first prompt",
  first_user_prompt_preview: "first human prompt",
  last_user_prompt_preview: "latest human prompt",
  cwd: "/work/example",
  created_at: "2026-08-31T00:00:00Z",
  updated_at: "2026-08-31T00:00:01Z",
  resumable: true,
};

test("history projections strip private and oversized daemon fields", () => {
  assert.deepEqual(projectHistorySessionsDaemonData({
    sessions: [{ ...session, transcript_path: "/private/transcript", environment: { TOKEN: "secret" } }],
    next_cursor: "next",
    truncated: true,
    capabilities: { latest_message_paging: true, private_capability: true },
    private_index: "/private/index",
  }), {
    sessions: [session],
    next_cursor: "next",
    truncated: true,
    capabilities: { latest_message_paging: true },
  });

  assert.deepEqual(projectHistoryMessagesDaemonData({
    messages: [{ id: "host-a", role: "assistant", text: "safe", raw: { command: "private" } }],
    older_cursor: "older",
    next_cursor: "newer",
    transcript_path: "/private/transcript",
  }), {
    messages: [{ id: "host-a", role: "assistant", text: "safe" }],
    older_cursor: "older",
    next_cursor: "newer",
  });
  assert.deepEqual(projectHistoryMessagesDaemonData({
    messages: [{ id: "m2", role: "assistant", text: "x".repeat(64 * 1024 + 1) }],
  }), { messages: [] });
  assert.deepEqual(projectHistoryMessagesDaemonData({
    messages: [{ id: "g1", role: "goal", text: "Repair retitle", internal_context: "private" }],
  }), { messages: [{ id: "g1", role: "goal", text: "Repair retitle" }] });
});

test("archive projection requires matching delete acknowledgement and strips private fields", () => {
  const archived = {
    history_id: "h-abc",
    provider: "codex",
    provider_session_id: "provider-1",
    cwd: "/work/example",
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:01Z",
    archived_at: "2026-08-31T00:00:02Z",
    archive_path: "/private/archive.json",
  };
  assert.equal(projectArchiveDaemonData({ archived }, "s1"), null);
  assert.equal(projectArchiveDaemonData({
    archived,
    deleted: { id: "replacement", deleted: true, killed: true, cleanup_pending: false },
  }, "s1"), null);
  assert.deepEqual(projectArchiveDaemonData({
    archived,
    deleted: {
      id: "s1",
      deleted: true,
      killed: true,
      cleanup_pending: false,
      session_dir: "/private/session",
    },
  }, "s1"), {
    archived: {
      id: "h-abc",
      provider: "codex",
      provider_session_id: "provider-1",
      cwd: "/work/example",
      created_at: "2026-08-31T00:00:00Z",
      updated_at: "2026-08-31T00:00:01Z",
      archived_at: "2026-08-31T00:00:02Z",
      resumable: false,
    },
    deleted: { id: "s1", deleted: true, killed: true, cleanup_pending: false },
  });
});

test("history projections carry the star and supported mutation capabilities", () => {
  assert.deepEqual(projectHistorySessionsDaemonData({
    sessions: [
      { ...session, starred_at: "2026-08-31T00:00:03Z" },
      { ...session, id: "h-unbounded", starred_at: "x".repeat(65) },
    ],
    truncated: false,
    capabilities: { star: true, resume: true, private_capability: true },
  }), {
    sessions: [{ ...session, starred_at: "2026-08-31T00:00:03Z" }, { ...session, id: "h-unbounded" }],
    truncated: false,
    capabilities: { star: true, resume: true },
  });
});

test("history projection accepts bounded non-resumable DSH sessions", () => {
  const dsh = {
    ...session,
    id: "h-dsh",
    provider: "dsh",
    provider_session_id: "dsh-session",
    agent_profile: "dsh-workbench",
    resumable: false,
  };
  assert.deepEqual(projectHistorySessionsDaemonData({ sessions: [dsh], truncated: false }), {
    sessions: [dsh],
    truncated: false,
  });
});

test("archive projection carries a star set as the session lands in history", () => {
  const projected = projectArchiveDaemonData({
    archived: {
      history_id: "h-abc",
      provider: "codex",
      provider_session_id: "provider-1",
      cwd: "/work/example",
      created_at: "2026-08-31T00:00:00Z",
      updated_at: "2026-08-31T00:00:01Z",
      archived_at: "2026-08-31T00:00:02Z",
      starred_at: "2026-08-31T00:00:02Z",
    },
    deleted: { id: "s1", deleted: true, killed: true, cleanup_pending: false },
  }, "s1");

  assert.equal(projected?.archived.starred_at, "2026-08-31T00:00:02Z");
});

test("history star projection keeps only the acknowledged id and star", () => {
  assert.deepEqual(
    projectHistoryStarDaemonData({ history_id: "h-abc", starred_at: "2026-09-01T00:00:00Z", path: "/private" }),
    { history_id: "h-abc", starred_at: "2026-09-01T00:00:00Z" },
  );
  assert.deepEqual(
    projectHistoryStarDaemonData({ history_id: "h-abc", starred_at: null }),
    { history_id: "h-abc", starred_at: null },
  );
  assert.equal(projectHistoryStarDaemonData({ starred_at: "2026-09-01T00:00:00Z" }), null);
});

test("image-only history messages retain bounded opaque descriptors", () => {
  const id = `${"a".repeat(16)}.0.0.${"b".repeat(32)}`;
  assert.deepEqual(projectHistoryMessagesDaemonData({ messages: [
    { id: "image-only", role: "user", text: "", images: [{ id, path: "/private/image.png", data: "private" }] },
  ] }), { messages: [{ id: "image-only", role: "user", text: "", images: [{ id }] }] });
});

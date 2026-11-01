import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeMailboxEvent } from "@agent-console/shared";
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

test("history projection admits the notice role only for a valid envelope without images", () => {
  const text = "<!-- agent-notice:v1 kind=mailbox source=fixture id=sample-1 -->\n\nSynthetic update";
  const image = { id: `${"a".repeat(16)}.0.0.${"b".repeat(32)}` };
  assert.deepEqual(projectHistoryMessagesDaemonData({
    messages: [
      { id: "n1", role: "notice", text, timestamp: "2026-01-01T00:00:00Z", internal: "private" },
      { id: "n2", role: "notice", text: "plain text, not an envelope" },
      { id: "n3", role: "notice", text, images: [image] },
      { id: "n4", role: "notice", text: "" },
    ],
  }), { messages: [{ id: "n1", role: "notice", text, timestamp: "2026-01-01T00:00:00Z" }] });
});

const mailboxText = "<!-- agent-notice:v1 kind=mailbox.read source=agent-session id=m-1 -->\n\nPlease review the synthetic change.\n";
const mailbox = {
  schema_version: "agent-session.mailbox-read-event.v1",
  message_id: "m-1",
  sender: { kind: "session", machine: "machine-a", session_id: "sender-1" },
  category: "handoff",
  state: "read",
  read_at: "2026-11-02T01:02:03.456Z",
  acknowledged_at: null,
  revision: 1,
  availability: "complete",
};

test("history projection forwards a valid mailbox read event with display fields only", () => {
  const event = { id: "h-abc-m-1-mailbox", role: "notice", text: mailboxText, timestamp: "2026-11-02T01:02:03.456Z" };
  const projected = projectHistoryMessagesDaemonData({
    messages: [{ ...event, mailbox: { ...mailbox, path: "/private", sender: { ...mailbox.sender, incarnation: "i-1" } } }],
  }) as { messages: Array<{ mailbox?: unknown }> };
  assert.deepEqual(projected, { messages: [{ ...event, mailbox }] }, "the wire shape, minus every field outside the allow-list");
  // The browser parses the edge's output with the same normalizer; it must keep the metadata.
  assert.deepEqual(normalizeMailboxEvent(projected.messages[0]!.mailbox), mailbox);
});

test("a malformed mailbox object leaves a plain notice, and only notices may carry one", () => {
  const event = { id: "n-1", role: "notice", text: mailboxText };
  assert.deepEqual(projectHistoryMessagesDaemonData({ messages: [{ ...event, mailbox: { ...mailbox, availability: "truncated" } }] }), { messages: [event] });
  assert.deepEqual(projectHistoryMessagesDaemonData({ messages: [{ id: "a-1", role: "assistant", text: "hi", mailbox }] }), { messages: [{ id: "a-1", role: "assistant", text: "hi" }] });
});

test("mailbox events do not count against the provider row limit, however many ride with a page", () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ id: `row-${index}`, role: "assistant", text: `row ${index}` }));
  const events = Array.from({ length: 151 }, (_, index) => ({ id: `h-abc-m-${index}-mailbox`, role: "notice", text: mailboxText, mailbox: { ...mailbox, message_id: `m-${index}` } }));
  const page = [...rows.slice(0, 50), ...events, ...rows.slice(50)];
  const projected = projectHistoryMessagesDaemonData({ messages: page }) as { messages: Array<{ id: string }> };
  assert.equal(projected.messages.length, 251, "all 100 rows and all 151 events");
  assert.equal(projected.messages.at(-1)?.id, "row-99", "the last element of the page is kept");
  const over = projectHistoryMessagesDaemonData({ messages: [...page, { id: "row-100", role: "assistant", text: "one more" }] }) as { messages: Array<{ id: string }> };
  assert.equal(over.messages.filter((message) => message.id.startsWith("row-")).length, 100, "provider rows stay bounded at 100");
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

test("history projection drops old-daemon dsh rows and preserves supported providers", () => {
  const claude = { ...session, id: "h-claude", provider: "claude" };
  assert.deepEqual(projectHistorySessionsDaemonData({
    sessions: [session, { ...session, id: "retired", provider: "dsh" }, claude],
    truncated: false,
  }), { sessions: [session, claude], truncated: false });
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

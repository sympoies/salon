/**
 * Synthetic scenario for the README previews. Everything here is fictional:
 * the "fernlight" project, its sessions and their conversations. Nothing is
 * read from a real host, account or session.
 */
export const MACHINE = "workspace";
/** The instant the page believes it is, so elapsed-time labels never change. */
export const NOW = "2026-10-29T09:30:00.000Z";
const at = (minutesAgo: number) => new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();
/**
 * Conversation messages are dated the day before NOW. The UI labels a message
 * dated today with a fixed non-English word, so a plain date keeps the previews
 * readable; session state times stay recent.
 */
const DAY = 24 * 60;
const msgAt = (minutesAgo: number) => at(minutesAgo + DAY);

export interface FixtureMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: string;
  readonly images?: readonly { readonly id: string }[];
}
export interface FixtureSession {
  readonly key: string;
  readonly id: string;
  readonly history: string;
  readonly provider: "claude" | "codex";
  readonly title: string;
  readonly phase: "working" | "waiting" | "needs_input" | "idle";
  /** Sessions list in this order: the one created first comes first. */
  readonly createdMinutesAgo: number;
  /** Minutes before NOW that the session last changed state. */
  readonly changedMinutesAgo: number;
  readonly completed?: boolean;
  readonly approval?: boolean;
  readonly messages: readonly FixtureMessage[];
}

/** An opaque image id in the shape the daemon issues. */
export const CHART_IMAGE_ID = "5f1c9a7e3b2d4c60.1.0.8d3a6b1f0c2e4a79b5d8e1f3a6c9b2d4";

const retryTitle = "fernlight#412 retry backoff for ingest workers";
const compactionTitle = "fernlight#398 flaky rollup compaction test";

const retryMessages: FixtureMessage[] = [
  { id: "m412-1", role: "user", timestamp: msgAt(9),
    text: "Ingest workers hammer the broker right after a restart. Add exponential backoff with jitter, cap it at 30s, and keep the existing retry metrics." },
  { id: "m412-2", role: "assistant", timestamp: msgAt(6), images: [{ id: CHART_IMAGE_ID }],
    text: [
      "Plan:",
      "",
      "1. Replace the fixed 500 ms retry delay in `ingest/src/worker.rs` with exponential backoff.",
      "2. Add full jitter and cap the delay at 30 s.",
      "3. Leave `ingest_retry_total` and `ingest_retry_delay_seconds` unchanged.",
      "",
      "```diff",
      "--- a/ingest/src/worker.rs",
      "+++ b/ingest/src/worker.rs",
      "@@ fn next_delay(attempt: u32) -> Duration {",
      "-    Duration::from_millis(500)",
      "+    let exp = BASE.saturating_mul(1 << attempt.min(16));",
      "+    exp.min(MAX_DELAY).mul_f64(jitter())",
      " }",
      "```",
      "",
      "`cargo test -p ingest` — 48 passed",
      "",
      "Broker connections after a restart, before and after the change:",
    ].join("\n") },
  { id: "m412-3", role: "user", timestamp: msgAt(3),
    text: "<!-- agent-notice:v1 kind=schedule.pulse source=scheduler -->\n\nCI for #412 passed" },
];

const compactionMessages: FixtureMessage[] = [
  { id: "m398-1", role: "assistant", timestamp: msgAt(14),
    text: "Reproduced 3 of 50 runs. The compaction timer races with shutdown; the fix is to cancel the timer before draining. Want me to open a PR?" },
  { id: "m398-2", role: "user", timestamp: msgAt(12), text: "Yes — open it and link #398." },
  { id: "m398-3", role: "assistant", timestamp: msgAt(11), text: "Opened PR #415." },
];

const generic = (id: string, user: string, agent: string): FixtureMessage[] => [
  { id: `${id}-1`, role: "user", timestamp: msgAt(40), text: user },
  { id: `${id}-2`, role: "assistant", timestamp: msgAt(38), text: agent },
];

export const SESSIONS: readonly FixtureSession[] = [
  { key: "retry", createdMinutesAgo: 100, id: "fl-412", history: "h-fl-412", provider: "claude", title: retryTitle, phase: "working", changedMinutesAgo: 6, messages: retryMessages },
  { key: "compaction", createdMinutesAgo: 99, id: "fl-398", history: "h-fl-398", provider: "codex", title: compactionTitle, phase: "waiting", changedMinutesAgo: 11, completed: true, messages: compactionMessages },
  { key: "release", createdMinutesAgo: 98, id: "fl-rel", history: "h-fl-rel", provider: "claude", title: "release 0.9.0-rc.2 checklist", phase: "needs_input", changedMinutesAgo: 4, approval: true,
    messages: generic("rel", "Walk through the 0.9.0-rc.2 release checklist.", "The changelog and version bump are ready. I need approval to tag rc.2.") },
  { key: "colors", createdMinutesAgo: 97, id: "fl-dash", history: "h-fl-dash", provider: "codex", title: "dashboard: chart colors in dark mode", phase: "working", changedMinutesAgo: 2,
    messages: generic("dash", "The chart colors are hard to tell apart in dark mode.", "Checking the palette against the dark background.") },
  { key: "docs", createdMinutesAgo: 96, id: "fl-docs", history: "h-fl-docs", provider: "claude", title: "docs: v0.9 config migration guide", phase: "idle", changedMinutesAgo: 27, completed: true,
    messages: generic("docs", "Write the v0.9 config migration guide.", "The guide is in `docs/migration-0.9.md`.") },
  { key: "deps", createdMinutesAgo: 95, id: "fl-deps", history: "h-fl-deps", provider: "codex", title: "deps: bump tokio and axum", phase: "idle", changedMinutesAgo: 55,
    messages: generic("deps", "Bump tokio and axum.", "Both are updated and the build is green.") },
];

/** What the stand-in daemon says it can do; the UI turns these into the conversation views. */
export const CAPABILITIES = { history: true, archive: true, history_star: true, last_prompt: true, last_message: true };

/** The daemon's view of one session. */
export function daemonSession(session: FixtureSession) {
  const changed = at(session.changedMinutesAgo);
  // Previews of the latest real prompt and message; notices are not either.
  const spoken = session.messages.filter(message => !message.text.startsWith("<!--"));
  const lastUser = [...spoken].reverse().find(message => message.role === "user");
  const lastMessage = spoken.at(-1);
  const turn = {
    schema_version: "agent-session.turn-state.v1",
    phase: session.phase,
    revision: 4,
    phase_changed_at: changed,
    source: { kind: "provider_hook", provider: session.provider, confidence: "authoritative" },
    ...(session.phase === "working" || session.phase === "needs_input"
      ? { current_turn: { started_at: changed, last_progress_at: changed,
        ...(session.approval ? { attention: { kind: "approval", requested_at: changed, pending_count: 1, certainty: "exact" } } : {}) } }
      : {}),
    ...(session.completed ? { last_turn: { started_at: at(session.changedMinutesAgo + 3), completed_at: changed, outcome: "completed" } } : {}),
  };
  return {
    id: session.id,
    agent: session.provider,
    status: "running",
    title: session.title,
    title_revision: 1,
    session_incarnation: `launch-${session.id}`,
    created_at: at(session.createdMinutesAgo),
    updated_at: changed,
    cwd: "/workspace/fernlight",
    repo_name: "fernlight",
    model: session.provider === "claude" ? "sonnet-5.5" : "gpt-5.5",
    reasoning_effort: session.provider === "claude" ? "high" : "medium",
    ...(lastUser ? { last_prompt: { text: lastUser.text, submitted_at: lastUser.timestamp } } : {}),
    ...(lastMessage ? { last_message: { role: lastMessage.role, text: lastMessage.text.split("\n")[0], submitted_at: lastMessage.timestamp } } : {}),
    provider_resume: { provider: session.provider, session_id: `thread-${session.id}` },
    turn_state: turn,
  };
}

export function historySession(session: FixtureSession) {
  return {
    id: session.history,
    provider: session.provider,
    provider_session_id: `thread-${session.id}`,
    title: session.title,
    cwd: "/workspace/fernlight",
    repo_name: "fernlight",
    created_at: at(session.createdMinutesAgo),
    updated_at: at(session.changedMinutesAgo),
    resumable: true,
  };
}

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { Server as NetServer } from "node:net";
import { createEdgeServer } from "../src/server.ts";
import { closeServers, jsonReader, listenOnLoopback, loginCookie, makeEdgeConfig } from "./support.ts";

// Every browser create is a console root (session-lineage-work-v1).
const CONSOLE_ROOT_LINEAGE = {
  schema_version: "agent-session.session-lineage.v1",
  parent: null,
  root: null,
  depth: 0,
  starter: { kind: "console", via: "console" },
};

interface DaemonRequest {
  readonly method: string;
  readonly url: string;
  readonly auth: string;
  readonly contentType?: string;
  readonly body: Buffer;
}

interface RouteCase {
  readonly label: string;
  readonly method?: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: BodyInit | null;
}

const daemonRequests: DaemonRequest[] = [];
let daemon: HttpServer;
let usageReader: HttpServer;
let layoutReader: HttpServer;
let edge: NetServer;
let base = "";
let cookie = "";
let slowAccountSwitch: {
  readonly started: () => void;
  readonly wait: Promise<void>;
} | null = null;
let nextAccountOutcomeIndex = -1;
let slowSessionMutation: {
  readonly started: () => void;
  readonly wait: Promise<void>;
} | null = null;
let slowMaintenancePreview: {
  readonly started: () => void;
  readonly wait: Promise<void>;
} | null = null;

const maintenancePreview = {
  schema_version: "agent-session.session-maintenance.v1",
  session_id: "s1",
  operation: "resume",
  state: "repairable",
  session_incarnation: "launch-s1",
  session_generation: 1,
  issue: {
    kind: "process_boundary_live",
    operation: "resume",
    retryable: true,
    preserves_session_metadata: true,
    message: "the recorded runtime process boundary is still live",
  },
  boundary: { kind: "managed_scope", safe_process_count: 2 },
  preservation: {
    session_metadata_retained_until_success: true,
    provider_conversation_retained: true,
    destructive_scope: "verified_recorded_runtime_only",
  },
  actions: [
    {
      id: "retry_resume",
      label: "Retry resume",
      destructive: false,
      requires_confirmation: false,
      preserves_session_metadata: true,
    },
    {
      id: "terminate_runtime_then_resume",
      label: "Terminate recorded runtime, then resume",
      destructive: true,
      requires_confirmation: true,
      preserves_session_metadata: true,
    },
  ],
  preview_digest: "sha256:8d5dece08afdf22b39fcbba1d1bc33dd6d967e81a4728a715be06995d9db7f24",
} as const;

/** v1 shape a daemon without the successor contract still returns for B2. */
const legacyDeletePreview = {
  schema_version: "agent-session.session-maintenance.v1",
  session_id: "legacy-daemon",
  operation: "delete",
  state: "blocked",
  session_incarnation: "launch-legacy",
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
  ],
  preview_digest: `sha256:${"c".repeat(64)}`,
} as const;

const recordOnlyDeletePreview = {
  ...legacyDeletePreview,
  schema_version: "agent-session.session-maintenance.v2",
  session_id: "record-only",
  session_incarnation: "launch-record-only",
  actions: [
    ...legacyDeletePreview.actions,
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
} as const;

before(async () => {
  daemon = createHttpServer(async (req, res) => {
    const body = await readRaw(req);
    const rawType = req.headers["content-type"];
    daemonRequests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: req.headers.authorization ?? "",
      contentType: Array.isArray(rawType) ? rawType[0] : rawType,
      body,
    });
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/healthz") {
      res.end(JSON.stringify({ ok: true, data: {
        machine: "maple",
        runtime: {
          state: "unavailable",
          binary_version: "1.29.1 (build details)",
          executable_state: "replaced",
          coordination: "available",
          reasons: ["runtime-executable-replaced"],
          token: "must-not-cross-edge",
        },
        secret: "must-not-cross-edge",
      } }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions") {
      res.end(JSON.stringify({ ok: true, data: { sessions: [{
        id: "s1",
        title: "Main session",
        codex_account: {
          schema_version: "agent-session.codex-account.v1",
          supported: true,
          state: "bound",
          selected_account: "account-a",
          revision: 2,
          applied_runtime_id: "launch-s1",
          access_token: "must-not-cross-edge",
        },
      }] } }));
      return;
    }
    if (req.method === "GET" && req.url === "/codex/accounts") {
      res.end(JSON.stringify({ ok: true, data: { accounts: [
        { account: "account-a", label: "Account A", plan: "team", access_token: "must-not-cross-edge" },
        { account: "../bad", label: "Unsafe" },
      ], readiness: {
        schema_version: "agent-session.codex-account-readiness.v1",
        supported: true,
        provider_version: "0.144.5",
        access_token: "must-not-cross-edge",
      } } }));
      return;
    }
    if (req.method === "GET" && req.url === "/claude/accounts") {
      res.end(JSON.stringify({ ok: true, data: {
        machine: "maple",
        accounts: [
          { account: "alpha", label: "Alpha", plan: "max", config_dir: "/private/claude-alpha" },
          { account: "../bad", label: "Unsafe" },
          { account: "beta" },
        ],
        selection_strategies: ["current_default"],
      } }));
      return;
    }
    if (req.method === "GET" && req.url === "/workdirs?q=agent&limit=2") {
      res.end(JSON.stringify({ ok: true, data: { workdirs: [{ path: "/repo/agent-console" }] } }));
      return;
    }
    if (req.method === "GET" && req.url === `/repos/remote-url?cwd=${encodeURIComponent("/repo/agent-console")}`) {
      res.end(JSON.stringify({ ok: true, data: { url: "https://github.com/example-org/agent-console" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/s1/glance?tail=40") {
      res.end(JSON.stringify({ ok: true, data: { text: "terminal glance" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/s1/buffer") {
      res.end(JSON.stringify({ ok: true, data: { text: "tmux buffer" } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/s1/send") {
      res.end(JSON.stringify({ ok: true, data: { sent: true } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/s1/prompt") {
      res.end(JSON.stringify({ ok: true, data: { submitted: true } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/s1/prompt/v2") {
      res.end(JSON.stringify({
        ok: true,
        data: {
          submitted: true,
          session_incarnation: "launch-s1",
          prompt: "must-not-cross-edge",
          access_token: "must-not-cross-edge",
          response_item: { type: "message", role: "user", content: "must-not-cross-edge" },
        },
        diagnostics: { provider_turn_id: "must-not-cross-edge" },
      }));
      return;
    }
    // A busy Claude session queues the prompt behind its running turn.
    if (req.method === "POST" && (req.url === "/sessions/prompt-queued/prompt/v2" || req.url === "/sessions/prompt-queued-string/prompt/v2")) {
      res.end(JSON.stringify({
        ok: true,
        data: {
          submitted: true,
          queued: req.url.includes("string") ? "true" : true,
          session_incarnation: "launch-expected",
          prompt: "must-not-cross-edge",
        },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/prompt-missing/prompt/v2") {
      res.end(JSON.stringify({
        ok: true,
        data: {
          response_item: { type: "message", role: "user", content: "must-not-cross-edge" },
          access_token: "must-not-cross-edge",
        },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/prompt-mismatch/prompt/v2") {
      res.end(JSON.stringify({
        ok: true,
        data: { submitted: true, session_incarnation: "replacement-runtime" },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/prompt-error/prompt/v2") {
      res.writeHead(409);
      res.end(JSON.stringify({
        ok: false,
        error: {
          code: "session-incarnation-conflict",
          message: "credential https://user:password@example.com must-not-cross-edge",
          access_token: "must-not-cross-edge",
        },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/s1/resume") {
      res.end(JSON.stringify({ ok: true, data: { session: { id: "s1", status: "running" } } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/serialize/resume") {
      slowSessionMutation?.started();
      if (slowSessionMutation) await slowSessionMutation.wait;
      res.end(JSON.stringify({ ok: true, data: { session: { id: "serialize", status: "running" } } }));
      return;
    }
    if (req.method === "DELETE" && req.url === "/sessions/serialize") {
      slowSessionMutation?.started();
      if (slowSessionMutation) await slowSessionMutation.wait;
      res.end(JSON.stringify({ ok: true, data: { deleted: {
        id: "serialize", deleted: true, killed: true, cleanup_pending: false,
      } } }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/serialize/maintenance?operation=resume") {
      res.end(JSON.stringify({
        ok: true,
        data: { maintenance: { ...maintenancePreview, session_id: "serialize" } },
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/s1/maintenance?operation=resume") {
      res.end(JSON.stringify({ ok: true, data: { maintenance: {
        ...maintenancePreview,
        cwd: "/private/repo",
        pane_pid: 123,
      } } }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/missing/maintenance?operation=resume") {
      res.writeHead(404);
      res.end(JSON.stringify({
        ok: false,
        error: { code: "session-not-found", message: "private missing-session detail" },
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/wrong-preview/maintenance?operation=resume") {
      res.end(JSON.stringify({
        ok: true,
        data: { maintenance: { ...maintenancePreview, session_id: "some-other-session" } },
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/wrong-error/maintenance?operation=resume") {
      res.writeHead(409);
      res.end(JSON.stringify({
        ok: false,
        error: {
          code: "session-maintenance-failed",
          details: {
            id: "another-session",
            operation: "delete",
            kind: "process_boundary_live",
            retryable: true,
            session_metadata_retained: false,
          },
        },
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/coalesce/maintenance?operation=resume") {
      slowMaintenancePreview?.started();
      if (slowMaintenancePreview) await slowMaintenancePreview.wait;
      res.end(JSON.stringify({
        ok: true,
        data: { maintenance: { ...maintenancePreview, session_id: "coalesce" } },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/coalesce/resume") {
      res.end(JSON.stringify({ ok: true, data: { session: { id: "coalesce", status: "running" } } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/s1/maintenance/actions") {
      const requested = JSON.parse(body.toString("utf8"));
      res.end(JSON.stringify({ ok: true, data: { maintenance_result: {
        schema_version: "agent-session.session-maintenance.v1",
        session_id: "s1",
        operation: requested.operation,
        action: requested.action,
        outcome: "resumed",
        session_incarnation: "launch-s1-next",
        session_generation: 2,
        status: "running",
        cleanup_pending: false,
        cwd: "/private/repo",
      } } }));
      return;
    }
    if (
      req.method === "GET"
      && req.url === "/sessions/record-only/maintenance"
        + "?operation=delete&schema_version=agent-session.session-maintenance.v2"
    ) {
      res.end(JSON.stringify({
        ok: true,
        data: { maintenance: { ...recordOnlyDeletePreview, cwd: "/private/repo" } },
      }));
      return;
    }
    // A daemon that predates the successor contract rejects the unknown field
    // while decoding the request, so nothing ran.
    if (req.method === "GET" && req.url?.startsWith("/sessions/legacy-daemon/maintenance?operation=delete&schema_version=")) {
      res.writeHead(400);
      res.end(JSON.stringify({
        ok: false,
        error: { code: "invalid-maintenance-query", message: "private decode detail" },
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/legacy-daemon/maintenance?operation=delete") {
      res.end(JSON.stringify({ ok: true, data: { maintenance: legacyDeletePreview } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/record-only/maintenance/actions") {
      const requested = JSON.parse(body.toString("utf8"));
      res.end(JSON.stringify({ ok: true, data: { maintenance_result: {
        schema_version: requested.schema_version ?? "agent-session.session-maintenance.v1",
        session_id: "record-only",
        operation: requested.operation,
        action: requested.action,
        outcome: "record_removed",
        session_incarnation: null,
        session_generation: null,
        status: "record_removed",
        cleanup_pending: true,
      } } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/legacy-daemon/maintenance/actions") {
      const requested = JSON.parse(body.toString("utf8"));
      if (requested.schema_version !== undefined) {
        res.writeHead(400);
        res.end(JSON.stringify({
          ok: false,
          error: { code: "invalid-maintenance-action-request", message: "private decode detail" },
        }));
        return;
      }
      res.end(JSON.stringify({ ok: true, data: { maintenance_result: {
        schema_version: "agent-session.session-maintenance.v1",
        session_id: "legacy-daemon",
        operation: requested.operation,
        action: requested.action,
        outcome: "deleted",
        session_incarnation: null,
        session_generation: null,
        status: "deleted",
        cleanup_pending: false,
      } } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/wrong-result/maintenance/actions") {
      const requested = JSON.parse(body.toString("utf8"));
      res.end(JSON.stringify({ ok: true, data: { maintenance_result: {
        schema_version: "agent-session.session-maintenance.v1",
        session_id: "some-other-session",
        operation: requested.operation,
        action: requested.action,
        outcome: "deleted",
        session_incarnation: null,
        session_generation: null,
        status: "deleted",
        cleanup_pending: true,
      } } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/unknown/maintenance/actions") {
      req.socket.destroy();
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/unknown/maintenance?operation=resume") {
      res.end(JSON.stringify({
        ok: true,
        data: { maintenance: { ...maintenancePreview, session_id: "unknown" } },
      }));
      return;
    }
    const accountRoute = req.url?.match(/^\/sessions\/([^/]+)\/account$/);
    if (req.method === "PUT" && accountRoute) {
      const requested = JSON.parse(body.toString("utf8"));
      if (accountRoute[1] === "claude-1") {
        if (requested.account === "unknown-nick") {
          res.writeHead(400);
          res.end(JSON.stringify({
            ok: false,
            error: { code: "claude-account-unknown", message: "private broker inventory" },
          }));
          return;
        }
        if (requested.account === "refused") {
          res.writeHead(422);
          res.end(JSON.stringify({
            ok: false,
            error: {
              code: "claude-account-switch-refused",
              message: "private /home/runner/.claude-accounts/refused",
              details: { cause: "claude-account-dir-unsafe", reason: "private path" },
            },
          }));
          return;
        }
        const applied = requested.account === "gamma";
        const queued = requested.account === "beta";
        res.end(JSON.stringify({ ok: true, data: {
          machine: "maple",
          session_incarnation: applied ? "launch-claude-2" : requested.expected_session_incarnation,
          claude_account: {
            schema_version: "agent-session.claude-account.v1",
            supported: true,
            state: "bound",
            selected_account: applied ? "gamma" : "alpha",
            selection_source: "explicit",
            revision: applied ? 2 : 1,
            applied_runtime_id: applied ? "launch-claude-2" : "launch-claude-1",
            config_dir: "/private/claude-account",
            ...(queued ? { next: { account: "beta", revision: 2, state: "queued", config_dir: "/private" } } : {}),
          },
        } }));
        return;
      }
      if (requested.account === "slow" && slowAccountSwitch) {
        slowAccountSwitch.started();
        await slowAccountSwitch.wait;
      }
      if (requested.account === "timeout") {
        res.writeHead(504);
        res.end(JSON.stringify({
          ok: false,
          error: { code: "codex-account-broker-timeout", message: "private broker timing" },
        }));
        return;
      }
      if (requested.account === "busy") {
        res.writeHead(409);
        res.end(JSON.stringify({
          ok: false,
          error: {
            code: "codex-account-session-busy",
            message: "TOKEN=must-not-cross-edge",
          },
        }));
        return;
      }
      if (
        requested.account === "unbound-next"
        || requested.account === "unbound-next-stale"
        || requested.account === "unbound-next-missing"
        || requested.account === "unbound-next-applying"
        || requested.account === "unbound-next-failed"
        || requested.account === "unbound-next-future"
      ) {
        const unboundNextState = requested.account === "unbound-next-applying"
          ? "applying"
          : requested.account === "unbound-next-failed"
            ? "failed"
            : requested.account === "unbound-next-future"
              ? "future-state"
              : "queued";
        res.end(JSON.stringify({ ok: true, data: {
          ...(requested.account === "unbound-next-missing"
            ? {}
            : {
                session_incarnation: requested.account === "unbound-next-stale"
                  ? "launch-replacement"
                  : requested.expected_session_incarnation,
              }),
          codex_account: {
            schema_version: "agent-session.codex-account.v1",
            supported: true,
            state: "unbound",
            revision: 0,
            next: {
              account: requested.account,
              revision: 1,
              state: unboundNextState,
              access_token: "drop-me",
            },
            private_binding: "drop-me",
          },
        } }));
        return;
      }
      const sequencedNextState = nextAccountOutcomeIndex >= 0
        ? ["queued", "applying", "failed", "future-state"][nextAccountOutcomeIndex]
        : undefined;
      const sequencedInvalid = nextAccountOutcomeIndex === 4;
      if (
        accountRoute[1] === "s1"
        && requested.account === "account-b"
        && (sequencedNextState || sequencedInvalid)
      ) {
        nextAccountOutcomeIndex += 1;
        const nextFixture: Record<string, unknown> = sequencedInvalid
          ? {
              revision: 0,
              state: "failed",
              failure_reason: "next_invalid",
              secret: "drop-me",
            }
          : {
              account: requested.account,
              revision: 2,
              state: sequencedNextState,
              ...(sequencedNextState === "failed" ? { failure_reason: "apply_failed" } : {}),
              access_token: "drop-me",
            };
        res.end(JSON.stringify({ ok: true, data: { codex_account: {
          schema_version: "agent-session.codex-account.v1",
          supported: true,
          state: "bound",
          selected_account: "account-a",
          revision: 2,
          applied_runtime_id: "launch-s1",
          next: nextFixture,
          private_binding: "drop-me",
        } } }));
        return;
      }
      res.end(JSON.stringify({ ok: true, data: { codex_account: {
        schema_version: "agent-session.codex-account.v1",
        supported: true,
        state: "bound",
        selected_account: requested.account === "mismatch" ? "galaxy" : requested.account,
        revision: 3,
        applied_runtime_id: `launch-${accountRoute[1]}`,
        access_token: "must-not-cross-edge",
      } } }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/s1/auto-resume") {
      res.end(JSON.stringify({ ok: true, data: { auto_resume: {
        schema_version: "agent-session.auto-resume.v1",
        supported: true,
        enabled: true,
        state: "scheduled",
        scheduled_at: "2026-07-12T12:34:56Z",
        continuation: "untrusted content",
        error_details: "private provider output",
      } } }));
      return;
    }
    if (req.method === "PUT" && req.url === "/sessions/s1/auto-resume") {
      res.end(JSON.stringify({ ok: true, data: { auto_resume: {
        schema_version: "agent-session.auto-resume.v1",
        supported: true,
        enabled: JSON.parse(body.toString("utf8")).enabled,
        state: "enabled",
        continuation: "untrusted content",
      } } }));
      return;
    }
    if (req.method === "DELETE" && req.url === "/sessions/s1/auto-resume") {
      res.end(JSON.stringify({ ok: true, data: { auto_resume: {
        schema_version: "agent-session.auto-resume.v1",
        supported: true,
        enabled: false,
        state: "cancelled",
        error_details: "private provider output",
      } } }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/bad/auto-resume") {
      res.end(JSON.stringify({ ok: true, data: { auto_resume: { schema_version: "future", supported: true } } }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/error/auto-resume") {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: { message: "TOKEN=private", error_details: "provider output" } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/s1/attachments?filename=clip.txt") {
      res.end(JSON.stringify({ ok: true, data: { attachment: { bytes: body.length } } }));
      return;
    }
    if (req.method === "PATCH" && req.url === "/sessions/s1") {
      res.end(JSON.stringify({ ok: true, data: { session: { id: "s1", title: "Renamed" } } }));
      return;
    }
    if (req.method === "DELETE" && req.url === "/sessions/s1") {
      res.end(JSON.stringify({ ok: true, data: { deleted: {
        id: "s1",
        deleted: true,
        killed: false,
        cleanup_pending: true,
        tmux_session: "private-tmux",
        session_dir: "/private/session",
        pid: 42,
      } } }));
      return;
    }
    if (req.method === "DELETE" && req.url === "/sessions/termination-blocked") {
      res.writeHead(500);
      res.end(JSON.stringify({
        ok: false,
        error: {
          code: "session-termination-failed",
          message: "the recorded tmux runtime process boundary remained live after kill-session; session metadata was retained",
          details: {
            id: "termination-blocked",
            tmux_session: "private-tmux",
            reason: "process-still-running",
            retryable: true,
            action: "retry-delete",
          },
        },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions") {
      const request = JSON.parse(body.toString("utf8"));
      if (request.cwd === "/not-a-directory") {
        res.writeHead(422);
        res.end(JSON.stringify({
          ok: false,
          error: {
            code: "cwd-not-directory",
            message: "private host path must not cross edge",
          },
        }));
        return;
      }
      if (request.codex_account === "daemon-error") {
        res.writeHead(500);
        res.end(JSON.stringify({
          ok: false,
          data: { access_token: "must-not-cross-edge" },
          error: { code: "broker_failed", message: "TOKEN=must-not-cross-edge" },
        }));
        return;
      }
      if (request.codex_account === "capability-error") {
        res.writeHead(422);
        res.end(JSON.stringify({
          ok: false,
          error: {
            code: "codex-app-server-capability-unavailable",
            message: "private provider diagnostics must not cross edge",
          },
        }));
        return;
      }
      if (request.agent === "claude") {
        if (request.claude_account === "unsupported") {
          res.writeHead(400);
          res.end(JSON.stringify({
            ok: false,
            error: { code: "claude-account-unsupported", message: "private broker configuration" },
          }));
          return;
        }
        res.end(JSON.stringify({ ok: true, data: { session: {
          id: "created-claude",
          agent: "claude",
          session_incarnation: "launch-created",
          ...(typeof request.claude_account === "string" && request.claude_account !== "host"
            ? {
                claude_account: {
                  schema_version: "agent-session.claude-account.v1",
                  supported: true,
                  state: "bound",
                  selected_account: request.claude_account,
                  selection_source: "explicit",
                  revision: 1,
                  applied_runtime_id: request.claude_account === "stale-runtime" ? "launch-old" : "launch-created",
                  config_dir: "/private/claude-account",
                },
                config_dir: "/private/claude-account",
              }
            : {}),
        } } }));
        return;
      }
      const codexAccount = typeof request.codex_account === "string"
        ? {
            schema_version: "agent-session.codex-account.v1",
            supported: true,
            state: request.codex_account === "pending" ? "pending" : "bound",
            selected_account: request.codex_account,
            revision: 1,
            ...(request.codex_account === "pending" ? {} : { applied_runtime_id: "launch-created" }),
            access_token: "must-not-cross-edge",
          }
        : undefined;
      res.end(JSON.stringify({ ok: true, data: { session: {
        id: "created",
        agent: "codex",
        session_incarnation: "launch-created",
        ...(codexAccount ? {
          codex_account: codexAccount,
          access_token: "must-not-cross-edge",
          credential_path: "/private/auth.json",
        } : {}),
      } } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: { message: `unexpected daemon request: ${req.method} ${req.url}` } }));
  });

  usageReader = jsonReader((url) => {
    if (url.pathname === "/usage") {
      return {
        status: 200,
        body: {
          providers: [{ provider: "codex", label: "Codex", ok: true, windows: [{ key: "5h", used_percent: 12 }] }],
        },
      };
    }
    return null;
  });
  layoutReader = jsonReader((url) => {
    if (url.pathname === "/layout") {
      return { status: 200, body: { order: ["maple/s1"], revision: 7 } };
    }
    return null;
  });

  const { port: daemonPort } = await listenOnLoopback(daemon);
  const { base: usageBase } = await listenOnLoopback(usageReader);
  const { base: layoutBase } = await listenOnLoopback(layoutReader);
  edge = createEdgeServer(
    makeEdgeConfig({
      clientToken: "client-secret",
      openAccess: false,
      machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
      usage: { url: usageBase, token: null },
      layout: { url: layoutBase, token: null },
    }),
  );
  ({ base } = await listenOnLoopback(edge));
  cookie = await loginCookie(base);
});

after(() => {
  closeServers(edge, daemon, usageReader, layoutReader);
});

test("API route matrix rejects unauthenticated requests before route handlers", async () => {
  for (const route of [
    { label: "machines", path: "/api/machines" },
    { label: "runtime health", path: "/api/machines/maple/runtime/health" },
    { label: "sessions", path: "/api/sessions" },
    { label: "activity events", path: "/api/activity/events" },
    { label: "title summary", method: "POST", path: "/api/title-summary", ...jsonBody({ prompt: "title" }) },
    { label: "layout write", method: "PUT", path: "/api/layout", ...jsonBody({ order: ["maple/s1"] }) },
    { label: "session glance", path: "/api/sessions/maple/s1/glance" },
    { label: "structured prompt", method: "POST", path: "/api/sessions/maple/s1/prompt", ...jsonBody({ text: "hi" }) },
    { label: "fenced structured prompt", method: "POST", path: "/api/sessions/maple/s1/prompt/v2", ...jsonBody({
      text: "hi",
      expected_session_incarnation: "launch-s1",
    }) },
    { label: "auto-resume", path: "/api/sessions/maple/s1/auto-resume" },
    { label: "maintenance preview", path: "/api/sessions/maple/s1/maintenance?operation=resume" },
    { label: "maintenance action", method: "POST", path: "/api/sessions/maple/s1/maintenance/actions", ...jsonBody({}) },
    {
      label: "Codex rate-limit reset",
      method: "POST",
      path: "/api/codex/rate-limit-reset",
      ...jsonBody({ account: "sym", idempotency_key: "123e4567-e89b-42d3-a456-426614174000" }),
    },
    { label: "Codex accounts", path: "/api/machines/maple/codex/accounts" },
    { label: "Codex account switch", method: "PUT", path: "/api/sessions/maple/s1/account", ...jsonBody({ account: "sym" }) },
  ] satisfies RouteCase[]) {
    const res = await request(route);
    assert.equal(res.status, 401, route.label);
  }
});

test("API route matrix returns 405 for known routes with unsupported methods", async () => {
  for (const route of [
    { label: "machines", method: "POST", path: "/api/machines" },
    { label: "title summary", method: "GET", path: "/api/title-summary" },
    { label: "workdirs", method: "POST", path: "/api/machines/maple/workdirs" },
    { label: "repo URL", method: "POST", path: "/api/machines/maple/repo-url?cwd=/repo/agent-console" },
    { label: "sessions", method: "PUT", path: "/api/sessions" },
    { label: "activity events", method: "POST", path: "/api/activity/events" },
    { label: "usage", method: "POST", path: "/api/usage" },
    { label: "Codex rate-limit reset", method: "GET", path: "/api/codex/rate-limit-reset" },
    { label: "layout", method: "POST", path: "/api/layout" },
    { label: "glance", method: "POST", path: "/api/sessions/maple/s1/glance" },
    { label: "buffer", method: "POST", path: "/api/sessions/maple/s1/buffer" },
    { label: "attach ticket", method: "GET", path: "/api/sessions/maple/s1/attach-ticket" },
    { label: "send", method: "GET", path: "/api/sessions/maple/s1/send" },
    { label: "structured prompt", method: "GET", path: "/api/sessions/maple/s1/prompt" },
    { label: "fenced structured prompt", method: "GET", path: "/api/sessions/maple/s1/prompt/v2" },
    { label: "resume", method: "GET", path: "/api/sessions/maple/s1/resume" },
    { label: "maintenance preview", method: "POST", path: "/api/sessions/maple/s1/maintenance" },
    { label: "maintenance action", method: "GET", path: "/api/sessions/maple/s1/maintenance/actions" },
    { label: "auto-resume", method: "POST", path: "/api/sessions/maple/s1/auto-resume" },
    { label: "Codex accounts", method: "POST", path: "/api/machines/maple/codex/accounts" },
    { label: "Codex account switch", method: "GET", path: "/api/sessions/maple/s1/account" },
    { label: "attachments", method: "GET", path: "/api/sessions/maple/s1/attachments" },
    { label: "session item", method: "GET", path: "/api/sessions/maple/s1" },
    { label: "create session", method: "GET", path: "/api/sessions/maple" },
  ] satisfies RouteCase[]) {
    const res = await request(route, authHeaders());
    assert.equal(res.status, 405, route.label);
  }
});

test("API route matrix reports missing or invalid parameters as client errors", async () => {
  const missingCwd = await request({ path: "/api/machines/maple/repo-url" }, authHeaders());
  assert.equal(missingCwd.status, 400);
  assert.equal((await bodyOf(missingCwd)).error.message, "missing cwd query parameter");

  const blankTitlePrompt = await request(
    { method: "POST", path: "/api/title-summary", ...jsonBody({ prompt: "   " }) },
    authHeaders(),
  );
  assert.equal(blankTitlePrompt.status, 422);
  assert.equal((await bodyOf(blankTitlePrompt)).error.message, "prompt is required");

  const malformedLayout = await request({ method: "PUT", path: "/api/layout", ...jsonBody({}) }, authHeaders());
  assert.equal(malformedLayout.status, 422);
  assert.equal((await bodyOf(malformedLayout)).error.message, "layout body must be { order: string[] }");

  const invalidLayoutOrder = await request(
    { method: "PUT", path: "/api/layout", ...jsonBody({ order: [null, 123] }) },
    authHeaders(),
  );
  assert.equal(invalidLayoutOrder.status, 422);
  assert.equal((await bodyOf(invalidLayoutOrder)).error.message, "layout order has no valid session keys");

  const unknownMachine = await request(
    { method: "POST", path: "/api/sessions/ghost", ...jsonBody({ agent: "codex" }) },
    authHeaders(),
  );
  assert.equal(unknownMachine.status, 404);
  assert.equal((await bodyOf(unknownMachine)).error.message, "unknown machine: ghost");

  daemonRequests.length = 0;
  const malformedAutoResume = await request(
    { method: "PUT", path: "/api/sessions/maple/s1/auto-resume", ...jsonBody({ enabled: "yes", continuation: "unsafe" }) },
    authHeaders({ origin: base }),
  );
  assert.equal(malformedAutoResume.status, 422);
  assert.equal((await bodyOf(malformedAutoResume)).error.message, "auto-resume body must be { enabled: boolean }");

  const malformedMaintenance = await request(
    {
      method: "POST",
      path: "/api/sessions/maple/s1/maintenance/actions",
      ...jsonBody({
        operation: "resume",
        action: "terminate_runtime_then_resume",
        expected_session_incarnation: "launch-s1",
        expected_session_generation: 1,
        expected_preview_digest: maintenancePreview.preview_digest,
        confirmed: false,
      }),
    },
    authHeaders({ origin: base }),
  );
  assert.equal(malformedMaintenance.status, 422);
  assert.equal((await bodyOf(malformedMaintenance)).error.message, "maintenance action body is invalid");

  const malformedCodexAccount = await request(
    { method: "PUT", path: "/api/sessions/maple/s1/account", ...jsonBody({ account: "../auth.json", access_token: "secret" }) },
    authHeaders({ origin: base }),
  );
  assert.equal(malformedCodexAccount.status, 422);
  assert.equal((await bodyOf(malformedCodexAccount)).error.message, "account body requires nickname and session incarnation");
  assert.deepEqual(daemonRequests, []);
});

test("API route matrix exercises read-route success paths", async () => {
  daemonRequests.length = 0;

  const machines = await bodyOf(await request({ path: "/api/machines" }, authHeaders()));
  assert.deepEqual(machines.data.machines, [{ name: "maple" }]);

  const health = await bodyOf(await request({ path: "/api/machines/maple/runtime/health" }, authHeaders()));
  assert.deepEqual(health.data, {
    machine: "maple",
    runtime: {
      state: "unavailable",
      binary_version: "1.29.1",
      executable_state: "replaced",
      reasons: ["runtime-executable-replaced"],
    },
  });
  assert.equal(JSON.stringify(health).includes("must-not-cross-edge"), false);

  const sessions = await bodyOf(await request({ path: "/api/sessions?machines=maple" }, authHeaders()));
  assert.deepEqual(sessions.data.sessions, [{
    id: "s1",
    title: "Main session",
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "account-a",
      revision: 2,
      applied_runtime_id: "launch-s1",
    },
    machine: "maple",
  }]);
  assert.deepEqual(sessions.data.machines, [{ name: "maple", ok: true }]);
  assert.deepEqual(sessions.data.capabilities, {
    auto_resume_control: true,
    profile_resume_import: true,
    managed_resume_command: true,
    resume_blocked_reason: true,
    last_prompt: true,
    last_message: true,
    history: true,
    archive: true,
    session_retitle_v2: true,
    session_retitle_v3: true,
  });

  const codexAccounts = await bodyOf(
    await request({ path: "/api/machines/maple/codex/accounts" }, authHeaders()),
  );
  assert.deepEqual(codexAccounts.data.accounts, [{ account: "account-a", label: "Account A", plan: "team" }]);
  assert.deepEqual(codexAccounts.data.readiness, {
    schema_version: "agent-session.codex-account-readiness.v1",
    supported: true,
    provider_version: "0.144.5",
  });

  const workdirs = await bodyOf(
    await request({ path: "/api/machines/maple/workdirs?q=agent&limit=2" }, authHeaders()),
  );
  assert.equal(workdirs.data.workdirs[0].path, "/repo/agent-console");

  const repo = await bodyOf(
    await request({ path: `/api/machines/maple/repo-url?cwd=${encodeURIComponent("/repo/agent-console")}` }, authHeaders()),
  );
  assert.equal(repo.data.url, "https://github.com/example-org/agent-console");

  const usage = await bodyOf(await request({ path: "/api/usage" }, authHeaders()));
  assert.equal(usage.data.providers[0].provider, "codex");

  const layout = await bodyOf(await request({ path: "/api/layout" }, authHeaders()));
  assert.deepEqual(layout.data.order, ["maple/s1"]);
  assert.equal(layout.data.revision, 7);

  const glance = await bodyOf(await request({ path: "/api/sessions/maple/s1/glance?tail=40" }, authHeaders()));
  assert.equal(glance.data.text, "terminal glance");

  const buffer = await bodyOf(await request({ path: "/api/sessions/maple/s1/buffer" }, authHeaders()));
  assert.equal(buffer.data.text, "tmux buffer");

  const autoResume = await bodyOf(await request({ path: "/api/sessions/maple/s1/auto-resume" }, authHeaders()));
  assert.deepEqual(autoResume.data.auto_resume, {
    schema_version: "agent-session.auto-resume.v1",
    supported: true,
    enabled: true,
    state: "scheduled",
    scheduled_at: "2026-07-12T12:34:56Z",
  });

  const maintenance = await bodyOf(await request(
    { path: "/api/sessions/maple/s1/maintenance?operation=resume" },
    authHeaders(),
  ));
  assert.deepEqual(maintenance.data.maintenance, maintenancePreview);
  assert.doesNotMatch(JSON.stringify(maintenance), /private|pane_pid/);

  const unsupportedMaintenance = await request(
    { path: "/api/sessions/maple/old/maintenance?operation=resume" },
    authHeaders(),
  );
  assert.equal(unsupportedMaintenance.status, 501);
  assert.equal((await bodyOf(unsupportedMaintenance)).error.code, "maintenance-unsupported");

  const malformedAutoResume = await request({ path: "/api/sessions/maple/bad/auto-resume" }, authHeaders());
  assert.equal(malformedAutoResume.status, 502);
  assert.equal((await bodyOf(malformedAutoResume)).error.message, "invalid auto-resume daemon response");

  const failedAutoResume = await request({ path: "/api/sessions/maple/error/auto-resume" }, authHeaders());
  assert.equal(failedAutoResume.status, 500);
  assert.deepEqual((await bodyOf(failedAutoResume)).error, { message: "auto-resume daemon request failed" });

  assert.deepEqual(
    daemonRequests.map((r) => [r.method, r.url, r.auth]),
    [
      ["GET", "/healthz", "Bearer machine-secret"],
      ["GET", "/sessions", "Bearer machine-secret"],
      ["GET", "/codex/accounts", "Bearer machine-secret"],
      ["GET", "/workdirs?q=agent&limit=2", "Bearer machine-secret"],
      ["GET", `/repos/remote-url?cwd=${encodeURIComponent("/repo/agent-console")}`, "Bearer machine-secret"],
      ["GET", "/sessions/s1/glance?tail=40", "Bearer machine-secret"],
      ["GET", "/sessions/s1/buffer", "Bearer machine-secret"],
      ["GET", "/sessions/s1/auto-resume", "Bearer machine-secret"],
      ["GET", "/sessions/s1/maintenance?operation=resume", "Bearer machine-secret"],
      ["GET", "/sessions/old/maintenance?operation=resume", "Bearer machine-secret"],
      ["GET", "/sessions/bad/auto-resume", "Bearer machine-secret"],
      ["GET", "/sessions/error/auto-resume", "Bearer machine-secret"],
    ],
  );
});

test("API route matrix rejects every cookie-backed write route from a foreign Origin", async () => {
  daemonRequests.length = 0;
  for (const route of writeRoutes("http://evil.example")) {
    const res = await request(route, authHeaders());
    assert.equal(res.status, 403, route.label);
  }
  assert.deepEqual(daemonRequests, []);
});

test("API route matrix exercises same-origin write-route success paths", async () => {
  daemonRequests.length = 0;
  const sameOriginHeaders = authHeaders({ origin: base });

  const title = await bodyOf(
    await request({ method: "POST", path: "/api/title-summary", ...jsonBody({ prompt: "Route table" }) }, sameOriginHeaders),
  );
  assert.equal(title.data.title, "Route table");

  const layout = await bodyOf(
    await request({ method: "PUT", path: "/api/layout", ...jsonBody({ order: ["maple/s1"] }) }, sameOriginHeaders),
  );
  assert.deepEqual(layout.data.order, ["maple/s1"]);
  assert.equal(layout.data.revision, 7);

  const ticket = await bodyOf(
    await request({ method: "POST", path: "/api/sessions/maple/s1/attach-ticket", ...jsonBody({}) }, sameOriginHeaders),
  );
  assert.match(ticket.data.ticket, /^[A-Za-z0-9_-]{32,}$/);

  const sent = await bodyOf(
    await request({ method: "POST", path: "/api/sessions/maple/s1/send", ...jsonBody({ data: "hi" }) }, sameOriginHeaders),
  );
  assert.equal(sent.data.sent, true);

  const submitted = await bodyOf(
    await request(
      { method: "POST", path: "/api/sessions/maple/s1/prompt", ...jsonBody({ text: "first\nsecond" }) },
      sameOriginHeaders,
    ),
  );
  assert.equal(submitted.data.submitted, true);

  const fencedSubmission = await bodyOf(
    await request(
      {
        method: "POST",
        path: "/api/sessions/maple/s1/prompt/v2",
        ...jsonBody({
          text: "first\nsecond",
          expected_session_incarnation: "launch-s1",
        }),
      },
      sameOriginHeaders,
    ),
  );
  assert.deepEqual(fencedSubmission.data, {
    submitted: true,
    session_incarnation: "launch-s1",
  });

  const resumed = await bodyOf(
    await request({ method: "POST", path: "/api/sessions/maple/s1/resume", ...jsonBody({}) }, sameOriginHeaders),
  );
  assert.equal(resumed.data.session.status, "running");

  const maintenanceAction = await bodyOf(await request(
    {
      method: "POST",
      path: "/api/sessions/maple/s1/maintenance/actions",
      ...jsonBody({
        operation: "resume",
        action: "terminate_runtime_then_resume",
        expected_session_incarnation: "launch-s1",
        expected_session_generation: 1,
        expected_preview_digest: maintenancePreview.preview_digest,
        confirmed: true,
      }),
    },
    sameOriginHeaders,
  ));
  assert.equal(maintenanceAction.data.maintenance_result.status, "running");
  assert.equal("cwd" in maintenanceAction.data.maintenance_result, false);

  const autoResumeEnabled = await bodyOf(
    await request(
      {
        method: "PUT",
        path: "/api/sessions/maple/s1/auto-resume",
        ...jsonBody({ enabled: true, recovery_policy: "next_account_then_resume" }),
      },
      sameOriginHeaders,
    ),
  );
  assert.equal(autoResumeEnabled.data.auto_resume.state, "enabled");
  assert.equal("continuation" in autoResumeEnabled.data.auto_resume, false);

  const autoResumeCancelled = await bodyOf(
    await request({ method: "DELETE", path: "/api/sessions/maple/s1/auto-resume" }, sameOriginHeaders),
  );
  assert.equal(autoResumeCancelled.data.auto_resume.state, "cancelled");
  assert.equal("error_details" in autoResumeCancelled.data.auto_resume, false);

  const codexAccount = await bodyOf(
    await request(
      {
        method: "PUT",
        path: "/api/sessions/maple/s1/account",
        ...jsonBody({ account: "sym", expected_session_incarnation: "launch-s1" }),
      },
      sameOriginHeaders,
    ),
  );
  assert.deepEqual(codexAccount.data.codex_account, {
    schema_version: "agent-session.codex-account.v1",
    supported: true,
    state: "bound",
    selected_account: "sym",
    revision: 3,
    applied_runtime_id: "launch-s1",
  });

  const upload = await bodyOf(
    await request(
      {
        method: "POST",
        path: "/api/sessions/maple/s1/attachments?filename=clip.txt",
        headers: { "content-type": "text/plain" },
        body: "clip bytes",
      },
      sameOriginHeaders,
    ),
  );
  assert.equal(upload.data.attachment.bytes, "clip bytes".length);

  const patched = await bodyOf(
    await request({ method: "PATCH", path: "/api/sessions/maple/s1", ...jsonBody({ title: "Renamed" }) }, sameOriginHeaders),
  );
  assert.equal(patched.data.session.title, "Renamed");

  const deleted = await bodyOf(await request({ method: "DELETE", path: "/api/sessions/maple/s1" }, sameOriginHeaders));
  assert.deepEqual(deleted.data.deleted, {
    id: "s1",
    deleted: true,
    killed: false,
    cleanup_pending: true,
  });
  assert.doesNotMatch(JSON.stringify(deleted), /private|tmux|session_dir|pid/);

  const created = await bodyOf(
    await request({
      method: "POST",
      path: "/api/sessions/maple",
      ...jsonBody({
        agent: "codex",
        title: "Retitle rules #317",
        title_state: {
          topic: "Retitle rules",
          topic_source: "auto",
          references: ["#317"],
          activity: null,
        },
      }),
    }, sameOriginHeaders),
  );
  assert.equal(created.data.session.id, "created");

  assert.deepEqual(
    daemonRequests.map((r) => [r.method, r.url, r.auth]),
    [
      ["POST", "/sessions/s1/send", "Bearer machine-secret"],
      ["POST", "/sessions/s1/prompt", "Bearer machine-secret"],
      ["POST", "/sessions/s1/prompt/v2", "Bearer machine-secret"],
      ["POST", "/sessions/s1/resume", "Bearer machine-secret"],
      ["POST", "/sessions/s1/maintenance/actions", "Bearer machine-secret"],
      ["PUT", "/sessions/s1/auto-resume", "Bearer machine-secret"],
      ["DELETE", "/sessions/s1/auto-resume", "Bearer machine-secret"],
      ["PUT", "/sessions/s1/account", "Bearer machine-secret"],
      ["POST", "/sessions/s1/attachments?filename=clip.txt", "Bearer machine-secret"],
      ["PATCH", "/sessions/s1", "Bearer machine-secret"],
      ["DELETE", "/sessions/s1", "Bearer machine-secret"],
      ["POST", "/sessions", "Bearer machine-secret"],
    ],
  );
  assert.equal(daemonRequests[0]?.contentType, "application/json");
  assert.deepEqual(jsonRequestBody(0), { data: "hi" });
  assert.equal(daemonRequests[1]?.contentType, "application/json");
  assert.deepEqual(jsonRequestBody(1), { text: "first\nsecond" });
  assert.equal(daemonRequests[2]?.contentType, "application/json");
  assert.deepEqual(jsonRequestBody(2), {
    text: "first\nsecond",
    expected_session_incarnation: "launch-s1",
  });
  assert.equal(daemonRequests[3]?.contentType, "application/json");
  assert.deepEqual(jsonRequestBody(3), {});
  assert.deepEqual(jsonRequestBody(4), {
    operation: "resume",
    action: "terminate_runtime_then_resume",
    expected_session_incarnation: "launch-s1",
    expected_session_generation: 1,
    expected_preview_digest: maintenancePreview.preview_digest,
    confirmed: true,
  });
  assert.deepEqual(jsonRequestBody(5), {
    enabled: true,
    recovery_policy: "next_account_then_resume",
  });
  assert.equal(daemonRequests[6]?.body.length, 0);
  assert.deepEqual(jsonRequestBody(7), {
    account: "sym",
    expected_session_incarnation: "launch-s1",
    supports_unbound_account_queue: true,
  });
  assert.equal(daemonRequests[8]?.contentType, "text/plain");
  assert.equal(daemonRequests[8]?.body.toString(), "clip bytes");
  assert.equal(daemonRequests[9]?.contentType, "application/json");
  assert.deepEqual(jsonRequestBody(9), { title: "Renamed" });
  assert.equal(daemonRequests[10]?.body.length, 0);
  assert.equal(daemonRequests[11]?.contentType, "application/json");
  assert.deepEqual(jsonRequestBody(11), {
    agent: "codex",
    lineage: CONSOLE_ROOT_LINEAGE,
    title: "Retitle rules #317",
    title_state: {
      topic: "Retitle rules",
      topic_source: "auto",
      references: ["#317"],
      activity: null,
    },
  });
});

test("fenced prompt route validates requests and projects daemon acknowledgements", async () => {
  daemonRequests.length = 0;
  const sameOriginHeaders = authHeaders({ origin: base });
  const oversizedPrompt = "x".repeat(16 * 1024 + 1);
  const oversizedIncarnation = "i".repeat(129);
  const invalidBodies: readonly unknown[] = [
    undefined,
    null,
    [],
    {},
    { text: "", expected_session_incarnation: "launch-s1" },
    { text: "   ", expected_session_incarnation: "launch-s1" },
    { text: oversizedPrompt, expected_session_incarnation: "launch-s1" },
    { text: "line one\rline two", expected_session_incarnation: "launch-s1" },
    { text: "word\tcompletion", expected_session_incarnation: "launch-s1" },
    { text: `nul${String.fromCharCode(0)}byte`, expected_session_incarnation: "launch-s1" },
    { text: `delete${String.fromCharCode(127)}byte`, expected_session_incarnation: "launch-s1" },
    { text: "hello", expected_session_incarnation: "" },
    { text: "hello", expected_session_incarnation: oversizedIncarnation },
    { text: "hello", expected_session_incarnation: "launch\ns1" },
    { text: "hello", expected_session_incarnation: "launch-s1", access_token: "browser-secret" },
  ];

  for (const body of invalidBodies) {
    const response = await request(
      body === undefined
        ? { method: "POST", path: "/api/sessions/maple/s1/prompt/v2" }
        : {
            method: "POST",
            path: "/api/sessions/maple/s1/prompt/v2",
            ...jsonBody(body),
          },
      sameOriginHeaders,
    );
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await bodyOf(response), {
      ok: false,
      error: { message: "invalid fenced provider prompt request" },
    });
  }
  const malformedJson = await request({
    method: "POST",
    path: "/api/sessions/maple/s1/prompt/v2",
    headers: { "content-type": "application/json" },
    body: "{",
  }, sameOriginHeaders);
  assert.equal(malformedJson.status, 400);
  assert.deepEqual(daemonRequests, []);

  const queued = await request({
    method: "POST",
    path: "/api/sessions/maple/prompt-queued/prompt/v2",
    ...jsonBody({ text: "hello", expected_session_incarnation: "launch-expected" }),
  }, sameOriginHeaders);
  assert.equal(queued.status, 200);
  assert.deepEqual(await bodyOf(queued), {
    ok: true,
    data: { submitted: true, queued: true, session_incarnation: "launch-expected" },
  }, "a prompt queued behind the running turn is a submission");
  const queuedString = await request({
    method: "POST",
    path: "/api/sessions/maple/prompt-queued-string/prompt/v2",
    ...jsonBody({ text: "hello", expected_session_incarnation: "launch-expected" }),
  }, sameOriginHeaders);
  assert.deepEqual(await bodyOf(queuedString), {
    ok: true,
    data: { submitted: true, session_incarnation: "launch-expected" },
  }, "only a boolean queued mark crosses the edge");

  for (const sessionId of ["prompt-missing", "prompt-mismatch"] as const) {
    const response = await request({
      method: "POST",
      path: `/api/sessions/maple/${sessionId}/prompt/v2`,
      ...jsonBody({ text: "hello", expected_session_incarnation: "launch-expected" }),
    }, sameOriginHeaders);
    assert.equal(response.status, 502);
    const responseText = JSON.stringify(await bodyOf(response));
    assert.match(responseText, /invalid provider prompt acknowledgement/);
    assert.doesNotMatch(responseText, /replacement-runtime|access_token|must-not-cross-edge/);
  }

  const failed = await request({
    method: "POST",
    path: "/api/sessions/maple/prompt-error/prompt/v2",
    ...jsonBody({ text: "hello", expected_session_incarnation: "launch-expected" }),
  }, sameOriginHeaders);
  assert.equal(failed.status, 409);
  assert.deepEqual(await bodyOf(failed), {
    ok: false,
    error: { message: "provider prompt submission failed" },
  });
});

test("Codex account create and switch require sanitized matching bound confirmation", async () => {
  const sameOriginHeaders = authHeaders({ origin: base });
  const create = await request({
    method: "POST",
    path: "/api/sessions/maple",
    ...jsonBody({
      agent: "codex",
      title: "Bound session",
      codex_account: "sym",
      access_token: "browser-secret",
      credential_path: "/private/auth.json",
    }),
  }, sameOriginHeaders);
  assert.equal(create.status, 200);
  const createdBody = await bodyOf(create);
  assert.deepEqual(createdBody.data.session.codex_account, {
    schema_version: "agent-session.codex-account.v1",
    supported: true,
    state: "bound",
    selected_account: "sym",
    revision: 1,
    applied_runtime_id: "launch-created",
  });
  assert.equal("access_token" in createdBody.data.session, false);
  assert.equal("credential_path" in createdBody.data.session, false);
  const forwardedCreate = JSON.parse(daemonRequests.at(-1)?.body.toString("utf8") ?? "{}");
  assert.deepEqual(forwardedCreate, { agent: "codex", title: "Bound session", codex_account: "sym", lineage: CONSOLE_ROOT_LINEAGE });

  const pendingCreate = await request({
    method: "POST",
    path: "/api/sessions/maple",
    ...jsonBody({ agent: "codex", codex_account: "pending" }),
  }, sameOriginHeaders);
  assert.equal(pendingCreate.status, 502);

  const failedCreate = await request({
    method: "POST",
    path: "/api/sessions/maple",
    ...jsonBody({ agent: "codex", codex_account: "daemon-error" }),
  }, sameOriginHeaders);
  assert.equal(failedCreate.status, 500);
  assert.doesNotMatch(JSON.stringify(await bodyOf(failedCreate)), /must-not-cross-edge/);

  const unsupportedCreate = await request({
    method: "POST",
    path: "/api/sessions/maple",
    ...jsonBody({ agent: "codex", codex_account: "capability-error" }),
  }, sameOriginHeaders);
  assert.equal(unsupportedCreate.status, 422);
  assert.deepEqual(await bodyOf(unsupportedCreate), {
    ok: false,
    error: {
      code: "codex-app-server-capability-unavailable",
      message: "Installed Codex does not support account selection; update Codex or use the default account",
    },
  });

  const mismatchedSwitch = await request({
    method: "PUT",
    path: "/api/sessions/maple/s1/account",
    ...jsonBody({ account: "mismatch", expected_session_incarnation: "launch-s1" }),
  }, sameOriginHeaders);
  assert.equal(mismatchedSwitch.status, 502);

  const staleIncarnationSwitch = await request({
    method: "PUT",
    path: "/api/sessions/maple/s1/account",
    ...jsonBody({ account: "sym", expected_session_incarnation: "stale-launch" }),
  }, sameOriginHeaders);
  assert.equal(staleIncarnationSwitch.status, 502);

  const busySwitch = await request({
    method: "PUT",
    path: "/api/sessions/maple/s1/account",
    ...jsonBody({ account: "busy", expected_session_incarnation: "launch-s1" }),
  }, sameOriginHeaders);
  assert.equal(busySwitch.status, 409);
  assert.deepEqual(await bodyOf(busySwitch), {
    ok: false,
    error: {
      code: "codex-account-session-busy",
      message: "wait for the current Codex turn to finish before switching accounts",
    },
  });

  const invalidCwdCreate = await request({
    method: "POST",
    path: "/api/sessions/maple",
    ...jsonBody({ agent: "codex", cwd: "/not-a-directory" }),
  }, sameOriginHeaders);
  assert.equal(invalidCwdCreate.status, 422);
  assert.deepEqual(await bodyOf(invalidCwdCreate), {
    ok: false,
    error: {
      code: "cwd-not-directory",
      message: "working directory is not a directory",
    },
  });

  // A delete blocked by a live recorded runtime is retryable and repairable, so
  // the reason must reach the operator instead of collapsing into the generic
  // fallback. Producer-owned host details still stay behind the edge.
  const blockedDelete = await request(
    { method: "DELETE", path: "/api/sessions/maple/termination-blocked" },
    sameOriginHeaders,
  );
  assert.equal(blockedDelete.status, 500);
  const blockedDeleteBody = await bodyOf(blockedDelete);
  assert.deepEqual(blockedDeleteBody, {
    ok: false,
    error: {
      code: "session-termination-failed",
      message: "the recorded session runtime is still live; retry, or resolve the runtime from Maintenance",
    },
  });
  assert.doesNotMatch(JSON.stringify(blockedDeleteBody), /private|tmux|kill-session/);
});

test("Codex account switches serialize per session and release after success or timeout", async () => {
  const sameOriginHeaders = authHeaders({ origin: base });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  slowAccountSwitch = { started: markStarted, wait };

  try {
    const first = request({
      method: "PUT",
      path: "/api/sessions/maple/s1/account",
      ...jsonBody({ account: "slow", expected_session_incarnation: "launch-s1" }),
    }, sameOriginHeaders);
    await started;

    const conflict = await request({
      method: "PUT",
      path: "/api/sessions/maple/s1/account",
      ...jsonBody({ account: "sym", expected_session_incarnation: "launch-s1" }),
    }, sameOriginHeaders);
    assert.equal(conflict.status, 409);
    // The guard runs before the daemon names the provider, so it names neither.
    assert.deepEqual((await bodyOf(conflict)).error, { message: "an account switch is already in progress" });

    const independent = await request({
      method: "PUT",
      path: "/api/sessions/maple/s2/account",
      ...jsonBody({ account: "poies", expected_session_incarnation: "launch-s2" }),
    }, sameOriginHeaders);
    assert.equal(independent.status, 200);
    assert.equal((await bodyOf(independent)).data.codex_account.selected_account, "poies");

    release();
    assert.equal((await first).status, 200);

    const afterSuccess = await request({
      method: "PUT",
      path: "/api/sessions/maple/s1/account",
      ...jsonBody({ account: "sym", expected_session_incarnation: "launch-s1" }),
    }, sameOriginHeaders);
    assert.equal(afterSuccess.status, 200);

    const timedOut = await request({
      method: "PUT",
      path: "/api/sessions/maple/s1/account",
      ...jsonBody({ account: "timeout", expected_session_incarnation: "launch-s1" }),
    }, sameOriginHeaders);
    assert.equal(timedOut.status, 504);

    const afterTimeout = await request({
      method: "PUT",
      path: "/api/sessions/maple/s1/account",
      ...jsonBody({ account: "galaxy", expected_session_incarnation: "launch-s1" }),
    }, sameOriginHeaders);
    assert.equal(afterTimeout.status, 200);
  } finally {
    release();
    slowAccountSwitch = null;
  }
});

test("Codex account route accepts authoritative next outcomes without claiming they are applied", async () => {
  const sameOriginHeaders = authHeaders({ origin: base });
  nextAccountOutcomeIndex = 0;
  try {
    for (const expectedState of ["queued", "applying", "failed", "unknown"] as const) {
      const response = await request({
        method: "PUT",
        path: "/api/sessions/maple/s1/account",
        ...jsonBody({ account: "account-b", expected_session_incarnation: "launch-s1" }),
      }, sameOriginHeaders);
      assert.equal(response.status, 200, expectedState);
      const status = (await bodyOf(response)).data.codex_account;
      assert.equal(status.selected_account, "account-a");
      assert.equal(status.applied_runtime_id, "launch-s1");
      assert.equal(status.next.account, "account-b");
      assert.equal(status.next.state, expectedState);
      assert.equal("access_token" in status.next, false);
      assert.equal("private_binding" in status, false);
    }

    const invalid = await request({
      method: "PUT",
      path: "/api/sessions/maple/s1/account",
      ...jsonBody({ account: "account-b", expected_session_incarnation: "launch-s1" }),
    }, sameOriginHeaders);
    assert.equal(invalid.status, 502);

    const replaced = await request({
      method: "PUT",
      path: "/api/sessions/maple/s1/account",
      ...jsonBody({ account: "account-b", expected_session_incarnation: "launch-replacement" }),
    }, sameOriginHeaders);
    assert.equal(replaced.status, 502);
  } finally {
    nextAccountOutcomeIndex = -1;
  }
});

test("Codex account route accepts an incarnation-fenced unbound next outcome", async () => {
  const sameOriginHeaders = authHeaders({ origin: base });
  const accepted = await request({
    method: "PUT",
    path: "/api/sessions/maple/s1/account",
    ...jsonBody({ account: "unbound-next", expected_session_incarnation: "launch-s1" }),
  }, sameOriginHeaders);
  assert.equal(accepted.status, 200);
  const body = await bodyOf(accepted);
  assert.equal(body.data.codex_account.state, "unbound");
  assert.equal(body.data.codex_account.next.account, "unbound-next");
  assert.equal(body.data.codex_account.next.state, "queued");
  // Both providers' switch answers name the runtime they were fenced against.
  assert.equal(body.data.session_incarnation, "launch-s1");
  assert.equal("access_token" in body.data.codex_account.next, false);
  assert.equal("private_binding" in body.data.codex_account, false);

  for (const account of [
    "unbound-next-stale",
    "unbound-next-missing",
    "unbound-next-applying",
    "unbound-next-failed",
    "unbound-next-future",
  ]) {
    const rejected = await request({
      method: "PUT",
      path: "/api/sessions/maple/s1/account",
      ...jsonBody({ account, expected_session_incarnation: "launch-s1" }),
    }, sameOriginHeaders);
    assert.equal(rejected.status, 502, account);
  }
});

test("Claude accounts route is authenticated and forwards a nickname-only inventory", async () => {
  daemonRequests.length = 0;
  const anonymous = await request({ path: "/api/machines/maple/claude/accounts" });
  assert.equal(anonymous.status, 401);
  const wrongMethod = await request({ method: "POST", path: "/api/machines/maple/claude/accounts" }, authHeaders());
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(daemonRequests, []);

  const accounts = await bodyOf(await request({ path: "/api/machines/maple/claude/accounts" }, authHeaders()));
  assert.deepEqual(accounts, {
    ok: true,
    data: {
      accounts: [{ account: "alpha", label: "Alpha", plan: "max" }, { account: "beta" }],
      selection_strategies: ["current_default"],
    },
  });
  assert.deepEqual(daemonRequests.map((entry) => [entry.method, entry.url, entry.auth]), [
    ["GET", "/claude/accounts", "Bearer machine-secret"],
  ]);
});

test("account routes serve only account providers", async () => {
  daemonRequests.length = 0;
  for (const path of ["/api/machines/maple/dsh/accounts", "/api/dsh/default-account", "/api/layout/default-account"]) {
    const response = await request({ path }, authHeaders());
    assert.equal(response.status, 404, path);
  }
  assert.deepEqual(daemonRequests, []);
});

test("Claude create forwards claude_account only for Claude and requires a bound confirmation", async () => {
  const sameOriginHeaders = authHeaders({ origin: base });
  daemonRequests.length = 0;
  for (const body of [
    { agent: "codex", claude_account: "alpha" },
    { agent: "dsh", claude_account: "alpha" },
    { agent: "claude", claude_account: "../escape" },
    { agent: "claude", claude_account: 7 },
    { agent: "claude", claude_account: "-x" },
    { agent: "claude", claude_account: ".hidden" },
    { agent: "codex", codex_account: "--format" },
  ]) {
    const rejected = await request({ method: "POST", path: "/api/sessions/maple", ...jsonBody(body) }, sameOriginHeaders);
    assert.equal(rejected.status, 422, JSON.stringify(body));
  }
  assert.deepEqual(daemonRequests, []);

  const created = await request({
    method: "POST",
    path: "/api/sessions/maple",
    ...jsonBody({ agent: "claude", title: "Bound Claude", claude_account: "alpha", config_dir: "/browser" }),
  }, sameOriginHeaders);
  assert.equal(created.status, 200);
  const createdBody = await bodyOf(created);
  assert.deepEqual(createdBody.data.session.claude_account, {
    schema_version: "agent-session.claude-account.v1",
    supported: true,
    state: "bound",
    selected_account: "alpha",
    selection_source: "explicit",
    revision: 1,
    applied_runtime_id: "launch-created",
  });
  assert.doesNotMatch(JSON.stringify(createdBody), /private/);
  assert.deepEqual(
    JSON.parse(daemonRequests.at(-1)?.body.toString("utf8") ?? "{}"),
    { agent: "claude", title: "Bound Claude", claude_account: "alpha", lineage: CONSOLE_ROOT_LINEAGE },
  );

  const unconfirmed = await request({
    method: "POST",
    path: "/api/sessions/maple",
    ...jsonBody({ agent: "claude", claude_account: "host" }),
  }, sameOriginHeaders);
  assert.equal(unconfirmed.status, 502);
  assert.equal((await bodyOf(unconfirmed)).error.code, "claude-account-unsupported-daemon");

  // Like Codex, the binding must be applied to the runtime this create started.
  const staleRuntime = await request({
    method: "POST",
    path: "/api/sessions/maple",
    ...jsonBody({ agent: "claude", claude_account: "stale-runtime" }),
  }, sameOriginHeaders);
  assert.equal(staleRuntime.status, 502);
  assert.equal((await bodyOf(staleRuntime)).error.code, "claude-account-unsupported-daemon");

  const unsupported = await request({
    method: "POST",
    path: "/api/sessions/maple",
    ...jsonBody({ agent: "claude", claude_account: "unsupported" }),
  }, sameOriginHeaders);
  assert.equal(unsupported.status, 400);
  assert.deepEqual(await bodyOf(unsupported), {
    ok: false,
    error: {
      code: "claude-account-unsupported",
      message: "Claude account selection is unavailable on this machine",
    },
  });
});

test("Claude account switch confirms queued and applied outcomes and maps Claude errors", async () => {
  const sameOriginHeaders = authHeaders({ origin: base });
  const put = (account: string) => request({
    method: "PUT",
    path: "/api/sessions/maple/claude-1/account",
    ...jsonBody({ account, expected_session_incarnation: "launch-claude-1" }),
  }, sameOriginHeaders);

  const queued = await put("beta");
  assert.equal(queued.status, 200);
  const queuedBody = await bodyOf(queued);
  assert.deepEqual(queuedBody.data, {
    session_incarnation: "launch-claude-1",
    claude_account: {
      schema_version: "agent-session.claude-account.v1",
      supported: true,
      state: "bound",
      selected_account: "alpha",
      selection_source: "explicit",
      revision: 1,
      applied_runtime_id: "launch-claude-1",
      next: { account: "beta", revision: 2, state: "queued" },
    },
  });

  const applied = await put("gamma");
  assert.equal(applied.status, 200);
  const appliedBody = await bodyOf(applied);
  assert.equal(appliedBody.data.session_incarnation, "launch-claude-2");
  assert.equal(appliedBody.data.claude_account.selected_account, "gamma");
  assert.equal(appliedBody.data.claude_account.applied_runtime_id, "launch-claude-2");
  assert.doesNotMatch(JSON.stringify([queuedBody, appliedBody]), /private/);

  const mismatch = await put("mismatch");
  assert.equal(mismatch.status, 502);

  const unknown = await put("unknown-nick");
  assert.equal(unknown.status, 400);
  assert.deepEqual(await bodyOf(unknown), {
    ok: false,
    error: { code: "claude-account-unknown", message: "Claude account is not configured on this machine" },
  });

  const refused = await put("refused");
  assert.equal(refused.status, 422);
  const refusedBody = await bodyOf(refused);
  assert.deepEqual(refusedBody, {
    ok: false,
    error: {
      code: "claude-account-switch-refused",
      message: "the new Claude account could not be prepared; the running session was left unchanged",
    },
  });
});

test("maintenance inspection serializes behind Resume and Delete for the same session", async () => {
  const sameOriginHeaders = authHeaders({ origin: base });
  for (const route of [
    { method: "POST", path: "/api/sessions/maple/serialize/resume", ...jsonBody({}) },
    { method: "DELETE", path: "/api/sessions/maple/serialize" },
  ] satisfies RouteCase[]) {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    slowSessionMutation = { started: markStarted, wait };
    daemonRequests.length = 0;
    try {
      const mutation = request(route, sameOriginHeaders);
      await started;
      const preview = request(
        { path: "/api/sessions/maple/serialize/maintenance?operation=resume" },
        authHeaders(),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        daemonRequests.some((entry) => entry.url.includes("/maintenance?")),
        false,
        `${route.method} must retain mutation ordering before maintenance inspection`,
      );
      release();
      assert.equal((await mutation).status, 200);
      assert.equal((await preview).status, 200);
      assert.equal(daemonRequests.at(-1)?.url, "/sessions/serialize/maintenance?operation=resume");
    } finally {
      release();
      slowSessionMutation = null;
    }
  }
});

test("maintenance proxy preserves typed missing sessions and rejects uncorrelated success envelopes", async () => {
  const missing = await request(
    { path: "/api/sessions/maple/missing/maintenance?operation=resume" },
    authHeaders(),
  );
  assert.equal(missing.status, 404);
  assert.equal((await bodyOf(missing)).error.code, "session-not-found");

  const wrongPreview = await request(
    { path: "/api/sessions/maple/wrong-preview/maintenance?operation=resume" },
    authHeaders(),
  );
  assert.equal(wrongPreview.status, 502);
  assert.equal((await bodyOf(wrongPreview)).error.code, "invalid-maintenance-response");

  const wrongResult = await request({
    method: "POST",
    path: "/api/sessions/maple/wrong-result/maintenance/actions",
    ...jsonBody({
      operation: "resume",
      action: "retry_resume",
      expected_session_incarnation: "launch-s1",
      expected_session_generation: 1,
      expected_preview_digest: maintenancePreview.preview_digest,
    }),
  }, authHeaders({ origin: base }));
  assert.equal(wrongResult.status, 502);
  assert.equal((await bodyOf(wrongResult)).error.code, "invalid-maintenance-response");

  const wrongError = await request(
    { path: "/api/sessions/maple/wrong-error/maintenance?operation=resume" },
    authHeaders(),
  );
  assert.equal(wrongError.status, 409);
  const wrongErrorBody = await bodyOf(wrongError);
  assert.equal(wrongErrorBody.error.code, "session-maintenance-failed");
  assert.equal("details" in wrongErrorBody.error, false);
});

test("maintenance preview negotiates the successor contract and degrades for a v1-only daemon", async () => {
  const negotiated = await request(
    {
      path: "/api/sessions/maple/record-only/maintenance"
        + "?operation=delete&schema_version=agent-session.session-maintenance.v2",
    },
    authHeaders(),
  );
  assert.equal(negotiated.status, 200);
  const preview = (await bodyOf(negotiated)).data.maintenance;
  assert.equal(preview.schema_version, "agent-session.session-maintenance.v2");
  assert.deepEqual(preview.actions.at(-1), recordOnlyDeletePreview.actions[1]);
  assert.doesNotMatch(JSON.stringify(preview), /private/);

  // The v1 daemon rejects the field; the client must still get a usable preview
  // instead of losing the recovery drawer entirely.
  const degraded = await request(
    {
      path: "/api/sessions/maple/legacy-daemon/maintenance"
        + "?operation=delete&schema_version=agent-session.session-maintenance.v2",
    },
    authHeaders(),
  );
  assert.equal(degraded.status, 200);
  const degradedPreview = (await bodyOf(degraded)).data.maintenance;
  assert.equal(degradedPreview.schema_version, "agent-session.session-maintenance.v1");
  assert.equal(
    degradedPreview.actions.some((action: { id: string }) => action.id === "remove_console_record"),
    false,
  );

  const unknownContract = await request(
    {
      path: "/api/sessions/maple/record-only/maintenance"
        + "?operation=delete&schema_version=agent-session.session-maintenance.v3",
    },
    authHeaders(),
  );
  assert.equal(unknownContract.status, 422);
});

test("record-only removal reports removal and never falls back to a v1 action", async () => {
  const removed = await request({
    method: "POST",
    path: "/api/sessions/maple/record-only/maintenance/actions",
    ...jsonBody({
      schema_version: "agent-session.session-maintenance.v2",
      operation: "delete",
      action: "remove_console_record",
      expected_session_incarnation: "launch-record-only",
      expected_session_generation: 1,
      expected_preview_digest: recordOnlyDeletePreview.preview_digest,
      confirmed: true,
    }),
  }, authHeaders({ origin: base }));
  assert.equal(removed.status, 200);
  const result = (await bodyOf(removed)).data.maintenance_result;
  assert.equal(result.outcome, "record_removed");
  assert.equal(result.status, "record_removed");
  assert.equal(result.cleanup_pending, true);

  // Replaying this action under v1 would silently mean something else, so the
  // edge must report it unavailable rather than degrade it.
  const unavailable = await request({
    method: "POST",
    path: "/api/sessions/maple/legacy-daemon/maintenance/actions",
    ...jsonBody({
      schema_version: "agent-session.session-maintenance.v2",
      operation: "delete",
      action: "remove_console_record",
      expected_session_incarnation: "launch-legacy",
      expected_session_generation: 1,
      expected_preview_digest: legacyDeletePreview.preview_digest,
      confirmed: true,
    }),
  }, authHeaders({ origin: base }));
  assert.equal(unavailable.status, 501);
  assert.equal((await bodyOf(unavailable)).error.code, "maintenance-unsupported");

  // A v1-safe action may be replayed, because the rejection proves nothing ran.
  const replayed = await request({
    method: "POST",
    path: "/api/sessions/maple/legacy-daemon/maintenance/actions",
    ...jsonBody({
      schema_version: "agent-session.session-maintenance.v2",
      operation: "delete",
      action: "retry_delete",
      expected_session_incarnation: "launch-legacy",
      expected_session_generation: 1,
      expected_preview_digest: legacyDeletePreview.preview_digest,
      confirmed: true,
    }),
  }, authHeaders({ origin: base }));
  assert.equal(replayed.status, 200);
  const replayedResult = (await bodyOf(replayed)).data.maintenance_result;
  assert.equal(replayedResult.schema_version, "agent-session.session-maintenance.v1");
  assert.equal(replayedResult.outcome, "deleted");
});

test("concurrent maintenance previews coalesce behind one bounded upstream request", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  slowMaintenancePreview = { started: markStarted, wait };
  daemonRequests.length = 0;
  try {
    const first = request(
      { path: "/api/sessions/maple/coalesce/maintenance?operation=resume" },
      authHeaders(),
    );
    await started;
    const second = request(
      { path: "/api/sessions/maple/coalesce/maintenance?operation=resume" },
      authHeaders(),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      daemonRequests.filter((entry) => entry.url === "/sessions/coalesce/maintenance?operation=resume").length,
      1,
    );
    release();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    assert.equal(
      daemonRequests.filter((entry) => entry.url === "/sessions/coalesce/maintenance?operation=resume").length,
      1,
    );
  } finally {
    release();
    slowMaintenancePreview = null;
  }
});

test("maintenance previews do not coalesce across an intervening mutation", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  slowMaintenancePreview = { started: markStarted, wait };
  daemonRequests.length = 0;
  try {
    const firstPreview = request(
      { path: "/api/sessions/maple/coalesce/maintenance?operation=resume" },
      authHeaders(),
    );
    await started;
    const mutation = request({
      method: "POST",
      path: "/api/sessions/maple/coalesce/resume",
      ...jsonBody({}),
    }, authHeaders({ origin: base }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondPreview = request(
      { path: "/api/sessions/maple/coalesce/maintenance?operation=resume" },
      authHeaders(),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      daemonRequests
        .filter((entry) => entry.url?.includes("/sessions/coalesce"))
        .map((entry) => `${entry.method} ${entry.url}`),
      ["GET /sessions/coalesce/maintenance?operation=resume"],
    );

    release();
    assert.equal((await firstPreview).status, 200);
    assert.equal((await mutation).status, 200);
    assert.equal((await secondPreview).status, 200);
    assert.deepEqual(
      daemonRequests
        .filter((entry) => entry.url?.includes("/sessions/coalesce"))
        .map((entry) => `${entry.method} ${entry.url}`),
      [
        "GET /sessions/coalesce/maintenance?operation=resume",
        "POST /sessions/coalesce/resume",
        "GET /sessions/coalesce/maintenance?operation=resume",
      ],
    );
  } finally {
    release();
    slowMaintenancePreview = null;
  }
});

test("maintenance mutation transport loss returns an indeterminate result with reconciled safe facts", async () => {
  const response = await request(
    {
      method: "POST",
      path: "/api/sessions/maple/unknown/maintenance/actions",
      ...jsonBody({
        operation: "resume",
        action: "terminate_runtime_then_resume",
        expected_session_incarnation: "launch-s1",
        expected_session_generation: 1,
        expected_preview_digest: maintenancePreview.preview_digest,
        confirmed: true,
      }),
    },
    authHeaders({ origin: base }),
  );
  assert.equal(response.status, 504);
  const body = await bodyOf(response);
  assert.equal(body.error.code, "maintenance-outcome-unknown");
  assert.equal(body.data.maintenance.session_id, "unknown");
  assert.equal("cwd" in body.data.maintenance, false);
});

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie, ...extra };
}

function jsonBody(value: unknown): Pick<RouteCase, "headers" | "body"> {
  return {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}

function writeRoutes(origin: string): RouteCase[] {
  return [
    { label: "title summary", method: "POST", path: "/api/title-summary", ...jsonBody({ prompt: "Title" }) },
    { label: "layout", method: "PUT", path: "/api/layout", ...jsonBody({ order: ["maple/s1"] }) },
    { label: "attach ticket", method: "POST", path: "/api/sessions/maple/s1/attach-ticket", ...jsonBody({}) },
    { label: "send", method: "POST", path: "/api/sessions/maple/s1/send", ...jsonBody({ data: "hi" }) },
    { label: "structured prompt", method: "POST", path: "/api/sessions/maple/s1/prompt", ...jsonBody({ text: "first\nsecond" }) },
    {
      label: "fenced structured prompt",
      method: "POST",
      path: "/api/sessions/maple/s1/prompt/v2",
      ...jsonBody({ text: "first\nsecond", expected_session_incarnation: "launch-s1" }),
    },
    { label: "resume", method: "POST", path: "/api/sessions/maple/s1/resume", ...jsonBody({}) },
    {
      label: "maintenance action",
      method: "POST",
      path: "/api/sessions/maple/s1/maintenance/actions",
      ...jsonBody({
        operation: "resume",
        action: "retry_resume",
        expected_session_incarnation: "launch-s1",
        expected_session_generation: 1,
        expected_preview_digest: maintenancePreview.preview_digest,
      }),
    },
    { label: "auto-resume enable", method: "PUT", path: "/api/sessions/maple/s1/auto-resume", ...jsonBody({ enabled: true }) },
    { label: "auto-resume cancel", method: "DELETE", path: "/api/sessions/maple/s1/auto-resume" },
    {
      label: "Codex rate-limit reset",
      method: "POST",
      path: "/api/codex/rate-limit-reset",
      ...jsonBody({ account: "sym", idempotency_key: "123e4567-e89b-42d3-a456-426614174000" }),
    },
    {
      label: "Codex account switch",
      method: "PUT",
      path: "/api/sessions/maple/s1/account",
      ...jsonBody({ account: "sym", expected_session_incarnation: "launch-s1" }),
    },
    {
      label: "attachments",
      method: "POST",
      path: "/api/sessions/maple/s1/attachments?filename=clip.txt",
      headers: { "content-type": "text/plain" },
      body: "clip bytes",
    },
    { label: "session patch", method: "PATCH", path: "/api/sessions/maple/s1", ...jsonBody({ title: "Renamed" }) },
    { label: "session delete", method: "DELETE", path: "/api/sessions/maple/s1" },
    { label: "create session", method: "POST", path: "/api/sessions/maple", ...jsonBody({ agent: "codex" }) },
  ].map((route) => ({
    ...route,
    headers: { ...route.headers, origin },
  }));
}

async function request(route: RouteCase, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${route.path}`, {
    method: route.method ?? "GET",
    headers: { ...headers, ...route.headers },
    body: route.body,
  });
}

async function bodyOf(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

function jsonRequestBody(index: number): unknown {
  return JSON.parse(daemonRequests[index]?.body.toString("utf8") ?? "");
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks);
}


test("retired group routes return 404 without forwarding reads or mutations", async () => {
  for (const route of ["group-cleanup", "group-archive"]) {
    for (const method of ["GET", "POST"]) {
      const before = daemonRequests.length;
      const response = await request({ method, path: `/api/sessions/maple/s1/orchestration/${route}`, headers: { origin: base } }, authHeaders());
      assert.equal(response.status, 404);
      assert.equal(daemonRequests.length, before);
    }
  }
});

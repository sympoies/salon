import type {
  DebugAgentBundle,
  DebugClientInfo,
  DebugClientSurface,
  DebugDiagnosticResult,
  DebugEvent,
  SessionStartupFailureDiagnostic,
} from "@agent-console/shared/api";
import type { SessionRetitleV3Receipts } from "@agent-console/shared/session-retitle";
import { isMacTauri, isTauri, loadServerUrl } from "./runtime.ts";
import { debugLifecycleSuffix } from "./debugLog.ts";

declare const __AGENT_CONSOLE_APP_VERSION__: string | undefined;
declare const __AGENT_CONSOLE_BUILD_SHA__: string | undefined;

export interface DebugAgentBundleInput {
  readonly now?: string;
  readonly app?: DebugClientInfo;
  readonly diagnostics?: DebugDiagnosticResult | null;
  readonly clientEvents: readonly DebugEvent[];
  readonly edgeEvents: readonly DebugEvent[];
  readonly sessionStartupFailure?: SessionStartupFailureDiagnostic;
  readonly filter?: string;
  readonly retitleReceipts?: SessionRetitleV3Receipts;
}

export function createDebugAgentBundle(input: DebugAgentBundleInput): DebugAgentBundle {
  return {
    kind: "agent-console.debug_bundle.v1",
    generated_at: input.now ?? new Date().toISOString(),
    app: input.app ?? debugClientInfo(),
    diagnostics: input.diagnostics ?? null,
    ...(input.sessionStartupFailure ? { session_startup_failure: input.sessionStartupFailure } : {}),
    ...(input.filter ? { filter: input.filter } : {}),
    ...(input.retitleReceipts ? { retitle_receipts: input.retitleReceipts } : {}),
    client_events: input.clientEvents,
    edge_events: input.edgeEvents,
  };
}

/** Startup copy is deliberately metadata-only; unrelated debug-ring events can
 * carry generic upstream error text that is not safe to export here. */
export function createStartupFailureDebugBundle(
  sessionStartupFailure: SessionStartupFailureDiagnostic,
): DebugAgentBundle {
  return createDebugAgentBundle({
    clientEvents: [],
    edgeEvents: [],
    diagnostics: null,
    sessionStartupFailure,
  });
}

export function debugAgentBundleMarkdown(bundle: DebugAgentBundle): string {
  const lines = [
    "# Agent Console Debug Bundle",
    "",
    `Generated: ${bundle.generated_at}`,
    `Version: ${bundle.app.version}`,
    `Build: ${bundle.app.build_sha ?? "unknown"}`,
    `Surface: ${bundle.app.surface}`,
    `URL: ${bundle.app.url ?? "unknown"}`,
    bundle.app.server_url ? `Server: ${bundle.app.server_url}` : null,
    bundle.filter ? `Filter: ${bundle.filter}` : null,
    "",
    "## Diagnostics",
  ].filter((line): line is string => line !== null);

  if (bundle.diagnostics) {
    lines.push(`Overall: ${bundle.diagnostics.ok ? "pass" : "fail"}`);
    for (const probe of bundle.diagnostics.probes) {
      const status = probe.status === null ? "-" : String(probe.status);
      const duration = probe.duration_ms === null ? "-" : `${probe.duration_ms}ms`;
      const request = probe.request_id ? ` request=${probe.request_id}` : "";
      const error = probe.error ? ` error=${probe.error}` : "";
      lines.push(`- ${probe.name}: ${probe.ok ? "pass" : "fail"} ${probe.route} status=${status} duration=${duration}${request}${error}`);
    }
  } else {
    lines.push("Not run");
  }

  if (bundle.session_startup_failure) {
    const failure = bundle.session_startup_failure;
    lines.push(
      "",
      "## Startup Failure",
      `Machine: ${failure.machine}`,
      `Session: ${failure.session_id}`,
      `Code: ${failure.startup.failure_code}`,
      `Stage: ${failure.startup.stage}`,
      `Started: ${failure.startup.started_at}`,
      `Failed: ${failure.startup.occurred_at}`,
      `Retry safe: ${failure.startup.retry_safe ? "yes" : "no"}`,
      `Message: ${failure.startup.message}`,
    );
  }

  if (bundle.retitle_receipts) {
    lines.push("", "## Retitle Receipts", ...retitleReceiptLines(bundle.retitle_receipts));
  }

  lines.push("", "## Client Events", ...debugEventLines(bundle.client_events), "", "## Edge Events", ...debugEventLines(bundle.edge_events));
  return lines.join("\n");
}

function retitleReceiptLines(receipts: SessionRetitleV3Receipts): string[] {
  if (receipts.receipts.length === 0) return ["None"];
  return receipts.receipts.map((receipt) => {
    const outcome = receipt.outcome ?? receipt.state;
    const result = receipt.result_fence
      ? ` result=${receipt.result_fence.title_revision}/${receipt.result_fence.memory_revision}`
      : "";
    const failure = receipt.failure_class ? ` failure_class=${receipt.failure_class}` : "";
    const stage = receipt.failure_stage ? ` failure_stage=${receipt.failure_stage}` : "";
    const attempts = receipt.provider_attempts
      .map((attempt) => ` attempt=${attempt.provider_kind}:${attempt.outcome}`)
      .join("");
    return `- ${receipt.started_at} ${receipt.trigger} ${outcome} duration=${receipt.duration_bucket}`
      + ` admitted=${receipt.admission_fence.title_revision}/${receipt.admission_fence.memory_revision}`
      + `${result} current=${receipt.result_is_current}${failure}${stage}${attempts}`;
  });
}

function debugEventLines(events: readonly DebugEvent[]): string[] {
  if (events.length === 0) return ["None"];
  return events.map((event) => {
    const status = event.status === null ? "-" : String(event.status);
    const ok = event.ok === null ? "-" : event.ok ? "ok" : "fail";
    const duration = event.duration_ms === null ? "-" : `${event.duration_ms}ms`;
    const request = event.request_id ? ` request=${event.request_id}` : "";
    const machine = event.machine ? ` machine=${event.machine}` : "";
    const session = event.session_id ? ` session=${event.session_id}` : "";
    const error = event.error ? ` error=${event.error}` : "";
    const lifecycle = debugLifecycleSuffix(event);
    return `- ${event.at} ${event.source} ${event.method ?? "-"} ${event.route} status=${status} ${ok} duration=${duration}${request}${machine}${session}${lifecycle}${error}`;
  });
}

function debugClientInfo(): DebugClientInfo {
  return {
    version: typeof __AGENT_CONSOLE_APP_VERSION__ === "string" ? __AGENT_CONSOLE_APP_VERSION__ : "0.1.0",
    build_sha: typeof __AGENT_CONSOLE_BUILD_SHA__ === "string" && __AGENT_CONSOLE_BUILD_SHA__ !== ""
      ? __AGENT_CONSOLE_BUILD_SHA__
      : null,
    surface: clientSurface(),
    url: currentUrl(),
    server_url: serverUrl(),
    user_agent: typeof navigator === "undefined" ? null : navigator.userAgent.slice(0, 240),
  };
}

function clientSurface(): DebugClientSurface {
  if (!isTauri()) return "web";
  if (isMacTauri()) return "macos";
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent.toLowerCase();
  if (userAgent.includes("android")) return "android";
  return "tauri";
}

function currentUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function serverUrl(): string | null {
  const url = loadServerUrl();
  return url === "" ? null : url;
}

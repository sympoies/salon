import type {
  SessionStartupFailureDiagnostic,
  StartupCleanupState,
  StartupCleanupStatus,
  StartupFailureCode,
  StartupStage,
} from "@agent-console/shared/api";
import type { Session } from "./types.ts";

const STAGE_LABELS: Readonly<Record<StartupStage, string>> = {
  record: "Session record",
  tmux: "Terminal runtime",
  runtime: "Agent runtime",
  app_server: "Agent control server",
  proxy: "Runtime connection",
  provider_client: "Agent client",
  initial_connection: "Initial connection",
};

const FAILURE_ACTIONS: Readonly<Record<StartupFailureCode, string>> = {
  "runtime-helper-unavailable": "Update or restart the session runtime, then retry.",
  "agent-binary-unavailable": "Check that the selected agent is installed and configured.",
  "working-directory-unavailable": "Restore the working directory or create a new session elsewhere.",
  "terminal-runtime-create-failed": "Retry the session.",
  "app-server-start-failed": "Retry the session.",
  "proxy-start-failed": "Retry the session.",
  "provider-client-exited": "Retry the session.",
  "provider-configuration-rejected": "Configure or sign in to the agent on this machine.",
  "startup-timeout": "Inspect the machine before trying again.",
  "startup-exited": "Retry the session.",
};

/**
 * Allowlisted copy for the secondary cleanup state. The primary startup failure
 * message stays as it is; this only adds what the producer could not finish.
 */
const CLEANUP_CAVEATS: Readonly<Record<StartupCleanupState, string>> = {
  pending: "Cleanup after the failed launch has not finished. An unverified process may still be"
    + " running, so the session record was kept.",
  blocked: "Cleanup after the failed launch could not complete. An unverified process may still be"
    + " running, so the session record was kept; recover it from session maintenance.",
};

const DIAGNOSTIC_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function startupStageLabel(stage: StartupStage): string {
  return STAGE_LABELS[stage];
}

export function startupFailureAction(code: StartupFailureCode): string {
  return FAILURE_ACTIONS[code];
}

export function startupCleanupCaveat(cleanup: StartupCleanupStatus | undefined): string | null {
  return cleanup ? CLEANUP_CAVEATS[cleanup.state] : null;
}

export function startupFailureDiagnostic(session: Session): SessionStartupFailureDiagnostic | null {
  if (session.startup?.state !== "failed") return null;
  return {
    machine: DIAGNOSTIC_IDENTIFIER.test(session.machine) ? session.machine : "unknown",
    session_id: DIAGNOSTIC_IDENTIFIER.test(session.id) ? session.id : "unknown",
    startup: session.startup,
  };
}

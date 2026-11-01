export type StatusNoticeKind = "unreachable" | "restored" | "attention" | "host-offline" | "info" | "transient";

/** A host-offline toast clears itself after this delay even while the host stays down. */
export const HOST_OFFLINE_DISMISS_MS = 8_000;
/** The same host is toasted at most once per window while it stays down. */
export const HOST_OFFLINE_REPEAT_MS = 120_000;
/** Host failures during the first load or this grace period are not toasted. */
export const STARTUP_GRACE_MS = 5_000;

export interface StatusNotice {
  readonly kind: StatusNoticeKind;
  readonly message: string;
  /** Colour of a transient notice; failures use the attention kind instead. */
  readonly tone?: "ok" | "neutral";
}

/** A short-lived result (session refresh, retitle, shortcut hint) shown in the shared notice layer. */
export function transientStatusNotice(message: string, tone: "ok" | "neutral" = "neutral"): StatusNotice {
  return { kind: "transient", message, tone };
}

export type RetitleFeedbackState = "working" | "updated" | "failed" | "updating" | "committed" | "unchanged" | "degraded_cached" | "terminal_failure";

/** The manual-retitle progress and result as a shared-layer notice; the failure reason is appended when known. */
export function retitleStatusNotice(state: RetitleFeedbackState, detail?: string): StatusNotice {
  switch (state) {
    case "working":
    case "updating": return transientStatusNotice("Retitling…");
    case "updated":
    case "committed": return transientStatusNotice("Title updated", "ok");
    case "unchanged": return transientStatusNotice("No change");
    case "degraded_cached": return transientStatusNotice("Cached title kept");
    default: return attentionStatusNotice(detail ? `Retitle failed: ${detail}` : "Retitle failed");
  }
}

export function unreachableStatusNotice(message: string): StatusNotice {
  return { kind: "unreachable", message };
}

export function restoredStatusNotice(): StatusNotice {
  return { kind: "restored", message: "Console server connection restored" };
}

export function attentionStatusNotice(message: string): StatusNotice {
  return { kind: "attention", message };
}

export function hostOfflineNotice(message: string): StatusNotice {
  return { kind: "host-offline", message };
}

/**
 * Host failures are "<machine>: <reason>" segments joined by "; ", where every machine is a known name.
 * The console-server prefix is checked first. Returns the hosts, or null when the message is not one.
 */
export function hostFailureHosts(message: string, knownMachines: readonly string[]): string[] | null {
  if (message.startsWith("Console server") || knownMachines.length === 0) return null;
  const hosts: string[] = [];
  for (const segment of message.split("; ")) {
    const match = /^([^:;]+): (.+)$/.exec(segment);
    const host = match?.[1]?.trim();
    if (!host || !knownMachines.includes(host)) return null;
    hosts.push(host);
  }
  return hosts.length > 0 ? hosts : null;
}

export function statusNoticeAutoDismissDelay(notice: StatusNotice | null): number | null {
  if (notice?.kind === "host-offline") return HOST_OFFLINE_DISMISS_MS;
  return notice?.kind === "restored" ? 3_000 : null;
}

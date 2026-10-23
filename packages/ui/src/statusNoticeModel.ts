export type StatusNoticeKind = "unreachable" | "restored" | "attention" | "host-offline";

/** A host-offline toast clears itself after this delay even while the host stays down. */
export const HOST_OFFLINE_DISMISS_MS = 8_000;
/** The same host is toasted at most once per window while it stays down. */
export const HOST_OFFLINE_REPEAT_MS = 120_000;
/** Host failures during the first load or this grace period are not toasted. */
export const STARTUP_GRACE_MS = 5_000;

export interface StatusNotice {
  readonly kind: StatusNoticeKind;
  readonly message: string;
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

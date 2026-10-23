// Pure presentation helpers for the dashboard. DOM-free so they run under
// `node --test`.

import { shellQuoteForTerminalArg } from "./shellQuote.ts";
import type { ProviderResume } from "./types.ts";

export interface SessionLike {
  readonly id: string;
  readonly agent?: string;
  readonly agent_profile?: string;
  readonly managed_resume_command_available?: boolean;
  readonly resume_blocked_reason?: string;
  readonly title?: string | null;
  readonly cwd?: string;
  readonly repo_name?: string | null;
  readonly provider_resume?: ProviderResume | null;
  readonly status?: string;
  readonly resumable?: boolean;
  readonly attach_command?: string | null;
  readonly ssh_attach_command?: string | null;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly last_terminal_activity_at?: string;
  readonly machine?: string;
}

function providerResumeObject(s: SessionLike): Record<string, unknown> | null {
  const providerResume = s.provider_resume;
  return providerResume && typeof providerResume === "object" ? (providerResume as Record<string, unknown>) : null;
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim() || undefined;
}

function fallbackProviderSessionId(value: unknown): string | undefined {
  const sessionId = trimmedString(value);
  if (!sessionId || sessionId.startsWith("-")) {
    return undefined;
  }
  return sessionId;
}

function timestampOrderValue(iso: string | undefined): number {
  const value = Date.parse(iso ?? "");
  return Number.isNaN(value) ? Infinity : value;
}

function stableSessionOrderKey(s: SessionLike): string {
  return `${s.machine ?? ""}/${s.id}`;
}

// Cross-client default order: configured machine order, session creation time,
// then a stable key. Activity remains display metadata and does not reshuffle slots.
export function sortByDefaultSessionOrder<T extends SessionLike>(
  sessions: readonly T[],
  machineOrder: readonly string[] = [],
): T[] {
  const machineRanks = new Map(machineOrder.map((machine, index) => [machine, index] as const));
  return [...sessions].sort((a, b) => {
    const machineRankA = a.machine && machineRanks.has(a.machine) ? machineRanks.get(a.machine)! : Infinity;
    const machineRankB = b.machine && machineRanks.has(b.machine) ? machineRanks.get(b.machine)! : Infinity;
    if (machineRankA !== machineRankB) {
      return machineRankA - machineRankB;
    }

    const machineNameOrder = (a.machine ?? "").localeCompare(b.machine ?? "");
    if (machineNameOrder !== 0) {
      return machineNameOrder;
    }

    const createdA = timestampOrderValue(a.created_at);
    const createdB = timestampOrderValue(b.created_at);
    if (createdA !== createdB) {
      return createdA - createdB;
    }

    return stableSessionOrderKey(a).localeCompare(stableSessionOrderKey(b));
  });
}

export function relativeTime(iso: string | undefined, nowMs: number): string {
  if (!iso) {
    return "—";
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return "—";
  }
  const secs = Math.round((nowMs - t) / 1000);
  if (secs < 0) {
    return "just now";
  }
  if (secs < 60) {
    return `${secs}s ago`;
  }
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Human "time until reset" for a usage window's reset epoch (unix seconds).
// nowMs is passed in so this stays pure/testable (no Date.now() inside). Returns
// "—" for an unknown reset and "now" once the window has reset (or is past).
export function formatResetCountdown(resetsAtEpochSec: number | null, nowMs: number): string {
  if (resetsAtEpochSec === null) {
    return "—";
  }
  const secs = Math.round(resetsAtEpochSec - nowMs / 1000);
  if (secs <= 0) {
    return "now";
  }
  if (secs < 60) {
    return `${secs}s`;
  }
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    return `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const remMins = mins % 60;
    return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

// Human "time since" for an epoch-seconds timestamp (e.g. a usage snapshot's
// updated_at). Returns "—" when unknown. Pure/testable — nowMs is passed in and
// it delegates to relativeTime, so the two stay in lockstep.
export function relativeEpochSeconds(epochSec: number | null, nowMs: number): string {
  if (epochSec === null) {
    return "—";
  }
  return relativeTime(new Date(epochSec * 1000).toISOString(), nowMs);
}

export function sessionLabel(s: SessionLike): string {
  const title = s.title && s.title.trim() !== "" ? s.title : undefined;
  const providerSessionId = trimmedString(providerResumeObject(s)?.session_id);
  return title ?? providerSessionId ?? s.id;
}

export function resumeCommand(s: SessionLike): string | null {
  const providerResume = providerResumeObject(s);
  if (!providerResume) {
    return null;
  }
  const provider = trimmedString(providerResume.provider);
  if (provider === "codex" || provider === "claude") {
    const resumeArgs = providerResume.resume_args;
    if (Array.isArray(resumeArgs) && resumeArgs.length > 0 && resumeArgs.every((arg) => typeof arg === "string")) {
      return [provider, ...resumeArgs].map(shellQuoteForTerminalArg).join(" ");
    }
  }
  const sessionId = fallbackProviderSessionId(providerResume.session_id);
  if (!sessionId) {
    return null;
  }
  const quotedSessionId = shellQuoteForTerminalArg(sessionId);
  if (provider === "codex") {
    return `codex resume ${quotedSessionId}`;
  }
  if (provider === "claude") {
    return `claude --resume ${quotedSessionId}`;
  }
  return null;
}

export type SessionCopyAction =
  | { readonly kind: "command"; readonly value: string }
  | { readonly kind: "provider-session-id"; readonly value: string };

export function sessionCopyAction(s: SessionLike): SessionCopyAction | null {
  const providerResume = providerResumeObject(s);
  if (providerResume && (s.agent_profile || s.resume_blocked_reason)) {
    if (s.agent_profile && s.managed_resume_command_available === true && !s.resume_blocked_reason) {
      const managedSessionId = fallbackProviderSessionId(s.id);
      return managedSessionId
        ? { kind: "command", value: "agent-session resume " + shellQuoteForTerminalArg(managedSessionId) }
        : null;
    }
    const providerSessionId = fallbackProviderSessionId(providerResume.session_id);
    return providerSessionId
      ? { kind: "provider-session-id", value: providerSessionId }
      : null;
  }
  const providerCommand = resumeCommand(s);
  if (providerCommand) {
    return { kind: "command", value: providerCommand };
  }
  if (s.managed_resume_command_available === true && !s.resume_blocked_reason) {
    const managedSessionId = fallbackProviderSessionId(s.id);
    if (managedSessionId) {
      return { kind: "command", value: "agent-session resume " + shellQuoteForTerminalArg(managedSessionId) };
    }
  }
  return null;
}

export function sessionCommand(s: SessionLike): string | null {
  const action = sessionCopyAction(s);
  return action?.kind === "command" ? action.value : null;
}

export function sessionRepoLabel(s: SessionLike): string {
  const repoName = s.repo_name?.trim();
  if (repoName) {
    return repoName;
  }
  const cwd = s.cwd?.trim();
  if (!cwd) {
    return "unknown";
  }
  const segments = cwd.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? "unknown";
}

export function compactRepoBadgeLines(label: string): string[] {
  const trimmed = label.trim();
  if (!trimmed) {
    return ["unknown"];
  }
  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  const repoName = segments[segments.length - 1] ?? trimmed;
  const parts = repoName.split("-").map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return [repoName];
  }
  let splitAt = 1;
  let smallestImbalance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < parts.length; index += 1) {
    const firstLine = parts.slice(0, index).join(" ");
    const secondLine = parts.slice(index).join(" ");
    const imbalance = Math.abs(firstLine.length - secondLine.length);
    if (imbalance < smallestImbalance) {
      splitAt = index;
      smallestImbalance = imbalance;
    }
  }
  return [parts.slice(0, splitAt).join(" "), parts.slice(splitAt).join(" ")];
}

function normalizedSessionStatus(s: SessionLike): "running" | "stopped" | "unknown" {
  if (s.status === "running" || s.status === "stopped" || s.status === "unknown") {
    return s.status;
  }
  return "unknown";
}

export function isSessionResumeAvailable(s: SessionLike): boolean {
  const status = normalizedSessionStatus(s);
  return status !== "running" && s.status === status && s.resumable === true;
}

export function sessionStatusLabel(s: SessionLike): string {
  if (isSessionResumeAvailable(s)) {
    return "resumable";
  }
  return normalizedSessionStatus(s);
}

export interface MachineHealth {
  readonly name: string;
  readonly ok: boolean;
  readonly error?: string;
}

// Banner text for any unreachable machines, or null when all are healthy.
export function describeUnreachable(machines: readonly MachineHealth[]): string | null {
  const down = machines.filter((m) => !m.ok);
  if (down.length === 0) {
    return null;
  }
  return down.map((m) => `${m.name}: ${m.error ?? "unreachable"}`).join("; ");
}

export interface EmergencyShell {
  readonly schema_version: "agent-session.shell.v1";
  readonly owner: string;
  readonly status: "running" | "stopped";
  readonly incarnation: string | null;
  readonly tmux_name: string;
}

export function normalizeEmergencyShell(value: unknown): EmergencyShell | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== "agent-session.shell.v1"
    || typeof raw.owner !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.owner)
    || typeof raw.tmux_name !== "string" || !raw.tmux_name.startsWith("ac-shell-")
    || !["running", "stopped"].includes(String(raw.status))
    || (raw.status === "running" && (typeof raw.incarnation !== "string" || !/^[a-z0-9-]{1,64}$/.test(raw.incarnation)))
    || (raw.status === "stopped" && raw.incarnation !== null)) return null;
  return { schema_version: "agent-session.shell.v1", owner: raw.owner,
    status: raw.status as EmergencyShell["status"], incarnation: raw.incarnation as string | null,
    tmux_name: raw.tmux_name };
}

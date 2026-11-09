import { normalizeAccountNickname } from "@agent-console/shared/api";
import type { MachineConfig } from "./config.ts";
import { aggregateSessions } from "./upstream.ts";

export function accountConflict(body: Record<string, unknown>): boolean {
  return body.account !== undefined && [body.codex_account, body.claude_account]
    .some(value => value !== undefined && value !== body.account);
}

export function projectAccount(body: Record<string, unknown>, output: Record<string, unknown>): boolean {
  const provider = body.agent;
  const oldKey = provider === "claude" || provider === "codex" ? `${provider}_account` : null;
  if (["claude_account", "codex_account"].some(key => key !== oldKey && body[key] !== undefined)) return false;
  const value = body.account ?? (oldKey ? body[oldKey] : undefined);
  if (value === undefined) return true;
  const account = normalizeAccountNickname(value);
  if (!oldKey || account === null) return false;
  output[oldKey] = account;
  return true;
}

export async function translateAccount(machine: MachineConfig, body: Record<string, unknown>): Promise<void> {
  const key = body.agent === "claude" || body.agent === "codex" ? `${body.agent}_account` : "";
  if (!key || body[key] === undefined) return;
  const snapshot = await aggregateSessions([machine]);
  if (snapshot.machines[0]?.capabilities?.session_account_field === true) {
    body.account = body[key];
    delete body[key];
  }
}

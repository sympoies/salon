import { createHash } from "node:crypto";
import { normalizePromptReceipt, type PromptReceipt } from "@agent-console/shared/prompt-receipt";
import type { MachineConfig, PrincipalConfig } from "./config.ts";
import { aggregateSessions, daemonFetch, type DaemonResult } from "./upstream.ts";
import { OutboxStore, type OutboxAttempt, type OutboxTarget } from "./outboxStore.ts";

export function outboxCredentialGeneration(principal: PrincipalConfig, machine: MachineConfig): string {
  // Never persist credentials. A reissued credential or repointed machine must
  // not silently inherit permission to submit old server-accepted text.
  return createHash("sha256").update(JSON.stringify([principal.token, machine.url, machine.token])).digest("hex");
}

export function outboxReceipt(result: DaemonResult, attempt: OutboxAttempt, lookup: boolean): PromptReceipt | null {
  const body = result.body as { ok?: unknown; data?: { receipt?: unknown; submitted?: unknown; session_incarnation?: unknown };
    error?: { details?: { receipt?: unknown } } } | undefined;
  const expected = { request_id: attempt.item.request_id!, session_id: attempt.target.sessionId,
    session_incarnation: attempt.target.incarnation };
  const receipt = normalizePromptReceipt(lookup ? body?.data?.receipt : body?.data?.receipt ?? body?.error?.details?.receipt, expected);
  const success = result.status >= 200 && result.status < 300 && body?.ok === true;
  if (!receipt) return null;
  if (lookup) return success ? receipt : null;
  if (receipt.outcome === "unknown") return receipt;
  if (receipt.outcome === "refused") return !success && result.status >= 400 ? receipt : null;
  return success && body?.data?.submitted === true && body.data.session_incarnation === expected.session_incarnation ? receipt : null;
}

interface DispatchAccess { readonly machine: MachineConfig; readonly principal: PrincipalConfig }
export interface OutboxDispatchOptions {
  readonly store: OutboxStore;
  /** Synchronous, fresh permission + ownership check, including after I/O. */
  readonly access: (target: OutboxTarget) => DispatchAccess | null;
  readonly intervalMs?: number;
}

/** A durable claim is never re-POSTed, even if the process died before POST. */
export class SharedOutboxDispatcher {
  readonly #options: OutboxDispatchOptions;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #reconciling = false;
  #stopped = false;
  readonly #active = new Set<string>();
  constructor(options: OutboxDispatchOptions) { this.#options = options; }
  start(): void {
    this.#timer = setInterval(() => void this.tick(), this.#options.intervalMs ?? 2_000);
    this.#timer.unref();
  }
  stop(): void { this.#stopped = true; clearInterval(this.#timer); }
  async tick(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    const { store, access } = this.#options;
    try {
      // One observation per machine per round; every target still checks its
      // current ownership/generation again after each asynchronous boundary.
      const observations = new Map<string, Awaited<ReturnType<typeof aggregateSessions>>>();
      for (const target of store.targets()) {
        if (this.#stopped) return;
        const allowed = access(target);
        if (!allowed) {
          for (const attempt of store.uncertain(target)) store.settle(attempt, null);
          const pending = store.candidate(target);
          if (pending) store.refuse(pending, "outbox-authorization-changed");
          continue;
        }
        const generation = outboxCredentialGeneration(allowed.principal, allowed.machine);
        if (this.#stopped) return;
        const candidate = store.candidate(target);
        if (!candidate) continue;
        if (candidate.credentialGeneration !== generation) { store.refuse(candidate, "outbox-authorization-changed"); continue; }
        let observed = observations.get(target.machine);
        if (!observed) {
          observed = await aggregateSessions([allowed.machine]);
          observations.set(target.machine, observed);
        }
        if (this.#stopped) return;
        const current = access(target);
        if (!current || outboxCredentialGeneration(current.principal, current.machine) !== generation) continue;
        if (!observed.machines.some(machine => machine.name === target.machine && machine.ok)) continue;
        const session = observed.sessions.find(session => session.id === target.sessionId);
        if (!session || session.session_incarnation !== target.incarnation) { store.refuse(candidate, "outbox-session-changed"); continue; }
        const provider = (session.provider_resume as { provider?: unknown } | undefined)?.provider ?? session.agent;
        if (provider !== "codex" && provider !== "claude") { store.refuse(candidate, "outbox-provider-changed"); continue; }
        if (session.status !== "running") continue;
        // The daemon owns native input admission and real-composer protection.
        // Console must not wait for an idle observation or provider completion.
        const attempt = store.claim(candidate);
        if (!attempt) continue;
        this.#active.add(attempt.item.request_id!);
        try {
          const result = await daemonFetch(current.machine, `/sessions/${encodeURIComponent(target.sessionId)}/prompt/v2`, {
            method: "POST", body: { text: attempt.item.text, expected_session_incarnation: target.incarnation,
              request_id: attempt.item.request_id, require_idle: false },
          });
          if (this.#stopped) return;
          const errorCode = (result.body as { error?: { code?: unknown } } | undefined)?.error?.code;
          if (result.status === 409 && errorCode === "request-id-conflict") store.refuse(attempt, "request-id-conflict");
          else if (result.status === 400 && errorCode === "invalid-json-body") store.refuse(attempt, "keyed-prompt-unsupported");
          else store.settle(attempt, outboxReceipt(result, attempt, false));
        } catch {
          if (!this.#stopped) store.settle(attempt, null);
        } finally { this.#active.delete(attempt.item.request_id!); }
      }
    } catch {
      // Persistence/observation failure never acknowledges or retries a claim.
      // Do not log payloads, identities or upstream diagnostics.
    } finally {
      this.#running = false;
      // Recovery I/O must never block a distinct new user input.
      void this.#reconcile();
    }
  }
  async #reconcile(): Promise<void> {
    if (this.#reconciling || this.#stopped) return;
    this.#reconciling = true;
    const { store, access } = this.#options;
    try {
      for (const target of store.targets()) {
        const allowed = access(target);
        if (!allowed) continue;
        const generation = outboxCredentialGeneration(allowed.principal, allowed.machine);
        for (const attempt of store.uncertain(target)) {
          if (this.#stopped) return;
          if (this.#active.has(attempt.item.request_id!)) continue;
          if (attempt.credentialGeneration !== generation) { store.settle(attempt, null); continue; }
          let receipt: PromptReceipt | null = null;
          try {
            const result = await daemonFetch(allowed.machine,
              `/sessions/${encodeURIComponent(target.sessionId)}/prompt/v2/receipts/${encodeURIComponent(attempt.item.request_id!)}?expected_session_incarnation=${encodeURIComponent(target.incarnation)}`);
            receipt = outboxReceipt(result, attempt, true);
          } catch { /* Missing/unavailable claims stay unknown, never replay. */ }
          if (this.#stopped) return;
          const current = access(target);
          if (current && outboxCredentialGeneration(current.principal, current.machine) === generation) store.settle(attempt, receipt);
        }
      }
    } catch {
      // A failed read cannot manufacture acknowledgement or another dispatch.
    } finally { this.#reconciling = false; }
  }
}

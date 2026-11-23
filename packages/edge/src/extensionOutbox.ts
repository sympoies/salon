import { isPromptIncarnation, isPromptRequestId } from "@agent-console/shared/prompt-receipt";
import { SHARED_OUTBOX_MAX_TEXT_BYTES, validOutboxText, type SharedOutboxItem } from "@agent-console/shared/shared-outbox";
import type { MachineConfig } from "./config.ts";
import type {
  EdgeOutbox, EdgeOutboxError, EdgeOutboxInput, EdgeOutboxInputKey, EdgeOutboxRecord, EdgeOutboxResult,
} from "./extensions.ts";
import { OutboxError, type ExtensionOutboxGrant, type ExtensionOutboxInput, type OutboxStore, type OutboxTarget } from "./outboxStore.ts";
import { aggregateSessions } from "./upstream.ts";

interface TargetAccess {
  readonly machine: MachineConfig;
  readonly credentialGeneration: string;
  readonly deviceId: string | null;
}

export interface ExtensionOutboxOptions {
  readonly store: OutboxStore | null;
  readonly extensionId: string;
  readonly principalId: string;
  readonly grant: ExtensionOutboxGrant;
  authorizeRequest(write: boolean): EdgeOutboxError | undefined;
  authorizeTarget(target: OutboxTarget, grant: ExtensionOutboxGrant): TargetAccess | EdgeOutboxError;
  dispatch(): void;
}

const inputChannel = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);

function record(inputId: string, admission: ExtensionOutboxInput, item: Omit<SharedOutboxItem, "text" | "edit_hold">): EdgeOutboxRecord {
  const { machine, sessionId, incarnation } = admission.target;
  return {
    inputId, target: { machine, sessionId, sessionIncarnation: incarnation }, source: admission.source,
    outboxIntentId: item.id, state: item.state, revision: item.revision, createdAt: item.created_at,
    updatedAt: item.updated_at, requestId: item.request_id, receipt: item.receipt, errorCode: item.error_code,
  };
}

const failure = (error: EdgeOutboxError): { ok: false; status: EdgeOutboxError["status"]; error: EdgeOutboxError } =>
  ({ ok: false, status: error.status, error });

async function run<Status extends 200 | 201>(action: () => Promise<EdgeOutboxResult<Status>>): Promise<EdgeOutboxResult<Status>> {
  try { return await action(); }
  catch (error) {
    if (error instanceof OutboxError) {
      if (error.code === "outbox-intent-conflict") return failure({ status: 409, code: "input-id-conflict" });
      if (error.code === "outbox-lifecycle-pending") return failure({ status: 409, code: "lifecycle-pending" });
      if (error.code === "outbox-capacity") return failure({ status: 507, code: "capacity-exceeded" });
    }
    if ((error as NodeJS.ErrnoException)?.code === "ERR_SQLITE_ERROR") return failure({ status: 503, code: "durability-unavailable" });
    throw error;
  }
}

export function createExtensionOutbox(options: ExtensionOutboxOptions): EdgeOutbox {
  const { store, principalId, extensionId, grant } = options;
  const unavailable = { status: 503, code: "durability-unavailable" } as const;
  const missing = { status: 404, code: "input-not-found" } as const;
  const invalid = { status: 400, code: "invalid-request" } as const;
  const scopedKey = (channel: string, inputId: string) => ({ principalId, extensionId, channel, inputId });

  // All storage operations using this observation happen synchronously after
  // the second credential and exact-target grant check.
  async function withSession<Status extends 200 | 201>(
    target: OutboxTarget, targetGrant: ExtensionOutboxGrant, operation: "admit" | "replay" | "read",
    use: (access: TargetAccess, running: boolean) => EdgeOutboxResult<Status>,
  ): Promise<EdgeOutboxResult<Status>> {
    const before = options.authorizeTarget(target, targetGrant);
    if ("code" in before) return failure(before);
    const observed = await aggregateSessions([before.machine]);
    const requestError = options.authorizeRequest(operation !== "read");
    if (requestError) return failure(requestError);
    const current = options.authorizeTarget(target, targetGrant);
    if ("code" in current) return failure(current);
    if (current.credentialGeneration !== before.credentialGeneration) return failure({ status: 403, code: "forbidden" });
    if (!observed.machines.some(machine => machine.ok)) return failure({ status: 503, code: "target-unavailable" });
    const session = observed.sessions.find(value => value.id === target.sessionId);
    if (!session || session.session_incarnation !== target.incarnation) return failure({ status: 409, code: "session-changed" });
    if (operation === "admit") {
      const provider = (session.provider_resume as { provider?: unknown } | undefined)?.provider ?? session.agent;
      if (provider !== "codex" && provider !== "claude") return failure({ status: 409, code: "provider-unsupported" });
    }
    return use(current, session.status === "running");
  }

  return {
    admit: (input: EdgeOutboxInput) => run<200 | 201>(async () => {
      const requestError = options.authorizeRequest(true);
      if (requestError) return failure(requestError);
      if (!store) return failure(unavailable);
      const { inputId, target, text, source } = input ?? {};
      if (!isPromptRequestId(inputId) || !target || typeof target.machine !== "string" || !target.machine
        || !isPromptRequestId(target.sessionId) || !isPromptIncarnation(target.sessionIncarnation)
        || typeof text !== "string" || !source || !inputChannel(source.channel)
        || typeof source.label !== "string" || !source.label.trim() || source.label.length > 128
        || typeof source.prefix !== "string" || /[\u0000-\u001f\u007f]/.test(source.label + source.prefix)) return failure(invalid);
      if (Buffer.byteLength(source.prefix + text) > SHARED_OUTBOX_MAX_TEXT_BYTES) {
        return failure({ status: 413, code: "input-too-large" });
      }
      if (!validOutboxText(text)) return failure(invalid);

      const identity = scopedKey(source.channel, inputId);
      const admission = {
        target: { machine: target.machine, sessionId: target.sessionId, incarnation: target.sessionIncarnation, principalId },
        source: { channel: source.channel, label: source.label, prefix: source.prefix },
        grant,
      };
      const existing = store.extensionInput(identity);
      const observedTarget = existing?.target ?? admission.target;
      // Capture the fence before the network observation so a late result
      // cannot clear a newer lifecycle operation.
      const fence = existing ? undefined : store.lifecycle(observedTarget.machine, observedTarget.sessionId);
      return withSession<200 | 201>(observedTarget, existing?.grant ?? grant, existing ? "replay" : "admit", (access, running) => {
        if (fence && running) store.releaseObsoleteLifecycle(fence, observedTarget.incarnation);
        const result = store.admitExtensionInput(identity, admission, text, access.credentialGeneration, access.deviceId);
        if (result.created) options.dispatch();
        else {
          const owner = options.authorizeTarget(result.entry.target, result.entry.grant);
          if ("code" in owner) return failure(owner);
        }
        return { ok: true, status: result.created ? 201 : 200, record: record(inputId, result.entry, result.entry.item) };
      });
    }),

    get: (key: EdgeOutboxInputKey) => run<200>(async () => {
      const requestError = options.authorizeRequest(false);
      if (requestError) return failure(requestError);
      if (!store) return failure(unavailable);
      const { channel, inputId } = key ?? {};
      if (!inputChannel(channel) || !isPromptRequestId(inputId)) return failure(invalid);
      const identity = scopedKey(channel, inputId);
      const existing = store.extensionInput(identity);
      if (!existing) return failure(missing);
      return withSession<200>(existing.target, existing.grant, "read", () => {
        const current = store.extensionInput(identity);
        return current ? { ok: true, status: 200, record: record(inputId, current, current.item) } : failure(missing);
      });
    }),
  };
}

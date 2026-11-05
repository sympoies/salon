import { createHash } from "node:crypto";
import { projectArchiveDaemonData } from "./daemonEnvelope.ts";
import { isPromptIncarnation } from "@agent-console/shared/prompt-receipt";
import { OutboxStore } from "./outboxStore.ts";

/** Operator evidence binds a verified completed archive to one migrated legacy row. */
export function planLegacyLifecycleRepair(store: OutboxStore, machine: string, sessionId: string, proofText: string) {
  const proof = JSON.parse(proofText);
  const fence = store.lifecycle(machine, sessionId);
  if (!fence || fence.incarnation !== null || fence.operation !== null) throw new Error("legacy fence required");
  if (proof?.schema_version !== "outbox-archive-proof.v1" || proof.machine !== machine || proof.session_id !== sessionId
    || proof.owner_token !== fence.ownerToken || proof.verified_completed_archive !== true
    || !isPromptIncarnation(proof.fenced_incarnation)
    || !Number.isInteger(proof.archive_result?.status) || proof.archive_result.status < 200 || proof.archive_result.status >= 300
    || proof.archive_result?.body?.ok !== true
    || !projectArchiveDaemonData(proof.archive_result.body.data, sessionId)) {
    throw new Error("verified completed archive provenance required");
  }
  return { schema_version: "outbox-lifecycle-repair-plan.v1", fence, incarnation: proof.fenced_incarnation as string,
    proof_sha256: createHash("sha256").update(proofText).digest("hex") };
}

export function applyLegacyLifecycleRepair(store: OutboxStore, machine: string, sessionId: string, proofText: string, planText: string): void {
  const plan = planLegacyLifecycleRepair(store, machine, sessionId, proofText);
  if (JSON.stringify(JSON.parse(planText)) !== JSON.stringify(plan)) throw new Error("repair plan changed; dry-run again");
  if (!store.repairLegacyLifecycle(plan.fence, plan.incarnation)) throw new Error("legacy fence changed");
}

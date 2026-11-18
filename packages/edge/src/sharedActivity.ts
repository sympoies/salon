import { ActivityFeedSseDecoder, serializeActivitySseEvent, serializeActivityDeliverySseEvent } from "@agent-console/shared/activity";
import type { ActivityStreamEvent } from "@agent-console/shared/activity";
import type { MachineConfig } from "./config.ts";
import { streamActivityEvents, type ActivityStreamOptions } from "./activityStream.ts";
import { SharedStreamRegistry } from "./sharedStream.ts";

export class SharedActivityStreams {
  readonly #streams = new SharedStreamRegistry();
  async stream(machines: readonly MachineConfig[], options: ActivityStreamOptions & { initialEvent?: (machine: MachineConfig) => Promise<ActivityStreamEvent>; onDisconnect?: () => void }): Promise<void> {
    await Promise.all(machines.map(async (machine) => {
      if (options.initialEvent) {
        const initial = await options.initialEvent(machine);
        if (options.signal.aborted) return;
        if (!options.write(serializeActivitySseEvent(initial))) await options.waitForDrain?.();
        if (!options.write(serializeActivityDeliverySseEvent({ schema_version: "agent-console.activity-delivery.event.v1",
          type: "delivery", machine: machine.name, observed_at: initial.observed_at, state: "polling" }))) await options.waitForDrain?.();
      }
      const decoder = new ActivityFeedSseDecoder();
      let previous: { streamId: string; sequence: number; sessions: Map<string, string> } | undefined;
      for await (const chunk of this.#streams.subscribe(machine.name, (signal, emit) =>
        streamActivityEvents([machine], { signal, write: (frame) => { emit(frame); return true; } }), options.signal, options.onDisconnect)) {
        for (const event of decoder.push(chunk)) {
          // Principal/incarnation filtering remains per subscriber, after shared
          // producer normalization. Delivery-only metadata needs no projection.
          const filtered = event.type === "delivery" ? event : options.filterEvent ? await options.filterEvent(event) : event;
          if (options.signal.aborted) return;
          let outgoing = filtered;
          if (filtered.type === "snapshot" || (filtered.type === "reset" && filtered.sessions)) {
            const { sessions, ...metadata } = filtered;
            const current = new Map(sessions.map(session => [session.id, JSON.stringify(session.turn_state)]));
            // Keep the full baseline on a stream reset, sequence gap or membership
            // change. The UI uses those to reconcile its session catalog.
            const baseline = previous;
            if (filtered.type === "snapshot" && baseline?.streamId === filtered.stream_id
              && baseline.sequence + 1 === filtered.sequence && baseline.sessions.size === current.size
              && sessions.every(session => baseline.sessions.has(session.id))) {
              const changes = sessions.filter(session => baseline.sessions.get(session.id) !== current.get(session.id));
              outgoing = changes.length ? { ...metadata, type: "delta", sessions: changes } : { ...metadata, type: "heartbeat" };
            }
            previous = { streamId: filtered.stream_id, sequence: filtered.sequence, sessions: current };
          } else if (filtered.type === "heartbeat" && previous?.streamId === filtered.stream_id
            && previous.sequence + 1 === filtered.sequence) {
            previous.sequence = filtered.sequence;
          } else {
            previous = undefined;
          }
          const serialized = outgoing.type === "delivery" ? serializeActivityDeliverySseEvent(outgoing) : serializeActivitySseEvent(outgoing);
          if (!options.write(serialized)) await options.waitForDrain?.();
        }
      }
    }));
  }
  close(): void { this.#streams.close(); }
}

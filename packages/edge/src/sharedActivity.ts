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
      for await (const chunk of this.#streams.subscribe(machine.name, (signal, emit) =>
        streamActivityEvents([machine], { signal, write: (frame) => { emit(frame); return true; } }), options.signal, options.onDisconnect)) {
        for (const event of decoder.push(chunk)) {
          // Principal/incarnation filtering remains per subscriber, after shared
          // producer normalization. Delivery-only metadata needs no projection.
          const filtered = event.type === "delivery" ? event : options.filterEvent ? await options.filterEvent(event) : event;
          if (options.signal.aborted) return;
          const serialized = filtered.type === "delivery" ? serializeActivityDeliverySseEvent(filtered) : serializeActivitySseEvent(filtered);
          if (!options.write(serialized)) await options.waitForDrain?.();
        }
      }
    }));
  }
  close(): void { this.#streams.close(); }
}

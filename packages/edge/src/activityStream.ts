import {
  ActivitySseDecoder,
  serializeActivityDeliverySseEvent,
  serializeActivitySseEvent,
  type ActivityDeliveryEvent,
  type ActivityStreamEvent,
} from "@agent-console/shared/activity";
import type { MachineConfig } from "./config.ts";

const INITIAL_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 10_000;
const INITIAL_UNSUPPORTED_REPROBE_MS = 30_000;
const MAX_UNSUPPORTED_REPROBE_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 10_000;
const DAEMON_HEARTBEAT_INTERVAL_MS = 15_000;
const READ_IDLE_TIMEOUT_MS = DAEMON_HEARTBEAT_INTERVAL_MS * 1.5;

interface DrainEventSource {
  once(event: "drain", listener: () => void): unknown;
  off(event: "drain", listener: () => void): unknown;
}

export function waitForDrainOrAbort(source: DrainEventSource, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const cleanup = () => {
      source.off("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onDrain = () => finish();
    const onAbort = () => finish();
    source.once("drain", onDrain);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export interface ActivityStreamOptions {
  readonly fetchImpl?: typeof fetch;
  readonly signal: AbortSignal;
  readonly write: (chunk: string) => boolean;
  readonly waitForDrain?: () => Promise<void>;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly readIdleTimeoutMs?: number;
  readonly filterEvent?: (event: ActivityStreamEvent) => ActivityStreamEvent | Promise<ActivityStreamEvent>;
}

interface ReadConnectionOptions {
  readonly fetchImpl: typeof fetch;
  readonly signal: AbortSignal;
  readonly lastEventId?: string;
  readonly readIdleTimeoutMs: number;
  readonly onEvent: (event: ActivityStreamEvent) => Promise<void> | void;
}

type ConnectionResult = "ended" | "unsupported";

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // A rejected response must not hold retry resources even if its body is already closed.
  }
}

async function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readMachineConnection(
  machine: MachineConfig,
  options: ReadConnectionOptions,
): Promise<ConnectionResult> {
  const headers = new Headers({
    accept: "text/event-stream",
    authorization: `Bearer ${machine.token}`,
  });
  if (options.lastEventId) headers.set("last-event-id", options.lastEventId);
  const connectionController = new AbortController();
  const connectSignal = AbortSignal.any([options.signal, connectionController.signal]);
  const connectTimer = setTimeout(() => connectionController.abort(), CONNECT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await options.fetchImpl(`${machine.url}/activity/events`, {
      method: "GET",
      headers,
      signal: connectSignal,
      redirect: "error",
    });
  } finally {
    clearTimeout(connectTimer);
  }
  if ([404, 405, 501].includes(response.status)) {
    await cancelResponseBody(response);
    return "unsupported";
  }
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`activity daemon status ${response.status}`);
  }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    await cancelResponseBody(response);
    throw new Error("activity daemon returned a non-SSE response");
  }
  if (!response.body) throw new Error("activity daemon returned no stream body");

  const reader = response.body.getReader();
  const textDecoder = new TextDecoder();
  const sse = new ActivitySseDecoder(machine.name);
  try {
    for (;;) {
      const idleTimer = setTimeout(() => connectionController.abort(), options.readIdleTimeoutMs);
      const { done, value } = await (async () => {
        try {
          return await reader.read();
        } finally {
          clearTimeout(idleTimer);
        }
      })();
      if (done) break;
      for (const event of sse.push(textDecoder.decode(value, { stream: true }))) {
        await options.onEvent(event);
      }
    }
    for (const event of sse.push(textDecoder.decode())) {
      await options.onEvent(event);
    }
    for (const event of sse.finish()) {
      await options.onEvent(event);
    }
  } finally {
    reader.releaseLock();
  }
  return "ended";
}

async function streamMachine(machine: MachineConfig, options: ActivityStreamOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const readIdleTimeoutMs = options.readIdleTimeoutMs ?? READ_IDLE_TIMEOUT_MS;
  let reconnectMs = INITIAL_RECONNECT_MS;
  let lastEventId: string | undefined;
  let lastStreamId: string | undefined;
  let lastSequence = -1;
  let unsupportedReprobeMs = INITIAL_UNSUPPORTED_REPROBE_MS;
  let deliveredEver = false;
  let signaledState: ActivityDeliveryEvent["state"] | undefined;
  const writeChunk = async (chunk: string) => {
    if (!options.write(chunk)) await options.waitForDrain?.();
  };
  const signalDelivery = async (state: ActivityDeliveryEvent["state"]) => {
    if (options.signal.aborted || !deliveredEver || signaledState === state) return;
    signaledState = state;
    await writeChunk(serializeActivityDeliverySseEvent({
      schema_version: "agent-console.activity-delivery.event.v1",
      type: "delivery",
      machine: machine.name,
      state,
      observed_at: new Date().toISOString(),
    }));
  };
  while (!options.signal.aborted) {
    let delivered = false;
    try {
      const result = await readMachineConnection(machine, {
        fetchImpl,
        signal: options.signal,
        lastEventId,
        readIdleTimeoutMs,
        onEvent: async (event) => {
          if (
            event.type !== "reset" &&
            event.stream_id === lastStreamId && event.sequence <= lastSequence
          ) return;
          delivered = true;
          deliveredEver = true;
          signaledState = undefined;
          lastEventId = `${event.stream_id}:${event.sequence}`;
          lastStreamId = event.stream_id;
          lastSequence = event.sequence;
          const filtered = options.filterEvent ? await options.filterEvent(event) : event;
          await writeChunk(serializeActivitySseEvent(filtered));
        },
      });
      if (result === "unsupported") {
        await signalDelivery("polling");
        if (options.signal.aborted) return;
        try {
          await sleep(unsupportedReprobeMs, options.signal);
        } catch (error) {
          if (aborted(options.signal)) return;
          throw error;
        }
        unsupportedReprobeMs = Math.min(unsupportedReprobeMs * 2, MAX_UNSUPPORTED_REPROBE_MS);
        continue;
      }
      unsupportedReprobeMs = INITIAL_UNSUPPORTED_REPROBE_MS;
    } catch (error) {
      if (aborted(options.signal)) return;
    }
    if (options.signal.aborted) return;
    await signalDelivery("reconnecting");
    if (options.signal.aborted) return;
    reconnectMs = delivered ? INITIAL_RECONNECT_MS : Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
    try {
      await sleep(reconnectMs, options.signal);
    } catch (error) {
      if (aborted(options.signal)) return;
      throw error;
    }
  }
}

export async function streamActivityEvents(
  machines: readonly MachineConfig[],
  options: ActivityStreamOptions,
): Promise<void> {
  await Promise.all(machines.map((machine) => streamMachine(machine, options)));
}

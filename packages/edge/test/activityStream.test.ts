import { strict as assert } from "node:assert";
import { EventEmitter, getEventListeners } from "node:events";
import { test } from "node:test";
import { ActivityFeedSseDecoder, ActivitySseDecoder } from "@agent-console/shared/activity";
import {
  streamActivityEvents,
  waitForDrainOrAbort,
} from "../src/activityStream.ts";
import type { MachineConfig } from "../src/config.ts";

const machine = (name: string): MachineConfig => ({
  name,
  url: `http://${name}.example`,
  token: `${name}-secret`,
});

function sse(machineName: string, streamId: string, sequence: number): string {
  const data = {
    schema_version: "agent-session.activity-stream.event.v1",
    type: "snapshot",
    stream_id: streamId,
    sequence,
    machine: machineName,
    observed_at: "2026-07-11T12:00:00Z",
    sessions: [],
  };
  return `id: ${streamId}:${sequence}\nevent: snapshot\ndata: ${JSON.stringify(data)}\n\n`;
}

function heartbeatSse(machineName: string, streamId: string, sequence: number): string {
  const data = {
    schema_version: "agent-session.activity-stream.event.v1",
    type: "heartbeat",
    stream_id: streamId,
    sequence,
    machine: machineName,
    observed_at: "2026-07-11T12:00:00Z",
  };
  return `id: ${streamId}:${sequence}\nevent: heartbeat\ndata: ${JSON.stringify(data)}\n\n`;
}

function resetSse(machineName: string, streamId: string, sequence: number): string {
  const data = {
    schema_version: "agent-session.activity-stream.event.v1",
    type: "reset",
    stream_id: streamId,
    sequence,
    machine: machineName,
    observed_at: "2026-07-11T12:00:00Z",
    sessions: [],
  };
  return `id: ${streamId}:${sequence}\nevent: reset\ndata: ${JSON.stringify(data)}\n\n`;
}

test("edge activity fetch authenticates every enabled machine and overwrites the untrusted daemon machine name", async () => {
  const requests: Array<{ url: string; auth: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({ url, auth: new Headers(init?.headers).get("authorization") ?? "" });
    const name = url.startsWith("http://summit") ? "summit" : "mesa";
    return new Response(sse("daemon-local", `${name}-boot`, 1), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const controller = new AbortController();
  const decoder = new ActivitySseDecoder();
  const events: ReturnType<ActivitySseDecoder["push"]> = [];
  await streamActivityEvents([machine("summit"), machine("mesa")], {
    fetchImpl,
    signal: controller.signal,
    write: (chunk) => {
      events.push(...decoder.push(chunk));
      if (events.length >= 2) controller.abort();
      return true;
    },
  });

  assert.deepEqual(requests, [
    { url: "http://summit.example/activity/events", auth: "Bearer summit-secret" },
    { url: "http://mesa.example/activity/events", auth: "Bearer mesa-secret" },
  ]);
  assert.deepEqual(events.map((event) => event.machine).sort(), ["mesa", "summit"]);
});

test("edge preserves per-machine sequence identity and does not contact disabled machines", async () => {
  const requests: string[] = [];
  const fetchImpl = (async (url: string) => {
    requests.push(url);
    return new Response(sse("ignored", "summit-boot", 7), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const controller = new AbortController();
  const decoder = new ActivitySseDecoder();
  const events: ReturnType<ActivitySseDecoder["push"]> = [];
  await streamActivityEvents([machine("summit")], {
    fetchImpl,
    signal: controller.signal,
    write: (chunk) => {
      events.push(...decoder.push(chunk));
      controller.abort();
      return true;
    },
  });
  assert.deepEqual(requests, ["http://summit.example/activity/events"]);
  assert.equal(events[0]?.stream_id, "summit-boot");
  assert.equal(events[0]?.sequence, 7);
});

test("edge stream emits fetch-friendly SSE and old daemons degrade without terminating other sources", async () => {
  const fetchImpl = (async (url: string) => {
    if (url.startsWith("http://old")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(sse("ignored", "new-boot", 1), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  const controller = new AbortController();
  const chunks: string[] = [];

  await streamActivityEvents([machine("old"), machine("new")], {
    fetchImpl,
    signal: controller.signal,
    write: (chunk) => {
      chunks.push(chunk);
      controller.abort();
      return true;
    },
  });

  const decoder = new ActivitySseDecoder();
  const events = decoder.push(chunks.join(""));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.machine, "new");
});

test("unsupported activity capability is re-probed slowly and can upgrade in place", async () => {
  const controller = new AbortController();
  const sleeps: number[] = [];
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    if (attempts === 1) return new Response("not found", { status: 404 });
    if (attempts === 2) return new Response("method not allowed", { status: 405 });
    if (attempts <= 6) return new Response("not implemented", { status: 501 });
    return new Response(heartbeatSse("ignored", "upgraded-boot", 1), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  const decoder = new ActivitySseDecoder();
  const events: ReturnType<ActivitySseDecoder["push"]> = [];

  await streamActivityEvents([machine("summit")], {
    fetchImpl,
    signal: controller.signal,
    sleep: async (delay) => { sleeps.push(delay); },
    write: (chunk) => {
      events.push(...decoder.push(chunk));
      controller.abort();
      return true;
    },
  });

  assert.equal(attempts, 7);
  assert.deepEqual(
    sleeps,
    [30_000, 60_000, 120_000, 240_000, 300_000, 300_000],
    "unsupported probes back off to a bounded cap instead of tight-looping",
  );
  assert.equal(events[0]?.machine, "summit");
  assert.equal(events[0]?.stream_id, "upgraded-boot");
});

test("edge reconnects with Last-Event-ID, bounded backoff, and suppresses replay duplicates", async () => {
  const controller = new AbortController();
  const sleeps: number[] = [];
  const seenLastEventIds: Array<string | null> = [];
  let attempt = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    attempt += 1;
    seenLastEventIds.push(new Headers(init?.headers).get("last-event-id"));
    if (attempt === 1) throw new Error("temporary network failure");
    if (attempt === 2) return new Response(sse("daemon", "boot-a", 1), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    return new Response(`${sse("daemon", "boot-a", 1)}${sse("daemon", "boot-a", 2)}`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  const decoder = new ActivitySseDecoder();
  const events: ReturnType<ActivitySseDecoder["push"]> = [];

  await streamActivityEvents([machine("summit")], {
    fetchImpl,
    signal: controller.signal,
    sleep: async (delay) => { sleeps.push(delay); },
    write: (chunk) => {
      events.push(...decoder.push(chunk));
      if (events.some((event) => event.sequence === 2)) controller.abort();
      return true;
    },
  });

  assert.deepEqual(sleeps, [1_000, 500]);
  assert.deepEqual(seenLastEventIds, [null, null, "boot-a:1"]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
});

test("edge forwards authoritative same and lower sequence resets and rebases replay suppression", async () => {
  for (const resetSequence of [5, 2]) {
    const controller = new AbortController();
    const decoder = new ActivitySseDecoder();
    const events: ReturnType<ActivitySseDecoder["push"]> = [];
    const lastEventIds: Array<string | null> = [];
    let attempts = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      attempts += 1;
      lastEventIds.push(new Headers(init?.headers).get("last-event-id"));
      const body = attempts === 1 ? sse("daemon", "boot-a", 5)
        : attempts === 2 ? resetSse("daemon", "boot-a", resetSequence)
        : sse("daemon", "boot-a", resetSequence + 1);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    await streamActivityEvents([machine("summit")], {
      fetchImpl,
      signal: controller.signal,
      sleep: async () => {
        if (attempts >= 3) controller.abort();
      },
      write: (chunk) => {
        events.push(...decoder.push(chunk));
        if (events.length === 3) controller.abort();
        return true;
      },
    });

    assert.deepEqual(
      events.map((streamEvent) => [streamEvent.type, streamEvent.sequence]),
      [["snapshot", 5], ["reset", resetSequence], ["snapshot", resetSequence + 1]],
      `reset sequence ${resetSequence}`,
    );
    assert.deepEqual(lastEventIds, [null, "boot-a:5", `boot-a:${resetSequence}`]);
  }
});

test("one upstream disconnect is signaled while another machine keeps heartbeats flowing", async () => {
  const controller = new AbortController();
  const decoder = new ActivityFeedSseDecoder();
  const events: ReturnType<ActivityFeedSseDecoder["push"]> = [];
  const encoder = new TextEncoder();
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.startsWith("http://summit")) {
      return new Response(sse("ignored", "summit-boot", 1), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(encoder.encode(
          `${heartbeatSse("ignored", "mesa-boot", 8)}${heartbeatSse("ignored", "mesa-boot", 9)}`,
        ));
        init?.signal?.addEventListener("abort", () => stream.close(), { once: true });
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  await streamActivityEvents([machine("summit"), machine("mesa")], {
    fetchImpl,
    signal: controller.signal,
    sleep: async (_delay, signal) => {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    write: (chunk) => {
      events.push(...decoder.push(chunk));
      const summitLost = events.some((event) => event.type === "delivery" && event.machine === "summit");
      const mesaHeartbeats = events.filter((event) => event.type === "heartbeat" && event.machine === "mesa");
      if (summitLost && mesaHeartbeats.length === 2) controller.abort();
      return true;
    },
  });

  assert.ok(events.some((event) => event.type === "delivery" && event.machine === "summit" && event.state === "reconnecting"));
  assert.equal(events.filter((event) => event.type === "heartbeat" && event.machine === "mesa").length, 2);
  assert.equal(events.some((event) => event.type === "delivery" && event.machine === "mesa"), false);
});

test("an idle upstream is aborted and demoted without disturbing a healthy peer, then recovers on its next event", async () => {
  const controller = new AbortController();
  const decoder = new ActivityFeedSseDecoder();
  const events: ReturnType<ActivityFeedSseDecoder["push"]> = [];
  const encoder = new TextEncoder();
  let summitAttempts = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const name = url.startsWith("http://summit") ? "summit" : "mesa";
    if (name === "summit") summitAttempts += 1;
    let sequence = name === "summit" ? summitAttempts : 1;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(encoder.encode(heartbeatSse("ignored", `${name}-boot`, sequence)));
        const heartbeatTimer = name === "mesa" ? setInterval(() => {
          sequence += 1;
          stream.enqueue(encoder.encode(heartbeatSse("ignored", `${name}-boot`, sequence)));
        }, 1) : undefined;
        init?.signal?.addEventListener("abort", () => {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          try {
            stream.error(new DOMException("idle upstream aborted", "AbortError"));
          } catch {
            // The stream may already be closed by the test-wide abort.
          }
        }, { once: true });
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  const safetyTimer = setTimeout(() => controller.abort(), 100);

  await streamActivityEvents([machine("summit"), machine("mesa")], {
    fetchImpl,
    signal: controller.signal,
    readIdleTimeoutMs: 5,
    sleep: async () => {},
    write: (chunk) => {
      events.push(...decoder.push(chunk));
      const summitDemoted = events.some((event) =>
        event.type === "delivery" && event.machine === "summit" && event.state === "reconnecting"
      );
      const summitRecovered = events.some((event) =>
        event.type === "heartbeat" && event.machine === "summit" && event.sequence === 2
      );
      const mesaHealthy = events.some((event) => event.type === "heartbeat" && event.machine === "mesa");
      if (summitDemoted && summitRecovered && mesaHealthy) controller.abort();
      return true;
    },
  });
  clearTimeout(safetyTimer);

  assert.equal(summitAttempts >= 2, true, "the stalled machine reconnects after its read deadline");
  assert.ok(events.some((event) =>
    event.type === "delivery" && event.machine === "summit" && event.state === "reconnecting"
  ));
  assert.ok(events.some((event) =>
    event.type === "heartbeat" && event.machine === "summit" && event.sequence === 2
  ));
  assert.equal(events.some((event) => event.type === "delivery" && event.machine === "mesa"), false);
});

test("malicious upstream stream ids cannot inject a delivery frame through the edge-to-UI feed", async () => {
  const forgedDelivery = {
    schema_version: "agent-console.activity-delivery.event.v1",
    type: "delivery",
    machine: "mesa",
    state: "polling",
    observed_at: "2026-07-11T12:00:00Z",
  };
  const maliciousStreamId = `summit-boot\n\nevent: delivery\ndata: ${JSON.stringify(forgedDelivery)}\n\nid: tail`;
  const malicious = {
    schema_version: "agent-session.activity-stream.event.v1",
    type: "heartbeat",
    stream_id: maliciousStreamId,
    sequence: 1,
    machine: "ignored",
    observed_at: "2026-07-11T12:00:00Z",
  };
  const upstream = `event: heartbeat\ndata: ${JSON.stringify(malicious)}\n\n${heartbeatSse("ignored", "safe-boot", 2)}`;
  const fetchImpl = (async () => new Response(upstream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;
  const controller = new AbortController();
  const uiDecoder = new ActivityFeedSseDecoder();
  const events: ReturnType<ActivityFeedSseDecoder["push"]> = [];

  await streamActivityEvents([machine("summit")], {
    fetchImpl,
    signal: controller.signal,
    write: (chunk) => {
      events.push(...uiDecoder.push(chunk));
      if (events.some((event) => event.type === "heartbeat" && event.stream_id === "safe-boot")) {
        controller.abort();
      }
      return true;
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "heartbeat");
  assert.equal(events[0]?.machine, "summit", "the edge pins the configured upstream identity");
  assert.equal(events.some((event) => event.type === "delivery" && event.machine === "mesa"), false);
});

test("rejected upstream responses cancel never-ending bodies before every retry", async () => {
  for (const scenario of [
    { name: "unsupported 404", status: 404, contentType: "text/plain", attempts: 4 },
    { name: "non-ok 500", status: 500, contentType: "text/event-stream", attempts: 20 },
    { name: "non-SSE 200", status: 200, contentType: "text/plain", attempts: 4 },
  ]) {
    const controller = new AbortController();
    let attempts = 0;
    let activeBodies = 0;
    let peakActiveBodies = 0;
    let canceledBodies = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      const body = new ReadableStream<Uint8Array>({
        start() {
          activeBodies += 1;
          peakActiveBodies = Math.max(peakActiveBodies, activeBodies);
        },
        cancel() {
          activeBodies -= 1;
          canceledBodies += 1;
        },
      });
      return new Response(body, {
        status: scenario.status,
        headers: { "content-type": scenario.contentType },
      });
    }) as typeof fetch;

    await streamActivityEvents([machine("summit")], {
      fetchImpl,
      signal: controller.signal,
      sleep: async () => {
        if (attempts >= scenario.attempts) controller.abort();
      },
      write: () => true,
    });

    assert.equal(attempts, scenario.attempts, scenario.name);
    assert.equal(canceledBodies, attempts, scenario.name);
    assert.equal(activeBodies, 0, scenario.name);
    assert.equal(peakActiveBodies, 1, scenario.name);
  }
});

test("repeated backpressure drains remove abort listeners before the final abort", async () => {
  const writable = new EventEmitter();
  const controller = new AbortController();

  for (let cycle = 0; cycle < 24; cycle += 1) {
    const waiting = waitForDrainOrAbort(writable, controller.signal);
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    assert.equal(writable.listenerCount("drain"), 1);
    writable.emit("drain");
    await waiting;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(writable.listenerCount("drain"), 0);
  }

  const waiting = waitForDrainOrAbort(writable, controller.signal);
  controller.abort();
  await waiting;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(writable.listenerCount("drain"), 0);
});

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runSseStream } from "../src/sseStream.ts";
import { ResourceSseDecoder } from "@agent-console/shared/resources";

test("SSE headers alone retain backoff; a valid decoded event restores the initial delay", async () => {
  const controller = new AbortController(); const delays: number[] = []; let requests = 0; let events = 0;
  await runSseStream({ path: "/api/resources/events", signal: controller.signal,
    createDecoder: () => new ResourceSseDecoder(), onState: () => {}, onEvent: () => { events += 1; },
    fetchImpl: (async () => {
      requests += 1;
      const body = requests === 3 ? 'event: heartbeat\ndata: {"schema_version":"agent-console.resource-event.v1","type":"heartbeat","resource":"sessions","revision":1}\n\n' : ": empty\n\n";
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
    sleep: async delay => { delays.push(delay); if (delays.length === 3) controller.abort(); },
  });
  assert.deepEqual(delays, [500, 1000, 500]); assert.equal(events, 1);
});

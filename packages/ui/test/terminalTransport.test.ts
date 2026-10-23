import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AttachTarget, SendSessionInputBody } from "../src/api.ts";
import { createProviderPromptTitleSource } from "../src/terminalTurnTitle.ts";
import {
  backgroundReconnectOffsetMs,
  DEFAULT_RECONNECT_DELAYS_MS,
  WEB_SOCKET_OPEN_STATE,
  createFocusedReconnectScheduler,
  createOrderedSessionInputSender,
  createTerminalTransportController,
  sendSessionInputViaWebSocket,
  type TerminalTransportSocket,
  type TerminalTransportStatus,
} from "../src/terminalTransport.ts";

test("background reconnect offsets spread retries while remaining stable per pane", () => {
  const first = backgroundReconnectOffsetMs("maple", "session-a");
  const second = backgroundReconnectOffsetMs("maple", "session-b");
  assert.equal(first, backgroundReconnectOffsetMs("maple", "session-a"));
  assert.notEqual(first, second);
  assert.ok(first >= 1_000 && first < 3_500);
  assert.ok(second >= 1_000 && second < 3_500);
});

class FakeSocket implements TerminalTransportSocket {
  readyState = 0;
  binaryType: BinaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.readyState = WEB_SOCKET_OPEN_STATE;
    this.onopen?.();
  }

  closeFromServer(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  errorFromServer(): void {
    this.onerror?.();
  }
}

test("sendSessionInputViaWebSocket frames text before keys", () => {
  const socket = new FakeSocket();

  sendSessionInputViaWebSocket(socket, { text: "hello", keys: ["enter", "c-c"] });

  assert.deepEqual(socket.sent, [
    JSON.stringify({ text: "hello" }),
    JSON.stringify({ key: "enter" }),
    JSON.stringify({ key: "c-c" }),
  ]);
});

test("ordered input sender uses open WebSocket immediately but preserves fallback order while closed", async () => {
  const socket = new FakeSocket();
  socket.open();
  const fallbackBodies: SendSessionInputBody[] = [];
  let releaseFirstFallback: (() => void) | null = null;
  const sender = createOrderedSessionInputSender({
    getWebSocket: () => socket,
    sendFallback: async (body) => {
      fallbackBodies.push(body);
      if (body.text === "queued-http") {
        await new Promise<void>((resolve) => {
          releaseFirstFallback = resolve;
        });
      }
      return { ok: true };
    },
    isMounted: () => true,
  });

  await sender.send({ text: "direct-ws" });
  assert.deepEqual(socket.sent, [JSON.stringify({ text: "direct-ws" })]);
  assert.deepEqual(fallbackBodies, []);

  socket.readyState = 3;
  const first = sender.send({ text: "queued-http" });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(fallbackBodies, [{ text: "queued-http" }]);

  socket.open();
  const second = sender.send({ keys: ["tab"] });
  assert.equal(sender.pendingCount(), 2);
  assert.deepEqual(socket.sent, [JSON.stringify({ text: "direct-ws" })]);

  assert.ok(releaseFirstFallback, "first fallback should be pending");
  releaseFirstFallback();
  await Promise.all([first, second]);

  assert.deepEqual(fallbackBodies, [{ text: "queued-http" }]);
  assert.deepEqual(socket.sent, [
    JSON.stringify({ text: "direct-ws" }),
    JSON.stringify({ key: "tab" }),
  ]);
  assert.equal(sender.pendingCount(), 0);
});

test("ordered input sender keeps connection state independent from HTTP input rejection", async () => {
  const rejections: Array<{
    message?: string;
    retryable: boolean;
    outcomeUnknown?: boolean;
  }> = [];
  const sender = createOrderedSessionInputSender({
    getWebSocket: () => null,
    sendFallback: async () => ({ ok: false, error: "account switch pending" }),
    isMounted: () => true,
    onInputRejected: (rejection) => rejections.push(rejection),
  });

  await sender.send({ text: "lost" });

  assert.deepEqual(rejections, [{
    message: "account switch pending",
    retryable: true,
    outcomeUnknown: false,
  }]);
  assert.equal(sender.pendingCount(), 0);
});

test("ordered input sender preserves an indeterminate HTTP delivery outcome", async () => {
  const rejections: Array<{
    message?: string;
    retryable: boolean;
    outcomeUnknown?: boolean;
  }> = [];
  const sender = createOrderedSessionInputSender({
    getWebSocket: () => null,
    sendFallback: async () => ({
      ok: false,
      error: "request failed (503)",
      outcomeUnknown: true,
    }),
    isMounted: () => true,
    onInputRejected: (rejection) => rejections.push(rejection),
  });

  await sender.send({ text: "possibly delivered" });

  assert.deepEqual(rejections, [{
    message: "request failed (503)",
    retryable: false,
    outcomeUnknown: true,
  }]);
});

test("focused reconnect scheduler backs off, skips duplicates, and cancels pending timers", () => {
  type Timer = { id: number; callback: () => void; delayMs: number; canceled: boolean };
  const timers: Timer[] = [];
  let focused = true;
  let nextTimerId = 0;
  let connectCalls = 0;
  const scheduler = createFocusedReconnectScheduler<Timer>({
    shouldReconnect: () => focused,
    setTimeout: (callback, delayMs) => {
      const timer = { id: ++nextTimerId, callback, delayMs, canceled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.canceled = true;
    },
  });

  scheduler.schedule(() => {
    connectCalls += 1;
  });
  scheduler.schedule(() => {
    connectCalls += 100;
  });

  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.delayMs, DEFAULT_RECONNECT_DELAYS_MS[0]);

  timers[0]?.callback();
  assert.equal(connectCalls, 1);

  scheduler.schedule(() => {
    connectCalls += 1;
  });
  assert.equal(timers[1]?.delayMs, DEFAULT_RECONNECT_DELAYS_MS[1]);

  scheduler.cancel();
  assert.equal(timers[1]?.canceled, true);

  focused = false;
  scheduler.schedule(() => {
    connectCalls += 1;
  });
  assert.equal(timers.length, 2);
});

test("reconnect attempts back off to a 30-second ceiling after repeated outages", async () => {
  const delays: number[] = [];
  const scheduler = createFocusedReconnectScheduler<number>({
    shouldReconnect: () => true,
    setTimeout: (callback, delayMs) => {
      delays.push(delayMs);
      queueMicrotask(callback);
      return delays.length;
    },
    clearTimeout: () => undefined,
  });
  for (let index = 0; index < DEFAULT_RECONNECT_DELAYS_MS.length + 2; index += 1) {
    scheduler.schedule(() => undefined);
    await Promise.resolve();
  }
  assert.equal(delays.at(-1), 30_000);
  assert.equal(delays.at(-2), 30_000);
});

test("focused reconnect scheduler resets attempts after a successful open", () => {
  const delays: number[] = [];
  const scheduler = createFocusedReconnectScheduler<number>({
    shouldReconnect: () => true,
    setTimeout: (callback, delayMs) => {
      delays.push(delayMs);
      callback();
      return delays.length;
    },
    clearTimeout: () => undefined,
  });

  scheduler.schedule(() => undefined);
  scheduler.schedule(() => undefined);
  scheduler.resetAttempts();
  scheduler.schedule(() => undefined);

  assert.deepEqual(delays, [
    DEFAULT_RECONNECT_DELAYS_MS[0],
    DEFAULT_RECONNECT_DELAYS_MS[1],
    DEFAULT_RECONNECT_DELAYS_MS[0],
  ]);
});

test("reconnect scheduler adds the background pane offset to each retry", () => {
  const delays: number[] = [];
  const scheduler = createFocusedReconnectScheduler<number>({
    shouldReconnect: () => true,
    delayOffsetMs: () => 1_500,
    setTimeout: (callback, delayMs) => {
      delays.push(delayMs);
      callback();
      return delays.length;
    },
    clearTimeout: () => undefined,
  });
  scheduler.schedule(() => undefined);
  scheduler.schedule(() => undefined);
  assert.deepEqual(delays, [DEFAULT_RECONNECT_DELAYS_MS[0] + 1_500, DEFAULT_RECONNECT_DELAYS_MS[1] + 1_500]);
});

test("a WebSocket that never opens is closed and retried", async () => {
  type Timer = { callback: () => void; delayMs: number; cleared: boolean };
  const timers: Timer[] = [];
  const sockets: FakeSocket[] = [];
  const statuses: TerminalTransportStatus[] = [];
  const controller = createTerminalTransportController<Timer>({
    machine: "maple",
    id: "stalled",
    attachTarget: async () => ({ url: "ws://stalled" }),
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    sendFallback: async () => ({ ok: true }),
    setStatus: (status) => statuses.push(status),
    shouldReconnect: () => true,
    reconnectDelayOffsetMs: () => 1_500,
    connectTimeoutMs: 100,
    setTimeout: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; },
  });

  await controller.connect();
  const deadline = timers.find((timer) => timer.delayMs === 100);
  assert.ok(deadline);
  deadline.callback();
  assert.equal(sockets[0]?.closed, true);
  assert.deepEqual(statuses, ["connecting", "closed"]);
  assert.ok(timers.some((timer) => timer.delayMs === DEFAULT_RECONNECT_DELAYS_MS[0] + 1_500 && !timer.cleared));
  controller.dispose();
});

test("online wake never replaces an in-progress attach or open socket", async () => {
  let releaseAttach!: (target: AttachTarget) => void;
  let attaches = 0;
  const sockets: FakeSocket[] = [];
  const controller = createTerminalTransportController({
    machine: "maple",
    id: "wake",
    attachTarget: async () => {
      attaches += 1;
      return new Promise<AttachTarget>((resolve) => { releaseAttach = resolve; });
    },
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    sendFallback: async () => ({ ok: true }),
    setStatus: () => undefined,
    shouldReconnect: () => true,
  });
  const connecting = controller.connect();
  controller.wake();
  assert.equal(attaches, 1);
  releaseAttach({ url: "ws://wake" });
  await connecting;
  controller.wake();
  assert.equal(attaches, 1);
  sockets[0]!.open();
  controller.wake();
  assert.equal(attaches, 1);
  assert.equal(sockets[0]!.closed, false);
  controller.dispose();
});

test("online wake reserves recovery for the next attach when an attempt is already active", async () => {
  let rejectFirst!: (reason: Error) => void;
  const recoveryFlags: boolean[] = [];
  const controller = createTerminalTransportController({
    machine: "maple", id: "wake",
    attachTarget: async (_machine, _id, recovery) => {
      recoveryFlags.push(recovery === true);
      if (recoveryFlags.length === 1) {
        return new Promise<AttachTarget>((_resolve, reject) => { rejectFirst = reject; });
      }
      return { url: "ws://wake" };
    },
    createWebSocket: () => new FakeSocket(),
    sendFallback: async () => ({ ok: true }),
    setStatus: () => undefined,
    shouldReconnect: () => true,
  });
  const first = controller.connect();
  controller.wake();
  assert.deepEqual(recoveryFlags, [false]);
  rejectFirst(new Error("offline"));
  await first;
  await controller.connect();
  assert.deepEqual(recoveryFlags, [false, true]);
  controller.dispose();
});

test("a stale connection deadline cannot detach a newer socket's deadline", async () => {
  type Timer = { callback: () => void; delayMs: number; cleared: boolean };
  const timers: Timer[] = [];
  const sockets: FakeSocket[] = [];
  const statuses: TerminalTransportStatus[] = [];
  const controller = createTerminalTransportController<Timer>({
    machine: "maple",
    id: "overlap",
    attachTarget: async () => ({ url: "ws://overlap" }),
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    sendFallback: async () => ({ ok: true }),
    setStatus: (status) => statuses.push(status),
    shouldReconnect: () => false,
    connectTimeoutMs: 100,
    setTimeout: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; },
  });

  await controller.connect();
  await controller.connect();
  const deadlines = timers.filter((timer) => timer.delayMs === 100);
  assert.equal(deadlines.length, 2);
  deadlines[0]!.callback();
  sockets[1]!.open();
  assert.equal(deadlines[1]!.cleared, true);
  deadlines[1]!.callback();
  assert.equal(sockets[1]!.closed, false);
  assert.equal(statuses.at(-1), "open");
  controller.dispose();
});

test("terminal transport controller opens attach target with protocols and reports status transitions", async () => {
  const statuses: TerminalTransportStatus[] = [];
  const debugEvents: Array<{ source?: string; route?: string; status?: number | null; ok?: boolean | null }> = [];
  const attachCalls: Array<{ machine: string; id: string }> = [];
  const sockets: FakeSocket[] = [];
  const messages: Array<string | Uint8Array> = [];
  const capabilityStates: string[] = [];
  const providerEvents: Array<{ eventId: string; text: string }> = [];
  const inputRejections: Array<{ code?: string; retryable: boolean }> = [];
  let layoutSyncs = 0;
  let outputActivity = 0;
  const controller = createTerminalTransportController({
    machine: "maple",
    id: "s1",
    attachTarget: async (machine, id): Promise<AttachTarget> => {
      attachCalls.push({ machine, id });
      return { url: "ws://edge/attach", protocols: ["agent-console-token.test"] };
    },
    createWebSocket: (url, protocols) => {
      assert.equal(url, "ws://edge/attach");
      assert.deepEqual(protocols, ["agent-console-token.test"]);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    sendFallback: async () => ({ ok: true }),
    setStatus: (status) => statuses.push(status),
    shouldReconnect: () => false,
    onOpen: () => {
      layoutSyncs += 1;
    },
    onOutputActivity: () => {
      outputActivity += 1;
    },
    onMessageData: (data) => {
      messages.push(data);
    },
    onProviderPromptCapability: (state) => {
      capabilityStates.push(state);
    },
    onProviderPromptEvent: (event) => {
      providerEvents.push({ eventId: event.eventId, text: event.text });
    },
    onInputRejected: (rejection) => {
      inputRejections.push({ code: rejection.code, retryable: rejection.retryable });
    },
    onDebugEvent: (event) => {
      debugEvents.push(event);
    },
  });

  await controller.connect();
  assert.deepEqual(attachCalls, [{ machine: "maple", id: "s1" }]);
  assert.deepEqual(statuses, ["connecting"]);
  assert.equal(debugEvents[0]?.source, "ws");
  assert.equal(debugEvents[0]?.route, "/api/sessions/:machine/:id/attach");
  assert.equal(debugEvents[0]?.status, null);
  assert.equal(sockets[0]?.binaryType, "arraybuffer");

  sockets[0]?.open();
  assert.deepEqual(statuses, ["connecting", "open"]);
  assert.equal(debugEvents[1]?.ok, true);
  assert.equal(layoutSyncs, 1);
  assert.deepEqual(sockets[0]?.sent, [JSON.stringify({ subscribe: ["provider-prompt.v1"] })]);
  assert.deepEqual(capabilityStates, ["pending"]);

  sockets[0]?.onmessage?.({ data: JSON.stringify({
    schema_version: "agent-session.attach.v1",
    type: "capability",
    capability: "provider-prompt.v1",
    supported: true,
    provider: "codex",
    prompt_max_bytes: 16_384,
  }) });
  sockets[0]?.onmessage?.({ data: JSON.stringify({
    schema_version: "agent-session.attach.event.v1",
    type: "prompt_submitted",
    event_id: "pp-transport",
    provider: "codex",
    submitted_at: "2026-07-10T00:00:00Z",
    text: "provider prompt",
    truncated: false,
  }) });
  sockets[0]?.onmessage?.({ data: JSON.stringify({
    schema_version: "agent-session.attach.event.v2",
    type: "prompt_submitted",
    text: "future control frame",
  }) });
  sockets[0]?.onmessage?.({ data: JSON.stringify({
    schema_version: "agent-session.attach.event.v1",
    type: "input_rejected",
    code: "codex-account-next-pending",
    retryable: true,
  }) });
  sockets[0]?.onmessage?.({ data: "out" });
  sockets[0]?.onmessage?.({ data: new Uint8Array([1, 2]).buffer });
  assert.equal(outputActivity, 2);
  assert.equal(messages[0], "out");
  assert.deepEqual(messages[1], new Uint8Array([1, 2]));
  assert.deepEqual(capabilityStates, ["pending", "supported"]);
  assert.deepEqual(providerEvents, [{ eventId: "pp-transport", text: "provider prompt" }]);
  assert.deepEqual(inputRejections, [{
    code: "codex-account-next-pending",
    retryable: true,
  }]);
  assert.deepEqual(statuses, ["connecting", "open"]);

  controller.sendResize(80, 24);
  assert.deepEqual(sockets[0]?.sent, [
    JSON.stringify({ subscribe: ["provider-prompt.v1"] }),
    JSON.stringify({ resize: { cols: 80, rows: 24 } }),
  ]);

  sockets[0]?.closeFromServer();
  assert.deepEqual(statuses, ["connecting", "open", "closed"]);
  assert.equal(debugEvents.some((event) => event.status === 1000 || event.route === "/api/sessions/:machine/:id/attach"), true);
  assert.deepEqual(capabilityStates, ["pending", "supported", "fallback"]);

  await controller.connect();
  sockets[1]?.open();
  assert.deepEqual(statuses, ["connecting", "open", "closed", "connecting", "open"]);
  assert.deepEqual(capabilityStates, ["pending", "supported", "fallback", "pending"]);
  assert.deepEqual(sockets[1]?.sent, [JSON.stringify({ subscribe: ["provider-prompt.v1"] })]);
  sockets[1]?.onmessage?.({ data: JSON.stringify({
    schema_version: "agent-session.attach.event.v1",
    type: "prompt_submitted",
    event_id: "pp-pre-ack",
    provider: "codex",
    submitted_at: "2026-07-10T00:00:01Z",
    text: "ignored before acknowledgement",
    truncated: false,
  }) });
  assert.equal(providerEvents.some((event) => event.eventId === "pp-pre-ack"), false);
  sockets[1]?.onmessage?.({ data: JSON.stringify({
    schema_version: "agent-session.attach.v1",
    type: "capability",
    capability: "provider-prompt.v1",
    supported: true,
    provider: "codex",
    prompt_max_bytes: 16_384,
  }) });
  sockets[1]?.onmessage?.({ data: JSON.stringify({
    schema_version: "agent-session.attach.event.v1",
    type: "prompt_submitted",
    event_id: "pp-reconnected",
    provider: "codex",
    submitted_at: "2026-07-10T00:00:02Z",
    text: "new socket prompt",
    truncated: false,
  }) });
  assert.deepEqual(providerEvents.at(-1), { eventId: "pp-reconnected", text: "new socket prompt" });
  sockets[1]?.errorFromServer();
  assert.deepEqual(statuses, ["connecting", "open", "closed", "connecting", "open", "closed"]);
  const afterErrorDebugCount = debugEvents.length;
  sockets[1]?.closeFromServer();
  assert.deepEqual(statuses, ["connecting", "open", "closed", "connecting", "open", "closed"]);
  assert.equal(debugEvents.length, afterErrorDebugCount);
});

test("terminal transport controller cleans up sockets, reconnect timers, and late attach resolution", async () => {
  type Timer = { callback: () => void; cleared: boolean };
  const timers: Timer[] = [];
  const sockets: FakeSocket[] = [];
  const statuses: TerminalTransportStatus[] = [];
  let resolveAttach: ((target: AttachTarget) => void) | null = null;
  let createdAfterDispose = 0;
  const controller = createTerminalTransportController({
    machine: "maple",
    id: "s1",
    attachTarget: async () =>
      new Promise<AttachTarget>((resolve) => {
        resolveAttach = resolve;
      }),
    createWebSocket: () => {
      createdAfterDispose += 1;
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    sendFallback: async () => ({ ok: true }),
    setStatus: (status) => statuses.push(status),
    shouldReconnect: () => true,
    setTimeout: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cleared = true;
    },
  });

  const connect = controller.connect();
  assert.deepEqual(statuses, ["connecting"]);
  controller.dispose();
  assert.ok(resolveAttach, "attach promise should be pending");
  resolveAttach({ url: "ws://late" });
  await connect;

  assert.equal(createdAfterDispose, 0);
  assert.deepEqual(statuses, ["connecting"]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.cleared, true, "pre-open negotiation timeout clears on dispose");

  const liveController = createTerminalTransportController({
    machine: "maple",
    id: "s2",
    attachTarget: async () => ({ url: "ws://live" }),
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    sendFallback: async () => ({ ok: true }),
    setStatus: (status) => statuses.push(status),
    shouldReconnect: () => true,
    setTimeout: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cleared = true;
    },
  });

  await liveController.connect();
  const socket = sockets.at(-1);
  assert.ok(socket);
  socket.open();
  socket.closeFromServer();
  assert.equal(timers.length, 4);
  assert.equal(timers[1]?.cleared, true, "capability timeout must clear on close");
  assert.equal(timers[2]?.cleared, true, "connection deadline clears on open");
  assert.equal(timers[3]?.cleared, false, "reconnect remains scheduled");

  liveController.dispose();

  assert.equal(timers[3]?.cleared, true);
  assert.equal(socket.closed, true);
  assert.equal(socket.onopen, null);
  assert.equal(socket.onmessage, null);
  assert.equal(socket.onclose, null);
  assert.equal(socket.onerror, null);
});

test("provider prompt capability timeout still accepts late support on the same connection", async () => {
  type Timer = { callback: () => void; delayMs: number; cleared: boolean };
  const timers: Timer[] = [];
  const states: string[] = [];
  const events: string[] = [];
  const socket = new FakeSocket();
  const controller = createTerminalTransportController<Timer>({
    machine: "maple",
    id: "s-timeout",
    attachTarget: async () => ({ url: "ws://timeout" }),
    createWebSocket: () => socket,
    sendFallback: async () => ({ ok: true }),
    setStatus: () => undefined,
    shouldReconnect: () => false,
    onProviderPromptCapability: (state) => states.push(state),
    onProviderPromptEvent: (event) => events.push(event.eventId),
    setTimeout: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cleared = true;
    },
  });

  await controller.connect();
  socket.open();
  assert.deepEqual(states, ["pending"]);
  assert.equal(timers.length, 2);
  assert.equal(timers[1]?.cleared, true, "connection deadline clears on open");
  assert.ok(timers[0]!.delayMs > 0);
  timers[0]!.callback();
  assert.deepEqual(states, ["pending", "fallback"]);

  socket.onmessage?.({ data: JSON.stringify({
    schema_version: "agent-session.attach.v1",
    type: "capability",
    capability: "provider-prompt.v1",
    supported: true,
    provider: "codex",
    prompt_max_bytes: 16_384,
  }) });
  socket.onmessage?.({ data: JSON.stringify({
    schema_version: "agent-session.attach.event.v1",
    type: "prompt_submitted",
    event_id: "pp-late",
    provider: "codex",
    submitted_at: "2026-07-10T00:00:00Z",
    text: "late provider event",
    truncated: false,
  }) });
  assert.deepEqual(states, ["pending", "fallback", "supported"]);
  assert.deepEqual(events, ["pp-late"]);

  controller.dispose();
});

test("unsupported capability and attach failure release queued title fallbacks", async () => {
  const emitted: string[] = [];
  const source = createProviderPromptTitleSource({ onPrompt: (prompt) => emitted.push(prompt) });
  const socket = new FakeSocket();
  const unsupported = createTerminalTransportController({
    machine: "maple",
    id: "s-unsupported",
    attachTarget: async () => ({ url: "ws://unsupported" }),
    createWebSocket: () => socket,
    sendFallback: async () => ({ ok: true }),
    setStatus: () => undefined,
    shouldReconnect: () => false,
    onProviderPromptCapability: (state) => source.setCapability(state),
  });

  source.acceptLocal(["queued unsupported prompt"]);
  await unsupported.connect();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({
    schema_version: "agent-session.attach.v1",
    type: "capability",
    capability: "provider-prompt.v1",
    supported: false,
    provider: null,
    prompt_max_bytes: 16_384,
  }) });
  assert.deepEqual(emitted, ["queued unsupported prompt"]);
  source.acceptLocal(["direct unsupported prompt"]);
  assert.deepEqual(emitted, ["queued unsupported prompt", "direct unsupported prompt"]);
  unsupported.dispose();

  const failedEmitted: string[] = [];
  const failedSource = createProviderPromptTitleSource({ onPrompt: (prompt) => failedEmitted.push(prompt) });
  failedSource.acceptLocal(["queued attach failure"]);
  const failed = createTerminalTransportController({
    machine: "maple",
    id: "s-failed",
    attachTarget: async () => {
      throw new Error("attach unavailable");
    },
    createWebSocket: () => new FakeSocket(),
    sendFallback: async () => ({ ok: true }),
    setStatus: () => undefined,
    shouldReconnect: () => false,
    onProviderPromptCapability: (state) => failedSource.setCapability(state),
  });
  await failed.connect();
  assert.deepEqual(failedEmitted, ["queued attach failure"]);
  failedSource.acceptLocal(["direct attach failure"]);
  assert.deepEqual(failedEmitted, ["queued attach failure", "direct attach failure"]);
  failed.dispose();
});

test("pre-open attach stalls select bounded title fallback", async () => {
  type Timer = { callback: () => void; cleared: boolean };
  const timers: Timer[] = [];
  const emitted: string[] = [];
  const fallbackBodies: SendSessionInputBody[] = [];
  const source = createProviderPromptTitleSource({ onPrompt: (prompt) => emitted.push(prompt) });
  let resolveAttach: ((target: AttachTarget) => void) | null = null;
  const controller = createTerminalTransportController<Timer>({
    machine: "maple",
    id: "s-stalled-target",
    attachTarget: async () => new Promise<AttachTarget>((resolve) => {
      resolveAttach = resolve;
    }),
    createWebSocket: () => new FakeSocket(),
    sendFallback: async (_machine, _id, body) => {
      fallbackBodies.push(body);
      return { ok: true };
    },
    setStatus: () => undefined,
    shouldReconnect: () => false,
    onProviderPromptCapability: (state) => source.setCapability(state),
    setTimeout: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cleared = true;
    },
  });

  const connect = controller.connect();
  source.acceptLocal(["prompt while attach target stalls"]);
  await controller.sendInput({ text: "prompt while attach target stalls\r" });
  assert.deepEqual(fallbackBodies, [{ text: "prompt while attach target stalls\r" }]);
  assert.equal(timers.length, 1, "the negotiation timeout starts before attach target resolves");
  timers[0]!.callback();
  assert.deepEqual(emitted, ["prompt while attach target stalls"]);

  controller.dispose();
  assert.ok(resolveAttach);
  resolveAttach({ url: "ws://late-target" });
  await connect;

  const socketTimers: Timer[] = [];
  const socketEmitted: string[] = [];
  const socketSource = createProviderPromptTitleSource({ onPrompt: (prompt) => socketEmitted.push(prompt) });
  const neverOpenSocket = new FakeSocket();
  const neverOpen = createTerminalTransportController<Timer>({
    machine: "maple",
    id: "s-never-open",
    attachTarget: async () => ({ url: "ws://never-open" }),
    createWebSocket: () => neverOpenSocket,
    sendFallback: async () => ({ ok: true }),
    setStatus: () => undefined,
    shouldReconnect: () => false,
    onProviderPromptCapability: (state) => socketSource.setCapability(state),
    setTimeout: (callback) => {
      const timer = { callback, cleared: false };
      socketTimers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cleared = true;
    },
  });
  await neverOpen.connect();
  socketSource.acceptLocal(["prompt while socket never opens"]);
  assert.equal(socketTimers.length, 2);
  socketTimers[0]!.callback();
  assert.deepEqual(socketEmitted, ["prompt while socket never opens"]);
  neverOpen.dispose();
});

test("stale socket close and error cannot mutate a newer attach attempt", async () => {
  type Timer = { callback: () => void; cleared: boolean };
  const timers: Timer[] = [];
  const sockets: FakeSocket[] = [];
  const statuses: TerminalTransportStatus[] = [];
  const capabilities: string[] = [];
  const debugEvents: string[] = [];
  let attachCalls = 0;
  let resolveSecondAttach: ((target: AttachTarget) => void) | null = null;
  const controller = createTerminalTransportController<Timer>({
    machine: "maple",
    id: "s-overlap",
    attachTarget: async () => {
      attachCalls += 1;
      if (attachCalls === 1) {
        return { url: "ws://first" };
      }
      return new Promise<AttachTarget>((resolve) => {
        resolveSecondAttach = resolve;
      });
    },
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    sendFallback: async () => ({ ok: true }),
    setStatus: (status) => statuses.push(status),
    shouldReconnect: () => false,
    onProviderPromptCapability: (state) => capabilities.push(state),
    onDebugEvent: (event) => debugEvents.push(`${event.ok}:${event.error ?? "none"}`),
    setTimeout: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cleared = true;
    },
  });

  await controller.connect();
  const first = sockets[0];
  assert.ok(first);
  first.open();
  first.onmessage?.({ data: JSON.stringify({
    schema_version: "agent-session.attach.v1",
    type: "capability",
    capability: "provider-prompt.v1",
    supported: true,
    provider: "codex",
    prompt_max_bytes: 16_384,
  }) });
  assert.deepEqual(capabilities, ["pending", "supported"]);

  const secondConnect = controller.connect();
  assert.ok(resolveSecondAttach, "second attach target should remain pending");
  assert.deepEqual(capabilities, ["pending", "supported", "pending"]);
  const statusBeforeStale = [...statuses];
  const debugCountBeforeStale = debugEvents.length;

  first.errorFromServer();
  first.closeFromServer();
  assert.deepEqual(statuses, statusBeforeStale);
  assert.deepEqual(capabilities, ["pending", "supported", "pending"]);
  assert.equal(debugEvents.length, debugCountBeforeStale);

  resolveSecondAttach({ url: "ws://second" });
  await secondConnect;
  const second = sockets[1];
  assert.ok(second);
  second.open();
  second.onmessage?.({ data: JSON.stringify({
    schema_version: "agent-session.attach.v1",
    type: "capability",
    capability: "provider-prompt.v1",
    supported: true,
    provider: "codex",
    prompt_max_bytes: 16_384,
  }) });
  assert.deepEqual(capabilities, ["pending", "supported", "pending", "supported"]);

  controller.dispose();
});

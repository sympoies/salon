import { type AttachTarget, type SendSessionInputBody } from "./api.ts";
import {
  keyFrame,
  parseProviderPromptServerFrame,
  providerPromptSubscriptionFrame,
  resizeFrame,
  textFrame,
  type ProviderPromptSubmittedFrame,
} from "./frames.ts";
import type { DebugEventInput } from "./debugLog.ts";
import { defaultScheduler, type TimeoutScheduler } from "./scheduler.ts";

export type TerminalTransportStatus = "connecting" | "open" | "closed";

export const WEB_SOCKET_OPEN_STATE = 1;
const WEB_SOCKET_CONNECTING_STATE = 0;
export const DEFAULT_RECONNECT_DELAYS_MS = [350, 800, 1600, 3200, 5000, 10000, 30000] as const;
export const PROVIDER_PROMPT_CAPABILITY_TIMEOUT_MS = 2_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export function backgroundReconnectOffsetMs(machine: string, id: string): number {
  let hash = 2166136261;
  for (const char of `${machine}\0${id}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  return 1_000 + hash % 2_500;
}
export type ProviderPromptCapabilityMode = "pending" | "supported" | "fallback";

export interface TerminalTransportSocket {
  readyState: number;
  binaryType: BinaryType;
  onopen: unknown;
  onmessage: unknown;
  onclose: unknown;
  onerror: unknown;
  send(data: string): void;
  close(): void;
}

export type TerminalTransportSocketFactory = (
  url: string,
  protocols?: readonly string[],
) => TerminalTransportSocket;

export interface ApiResultLike {
  readonly ok: boolean;
  readonly error?: string;
  readonly outcomeUnknown?: boolean;
}

export interface TerminalInputRejection {
  readonly code?: string;
  readonly message?: string;
  readonly retryable: boolean;
  readonly outcomeUnknown?: boolean;
}

export interface OrderedSessionInputSender {
  send(body: SendSessionInputBody): Promise<void>;
  pendingCount(): number;
}

export interface OrderedSessionInputSenderOptions {
  readonly getWebSocket: () => TerminalTransportSocket | null;
  readonly sendFallback: (body: SendSessionInputBody) => Promise<ApiResultLike>;
  readonly isMounted: () => boolean;
  readonly onInputRejected?: (rejection: TerminalInputRejection) => void;
  readonly openState?: number;
}

export function sendSessionInputViaWebSocket(
  ws: Pick<TerminalTransportSocket, "send">,
  body: SendSessionInputBody,
): void {
  if (body.text !== undefined) {
    ws.send(textFrame(body.text));
  }
  for (const key of body.keys ?? []) {
    ws.send(keyFrame(key));
  }
}

export function createOrderedSessionInputSender({
  getWebSocket,
  sendFallback,
  isMounted,
  onInputRejected,
  openState = WEB_SOCKET_OPEN_STATE,
}: OrderedSessionInputSenderOptions): OrderedSessionInputSender {
  let queue = Promise.resolve();
  let pendingSends = 0;

  const enqueue = (body: SendSessionInputBody): Promise<void> => {
    pendingSends += 1;
    const run = queue
      .catch(() => undefined)
      .then(async () => {
        const ws = getWebSocket();
        if (ws?.readyState === openState) {
          sendSessionInputViaWebSocket(ws, body);
          return;
        }
        const result = await sendFallback(body).catch(() => ({
          ok: false,
          error: "Terminal input failed.",
          outcomeUnknown: false,
        }));
        if (!result.ok && isMounted()) {
          onInputRejected?.({
            message: result.error,
            retryable: result.outcomeUnknown !== true,
            outcomeUnknown: result.outcomeUnknown === true,
          });
        }
      });

    queue = run.finally(() => {
      pendingSends = Math.max(0, pendingSends - 1);
    });
    return queue;
  };

  return {
    send(body) {
      const ws = getWebSocket();
      if (pendingSends === 0 && ws?.readyState === openState) {
        sendSessionInputViaWebSocket(ws, body);
        return Promise.resolve();
      }
      return enqueue(body);
    },
    pendingCount() {
      return pendingSends;
    },
  };
}

export interface FocusedReconnectScheduler<TTimer> {
  schedule(connect: () => void): void;
  cancel(): void;
  resetAttempts(): void;
  dispose(): void;
  hasPendingTimer(): boolean;
}

export interface FocusedReconnectSchedulerOptions<TTimer> extends TimeoutScheduler<TTimer> {
  readonly shouldReconnect: () => boolean;
  readonly delaysMs?: readonly number[];
  readonly delayOffsetMs?: () => number;
}

export function createFocusedReconnectScheduler<TTimer>({
  shouldReconnect,
  setTimeout,
  clearTimeout,
  delaysMs = DEFAULT_RECONNECT_DELAYS_MS,
  delayOffsetMs = () => 0,
}: FocusedReconnectSchedulerOptions<TTimer>): FocusedReconnectScheduler<TTimer> {
  let disposed = false;
  let timer: TTimer | null = null;
  let attempts = 0;

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    schedule(connect) {
      if (disposed || !shouldReconnect() || timer !== null) {
        return;
      }
      const delay = (delaysMs[Math.min(attempts, delaysMs.length - 1)] ?? 5000) + delayOffsetMs();
      attempts += 1;
      let firedBeforeAssignment = false;
      let assigned = false;
      const nextTimer = setTimeout(() => {
        if (assigned) {
          timer = null;
        } else {
          firedBeforeAssignment = true;
        }
        if (!disposed && shouldReconnect()) {
          connect();
        }
      }, delay);
      assigned = true;
      timer = firedBeforeAssignment ? null : nextTimer;
    },
    cancel,
    resetAttempts() {
      attempts = 0;
    },
    dispose() {
      disposed = true;
      cancel();
    },
    hasPendingTimer() {
      return timer !== null;
    },
  };
}

export interface TerminalTransportController {
  connect(): Promise<void>;
  wake(): void;
  dispose(): void;
  sendInput(body: SendSessionInputBody): Promise<void>;
  sendResize(cols: number, rows: number): void;
  currentWebSocket(): TerminalTransportSocket | null;
}

export interface TerminalTransportControllerOptions<TTimer = number> extends Partial<TimeoutScheduler<TTimer>> {
  readonly machine: string;
  readonly id: string;
  readonly attachTarget: (machine: string, id: string, recovery?: boolean) => Promise<AttachTarget>;
  readonly createWebSocket: TerminalTransportSocketFactory;
  readonly sendFallback: (
    machine: string,
    id: string,
    body: SendSessionInputBody,
  ) => Promise<ApiResultLike>;
  readonly setStatus: (status: TerminalTransportStatus) => void;
  readonly shouldReconnect: () => boolean;
  readonly isMounted?: () => boolean;
  readonly onOpen?: () => void;
  readonly onOutputActivity?: () => void;
  readonly onMessageData?: (data: string | Uint8Array) => void;
  readonly onProviderPromptCapability?: (mode: ProviderPromptCapabilityMode) => void;
  readonly onProviderPromptEvent?: (event: ProviderPromptSubmittedFrame) => void;
  readonly onInputRejected?: (rejection: TerminalInputRejection) => void;
  readonly onDebugEvent?: (event: DebugEventInput) => void;
  readonly reconnectDelaysMs?: readonly number[];
  readonly reconnectDelayOffsetMs?: () => number;
  readonly providerPromptCapabilityTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

export function createTerminalTransportController<TTimer = number>({
  machine,
  id,
  attachTarget,
  createWebSocket,
  sendFallback,
  setStatus,
  shouldReconnect,
  isMounted = () => true,
  onOpen,
  onOutputActivity,
  onMessageData,
  onProviderPromptCapability,
  onProviderPromptEvent,
  onInputRejected,
  onDebugEvent,
  setTimeout: setTimer = defaultScheduler.setTimeout as TimeoutScheduler<TTimer>["setTimeout"],
  clearTimeout: clearTimer = defaultScheduler.clearTimeout as TimeoutScheduler<TTimer>["clearTimeout"],
  reconnectDelaysMs,
  reconnectDelayOffsetMs,
  providerPromptCapabilityTimeoutMs = PROVIDER_PROMPT_CAPABILITY_TIMEOUT_MS,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
}: TerminalTransportControllerOptions<TTimer>): TerminalTransportController {
  let disposed = false;
  let activeWs: TerminalTransportSocket | null = null;
  let ownedWs: TerminalTransportSocket | null = null;
  let providerPromptMode: ProviderPromptCapabilityMode | null = null;
  let providerPromptTimer: TTimer | null = null;
  let connectTimer: TTimer | null = null;
  let connectionAttempt = 0;
  let phase: "idle" | "connecting" | "open" = "idle";
  let recoveryRequested = false;

  const clearProviderPromptTimer = () => {
    if (providerPromptTimer !== null) {
      clearTimer(providerPromptTimer);
      providerPromptTimer = null;
    }
  };
  const clearConnectTimer = () => {
    if (connectTimer !== null) {
      clearTimer(connectTimer);
      connectTimer = null;
    }
  };
  const setProviderPromptMode = (mode: ProviderPromptCapabilityMode) => {
    if (providerPromptMode === mode) {
      return;
    }
    providerPromptMode = mode;
    onProviderPromptCapability?.(mode);
  };
  const armProviderPromptTimeout = (attempt: number) => {
    clearProviderPromptTimer();
    let firedBeforeAssignment = false;
    let assigned = false;
    const nextTimer = setTimer(() => {
      if (assigned) {
        providerPromptTimer = null;
      } else {
        firedBeforeAssignment = true;
      }
      if (!disposed && connectionAttempt === attempt && providerPromptMode === "pending") {
        setProviderPromptMode("fallback");
      }
    }, providerPromptCapabilityTimeoutMs);
    assigned = true;
    providerPromptTimer = firedBeforeAssignment ? null : nextTimer;
  };

  const reconnect = createFocusedReconnectScheduler<TTimer>({
    shouldReconnect: () => !disposed && shouldReconnect(),
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    delaysMs: reconnectDelaysMs,
    delayOffsetMs: reconnectDelayOffsetMs,
  });

  const inputSender = createOrderedSessionInputSender({
    getWebSocket: () => activeWs,
    sendFallback: (body) => sendFallback(machine, id, body),
    isMounted: () => !disposed && isMounted(),
    onInputRejected,
  });

  const markClosed = (ws: TerminalTransportSocket, attempt: number) => {
    if (connectionAttempt !== attempt || activeWs !== ws) {
      return;
    }
    activeWs = null;
    phase = "idle";
    clearConnectTimer();
    clearProviderPromptTimer();
    setProviderPromptMode("fallback");
    onDebugEvent?.({
      source: "ws",
      route: "/api/sessions/:machine/:id/attach",
      method: "WS",
      status: null,
      ok: false,
      machine,
      session_id: id,
      error: "closed",
    });
    setStatus("closed");
    reconnect.schedule(() => {
      void connect();
    });
  };

  const connect = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    const attempt = ++connectionAttempt;
    const recovery = recoveryRequested;
    recoveryRequested = false;
    phase = "connecting";
    reconnect.cancel();
    clearConnectTimer();
    const previousWs = activeWs;
    activeWs = null;
    previousWs?.close();
    setProviderPromptMode("pending");
    armProviderPromptTimeout(attempt);
    setStatus("connecting");
    onDebugEvent?.({
      source: "ws",
      route: "/api/sessions/:machine/:id/attach",
      method: "WS",
      status: null,
      ok: null,
      machine,
      session_id: id,
    });
    try {
      const target = await attachTarget(machine, id, recovery);
      if (disposed || connectionAttempt !== attempt) {
        return;
      }
      const ws = createWebSocket(target.url, target.protocols);
      activeWs = ws;
      ownedWs = ws;
      ws.binaryType = "arraybuffer";
      let firedBeforeAssignment = false;
      let assigned = false;
      const nextTimer = setTimer(() => {
        if (disposed || connectionAttempt !== attempt || activeWs !== ws || ws.readyState !== WEB_SOCKET_CONNECTING_STATE) return;
        if (assigned && connectTimer === nextTimer) connectTimer = null;
        else if (!assigned) firedBeforeAssignment = true;
        ws.close();
        markClosed(ws, attempt);
      }, connectTimeoutMs);
      assigned = true;
      connectTimer = firedBeforeAssignment ? null : nextTimer;
      ws.onopen = () => {
        if (disposed || connectionAttempt !== attempt || activeWs !== ws) {
          return;
        }
        try {
          ws.send(providerPromptSubscriptionFrame());
        } catch {
          markClosed(ws, attempt);
          return;
        }
        reconnect.resetAttempts();
        phase = "open";
        clearConnectTimer();
        setStatus("open");
        onDebugEvent?.({
          source: "ws",
          route: "/api/sessions/:machine/:id/attach",
          method: "WS",
          status: 101,
          ok: true,
          machine,
          session_id: id,
        });
        onOpen?.();
      };
      ws.onmessage = (ev: { data: unknown }) => {
        if (disposed || connectionAttempt !== attempt || activeWs !== ws) {
          return;
        }
        if (typeof ev.data === "string") {
          const providerFrame = parseProviderPromptServerFrame(ev.data);
          if (providerFrame) {
            if (providerFrame.kind === "capability") {
              if (providerFrame.supported) {
                clearProviderPromptTimer();
                setProviderPromptMode("supported");
              } else if (providerPromptMode === "pending") {
                clearProviderPromptTimer();
                setProviderPromptMode("fallback");
              }
              return;
            }
            if (providerFrame.kind === "prompt_submitted") {
              if (providerPromptMode === "supported") {
                onProviderPromptEvent?.(providerFrame);
              }
              return;
            }
            if (providerFrame.kind === "input_rejected") {
              onInputRejected?.({
                code: providerFrame.code,
                retryable: providerFrame.retryable,
                outcomeUnknown: false,
              });
              return;
            }
            return;
          }
          if (ev.data.length > 0) {
            onOutputActivity?.();
          }
          onMessageData?.(ev.data);
        } else if (ev.data instanceof ArrayBuffer) {
          if (ev.data.byteLength > 0) {
            onOutputActivity?.();
          }
          onMessageData?.(new Uint8Array(ev.data));
        }
      };
      ws.onclose = () => markClosed(ws, attempt);
      ws.onerror = () => {
        if (disposed || connectionAttempt !== attempt || activeWs !== ws) {
          return;
        }
        onDebugEvent?.({
          source: "ws",
          route: "/api/sessions/:machine/:id/attach",
          method: "WS",
          status: null,
          ok: false,
          machine,
          session_id: id,
          error: "socket error",
        });
        ws.close();
        markClosed(ws, attempt);
      };
    } catch {
      if (!disposed && connectionAttempt === attempt) {
        phase = "idle";
        clearProviderPromptTimer();
        setProviderPromptMode("fallback");
        onDebugEvent?.({
          source: "ws",
          route: "/api/sessions/:machine/:id/attach",
          method: "WS",
          status: null,
          ok: false,
          machine,
          session_id: id,
          error: "connect failed",
        });
        setStatus("closed");
        reconnect.schedule(() => {
          void connect();
        });
      }
    }
  };

  return {
    connect,
    wake() {
      if (disposed || phase === "open") return;
      recoveryRequested = true;
      if (shouldReconnect() && phase === "idle") void connect();
    },
    dispose() {
      disposed = true;
      phase = "idle";
      reconnect.dispose();
      clearProviderPromptTimer();
      clearConnectTimer();
      const ws = ownedWs;
      activeWs = null;
      ownedWs = null;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
    },
    sendInput(body) {
      return inputSender.send(body);
    },
    sendResize(cols, rows) {
      if (activeWs?.readyState === WEB_SOCKET_OPEN_STATE) {
        activeWs.send(resizeFrame(cols, rows));
      }
    },
    currentWebSocket() {
      return activeWs;
    },
  };
}

import { sessionKey } from "./layout.ts";
import { completionAcknowledgementKey, parseTurnStateV1 } from "./sessionActivity.ts";
import { resolveLocalStorage, safeGetItem, safeSetItem, type StorageLike } from "./storage.ts";
import type { DashboardSession } from "./types.ts";

// Device-local, opt-in alerts for sessions that start waiting on the user. They
// run only while the console is open: the sound works in every surface, and a
// system notification is added where the web Notification API exists (browsers,
// not the native WebView shells) and the console is in the background.

export const ATTENTION_ALERTS_STORAGE_KEY = "ac.attentionAlerts";

export function loadAttentionAlerts(storage?: StorageLike): boolean {
  return safeGetItem(resolveLocalStorage(storage), ATTENTION_ALERTS_STORAGE_KEY) === "1";
}

export function saveAttentionAlerts(enabled: boolean, storage?: StorageLike): boolean {
  return safeSetItem(resolveLocalStorage(storage), ATTENTION_ALERTS_STORAGE_KEY, enabled ? "1" : "0");
}

export type AttentionAlertKind = "needs-input" | "completed";

export interface AttentionAlert {
  // Identity of the exact request or completion, so one event alerts once.
  readonly key: string;
  readonly kind: AttentionAlertKind;
  readonly sessionKey: string;
  readonly title: string;
}

const SEPARATOR = "\u001f";

export function attentionAlertFor(session: DashboardSession): AttentionAlert | null {
  if (session.status !== "running") return null;
  const title = session.title?.trim() || "Untitled session";
  const completion = completionAcknowledgementKey(session);
  if (completion) {
    return { key: `completed${SEPARATOR}${completion}`, kind: "completed", sessionKey: sessionKey(session), title };
  }
  const state = parseTurnStateV1(session.turn_state);
  const attention = state?.phase === "needs_input" ? state.current_turn?.attention : undefined;
  // A conservative attention renders as "Input may be needed"; alerting on it
  // would train the user to ignore the sound.
  if (attention?.certainty !== "exact" || !attention.requested_at) return null;
  const key = ["needs-input", session.machine, session.id, session.session_incarnation ?? "", attention.requested_at]
    .join(SEPARATOR);
  return { key, kind: "needs-input", sessionKey: sessionKey(session), title };
}

export interface AttentionAlertTracker {
  observe(sessions: readonly DashboardSession[]): AttentionAlert[];
}

const MAX_REMEMBERED_ALERTS = 512;

// Reports alertable events that appeared since the previous snapshot. A session
// must have been listed before it can alert, so the first load, a newly enabled
// machine, or a newly listed session never replays events that already happened.
export function createAttentionAlertTracker(): AttentionAlertTracker {
  let known = new Set<string>();
  const alerted = new Set<string>();
  return {
    observe(sessions) {
      const alerts: AttentionAlert[] = [];
      const next = new Set<string>();
      for (const session of sessions) {
        const key = sessionKey(session);
        next.add(key);
        const alert = attentionAlertFor(session);
        if (!alert || alerted.has(alert.key)) continue;
        alerted.add(alert.key);
        if (alerted.size > MAX_REMEMBERED_ALERTS) {
          alerted.delete(alerted.values().next().value!);
        }
        if (known.has(key)) alerts.push(alert);
      }
      known = next;
      return alerts;
    },
  };
}

export interface AttentionAlertEnvironment {
  readonly hidden: boolean;
  readonly focusedSessionKey: string | null;
  readonly notificationPermission: NotificationPermission | "unsupported";
  readonly playSound: () => void;
  readonly notify: (title: string, body: string, tag: string) => void;
}

// Returns how many alerts were delivered.
export function deliverAttentionAlerts(
  alerts: readonly AttentionAlert[],
  env: AttentionAlertEnvironment,
): number {
  const deliverable = alerts.filter((alert) => env.hidden || alert.sessionKey !== env.focusedSessionKey);
  if (deliverable.length === 0) return 0;
  env.playSound();
  if (env.hidden && env.notificationPermission === "granted") {
    for (const alert of deliverable) {
      env.notify(alert.kind === "needs-input" ? "Needs input" : "Done", alert.title, alert.key);
    }
  }
  return deliverable.length;
}

export function browserNotificationPermission(): NotificationPermission | "unsupported" {
  try {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  } catch {
    return "unsupported";
  }
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (browserNotificationPermission() !== "default") return browserNotificationPermission();
  try {
    return await Notification.requestPermission();
  } catch {
    return browserNotificationPermission();
  }
}

export function showBrowserNotification(title: string, body: string, tag: string): void {
  try {
    new Notification(title, { body, tag });
  } catch {
    // Some embedded engines expose the constructor but refuse to show one.
  }
}

type AudioContextConstructor = new () => AudioContext;

// A short two-note chime synthesized on demand, so no audio asset ships with
// the bundle. Autoplay policy may keep the context suspended until the first
// user gesture; resuming on the next pointer or key press unlocks it.
export function createAlertChime(): () => void {
  let context: AudioContext | null = null;
  const ensure = (): AudioContext | null => {
    if (context) return context;
    const Ctor = (globalThis as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor })
      .AudioContext ?? (globalThis as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      context = new Ctor();
    } catch {
      return null;
    }
    if (typeof document !== "undefined") {
      const unlock = () => {
        void context?.resume().catch(() => undefined);
        document.removeEventListener("pointerdown", unlock, true);
        document.removeEventListener("keydown", unlock, true);
      };
      document.addEventListener("pointerdown", unlock, true);
      document.addEventListener("keydown", unlock, true);
    }
    return context;
  };
  ensure();
  return () => {
    const ctx = ensure();
    if (!ctx) return;
    void ctx.resume().catch(() => undefined);
    const start = ctx.currentTime + 0.01;
    for (const [offset, frequency] of [[0, 880], [0.16, 1318.5]] as const) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.3);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.32);
    }
  };
}

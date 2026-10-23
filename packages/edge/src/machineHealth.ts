// Per-machine reachability breaker for the session aggregation poll.
//
// The dashboard polls `/api/sessions` every few seconds and `aggregateSessions`
// fans out to every configured machine at once. A laptop spoke that is
// asleep or has moved networks black-holes its connection SYN, so a naive probe
// waits the full connect timeout on *every* poll — and because the fan-out
// awaits all machines, one sleeping spoke stalls the whole console (the hub's
// sessions included).
//
// This breaker records a machine as "open" (skip it) for a cooldown window after
// a probe that stalled, so subsequent polls fast-fail it without a network
// round-trip. Once the cooldown elapses the breaker is half-open: the next poll
// probes once and either recovers (success clears it) or re-opens (another
// stall). Failures that return quickly are NOT tripped — they don't stall the
// poll, so the machine stays probed: a reachable-but-erroring daemon (a fast
// non-200) surfaces its real error, and a restarting daemon (a refused
// connection) is back on its next probe instead of a cooldown later.

export interface MachineHealthOptions {
  readonly cooldownMs?: number;
  readonly stallMs?: number;
  readonly now?: () => number;
}

const DEFAULT_COOLDOWN_MS = 15_000;
// A failed probe shorter than this cost the poll too little to be worth skipping.
const DEFAULT_STALL_MS = 1_000;

export class MachineHealth {
  private readonly cooldownMs: number;
  private readonly stallMs: number;
  // The breaker's clock; callers time their probes with it.
  readonly now: () => number;
  // machine name -> epoch ms until which the breaker stays open (skip probing).
  private readonly openUntil = new Map<string, number>();

  constructor(options: MachineHealthOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.stallMs = options.stallMs ?? DEFAULT_STALL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  // Whether this machine should be probed on this poll. False only while its
  // breaker is open and the cooldown has not yet elapsed; true otherwise
  // (including half-open, once the cooldown passes — one probe is allowed).
  shouldProbe(name: string): boolean {
    const until = this.openUntil.get(name);
    if (until === undefined) {
      return true;
    }
    return this.now() >= until;
  }

  // A reachable machine: clear the breaker so it is probed normally.
  recordSuccess(name: string): void {
    this.openUntil.delete(name);
  }

  // A connection/timeout failure that took `elapsedMs`: open the breaker for the
  // cooldown window only if the probe stalled.
  recordFailure(name: string, elapsedMs: number): void {
    if (elapsedMs < this.stallMs) {
      return;
    }
    this.openUntil.set(name, this.now() + this.cooldownMs);
  }
}

import type { MachineConfig } from "../config.ts";
import { objectProp as object } from "../normalize.ts";
import {
  BOARD_CLOSED_SCHEMA,
  BOARD_RECORD_SCHEMA,
  BOARD_RETENTIONS,
  BOARD_SNAPSHOT_SCHEMA,
  projectBoardRecord,
  type BoardRecord,
  type BoardRetention,
} from "./record.ts";
import type { BoardStore } from "./store.ts";

// Board ingestion: polls every configured machine's `GET /board/v1` and
// `GET /board/closed/v1` with its operator bearer and folds them into
// board.sqlite. Board rows are peer data and may carry titles and paths, so
// nothing here writes to the browser debug ring or the process logger: a failed
// attempt only marks the machine unavailable.

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CURSOR_LENGTH = 1024;
const POLL_INTERVAL_MS = 30_000;
const POLL_JITTER_MS = 5_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

class IngestFailure extends Error {}
const fail = (): never => { throw new IngestFailure("board ingestion failed"); };

// Bounded transport matching the coordination relay: a hard deadline covering
// the body, a response size cap, and no redirects, so a daemon cannot bounce
// the operator bearer to an unconfigured destination.
async function getJson(machine: MachineConfig, path: string): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${machine.url}${path}`, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { authorization: `Bearer ${machine.token}`, accept: "application/json" },
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return fail();
      }
      chunks.push(chunk.value);
    }
    return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } finally {
    clearTimeout(timer);
  }
}

function cursor(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CURSOR_LENGTH ? value : fail();
}

// The envelope and every record must name the configured machine the response
// was fetched from; any mismatch rejects the whole response.
function payload(body: unknown, key: string, schema: string, machine: string): Record<string, unknown> {
  const root = object(body);
  const data = object(root?.data);
  const board = object(data?.[key]);
  if (
    root?.ok !== true || !data || !board
    || (data.machine !== undefined && data.machine !== machine)
    || board.machine !== machine
    || board.schema_version !== schema || board.record_schema !== BOARD_RECORD_SCHEMA
  ) return fail();
  return board;
}

// A record naming another machine rejects the whole response. Any other record
// outside the contract is skipped, like a daemon-side `skipped_count`, so one
// unusual session cannot take its machine offline.
function records(values: readonly unknown[], machine: string, kind: "snapshot" | "closed"): { records: BoardRecord[]; skipped: number } {
  const accepted: BoardRecord[] = [];
  for (const value of values) {
    if (object(value)?.machine !== machine) return fail();
    const projected = projectBoardRecord(value, machine, kind);
    if (projected) accepted.push(projected);
  }
  return { records: accepted, skipped: values.length - accepted.length };
}

type ClosedRead = { expired: true } | { expired: false; records: BoardRecord[]; next: string };

async function readClosed(machine: MachineConfig, since: string | null): Promise<ClosedRead> {
  const path = since === null ? "/board/closed/v1" : `/board/closed/v1?since=${encodeURIComponent(since)}`;
  const result = await getJson(machine, path);
  if (since !== null && result.status === 410 && object(object(result.body)?.error)?.code === "board-cursor-expired") {
    return { expired: true };
  }
  if (result.status !== 200) return fail();
  const closed = payload(result.body, "board_closed", BOARD_CLOSED_SCHEMA, machine.name);
  if (!Array.isArray(closed.entries)) return fail();
  const entries = (closed.entries as unknown[]).map((entry) => object(entry)?.record);
  // A skipped closed entry is left to the vanished rule, as a missed append is.
  return { expired: false, records: records(entries, machine.name, "closed").records, next: cursor(closed.next_cursor) };
}

async function readSnapshot(machine: MachineConfig): Promise<{ records: BoardRecord[]; complete: boolean }> {
  const result = await getJson(machine, "/board/v1");
  if (result.status !== 200) return fail();
  const board = payload(result.body, "board", BOARD_SNAPSHOT_SCHEMA, machine.name);
  const skipped = board.skipped_count;
  if (!Array.isArray(board.records) || !Number.isSafeInteger(skipped) || (skipped as number) < 0) return fail();
  const projected = records(board.records as unknown[], machine.name, "snapshot");
  return { records: projected.records, complete: skipped === 0 && projected.skipped === 0 };
}

export interface BoardAggregatorOptions {
  readonly retention: BoardRetention;
  readonly now?: () => number;
}

export class BoardAggregator {
  readonly #store: BoardStore;
  readonly #machines: readonly MachineConfig[];
  readonly #retentionMs: number;
  readonly #now: () => number;
  #pollTimer: NodeJS.Timeout | null = null;
  #pruneTimer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;
  #stopped = true;

  constructor(store: BoardStore, machines: readonly MachineConfig[], options: BoardAggregatorOptions) {
    this.#store = store;
    this.#machines = machines;
    this.#retentionMs = BOARD_RETENTIONS[options.retention];
    this.#now = options.now ?? Date.now;
  }

  /**
   * One ingestion attempt for one machine. Order per the spec: the closed
   * ledger from the stored cursor (or in full, with no cursor), then the
   * snapshot. `board-cursor-expired` discards the cursor and resyncs.
   */
  async ingestMachine(machine: MachineConfig): Promise<void> {
    try {
      const stored = this.#store.machineStatus(machine.name).cursor;
      let closed = await readClosed(machine, stored);
      if (closed.expired) {
        this.#store.clearCursor(machine.name);
        closed = await readClosed(machine, null);
        if (closed.expired) return fail();
      }
      this.#store.applyClosed(machine.name, closed.records, closed.next);
      const snapshot = await readSnapshot(machine);
      this.#store.applySnapshot(machine.name, snapshot.records, snapshot.complete, this.#now());
    } catch {
      try {
        this.#store.recordFailure(machine.name);
      } catch {
        // The store itself is unavailable; the next attempt retries.
      }
    }
  }

  async ingestAll(): Promise<void> {
    await Promise.all(this.#machines.map((machine) => this.ingestMachine(machine)));
  }

  prune(): void {
    try {
      this.#store.prune(this.#now(), this.#retentionMs, this.#machines.map((machine) => machine.name));
    } catch {
      // Retried on the next prune tick.
    }
  }

  /** Prunes and ingests immediately, then on jittered and hourly timers. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.prune();
    this.#pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.#pruneTimer.unref();
    this.#poll();
  }

  #poll(): void {
    if (this.#stopped) return;
    this.#inFlight = this.ingestAll().finally(() => {
      this.#inFlight = null;
      if (this.#stopped) return;
      this.#pollTimer = setTimeout(() => this.#poll(), POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_JITTER_MS));
      this.#pollTimer.unref();
    });
  }

  /** Stops the timers and resolves once any in-flight attempt has finished. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    if (this.#pruneTimer) clearInterval(this.#pruneTimer);
    this.#pollTimer = null;
    this.#pruneTimer = null;
    await this.#inFlight;
  }
}

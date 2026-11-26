import { createHash } from "node:crypto";
import type { MachineConfig } from "./config.ts";

const SCHEMA = "agent-session.console-resume-move.v1";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const UUID_V7 = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const NEXT_ACTION = {
  "resume-unsupported": "inspect_destination",
  "resume-account-mismatch": "inspect_destination",
  "resume-history-missing": "inspect_destination",
  "session-exists": "inspect_destination",
  "resume-source-live": "inspect_source",
  "resume-source-unknown": "inspect_source",
  "resume-move-source-fenced": "inspect_source",
  "resume-move-source-busy": "inspect_source",
  "resume-move-session-mismatch": "inspect_source",
  "resume-move-source-already-stopped": "inspect_source",
  "resume-move-proof-invalid": "inspect_destination",
  "resume-move-proof-expired": "inspect_destination",
  "resume-move-proof-missing": "inspect_destination",
  "resume-move-binding-mismatch": "inspect_destination",
  "resume-move-target-mismatch": "inspect_destination",
  "resume-move-path-mismatch": "inspect_destination",
  "resume-move-transcript-cwd-outside-checkout": "inspect_destination",
  "resume-move-history-stale": "inspect_destination",
  "resume-move-history-unsupported": "inspect_destination",
  "resume-move-destination-reserved": "inspect_destination",
  "resume-move-ssh-keygen-unavailable": "inspect_destination",
  "resume-move-trust-unavailable": "inspect_destination",
  "resume-move-signing-unavailable": "inspect_destination",
  "resume-move-state-unavailable": "inspect_destination",
  "resume-move-unavailable": "inspect_destination",
  "resume-move-destination-writer-present": "reconcile_destination",
  "resume-move-outcome-unknown": "reconcile_destination",
  "resume-move-aborted": "obtain_no_writer_receipt",
} as const;

type MoveCode = keyof typeof NEXT_ACTION;
type MoveState = "prepared" | "staged" | "writer_admitted" | "created" | "aborted_no_writer";
const STATES: ReadonlySet<unknown> = new Set<MoveState>(["prepared", "staged", "writer_admitted", "created", "aborted_no_writer"]);

interface MoveDetails {
  readonly move_id?: string;
  readonly state?: MoveState;
  readonly safe_to_retry: false;
  readonly session_created?: false;
  readonly next_action: (typeof NEXT_ACTION)[MoveCode];
}

export interface ResumeMoveRequest {
  readonly schema_version: typeof SCHEMA;
  readonly operation_id: string;
  readonly machine: string;
  readonly caller: { readonly session_id: string; readonly session_incarnation: string; readonly owner: string };
  readonly session: {
    readonly move_id: string;
    readonly agent: "codex" | "claude";
    readonly resume: string;
    readonly account: string;
    readonly cwd: string;
  };
}

interface MoveCreated {
  readonly machine: string;
  readonly move_id: string;
  readonly state: "created";
  readonly session_id: string;
  readonly session_incarnation: string;
}

interface WireReply {
  readonly status: number;
  readonly body: unknown;
}

export interface ResumeMoveReply extends WireReply {
  readonly body:
    | { readonly schema_version: typeof SCHEMA; readonly ok: true; readonly data: MoveCreated }
    | { readonly schema_version: typeof SCHEMA; readonly ok: false; readonly error: { readonly code: MoveCode; readonly details: MoveDetails } };
}

// Internal fixture seam only. No capability advertisement, transport binding,
// or status/expiry wire format is defined here.
export interface ResumeMoveDestination {
  connect(machine: MachineConfig, binding: {
    readonly originMachine: string;
    readonly callerId: string;
    readonly callerIncarnation: string;
    readonly owner: string;
  }): Promise<{
      readonly signer: string;
      inspect(moveId: string): Promise<{
        // Supply this only from independently verified proof evidence that
        // permits checking this move for a first submission.
        readonly proofExpiresAt: number | null;
        // A verified native result translated to the frozen start envelope.
        readonly outcome: WireReply | null;
      } | null>;
      forward(request: ResumeMoveRequest): Promise<WireReply | null>;
    } | null>;
}

export const unavailableResumeMoveDestination: ResumeMoveDestination = {
  async connect() { return null; },
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }

// JSON.parse checks syntax and types but discards duplicate members. Scan
// tokens in the validated input, comparing decoded keys per object, including
// escaped equivalents. Quoted braces and brackets are not structure.
function uniqueKeys(text: string): boolean {
  const tokens = /"(?:[^"\\]|\\.)*"|[{}\[\]]/gs;
  const colon = /\s*:/y;
  const stack: (Set<string> | null)[] = [];
  for (const token of text.matchAll(tokens)) {
    const value = token[0];
    if (value === "{") stack.push(new Set());
    else if (value === "[") stack.push(null);
    else if (value === "}" || value === "]") stack.pop();
    else {
      const keys = stack.at(-1);
      if (!keys) continue;
      colon.lastIndex = token.index + value.length;
      if (colon.test(text)) {
        const key = JSON.parse(value) as string;
        if (keys.has(key)) return false;
        keys.add(key);
      }
    }
  }
  return true;
}

export function parseResumeMoveRequest(bytes: Uint8Array): ResumeMoveRequest | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const root = object(JSON.parse(text));
    if (!root || !exact(root, ["schema_version", "operation_id", "machine", "caller", "session"])
      || root.schema_version !== SCHEMA || typeof root.operation_id !== "string" || !UUID_V7.test(root.operation_id)
      || !nonempty(root.machine)) return null;
    const caller = object(root.caller);
    const session = object(root.session);
    if (!caller || !exact(caller, ["session_id", "session_incarnation", "owner"])
      || !nonempty(caller.session_id) || !uuid(caller.session_incarnation) || !nonempty(caller.owner)
      || !session || !exact(session, ["move_id", "agent", "resume", "account", "cwd"])
      || !uuid(session.move_id) || (session.agent !== "codex" && session.agent !== "claude")
      || !uuid(session.resume) || !nonempty(session.account) || !nonempty(session.cwd)
      || !uniqueKeys(text)) return null;
    return root as unknown as ResumeMoveRequest;
  } catch { return null; }
}

export function resumeMoveDigest(request: ResumeMoveRequest): string {
  const { caller, machine, schema_version, session } = request;
  return createHash("sha256").update(JSON.stringify({
    caller: { owner: caller.owner, session_id: caller.session_id, session_incarnation: caller.session_incarnation },
    machine, schema_version,
    session: { account: session.account, agent: session.agent, cwd: session.cwd, move_id: session.move_id, resume: session.resume },
  })).digest("hex");
}

export function moveRefusal(status: number, code: MoveCode, moveId?: string, disposition: "not-created" | "unknown" = "not-created"): ResumeMoveReply {
  return { status, body: { schema_version: SCHEMA, ok: false, error: { code, details: {
    ...(moveId !== undefined ? { move_id: moveId } : {}),
    safe_to_retry: false,
    ...(disposition === "not-created" ? { session_created: false } : {}),
    next_action: disposition === "not-created" ? NEXT_ACTION[code] : "reconcile_destination",
  } } } };
}

export function projectResumeMoveReply(reply: WireReply | null, request: ResumeMoveRequest): ResumeMoveReply | null {
  if (!reply || !Number.isInteger(reply.status)) return null;
  const root = object(reply.body);
  const { move_id } = request.session;
  if (!root || root.schema_version !== SCHEMA) return null;
  if (root.ok === true && reply.status >= 200 && reply.status < 300 && exact(root, ["schema_version", "ok", "data"])) {
    const data = object(root.data);
    if (!data || !exact(data, ["machine", "move_id", "state", "session_id", "session_incarnation"])
      || data.machine !== request.machine || data.move_id !== move_id || data.state !== "created"
      || data.session_id !== `move-${move_id}` || !uuid(data.session_incarnation)) return null;
    return { status: reply.status, body: { schema_version: SCHEMA, ok: true, data: {
      machine: data.machine, move_id, state: "created", session_id: data.session_id, session_incarnation: data.session_incarnation,
    } } };
  }
  if (root.ok !== false || reply.status < 400 || reply.status >= 600 || !exact(root, ["schema_version", "ok", "error"])) return null;
  const error = object(root.error);
  const details = object(error?.details);
  if (!error || !exact(error, ["code", "details"]) || typeof error.code !== "string"
    || !Object.hasOwn(NEXT_ACTION, error.code) || !details || details.move_id !== move_id || details.safe_to_retry !== false) return null;
  if (!exact(details, ["move_id", "safe_to_retry", "next_action",
    ...(Object.hasOwn(details, "state") ? ["state"] : []),
    ...(Object.hasOwn(details, "session_created") ? ["session_created"] : [])])
    || (Object.hasOwn(details, "state") && !STATES.has(details.state))
    || (Object.hasOwn(details, "session_created") && details.session_created !== false)) return null;
  const code = error.code as MoveCode;
  const noCreate = details.session_created === false;
  const nextAction = noCreate ? NEXT_ACTION[code] : "reconcile_destination";
  if (details.next_action !== nextAction
    || (noCreate && (code === "resume-move-outcome-unknown" || details.state === "created" || details.state === "writer_admitted"))) return null;
  return { status: reply.status, body: { schema_version: SCHEMA, ok: false, error: { code, details: {
    move_id, safe_to_retry: false,
    ...(details.state !== undefined ? { state: details.state as MoveState } : {}),
    ...(noCreate ? { session_created: false } : {}),
    next_action: nextAction,
  } } } };
}

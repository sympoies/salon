// Session lineage, work references, and console role
// (nils-cli crates/agent-session/docs/specs/session-lineage-work-v1.md).
// The daemon records them once at create time; they are descriptive and never
// an authorization input. These are strict public projections: a malformed
// value is dropped as a whole, and unknown members never pass through.

export const SESSION_LINEAGE_SCHEMA = "agent-session.session-lineage.v1";

const MAX_REF_STRING = 512;
const MAX_LABEL = 64;
const MAX_ISSUES = 16;

/** A session identity: `(machine, session_id, session_created_at)`; the incarnation is audit only. */
export interface SessionLineageRef {
  readonly machine: string;
  readonly session_id: string;
  readonly session_created_at: string;
  readonly session_incarnation?: string;
}

export interface SessionLineageStarter {
  readonly kind: string;
  readonly via: string;
}

/** `parent` is null for a root (depth 0); `root` names the tree's first session. */
export interface SessionLineage {
  readonly schema_version: string;
  readonly parent: SessionLineageRef | null;
  readonly root: SessionLineageRef;
  readonly depth: number;
  readonly starter: SessionLineageStarter;
}

/** A later steward; readers use `adopted_by ?? lineage.parent` as the effective parent. */
export interface SessionLineageAdoption {
  readonly adopted_by: SessionLineageRef | null;
  readonly revision: number;
  readonly updated_at: string;
}

export interface SessionWorkRef {
  readonly provider: string;
  readonly repository: string;
  readonly number: number;
}

export interface SessionWork {
  readonly program: SessionWorkRef | null;
  readonly issues: readonly SessionWorkRef[];
  readonly inherited: boolean;
  readonly revision?: number;
}

/** `coordinator` marks an ops coordinator; several may hold it at once. */
export const SESSION_ROLES = ["coordinator", "domain-coordinator"] as const;
/** Public daemon role identifier; only SESSION_ROLES carry built-in semantics. */
export type SessionRole = string;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

export function normalizeSessionLineageRef(value: unknown): SessionLineageRef | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const machine = text(raw.machine, MAX_REF_STRING);
  const sessionId = text(raw.session_id, MAX_REF_STRING);
  const createdAt = text(raw.session_created_at, MAX_LABEL);
  if (!machine || !sessionId || !createdAt) return undefined;
  const incarnation = raw.session_incarnation === undefined || raw.session_incarnation === null
    ? undefined
    : text(raw.session_incarnation, MAX_REF_STRING);
  if (raw.session_incarnation !== undefined && raw.session_incarnation !== null && !incarnation) return undefined;
  return { machine, session_id: sessionId, session_created_at: createdAt, ...(incarnation ? { session_incarnation: incarnation } : {}) };
}

export function normalizeSessionLineageStarter(value: unknown): SessionLineageStarter | undefined {
  const raw = record(value);
  const kind = text(raw?.kind, MAX_LABEL);
  const via = text(raw?.via, MAX_LABEL);
  return kind && via ? { kind, via } : undefined;
}

export function normalizeSessionLineage(value: unknown): SessionLineage | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const schemaVersion = text(raw.schema_version, MAX_LABEL);
  const parent = raw.parent === null ? null : normalizeSessionLineageRef(raw.parent);
  const root = normalizeSessionLineageRef(raw.root);
  const depth = count(raw.depth);
  const starter = normalizeSessionLineageStarter(raw.starter);
  if (!schemaVersion || parent === undefined || !root || depth === undefined || !starter) return undefined;
  if ((parent === null) !== (depth === 0)) return undefined;
  return { schema_version: schemaVersion, parent, root, depth, starter };
}

export function normalizeSessionLineageAdoption(value: unknown): SessionLineageAdoption | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const adoptedBy = raw.adopted_by === null ? null : normalizeSessionLineageRef(raw.adopted_by);
  const revision = count(raw.revision);
  const updatedAt = text(raw.updated_at, MAX_LABEL);
  if (adoptedBy === undefined || revision === undefined || !updatedAt) return undefined;
  return { adopted_by: adoptedBy, revision, updated_at: updatedAt };
}

function normalizeSessionWorkRef(value: unknown): SessionWorkRef | undefined {
  const raw = record(value);
  const provider = text(raw?.provider, MAX_LABEL);
  const repository = text(raw?.repository, MAX_REF_STRING);
  const number = count(raw?.number);
  return provider && repository && number !== undefined && number > 0 ? { provider, repository, number } : undefined;
}

export function normalizeSessionWork(value: unknown): SessionWork | undefined {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.issues) || raw.issues.length > MAX_ISSUES || typeof raw.inherited !== "boolean") {
    return undefined;
  }
  const program = raw.program === null || raw.program === undefined ? null : normalizeSessionWorkRef(raw.program);
  const issues = raw.issues.map(normalizeSessionWorkRef);
  if (program === undefined || issues.some((issue) => issue === undefined)) return undefined;
  const revision = count(raw.revision);
  return {
    program,
    issues: issues as SessionWorkRef[],
    inherited: raw.inherited,
    ...(revision !== undefined ? { revision } : {}),
  };
}

export function normalizeSessionRole(value: unknown): SessionRole | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : undefined;
}

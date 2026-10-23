// Only stable, content-free daemon health fields may reach a browser debug view.
export function projectRuntimeHealth(body: unknown): {
  state: "available" | "degraded" | "unavailable";
  binary_version: string;
  executable_state: string;
  reasons: string[];
} | null {
  if (!body || typeof body !== "object") return null;
  const envelope = body as { ok?: unknown; data?: { runtime?: unknown } };
  if (envelope.ok !== true || !envelope.data?.runtime || typeof envelope.data.runtime !== "object") return null;
  const runtime = envelope.data.runtime as Record<string, unknown>;
  if (runtime.state !== "available" && runtime.state !== "degraded" && runtime.state !== "unavailable") return null;
  const version = typeof runtime.binary_version === "string"
    ? /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(runtime.binary_version)?.[0]
    : undefined;
  if (!version || typeof runtime.executable_state !== "string"
    || !/^[a-z][a-z0-9_-]{0,31}$/.test(runtime.executable_state)) return null;
  if (!Array.isArray(runtime.reasons) || runtime.reasons.length > 8
    || !runtime.reasons.every((reason) => typeof reason === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(reason))) return null;
  return {
    state: runtime.state,
    binary_version: version,
    executable_state: runtime.executable_state,
    reasons: runtime.reasons,
  };
}

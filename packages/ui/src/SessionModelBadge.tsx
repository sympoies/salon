import { normalizeSessionModelSettings, sessionModelLabel, type SessionModelSettings } from "@agent-console/shared/session-model";
import type { AgentSessionContextUsage } from "@agent-console/shared/api";
import { formatContextUsage } from "./contextUsage.ts";

type SessionModelDisplay = SessionModelSettings & {
  readonly context_usage?: AgentSessionContextUsage | null;
  readonly turn_state?: { readonly phase?: string } | null;
};

export function SessionModelBadge({ session }: { readonly session: SessionModelDisplay }) {
  const label = sessionModelLabel(session);
  const settings = normalizeSessionModelSettings(session);
  const usage = formatContextUsage(session.context_usage, Date.now(), session.turn_state?.phase === "working");
  const title = [`Model · reasoning effort: ${label}`, usage?.title].filter(Boolean).join("\n");
  return (
    <span className="slot-meta session-model-badge" title={title} aria-label={`${label}${usage ? ` ${usage.text}` : ""}`} style={{ display: "flex" }}>
      <span className="session-model-name">{settings.model ?? "unknown"}</span>
      <span className="session-model-effort">{` · ${settings.reasoning_effort ?? "unknown"}`}</span>
      {usage ? (
        <span data-context-usage="true" style={{ flex: "none", whiteSpace: "nowrap", ...(usage.stale ? { opacity: 0.55 } : {}) }}>
          <span data-context-sep="true">{" · "}</span>
          {usage.percentText}
          <span data-context-tokens="true">{` ${usage.tokensText}`}</span>
        </span>
      ) : null}
    </span>
  );
}

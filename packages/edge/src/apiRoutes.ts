import { matchPath } from "./http.ts";

interface ApiRouteSpec {
  readonly id: string;
  readonly pattern: string;
  readonly methods: readonly string[];
  readonly params: readonly string[];
}

const API_ROUTES = [
  { id: "debug", pattern: "/api/debug/events", methods: ["GET"], params: [] },
  { id: "debug", pattern: "/api/debug/bundle", methods: ["GET"], params: [] },
  { id: "shell", pattern: "/api/shells/:machine", methods: ["GET", "POST", "DELETE"], params: ["machine"] },
  { id: "shell-ticket", pattern: "/api/shells/:machine/:incarnation/attach-ticket", methods: ["POST"], params: ["machine", "incarnation"] },
  { id: "machines", pattern: "/api/machines", methods: ["GET"], params: [] },
  { id: "machine-preferences", pattern: "/api/machine-preferences", methods: ["GET"], params: [] },
  { id: "machine-preference", pattern: "/api/machine-preferences/:machine", methods: ["PUT"], params: ["machine"] },
  { id: "runtime-health", pattern: "/api/machines/:machine/runtime/health", methods: ["GET"], params: ["machine"] },
  { id: "speech-providers", pattern: "/api/speech/providers", methods: ["GET"], params: [] },
  { id: "speech-engines", pattern: "/api/speech/:provider/engines", methods: ["GET"], params: ["provider"] },
  { id: "speech-transcription", pattern: "/api/speech/:provider/transcriptions", methods: ["POST"], params: ["provider"] },
  { id: "title-summary", pattern: "/api/title-summary", methods: ["POST"], params: [] },
  {
    id: "retitle-readiness",
    pattern: "/api/machines/:machine/retitle/readiness",
    methods: ["GET"],
    params: ["machine"],
  },
  {
    id: "retitle-v3-readiness",
    pattern: "/api/sessions/:machine/:id/retitle-v3/readiness",
    methods: ["GET"],
    params: ["machine", "id"],
  },
  { id: "workdirs", pattern: "/api/machines/:machine/workdirs", methods: ["GET"], params: ["machine"] },
  { id: "repo-url", pattern: "/api/machines/:machine/repo-url", methods: ["GET"], params: ["machine"] },
  // `:provider` is an account provider (`codex` or `claude`); others are 404.
  {
    id: "accounts",
    pattern: "/api/machines/:machine/:provider/accounts",
    methods: ["GET"],
    params: ["machine", "provider"],
  },
  { id: "sessions", pattern: "/api/sessions", methods: ["GET"], params: [] },
  { id: "board", pattern: "/api/board", methods: ["GET"], params: [] },
  { id: "history-sessions", pattern: "/api/history/sessions", methods: ["GET"], params: [] },
  {
    id: "history-messages",
    pattern: "/api/history/sessions/:machine/:id/messages",
    methods: ["GET"],
    params: ["machine", "id"],
  },
  {
    id: "history-star",
    pattern: "/api/history/sessions/:machine/:id/star",
    methods: ["POST"],
    params: ["machine", "id"],
  },
  {
    id: "history-resume",
    pattern: "/api/history/sessions/:machine/:id/resume",
    methods: ["POST"],
    params: ["machine", "id"],
  },
  { id: "history-image", pattern: "/api/history/sessions/:machine/:id/images/:image", methods: ["GET"], params: ["machine", "id", "image"] },
  { id: "resource-events", pattern: "/api/resources/events", methods: ["GET"], params: [] },
  { id: "activity-events", pattern: "/api/activity/events", methods: ["GET"], params: [] },
  { id: "usage", pattern: "/api/usage", methods: ["GET"], params: [] },
  { id: "codex-rate-limit-reset", pattern: "/api/codex/rate-limit-reset", methods: ["POST"], params: [] },
  { id: "claude-limit-reset", pattern: "/api/claude/limit-reset", methods: ["POST"], params: [] },
  { id: "layout", pattern: "/api/layout", methods: ["GET", "PUT"], params: [] },
  { id: "glance", pattern: "/api/sessions/:machine/:id/glance", methods: ["GET"], params: ["machine", "id"] },
  { id: "buffer", pattern: "/api/sessions/:machine/:id/buffer", methods: ["GET"], params: ["machine", "id"] },
  {
    id: "attach-ticket",
    pattern: "/api/sessions/:machine/:id/attach-ticket",
    methods: ["POST"],
    params: ["machine", "id"],
  },
  { id: "send", pattern: "/api/sessions/:machine/:id/send", methods: ["POST"], params: ["machine", "id"] },
  { id: "outbox", pattern: "/api/sessions/:machine/:id/outbox", methods: ["GET", "PATCH"], params: ["machine", "id"] },
  { id: "outbox-item", pattern: "/api/sessions/:machine/:id/outbox/:intent", methods: ["GET", "PUT", "PATCH"], params: ["machine", "id", "intent"] },
  {
    id: "prompt-receipt",
    pattern: "/api/sessions/:machine/:id/prompt/v2/receipts/:requestId",
    methods: ["GET"],
    params: ["machine", "id", "requestId"],
  },
  {
    id: "fenced-structured-prompt",
    pattern: "/api/sessions/:machine/:id/prompt/v2",
    methods: ["POST"],
    params: ["machine", "id"],
  },
  {
    id: "structured-prompt",
    pattern: "/api/sessions/:machine/:id/prompt",
    methods: ["POST"],
    params: ["machine", "id"],
  },
  { id: "resume", pattern: "/api/sessions/:machine/:id/resume", methods: ["POST"], params: ["machine", "id"] },
  {
    id: "archive-session",
    pattern: "/api/sessions/:machine/:id/archive",
    methods: ["POST"],
    params: ["machine", "id"],
  },
  {
    id: "maintenance-preview",
    pattern: "/api/sessions/:machine/:id/maintenance",
    methods: ["GET"],
    params: ["machine", "id"],
  },
  {
    id: "maintenance-actions",
    pattern: "/api/sessions/:machine/:id/maintenance/actions",
    methods: ["POST"],
    params: ["machine", "id"],
  },
  {
    id: "auto-resume",
    pattern: "/api/sessions/:machine/:id/auto-resume",
    methods: ["GET", "PUT", "DELETE"],
    params: ["machine", "id"],
  },
  {
    id: "session-account",
    pattern: "/api/sessions/:machine/:id/account",
    methods: ["PUT"],
    params: ["machine", "id"],
  },
  {
    id: "attachments",
    pattern: "/api/sessions/:machine/:id/attachments",
    methods: ["POST"],
    params: ["machine", "id"],
  },
  {
    id: "session-retitle",
    pattern: "/api/sessions/:machine/:id/retitle",
    methods: ["POST"],
    params: ["machine", "id"],
  },
  {
    id: "session-retitle-v3",
    pattern: "/api/sessions/:machine/:id/retitle-v3",
    methods: ["POST"],
    params: ["machine", "id"],
  },
  {
    id: "session-retitle-v3-receipts",
    pattern: "/api/sessions/:machine/:id/retitle-v3/operations",
    methods: ["GET"],
    params: ["machine", "id"],
  },
  {
    id: "session-retitle-v3-operation",
    pattern: "/api/sessions/:machine/:id/retitle-v3/operations/:operation",
    methods: ["GET"],
    params: ["machine", "id", "operation"],
  },
  {
    id: "session-refresh",
    pattern: "/api/sessions/:machine/:id/refresh",
    methods: ["POST"],
    params: ["machine", "id"],
  },
  { id: "display-metadata", pattern: "/api/sessions/:machine/:id/display-metadata", methods: ["POST"], params: ["machine", "id"] },
  { id: "session-item", pattern: "/api/sessions/:machine/:id", methods: ["PATCH", "DELETE"], params: ["machine", "id"] },
  { id: "create-session", pattern: "/api/sessions/:machine", methods: ["POST"], params: ["machine"] },
] as const satisfies readonly ApiRouteSpec[];

type ApiRouteId = (typeof API_ROUTES)[number]["id"];

interface ApiRouteMatch {
  readonly id: ApiRouteId;
  readonly methodAllowed: boolean;
  readonly params: Readonly<Record<string, string>>;
}

export function matchApiRoute(path: string, method: string): ApiRouteMatch | null {
  for (const route of API_ROUTES) {
    const matched = matchPath(route.pattern, path);
    if (!matched) {
      continue;
    }
    const params: Record<string, string> = {};
    for (const key of route.params) {
      const value = matched[key];
      if (value === undefined) {
        return null;
      }
      params[key] = value;
    }
    return {
      id: route.id,
      methodAllowed: (route.methods as readonly string[]).includes(method),
      params,
    };
  }
  return null;
}

export function routeParam(match: ApiRouteMatch, name: string): string {
  const value = match.params[name];
  if (value === undefined) {
    throw new Error(`route param missing: ${name}`);
  }
  return value;
}

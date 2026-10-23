import { startEdge } from "./start.ts";

// agent-console edge backend (Task 3.1). Loopback-only by default: it sits behind
// an HTTPS reverse proxy and is never exposed directly. It aggregates every
// configured machine's `agent-session serve` daemon, injects each machine's
// bearer token, presents one client-facing token (traded for an httpOnly session
// cookie so the WebSocket attach authenticates without a token in the URL), and
// serves the built UI from packages/ui/dist.
// This is core's own entry; the private distribution starts the edge from
// packages/overlay/src/main/edge.ts.
startEdge(process.env);

import { createServer, type Server } from "node:http";
import { CAPABILITIES, CHART_IMAGE_ID, MACHINE, SESSIONS, daemonSession, historySession } from "./fixture.ts";

/** A stand-in for the agent-session daemon that serves only the synthetic scenario. */
export interface FakeDaemon {
  readonly url: string;
  readonly unhandled: string[];
  close(): Promise<void>;
}

export async function startFakeDaemon(chart: Buffer): Promise<FakeDaemon> {
  const unhandled: string[] = [];
  const json = (res: import("node:http").ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ schema_version: "cli.agent-session.serve.v1", ok: status < 400, data }));
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://daemon");
    const path = url.pathname;
    if (req.method === "GET" && path === "/sessions") return json(res, { machine: MACHINE, capabilities: CAPABILITIES, sessions: SESSIONS.map(daemonSession) });
    if (req.method === "GET" && path === "/history/sessions") {
      const wanted = url.searchParams.get("q");
      const sessions = SESSIONS.filter(session => !wanted || `thread-${session.id}` === wanted).map(historySession);
      return json(res, { machine: MACHINE, sessions, next_cursor: null, truncated: false });
    }
    const messages = /^\/history\/sessions\/([^/]+)\/messages$/.exec(path);
    if (req.method === "GET" && messages) {
      const session = SESSIONS.find(candidate => candidate.history === decodeURIComponent(messages[1]!));
      return session ? json(res, { machine: MACHINE, messages: session.messages, next_cursor: null, older_cursor: null }) : json(res, {}, 404);
    }
    const image = /^\/history\/sessions\/([^/]+)\/images\/([^/]+)$/.exec(path);
    if (req.method === "GET" && image && decodeURIComponent(image[2]!) === CHART_IMAGE_ID) {
      res.writeHead(200, { "content-type": "image/png", "content-length": chart.byteLength, "content-disposition": "inline; filename=\"broker-connections.png\"" });
      return void res.end(chart);
    }
    unhandled.push(`${req.method} ${req.url}`);
    json(res, { code: "not-found" }, 404);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`, unhandled,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

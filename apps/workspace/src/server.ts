import { fileURLToPath } from "node:url";
import { startEdge } from "@agent-console/edge/start";

export function startWorkspaceEdge({ daemonToken, clientToken }: { daemonToken: string; clientToken: string }) {
  // This object belongs to edge configuration only, never process.env. The
  // daemon was launched with a separate environment before edge starts.
  return startEdge({
    AGENT_CONSOLE_EDGE_HOST: "0.0.0.0",
    AGENT_CONSOLE_EDGE_PORT: "3000",
    AGENT_CONSOLE_UI_DIR: fileURLToPath(new URL("../dist", import.meta.url)),
    AGENT_CONSOLE_TOKEN: clientToken,
    AGENT_CONSOLE_INSECURE_COOKIE: "1",
    AGENT_CONSOLE_MACHINES: JSON.stringify([
      { name: "workspace", url: "http://127.0.0.1:8781", token: daemonToken },
    ]),
  });
}

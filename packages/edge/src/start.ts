import { loadConfig } from "./config.ts";
import { createEdgeServer, type EdgeServer, type EdgeServerOptions } from "./server.ts";

// Start the edge from an environment. The core entry (index.ts) and the
// distribution entries call this; neither builds the server itself. A
// distribution passes its edge extensions in `options` (#918).
export function startEdge(env: NodeJS.ProcessEnv, options: EdgeServerOptions = {}, onShutdown?: () => Promise<void>): EdgeServer {
  // A single shared process fronts every live terminal, so a stray socket/stream
  // error must never take it down. Log and continue.
  process.on("uncaughtException", (err) => {
    console.error("edge uncaughtException:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("edge unhandledRejection:", reason);
  });

  // Principals may hold the permissions the extensions declare.
  const config = loadConfig(env, { extraPermissions: (options.extensions ?? []).flatMap((extension) => extension.permissions ?? []) });
  const server = createEdgeServer(config, options);

  let stopping = false;
  const signal = () => {
    if (stopping) process.exit(1);
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    void Promise.all([server.shutdown(), onShutdown?.()]).then(() => {
      clearTimeout(deadline);
      process.exit(0);
    }, error => {
      console.error("edge shutdown failed:", error);
      process.exit(1);
    });
  };
  process.on("SIGTERM", signal);
  process.on("SIGINT", signal);
  server.once("close", () => { if (!stopping) { process.off("SIGTERM", signal); process.off("SIGINT", signal); } });

  server.listen(config.port, config.host, () => {
    const names = config.machines.map((m) => m.name).join(", ") || "(none configured)";
    console.log(`agent-console edge listening on http://${config.host}:${config.port}`);
    console.log(`  machines: ${names}`);
    console.log(`  ui dir:   ${config.uiDir}`);
  });
  return server;
}

import { fileURLToPath } from "node:url";
import { consoleViteConfig } from "@agent-console/ui/vite";

export default consoleViteConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  outDir: "dist",
  publicDir: fileURLToPath(new URL("../../assets/brand", import.meta.url)),
  appVersion: "0.1.0",
});

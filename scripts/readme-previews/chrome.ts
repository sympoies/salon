import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/** Headless Chrome driven over the DevTools protocol. Only what the preview capture needs. */
export interface Page {
  navigate(url: string): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  setViewport(width: number, height: number, scale: number, mobile?: boolean): Promise<void>;
  /** Run a script in every document before the page's own scripts. */
  addInitScript(source: string): Promise<void>;
  /** Fix the time zone and the language the page sees, so the images do not depend on the machine. */
  setEnvironment(timezoneId: string, locale: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

export function chromeBinary(): string {
  return process.env.CHROME_BIN || "google-chrome";
}

export async function launchPage(): Promise<Page> {
  // Chrome's profile directory must have a short path: it holds a unix socket.
  const profile = mkdtempSync("/tmp/salon-preview-");
  const child: ChildProcess = spawn(chromeBinary(), [
    "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--mute-audio",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--force-color-profile=srgb", "--lang=en-US", "about:blank",
  ], { stdio: "ignore", env: { ...process.env, TMPDIR: "/tmp" } });
  const port = await new Promise<number>(async (resolve, reject) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { resolve(Number(readFileSync(`${profile}/DevToolsActivePort`, "utf8").split("\n")[0])); return; }
      catch { await sleep(100); }
    }
    reject(new Error("Chrome did not expose a DevTools port"));
  });
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let attempt = 0; attempt < 50 && !target; attempt++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
    target = list.find(entry => entry.type === "page");
    if (!target) await sleep(100);
  }
  if (!target) throw new Error("Chrome has no page target");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("DevTools connection failed")); });
  let nextId = 1;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const loaded: (() => void)[] = [];
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)!; pending.delete(message.id);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    } else if (message.method === "Page.loadEventFired") for (const waiter of loaded.splice(0)) waiter();
  };
  const send = <T>(method: string, params: object = {}) => new Promise<T>((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  await send("Page.enable");
  await send("Runtime.enable");
  return {
    async navigate(url) {
      const done = new Promise<void>(resolve => loaded.push(resolve));
      await send("Page.navigate", { url }); await done;
    },
    async evaluate<T>(expression: string) {
      const result = await send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
        "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    async setViewport(width, height, scale, mobile = false) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile });
      await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
    },
    async addInitScript(source) { await send("Page.addScriptToEvaluateOnNewDocument", { source }); },
    async setEnvironment(timezoneId, locale) {
      await send("Emulation.setTimezoneOverride", { timezoneId });
      await send("Emulation.setLocaleOverride", { locale });
    },
    async screenshot() {
      const { data } = await send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      return Buffer.from(data, "base64");
    },
    async close() {
      socket.close(); child.kill("SIGKILL");
      await new Promise(resolve => child.once("exit", resolve));
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

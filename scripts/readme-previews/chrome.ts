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

export interface LaunchOptions {
  /** How long to wait for Chrome to expose its DevTools port. */
  readonly portWaitMs?: number;
}

export function chromeBinary(): string {
  return process.env.CHROME_BIN || "google-chrome";
}

const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * Kill a browser, wait until it is gone, then remove its profile directory.
 * Safe to call more than once and for a child that has already exited, whose
 * exit event will not fire again.
 */
export async function stopBrowser(child: ChildProcess, profile: string): Promise<void> {
  if (!hasExited(child)) {
    const gone = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await gone;
  }
  rmSync(profile, { recursive: true, force: true });
}

export async function launchPage(options: LaunchOptions = {}): Promise<Page> {
  // Chrome's profile directory must have a short path: it holds a unix socket.
  const profile = mkdtempSync("/tmp/salon-preview-");
  const child: ChildProcess = spawn(chromeBinary(), [
    "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--mute-audio",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--force-color-profile=srgb", "--lang=en-US", "about:blank",
  ], { stdio: "ignore", env: { ...process.env, TMPDIR: "/tmp" } });
  let spawnError: Error | undefined;
  child.once("error", error => { spawnError = error; });
  let socket: WebSocket | undefined;
  try {
    const attempts = Math.max(1, Math.ceil((options.portWaitMs ?? 10_000) / 100));
    let port: number | undefined;
    for (let attempt = 0; attempt < attempts && port === undefined; attempt++) {
      if (spawnError) throw spawnError;
      if (hasExited(child)) throw new Error("Chrome exited before it exposed a DevTools port");
      try { port = Number(readFileSync(`${profile}/DevToolsActivePort`, "utf8").split("\n")[0]); }
      catch { await sleep(100); }
    }
    if (port === undefined) throw new Error("Chrome did not expose a DevTools port");
    let target: { webSocketDebuggerUrl: string } | undefined;
    for (let attempt = 0; attempt < 50 && !target; attempt++) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
      target = list.find(entry => entry.type === "page");
      if (!target) await sleep(100);
    }
    if (!target) throw new Error("Chrome has no page target");
    const connection = new WebSocket(target.webSocketDebuggerUrl);
    socket = connection;
    await new Promise<void>((resolve, reject) => { connection.onopen = () => resolve(); connection.onerror = () => reject(new Error("DevTools connection failed")); });
    let nextId = 1;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    const loaded: { resolve(): void; reject(error: Error): void }[] = [];
    const lost = (reason: string) => {
      for (const entry of [...pending.values(), ...loaded.splice(0)]) entry.reject(new Error(reason));
      pending.clear();
    };
    connection.onclose = () => lost("The DevTools connection closed");
    connection.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id)!; pending.delete(message.id);
        message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
      } else if (message.method === "Page.loadEventFired") for (const waiter of loaded.splice(0)) waiter.resolve();
    };
    const send = <T>(method: string, params: object = {}) => new Promise<T>((resolve, reject) => {
      const id = nextId++; pending.set(id, { resolve, reject }); connection.send(JSON.stringify({ id, method, params }));
    });
    await send("Page.enable");
    await send("Runtime.enable");
    return {
      async navigate(url) {
        const done = new Promise<void>((resolve, reject) => loaded.push({ resolve, reject }));
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
        connection.onclose = null; connection.close();
        await stopBrowser(child, profile);
      },
    };
  } catch (error) {
    // Setup failed before the caller got a handle, so nobody else can clean up.
    if (socket) { socket.onclose = null; socket.close(); }
    await stopBrowser(child, profile);
    throw error;
  }
}

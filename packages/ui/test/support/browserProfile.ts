import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

export const hasBrowserExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * Kill a browser, wait until it is gone, then remove its profile directory.
 * Safe to call more than once and for a child that has already exited, whose
 * exit event will not fire again.
 */
export async function stopBrowser(child: ChildProcess, profile: string): Promise<void> {
  if (child.pid !== undefined && !hasBrowserExited(child)) {
    const gone = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
    child.kill("SIGKILL");
    await gone;
  }

  // Chrome's subprocesses can still finish profile writes after the main process exits.
  const maxRetries = 5;
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(profile, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === maxRetries || (code !== "ENOTEMPTY" && code !== "EBUSY")) throw error;
      await sleep((attempt + 1) * 100);
    }
  }
}

import { spawnSync } from "node:child_process";

// Shared by the release entrypoint and its pack step so nested failures retain
// their command and stderr rather than leaking Node's raw subprocess result.
export function releaseStep(command: string, args: string[], options: { cwd: string; inherit?: boolean; maxBuffer?: number }): Buffer {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: ["ignore", options.inherit ? "inherit" : "pipe", "pipe"],
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const status = result.signal ? `signal ${result.signal}` : result.status !== null ? `exit status ${result.status}` : "could not start";
    const step = [command, ...args].map(value => JSON.stringify(value)).join(" ");
    const stderr = result.stderr?.subarray(-4096).toString("utf8").trim() || "(no stderr captured)";
    throw new Error([
      `Release step failed: ${step} (${status}${result.error ? `; ${result.error.message}` : ""}).`,
      `Stderr tail:\n${stderr}`,
      "For a transient provider failure, rerun with the same approved source and notes; existing releases are verified without replacement.",
    ].join("\n"));
  }
  if (options.inherit && result.stderr?.length) process.stderr.write(result.stderr);
  return result.stdout ?? Buffer.alloc(0);
}

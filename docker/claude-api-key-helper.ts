import { randomBytes } from "node:crypto";
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const apiKeyHelper = 'cat -- "$CLAUDE_CONFIG_DIR/api-key"';

async function updateSettings(configDir: string, operation: "add" | "remove") {
  const target = await realpath(join(configDir, "settings.json"));
  const settings: Record<string, unknown> = JSON.parse(await readFile(target, "utf8"));
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Expected a settings object");
  }

  if (Object.hasOwn(settings, "apiKeyHelper") && settings.apiKeyHelper !== apiKeyHelper) {
    console.error("Claude settings already use a different API-key helper. Edit settings.json to change it.");
    process.exitCode = 1;
    return;
  }

  if (operation === "add") {
    if (settings.apiKeyHelper === apiKeyHelper) return;
    settings.apiKeyHelper = apiKeyHelper;
  } else {
    if (!Object.hasOwn(settings, "apiKeyHelper")) return;
    delete settings.apiKeyHelper;
  }

  const mode = (await stat(target)).mode & 0o777;
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await chmod(temporary, mode);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

const [operation, ...extra] = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR;
if (!configDir || (operation !== "add" && operation !== "remove") || extra.length) {
  console.error("Set CLAUDE_CONFIG_DIR and run claude-api-key-helper.ts with add or remove.");
  process.exitCode = 1;
} else {
  try {
    await updateSettings(configDir, operation);
  } catch {
    console.error("Could not update Claude settings. Check that settings.json exists, contains a JSON object, and is writable.");
    process.exitCode = 1;
  }
}

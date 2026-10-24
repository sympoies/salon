import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = path => JSON.parse(readFileSync(path, "utf8"));

test("installed compiled core starts an authenticated edge and composes a generic UI", { timeout: 180_000 }, () => {
  const temporary = mkdtempSync("/tmp/core-package-consumer-");
  const consumer = join(temporary, "consumer");
  const env = { ...process.env, TMPDIR: "/tmp" };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  for (const key of Object.keys(env)) if (key.startsWith("AGENT_CONSOLE_")) delete env[key];
  const run = (command, args, cwd = consumer) => execFileSync(command, args, {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
  });
  try {
    mkdirSync(consumer);
    const packs = join(temporary, "packs");
    run(process.execPath, [join(root, "scripts/pack-core.mjs"), packs], root);
    const provenance = readJson(join(packs, "manifest.json"));
    assert.equal(provenance.sourceCommit, run("git", ["rev-parse", "HEAD"], root).trim());
    assert.equal(provenance.packages.length, 3);
    for (const pkg of provenance.packages) {
      const bytes = readFileSync(join(packs, pkg.asset));
      assert.equal(pkg.bytes, bytes.length);
      assert.equal(pkg.sha256, createHash("sha256").update(bytes).digest("hex"));
      console.log(`${pkg.asset} sha256 ${pkg.sha256}`);
    }
    const ui = readJson(join(root, "packages/ui/package.json"));
    const dependencies = Object.fromEntries(["shared", "edge", "ui"].map(name => [`@agent-console/${name}`, `file:../packs/${name}.tgz`]));
    const devDependencies = Object.fromEntries(["typescript", "vite", "@types/node", "@types/react", "@types/react-dom"].map(name => [name, ui.devDependencies[name]]));
    writeFileSync(join(consumer, "package.json"), JSON.stringify({
      name: "generic-package-consumer", version: "0.0.0", private: true, type: "module",
      packageManager: readJson(join(root, "package.json")).packageManager,
      dependencies: { ...dependencies, react: ui.dependencies.react, "react-dom": ui.dependencies["react-dom"] },
      devDependencies,
    }, null, 2));
    writeFileSync(join(consumer, "pnpm-workspace.yaml"), "overrides:\n" + ["shared", "edge", "ui"].map(name => `  '@agent-console/${name}': 'file:../packs/${name}.tgz'\n`).join(""));
    run("pnpm", ["install", "--ignore-scripts", "--config.node-linker=hoisted"]);
    // Node 24 rejects TypeScript modules in node_modules on the source-only base.
    run(process.execPath, ["--input-type=module", "--eval", "await import('@agent-console/edge/start')"]);
    for (const name of ["shared", "edge", "ui"]) {
      const installed = realpathSync(join(consumer, "node_modules/@agent-console", name));
      assert.ok(installed.startsWith(`${consumer}/`), `${name} escaped the isolated consumer`);
      const payload = readdirSync(installed, { recursive: true });
      assert.ok(payload.some(path => path.endsWith(".d.ts")), `${name} has no declarations`);
      assert.ok(!payload.some(path => /\.tsx?$/.test(path) && !path.endsWith(".d.ts")), `${name} ships TypeScript source`);
      assert.ok(payload.includes("dist-package/LICENSE"), `${name} omits the root license`);
    }
    for (const notice of ["OFL.txt", "NERD-FONTS-LICENSE"]) {
      assert.ok(readFileSync(join(consumer, "node_modules/@agent-console/ui/dist-package/src/fonts", notice)).length > 0);
    }
    cpSync(join(root, "scripts/fixtures/package-consumer"), consumer, { recursive: true });
    const files = run("pnpm", ["exec", "tsc", "-p", "tsconfig.json", "--listFiles"]);
    const coreFiles = files.split("\n").filter(path => path.includes("/node_modules/@agent-console/"));
    assert.ok(coreFiles.length > 0 && coreFiles.every(path => path.trim().endsWith(".d.ts")), "consumer must resolve installed declarations");
    assert.match(files, /node_modules\/@agent-console\/ui\/dist-package\/.*\.d\.ts/);
    assert.match(files, /node_modules\/@agent-console\/edge\/dist-package\/.*\.d\.ts/);
    console.log(`consumer typecheck: PASS (${coreFiles.length} installed declaration modules)`);
    run("pnpm", ["exec", "vite", "build"]);
    const evidence = run(process.execPath, ["probe.ts"]);
    assert.match(evidence, /packed edge and generic UI: PASS/);
    assert.match(evidence, /packed public UI: PASS/);
    console.log(evidence.trim());
  } catch (error) {
    error.message += `\n${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    throw error;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

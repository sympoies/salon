import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const checker = join(repoRoot, "scripts", "check-core-boundary.ts");

const CONFIG = {
  core: {
    "packages/shared": [],
    "packages/edge": ["packages/shared"],
    "packages/ui": ["packages/shared"],
  },
  exceptions: [],
};

function manifest(name: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ name, type: "module", ...extra });
}

// A minimal clean workspace: three core packages, an overlay and a native shell.
function baseFiles() {
  return {
    "scripts/core-boundary.config.json": JSON.stringify(CONFIG),
    "packages/shared/package.json": manifest("@ac/shared", { exports: { ".": "./src/index.ts", "./api": "./src/api.ts" } }),
    "packages/shared/src/index.ts": `export * from "./api.ts";\n`,
    "packages/shared/src/api.ts": `export const api = 1;\n`,
    "packages/edge/package.json": manifest("@ac/edge", {
      exports: { "./server": "./src/server.ts" },
      dependencies: { "@ac/shared": "workspace:*" },
    }),
    "packages/edge/src/server.ts": `import { api } from "@ac/shared/api";\nimport { join } from "node:path";\nexport const server = api + join("a").length;\n`,
    "packages/edge/test/server.test.ts": `import { server } from "../src/server.ts";\nvoid server;\n`,
    "packages/ui/package.json": manifest("@ac/ui", {
      exports: { "./app": "./src/app.tsx", "./styles.css": "./src/styles.css" },
      dependencies: { "@ac/shared": "workspace:*", react: "^19" },
    }),
    "packages/ui/src/app.tsx": `import type { ReactNode } from "react";\nimport { api } from "@ac/shared";\nexport const App = (): ReactNode => <div>{api}</div>;\n`,
    "packages/ui/src/styles.css": `@import "./tokens.css";\n.a { color: red; }\n`,
    "packages/ui/src/tokens.css": `:root { --x: 1; }\n`,
    "packages/overlay/package.json": manifest("@ac/overlay", {
      dependencies: { "@ac/edge": "workspace:*", "@ac/ui": "workspace:*" },
    }),
    "packages/overlay/src/main.tsx": `import { App } from "@ac/ui/app";\nimport "@ac/ui/styles.css";\nimport { server } from "@ac/edge/server";\nexport { App, server };\n`,
    "packages/android/package.json": manifest("@ac/android"),
    "packages/android/scripts/run.mjs": `import { spawnSync } from "node:child_process";\nvoid spawnSync;\n`,
    // Generated and installed trees are never scanned.
    "packages/ui/node_modules/x/index.js": `import "@ac/overlay";\n`,
    "packages/ui/dist/assets/app.js": `import "@ac/overlay";\n`,
  };
}

function workspace(overrides: Record<string, string | null> = {}) {
  const root = mkdtempSync(join(tmpdir(), "core-boundary-"));
  for (const [path, body] of Object.entries({ ...baseFiles(), ...overrides })) {
    if (body === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

function check(root: string) {
  const result = spawnSync(process.execPath, [checker, "--root", root], { encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function expectViolation(overrides: Record<string, string | null>, ...patterns: RegExp[]) {
  const root = workspace(overrides);
  try {
    const result = check(root);
    assert.equal(result.status, 1, result.out);
    for (const pattern of patterns) assert.match(result.out, pattern);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a clean workspace passes", () => {
  const root = workspace();
  try {
    const result = check(root);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /core boundary: ok/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("core must not import an overlay package in any import form", () => {
  const forms = [
    `import { x } from "@ac/overlay";`,
    `import type { X } from "@ac/overlay/types";`,
    `import "@ac/overlay";`,
    `export * from "@ac/overlay";`,
    `export { x } from "@ac/overlay";`,
    `const m = await import("@ac/overlay");`,
    "const m = await import(`@ac/overlay`);",
    `type M = typeof import("@ac/overlay");`,
    `const m = require("@ac/overlay");`,
  ];
  for (const form of forms) {
    expectViolation(
      { "packages/edge/src/extra.ts": `${form}\nexport {};\n` },
      /packages\/edge\/src\/extra\.ts:1/,
      /@ac\/overlay/,
      /rule 1/,
    );
  }
});

test("core must not import a distribution package", () => {
  expectViolation({ "packages/ui/src/native.ts": `import "@ac/android";\n` }, /packages\/ui\/src\/native\.ts/, /rule 1/);
});

test("core relative imports must stay inside their own package", () => {
  expectViolation(
    { "packages/edge/src/extra.ts": `import { App } from "../../overlay/src/main.tsx";\nvoid App;\n` },
    /packages\/edge\/src\/extra\.ts:1/,
    /rule 1/,
  );
  expectViolation(
    { "packages/ui/test/fixture.ts": `import { server } from "../../edge/src/server.ts";\nvoid server;\n` },
    /packages\/ui\/test\/fixture\.ts:1/,
  );
  expectViolation({ "packages/ui/src/styles.css": `@import "../../overlay/theme.css";\n` }, /packages\/ui\/src\/styles\.css:1/);
});

test("core packages import each other only by name and in the allowed direction", () => {
  expectViolation(
    { "packages/ui/src/extra.ts": `import { api } from "../../shared/src/api.ts";\nvoid api;\n` },
    /packages\/ui\/src\/extra\.ts:1/,
    /rule 2/,
  );
  expectViolation({ "packages/edge/src/extra.ts": `import { App } from "@ac/ui/app";\nvoid App;\n` }, /rule 3/);
  expectViolation({ "packages/ui/src/extra.ts": `import { server } from "@ac/edge/server";\nvoid server;\n` }, /rule 3/);
  expectViolation({ "packages/shared/src/extra.ts": `import { server } from "@ac/edge/server";\nvoid server;\n` }, /rule 3/);
});

test("imports of a core package must use an exported subpath", () => {
  expectViolation(
    { "packages/ui/src/extra.ts": `import { api } from "@ac/shared/src/api.ts";\nvoid api;\n` },
    /@ac\/shared\/src\/api\.ts/,
    /rule 2/,
  );
  expectViolation(
    { "packages/overlay/src/deep.ts": `import { App } from "@ac/ui/src/app.tsx";\nvoid App;\n` },
    /packages\/overlay\/src\/deep\.ts:1/,
    /rule 4/,
  );
  expectViolation(
    { "packages/overlay/src/deep.ts": `import { App } from "../../ui/src/app.tsx";\nvoid App;\n` },
    /packages\/overlay\/src\/deep\.ts:1/,
    /rule 4/,
  );
});

test("core dynamic imports need a literal specifier", () => {
  expectViolation(
    { "packages/edge/src/extra.ts": `const name = "x";\nexport const m = await import(name);\n` },
    /packages\/edge\/src\/extra\.ts:2/,
    /non-literal/,
  );
  const root = workspace({
    "packages/edge/test/load.test.ts": `const url = new URL("../src/server.ts", import.meta.url).href;\nexport const m = await import(url);\n`,
  });
  try {
    const result = check(root);
    assert.equal(result.status, 0, result.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("core manifests must not depend on overlay or distribution packages", () => {
  expectViolation(
    {
      "packages/ui/package.json": manifest("@ac/ui", {
        exports: { "./app": "./src/app.tsx", "./styles.css": "./src/styles.css" },
        devDependencies: { "@ac/overlay": "workspace:*" },
      }),
    },
    /packages\/ui\/package\.json/,
    /rule 5/,
  );
});

test("a listed exception passes while it matches and fails once stale", () => {
  const extra = `import { App } from "@ac/overlay";\nvoid App;\n`;
  const config = (exceptions: { file: string; specifier: string; reason: string }[]) => JSON.stringify({ ...CONFIG, exceptions });
  const exception = { file: "packages/edge/src/extra.ts", specifier: "@ac/overlay", reason: "tracked migration" };
  let root = workspace({ "packages/edge/src/extra.ts": extra, "scripts/core-boundary.config.json": config([exception]) });
  try {
    const result = check(root);
    assert.equal(result.status, 0, result.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  root = workspace({ "scripts/core-boundary.config.json": config([exception]) });
  try {
    const result = check(root);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /stale exception/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unparseable core file fails instead of being skipped", () => {
  expectViolation({ "packages/edge/src/broken.ts": `import { from "x";\n` }, /packages\/edge\/src\/broken\.ts/, /parse/);
});

test("this repository satisfies the core boundary", () => {
  const result = check(repoRoot);
  assert.equal(result.status, 0, result.out);
});

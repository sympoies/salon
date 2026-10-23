import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { CallExpression, Expression, Node, SourceFile } from "typescript/unstable/ast";
import {
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
} from "typescript/unstable/ast/is";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";

// Root-cure regression guard for the Happy DOM assertion out-of-memory hazard.
//
// When a `node:assert` comparison fails, Node builds the AssertionError message by
// running `util.inspect` over BOTH operands. If an operand is a Happy DOM Node,
// Window, Document, Event, or live NodeList/HTMLCollection, that inspection walks
// the entire DOM/JS object graph (which is deeply cyclic) and can consume tens of
// GiB of RSS — 32-34 GiB was observed while diagnosing PR #319, which exhausted
// swap and triggered a global OOM.
//
// The safe pattern projects any DOM lookup to a scalar/boolean BEFORE it reaches
// `node:assert` (see ./support/domAssert.ts, or an inline `?.dataset.x ?? null`).
// This guard parses every UI `*.test.ts` file and fails if a raw DOM-node
// expression is passed directly as an operand of a comparison assertion, so the
// hazard cannot be reintroduced by a future test.
//
// TypeScript 7 (the native port) gates the classic monolithic JS API: the AST
// helpers now live under `typescript/unstable/ast*`, and there is no in-process
// string parser, so the files are parsed by standing up a tiny project against
// `typescript/unstable/sync`. The AST-walking detection logic below is otherwise
// unchanged from the TS6 version.
//
// Hermeticity note: `createVirtualFileSystem` is a real-FS *overlay*, not a
// sandbox — its `readFile` returns `undefined` for unmapped paths, which the
// native server treats as "fall back to the real filesystem". This scan stays
// self-contained only because `noLib` + `noResolve` + an explicit `files:` list
// mean every program input is already in the overlay, so no fallback ever fires.
// Do NOT relax those options (e.g. switch to `include:`/`exclude:`, or drop
// `noResolve`/`noLib`) without re-establishing isolation, or the guard would read
// real `node_modules`/lib and become environment-dependent.
//
// These `unstable/*` subpaths are explicitly pre-stable. The effective version
// pin is the lockfile (`pnpm install --frozen-lockfile` in CI resolves the exact
// 7.0.2 that these imports were validated against); the `^7.0.0` specifier only
// matters on a deliberate `pnpm update`. The positive-control test below fails
// loudly if a future minor moves/renames a subpath or changes an AST accessor, so
// a silent detector break cannot slip through.
//
// Known residual gaps (intentionally not flagged; see the PR write-up):
//   - a DOM node returned from a locally-defined helper function, e.g.
//     `assert.equal(getNode(), null)`, where the node type is not visible at the
//     call site.

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));

// This guard file exercises the hazardous shapes only as parsed strings from
// other files; it never itself passes a DOM node to `node:assert`.
const SELF = "domAssertSafety.test.ts";

// `node:assert` comparison methods that capture BOTH operands and inspect them on
// failure. `ok`/`assert()` take a single already-coerced value and are excluded.
const COMPARISON_METHODS = new Set([
  "equal",
  "strictEqual",
  "deepEqual",
  "deepStrictEqual",
  "notEqual",
  "notStrictEqual",
  "notDeepEqual",
  "notDeepStrictEqual",
]);

// Methods that return a raw DOM node or live collection.
const DOM_LOOKUP_METHODS = new Set([
  "querySelector",
  "querySelectorAll",
  "getElementById",
  "getElementsByClassName",
  "getElementsByTagName",
  "closest",
]);

// Property accessors that yield a raw DOM node.
const DOM_NODE_PROPERTIES = new Set([
  "activeElement",
  "parentElement",
  "parentNode",
  "firstElementChild",
  "lastElementChild",
  "nextElementSibling",
  "previousElementSibling",
  "offsetParent",
  "firstChild",
  "lastChild",
]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

function listTestFiles(): string[] {
  return readdirSync(TEST_DIR, { recursive: true })
    .map((entry) => String(entry))
    .filter((name) => name.endsWith(".test.ts") && !name.endsWith(SELF))
    .map((name) => join(TEST_DIR, name))
    .sort();
}

function leftmostIdentifier(expression: Expression): string | null {
  let current: Expression = expression;
  while (isPropertyAccessExpression(current)) {
    current = current.expression;
  }
  return isIdentifier(current) ? current.text : null;
}

function isComparisonAssert(call: CallExpression): boolean {
  const callee = call.expression;
  if (!isPropertyAccessExpression(callee)) return false;
  if (!COMPARISON_METHODS.has(callee.name.text)) return false;
  // e.g. `assert.equal(...)` or `assert.strict.equal(...)`.
  return leftmostIdentifier(callee.expression) === "assert";
}

// A raw, un-projected DOM-node expression: a DOM lookup call or a DOM-node
// property access. Projected forms (`x.querySelector(s)?.dataset.k ?? null`,
// `x.contains(node)`, `x.activeElement?.id`) resolve to a different outer node
// and are not flagged.
function isRawDomNode(node: Expression, rawNodeVars: ReadonlySet<string>): boolean {
  if (isCallExpression(node) && isPropertyAccessExpression(node.expression)) {
    if (DOM_LOOKUP_METHODS.has(node.expression.name.text)) return true;
  }
  if (isPropertyAccessExpression(node) && DOM_NODE_PROPERTIES.has(node.name.text)) {
    return true;
  }
  if (isIdentifier(node) && rawNodeVars.has(node.text)) {
    return true;
  }
  return false;
}

// Collect local `const`/`let` names whose initializer is a raw, un-projected DOM
// node, so a later bare comparison against that variable is still caught.
function collectRawNodeVars(source: SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: Node): void => {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isRawDomNode(node.initializer, names)
    ) {
      names.add(node.name.text);
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return names;
}

function findViolations(file: string, source: SourceFile): Violation[] {
  const rawNodeVars = collectRawNodeVars(source);
  const violations: Violation[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node) && isComparisonAssert(node)) {
      const operands = node.arguments.filter((arg) => !isSpreadElement(arg)) as Expression[];
      // The 3rd `node:assert` argument is a message string, never an operand.
      for (const operand of operands.slice(0, 2)) {
        if (isRawDomNode(operand, rawNodeVars)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          const snippet = node.getText(source).replace(/\s+/g, " ").slice(0, 120);
          violations.push({ file, line: line + 1, snippet });
          break;
        }
      }
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return violations;
}

// A batch of parsed sources keyed by a caller-chosen id, plus a `close()` that
// tears down the spawned tsgo subprocess.
interface ParsedBatch {
  readonly sources: Map<string, SourceFile>;
  readonly close: () => void;
}

// Parse a set of in-memory sources in one virtual, resolution-free TS7 project so
// the AST walk stays pure syntax (see the hermeticity note at the top of the
// file). The virtual tsconfig `files` are relative to the project dir (`cwd`),
// while the overlay keys are absolute — both derive from the same index so they
// stay in sync.
function parseSources(entries: ReadonlyArray<{ id: string; text: string }>): ParsedBatch {
  const virtualDir = "/dom-assert-scan";
  const configPath = `${virtualDir}/tsconfig.json`;
  const vfsFiles: Record<string, string> = {};
  const virtualById = new Map<string, string>();
  entries.forEach((entry, index) => {
    const virtualPath = `${virtualDir}/f${index}.ts`;
    vfsFiles[virtualPath] = entry.text;
    virtualById.set(entry.id, virtualPath);
  });
  vfsFiles[configPath] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, noEmit: true },
    files: entries.map((_, index) => `f${index}.ts`),
  });

  // Own the subprocess lifecycle: close on any throw between spawn and return so a
  // failed parse can never orphan a tsgo child (an orphan holding stdio pipes
  // keeps Node's event loop alive and turns a clean assertion failure into a hang).
  const api = new API({ fs: createVirtualFileSystem(vfsFiles), cwd: virtualDir });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot.getProject(configPath);
    assert.ok(project, "expected the virtual scan project to load");

    const sources = new Map<string, SourceFile>();
    for (const entry of entries) {
      const virtualPath = virtualById.get(entry.id);
      assert.ok(virtualPath, `missing virtual path for ${entry.id}`);
      const source = project.program.getSourceFile(virtualPath);
      assert.ok(source, `expected TypeScript to parse ${entry.id}`);
      // Content-fidelity guard: a truthy-but-empty/mismatched source served across
      // the out-of-process boundary would contribute zero nodes and silently
      // under-scan. Fail loud unless the parsed text round-trips intact.
      assert.equal(
        source.text.length,
        entry.text.length,
        `parsed source for ${entry.id} did not round-trip intact`,
      );
      sources.set(entry.id, source);
    }
    return { sources, close: () => api.close() };
  } catch (error) {
    api.close();
    throw error;
  }
}

test("no UI test passes a raw Happy DOM object to a node:assert comparison", () => {
  const files = listTestFiles();
  assert.ok(files.length > 0, "expected to find UI test files to scan");

  const { sources, close } = parseSources(files.map((file) => ({ id: file, text: readFileSync(file, "utf8") })));
  const violations: Violation[] = [];
  try {
    for (const [file, source] of sources) {
      violations.push(...findViolations(file, source));
    }
  } finally {
    close();
  }

  const report = violations
    .map((v) => `  ${v.file.slice(TEST_DIR.length)}:${v.line}  ${v.snippet}`)
    .join("\n");
  assert.equal(
    violations.length,
    0,
    `Found ${violations.length} hazardous assertion(s) that pass a raw DOM node to node:assert.\n` +
      `On failure Node serializes the Happy DOM object graph and can OOM the host.\n` +
      `Use assertNoElement / assertActiveElement from ./support/domAssert.ts, or project to a scalar first.\n` +
      report,
  );
});

// Positive control: parse synthetic fixtures through the SAME virtual-project
// harness and assert the detector still fires. Without this the guard above only
// ever asserts `0 violations` against a clean tree, so a silent break in the TS7
// parse substrate (a moved `unstable/*` subpath, a changed AST accessor) would
// pass vacuously and re-open the OOM hazard. This keeps the detector honest across
// TypeScript upgrades.
test("domAssertSafety guard still flags raw DOM operands (positive control)", () => {
  const hazard = [
    'import { strict as assert } from "node:assert";',
    "export function hazards(root: Element, el: Element): void {",
    '  assert.equal(root.querySelector(".x"), null);', // raw DOM lookup -> flag
    "  assert.strictEqual(document.activeElement, el);", // raw DOM property -> flag
    '  const found = root.getElementById("z");', // tracked raw-node local...
    "  assert.deepEqual(found, el);", // ...compared bare -> flag
    "}",
  ].join("\n");
  const safe = [
    'import { strict as assert } from "node:assert";',
    "export function safe(root: Element): void {",
    '  assert.equal(root.querySelector(".x")?.getAttribute("data-k") ?? null, null);', // projected -> no flag
    '  assert.strictEqual(root.textContent, "hi");', // non-DOM property -> no flag
    '  assert.equal(root.children.length, 0, root.querySelector(".x"));', // raw node is the 3rd (message) arg -> no flag
    "}",
  ].join("\n");

  const { sources, close } = parseSources([
    { id: "hazard", text: hazard },
    { id: "safe", text: safe },
  ]);
  try {
    const hazardHits = findViolations("hazard", sources.get("hazard") as SourceFile);
    const safeHits = findViolations("safe", sources.get("safe") as SourceFile);
    assert.equal(hazardHits.length, 3, `expected 3 hazards, got ${JSON.stringify(hazardHits)}`);
    assert.equal(safeHits.length, 0, `expected 0 safe violations, got ${JSON.stringify(safeHits)}`);
  } finally {
    close();
  }
});

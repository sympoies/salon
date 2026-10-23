#!/usr/bin/env node
// Enforce the core/overlay import rules in docs/package-boundary.md.
//
//   1. Core never imports overlay or distribution code, and core relative
//      imports never leave their own package.
//   2. Core packages reach each other by package name and exported subpath.
//   3. `shared` imports no workspace package; `edge` and `ui` import only
//      `shared`.
//   4. Non-core packages reach core only through exported subpaths.
//   5. Core manifests list no overlay or distribution package.
//
// Usage: node scripts/check-core-boundary.mjs [--root <repo>]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const STYLE_FILE = /\.css$/;
const TEST_FILE = /^packages\/[^/]+\/test\//;
const SKIPPED_DIRS = new Set(["node_modules", "dist", "target", "gen", ".vite", ".cache"]);
const MANIFEST_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const CSS_IMPORT = /@import\s+(?:url\(\s*)?["']([^"']+)["']/g;

const { parseSync } = createRequire(import.meta.url)("oxc-parser");

function parseArgs(argv) {
  let root = fileURLToPath(new URL("..", import.meta.url));
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1]) root = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return resolve(root);
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function workspacePackages(root) {
  const packagesDir = join(root, "packages");
  return readdirSync(packagesDir)
    .map((name) => `packages/${name}`)
    .filter((dir) => existsSync(join(root, dir, "package.json")))
    .map((dir) => {
      const manifest = readJson(join(root, dir, "package.json"));
      return { dir, name: manifest.name, manifest };
    });
}

function* walk(root, dir) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* walk(root, path);
    } else if (entry.isFile() && (SOURCE_FILE.test(entry.name) || STYLE_FILE.test(entry.name))) {
      yield path;
    }
  }
}

function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function literalValue(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value?.cooked ?? null;
  return null;
}

function visit(node, onNode) {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, onNode);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") onNode(node);
  for (const key of Object.keys(node)) {
    if (key !== "parent") visit(node[key], onNode);
  }
}

// Every module reference in a file: { specifier, line } or { dynamic: true, line }.
function moduleReferences(root, file) {
  const text = readFileSync(join(root, file), "utf8");
  if (STYLE_FILE.test(file)) {
    return [...text.matchAll(CSS_IMPORT)].map((match) => ({ specifier: match[1], line: lineOf(text, match.index) }));
  }
  const result = parseSync(file, text);
  if (result.errors.length > 0) {
    throw new Error(`${file}: cannot parse: ${result.errors[0].message}`);
  }
  const references = [];
  const add = (source, at) => {
    const specifier = literalValue(source);
    references.push(specifier === null ? { dynamic: true, line: lineOf(text, at) } : { specifier, line: lineOf(text, at) });
  };
  visit(result.program, (node) => {
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
        add(node.source, node.start);
        break;
      case "ExportNamedDeclaration":
        if (node.source) add(node.source, node.start);
        break;
      case "ImportExpression":
      case "TSImportType":
        add(node.source, node.start);
        break;
      case "CallExpression":
        if (node.callee?.type === "Identifier" && node.callee.name === "require" && node.arguments.length > 0) {
          add(node.arguments[0], node.start);
        }
        break;
      default:
        break;
    }
  });
  return references;
}

function splitPackageSpecifier(specifier) {
  const parts = specifier.split("/");
  const nameLength = specifier.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, nameLength).join("/");
  const rest = parts.slice(nameLength).join("/");
  return { name, subpath: rest ? `./${rest}` : "." };
}

function exportsSubpath(manifest, subpath) {
  const exportsField = manifest.exports;
  if (exportsField === undefined) return subpath === ".";
  if (typeof exportsField === "string" || Array.isArray(exportsField)) return subpath === ".";
  const keys = Object.keys(exportsField);
  if (!keys.every((key) => key.startsWith("."))) return subpath === ".";
  return keys.some((key) => {
    if (!key.includes("*")) return key === subpath;
    const [prefix, suffix] = key.split("*");
    return subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length;
  });
}

function packageOf(packages, file) {
  return packages.find((pkg) => file === pkg.dir || file.startsWith(`${pkg.dir}/`));
}

export function checkCoreBoundary(root) {
  const config = readJson(join(root, "scripts", "core-boundary.config.json"));
  const packages = workspacePackages(root);
  const core = new Map(Object.entries(config.core));
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const exceptions = (config.exceptions ?? []).map((exception) => ({ ...exception, used: false }));
  const violations = [];

  const report = (file, line, specifier, rule, message) => {
    const exception = exceptions.find((entry) => entry.file === file && entry.specifier === specifier);
    if (exception) {
      exception.used = true;
      return;
    }
    violations.push(`${file}${line ? `:${line}` : ""}: rule ${rule}: ${message}`);
  };

  for (const pkg of packages) {
    const isCore = core.has(pkg.dir);
    const allowed = new Set(core.get(pkg.dir) ?? []);

    if (isCore) {
      for (const field of MANIFEST_FIELDS) {
        for (const dependency of Object.keys(pkg.manifest[field] ?? {})) {
          const target = byName.get(dependency);
          if (target && !allowed.has(target.dir)) {
            report(`${pkg.dir}/package.json`, 0, dependency, 5, `${field} lists ${dependency}, which core ${pkg.dir} must not depend on`);
          }
        }
      }
    }

    for (const file of walk(root, pkg.dir)) {
      let references;
      try {
        references = moduleReferences(root, file);
      } catch (error) {
        violations.push(error.message);
        continue;
      }
      for (const reference of references) {
        if (reference.dynamic) {
          // Tests load their own modules by computed URL; shipped core code may not.
          if (isCore && !TEST_FILE.test(file)) {
            report(file, reference.line, "", 1, "dynamic import with a non-literal specifier");
          }
          continue;
        }
        const { specifier, line } = reference;
        const path = specifier.split("?")[0];
        if (path.startsWith(".") || path.startsWith("/")) {
          const target = toPosix(relative(root, resolve(root, dirname(file), path)));
          const targetPkg = packageOf(packages, target);
          if (isCore && targetPkg !== pkg) {
            const rule = targetPkg && core.has(targetPkg.dir) && allowed.has(targetPkg.dir) ? 2 : 1;
            report(file, line, specifier, rule, `relative import ${specifier} leaves ${pkg.dir}`);
          } else if (!isCore && targetPkg && core.has(targetPkg.dir)) {
            report(file, line, specifier, 4, `relative import ${specifier} reaches into core ${targetPkg.dir}; import an exported subpath`);
          }
          continue;
        }
        const { name, subpath } = splitPackageSpecifier(path);
        const target = byName.get(name);
        if (!target || target === pkg) continue;
        const targetIsCore = core.has(target.dir);
        if (isCore && !targetIsCore) {
          report(file, line, specifier, 1, `core ${pkg.dir} imports non-core package ${specifier}`);
        } else if (isCore && !allowed.has(target.dir)) {
          report(file, line, specifier, 3, `core ${pkg.dir} must not import ${target.dir} (${specifier})`);
        } else if (targetIsCore && !exportsSubpath(target.manifest, subpath)) {
          report(file, line, specifier, isCore ? 2 : 4, `${specifier} is not an exported subpath of ${name}`);
        }
      }
    }
  }

  for (const exception of exceptions) {
    if (!exception.used) {
      violations.push(`${exception.file}: stale exception for ${exception.specifier}; remove it from scripts/core-boundary.config.json`);
    }
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = parseArgs(process.argv.slice(2));
  if (!statSync(join(root, "packages")).isDirectory()) throw new Error(`${root} has no packages directory`);
  const violations = checkCoreBoundary(root);
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    console.error(`core boundary: ${violations.length} violation(s); see docs/package-boundary.md#import-rules`);
    process.exit(1);
  }
  console.log("core boundary: ok");
}

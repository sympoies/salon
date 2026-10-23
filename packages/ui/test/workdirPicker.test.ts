import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  cwdForCreate,
  filterWorkdirOptions,
  primaryWorkdirLabel,
  secondaryWorkdirLabel,
  selectWorkdir,
} from "../src/workdirPicker.ts";

const repos = [
  {
    path: "/home/runner/Project/summit/agent-console",
    name: "agent-console",
    root: "/home/runner/Project",
    is_git_repo: true,
    last_used: "2026-07-05T08:00:00Z",
  },
  {
    path: "/home/runner/Project/sampleRepo/agent-console",
    name: "agent-console",
    root: "/home/runner/Project",
    is_git_repo: true,
    last_used: null,
  },
  {
    path: "/home/runner/.config/zsh",
    name: "zsh",
    root: "/home/runner/.config",
    is_git_repo: true,
    last_used: null,
  },
];

test("workdir picker renders repo name as the primary label", () => {
  assert.equal(primaryWorkdirLabel(repos[0]!), "agent-console");
  assert.equal(primaryWorkdirLabel({ path: "/home/runner/Project/example/toolkit" }), "toolkit");
});

test("workdir picker disambiguates duplicate repo names with the parent segment", () => {
  assert.equal(secondaryWorkdirLabel(repos[0]!, repos), "summit");
  assert.equal(secondaryWorkdirLabel(repos[1]!, repos), "sampleRepo");
  assert.equal(secondaryWorkdirLabel(repos[2]!, repos), undefined);
});

test("workdir picker filters by typed text while preserving daemon order", () => {
  assert.deepEqual(
    filterWorkdirOptions(repos, "agent").map((item) => item.path),
    [repos[0]!.path, repos[1]!.path],
  );
  assert.deepEqual(
    filterWorkdirOptions(repos, "sample").map((item) => item.path),
    [repos[1]!.path],
  );
});

test("workdir picker is select-only for create cwd", () => {
  assert.deepEqual(selectWorkdir(repos[0]!), {
    displayValue: "agent-console",
    selectedPath: "/home/runner/Project/summit/agent-console",
  });
  assert.equal(cwdForCreate({ displayValue: "not-a-real-repo", selectedPath: "" }), undefined);
  assert.equal(cwdForCreate(selectWorkdir(repos[0]!)), "/home/runner/Project/summit/agent-console");
});

test("CreateDialog uses a custom combobox instead of native datalist", () => {
  const source = readFileSync(new URL("../src/CreateDialog.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /<datalist\b/);
  assert.doesNotMatch(source, /\blist="workdir-options"/);
  assert.match(source, /workdir-combobox/);
});

test("the workdir field is presented as starting context, not an access boundary", async () => {
  const dialog = readFileSync(new URL("../src/CreateDialog.tsx", import.meta.url), "utf8");
  // The dialog must render the shared hint, keep the field optional, and never
  // require a managed worktree to start a session.
  assert.match(dialog, /\{WORKDIR_CONTEXT_HINT\}/);
  assert.match(dialog, /Working dir <span className="hint">optional<\/span>/);
  assert.doesNotMatch(dialog, /New managed worktree/);

  const picker = await import("../src/workdirPicker.ts");
  const hint: unknown = picker.WORKDIR_CONTEXT_HINT;
  assert.equal(typeof hint, "string");
  const text = String(hint);
  assert.match(text, /starting context/i);
  assert.match(text, /does not limit/i);
  assert.match(text, /repositories/i);
  // Ban the promise, not the vocabulary: wording that states plainly that the
  // selection does not restrict the session must stay allowed, while any claim
  // that the session *is* scoped must not. The hint also must not assert host
  // authority, which belongs to the agent's own configuration, not this dialog.
  assert.doesNotMatch(text, /restricted to|confined to|sandboxed|isolated/i);
  assert.doesNotMatch(text, /full host access/i);
});

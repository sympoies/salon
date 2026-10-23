import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeProviders } from "../src/usage.ts";

// The usage reader (host-local, summit-infra) is the source of truth for the
// numbers; the edge only normalizes its payload into a stable, defensively-typed
// shape so a malformed/partial reader response can never crash the panel.

test("normalizeProviders maps a well-formed codex provider with two windows", () => {
  const out = normalizeProviders({
    providers: [
      {
        provider: "codex",
        label: "Codex",
        ok: true,
        stale: false,
        plan: "chatgpt",
        reset_credits: { available_count: 2 },
        updated_at: 1783288000,
        windows: [
          { key: "5h", label: "5h", used_percent: 86, window_minutes: 300, resets_at: 1783288112 },
          { key: "weekly", label: "Weekly", used_percent: 78, window_minutes: 10080, resets_at: 1783390857 },
        ],
      },
    ],
  });
  assert.equal(out.length, 1);
  const p = out[0]!;
  assert.equal(p.provider, "codex");
  assert.equal(p.label, "Codex");
  assert.equal(p.ok, true);
  assert.equal(p.stale, false);
  assert.equal(p.plan, "chatgpt");
  assert.deepEqual(p.reset_credits, { available_count: 2 });
  assert.equal(p.updated_at, 1783288000);
  assert.equal(p.windows.length, 2);
  assert.deepEqual(p.windows[0], {
    key: "5h",
    label: "5h",
    used_percent: 86,
    window_minutes: 300,
    resets_at: 1783288112,
  });
});

test("normalizeProviders accepts agent-session reset aliases and ISO timestamps", () => {
  const out = normalizeProviders({
    providers: [
      {
        provider: "claude",
        label: "Claude",
        ok: true,
        windows: [
          { key: "5h", label: "5h", used_percent: 24, window_minutes: 300, reset_at: "2030-01-01T00:00:00.328421+00:00" },
          { key: "weekly", label: "Weekly", used_percent: 3, window_minutes: 10080, reset_at_epoch: 1893542400 },
        ],
      },
    ],
  });

  assert.deepEqual(
    out[0]!.windows.map((w) => w.resets_at),
    [1893456000, 1893542400],
  );
});

test("normalizeProviders unwraps agent-session usage envelopes", () => {
  const out = normalizeProviders({
    schema_version: "cli.agent-session.serve.v1",
    ok: true,
    data: {
      machine: "local",
      usage: {
        schema_version: "agent-session.usage.v1",
        ok: true,
        providers: [
          {
            id: "claude",
            label: "Claude",
            ok: true,
            source: "claude-cli",
            windows: [
              { label: "5h", used_percent: 55, reset_at: "3:20pm(Asia/Taipei)", reset_at_epoch: 1783668000 },
              { label: "Weekly", used_percent: 7, reset_at: "2026-07-12T13:00:00.054659+00:00", reset_at_epoch: 1783861200 },
            ],
          },
        ],
      },
    },
  });

  assert.equal(out.length, 1);
  assert.equal(out[0]!.provider, "claude");
  assert.deepEqual(
    out[0]!.windows.map((w) => [w.key, w.label, w.window_minutes, w.resets_at]),
    [
      ["5h", "5h", 300, 1783668000],
      ["weekly", "Weekly", 10080, 1783861200],
    ],
  );
});

test("normalizeProviders defaults missing fields (label<-provider, ok<-true, nulls)", () => {
  const out = normalizeProviders({ providers: [{ provider: "claude", stale: true }] });
  assert.equal(out.length, 1);
  const p = out[0]!;
  assert.equal(p.label, "claude"); // falls back to provider id
  assert.equal(p.ok, true); // absent ok is treated as ok:true
  assert.equal(p.stale, true);
  assert.equal(p.plan, null);
  assert.equal(p.updated_at, null);
  assert.equal(p.note, null);
  assert.equal(p.reset_credits, null);
  assert.equal(p.error, null);
  assert.deepEqual(p.windows, []);
});

test("normalizeProviders accepts only nonnegative integer reset credits", () => {
  const out = normalizeProviders({
    providers: [
      { provider: "codex", account: "zero", reset_credits: { available_count: 0 } },
      { provider: "codex", account: "negative", reset_credits: { available_count: -1 } },
      { provider: "codex", account: "fraction", reset_credits: { available_count: 1.5 } },
      { provider: "codex", account: "string", reset_credits: { available_count: "2" } },
    ],
  });
  assert.deepEqual(out.map((provider) => provider.reset_credits), [
    { available_count: 0 },
    null,
    null,
    null,
  ]);
});

test("normalizeProviders coerces non-finite numbers to null and drops keyless windows", () => {
  const out = normalizeProviders({
    providers: [
      {
        provider: "codex",
        windows: [
          { used_percent: 1 }, // dropped: no stable key
          { key: "5h", used_percent: "oops", window_minutes: null, resets_at: 1783288112 },
        ],
      },
    ],
  });
  const p = out[0]!;
  assert.equal(p.windows.length, 1);
  assert.equal(p.windows[0]!.key, "5h");
  assert.equal(p.windows[0]!.label, "5h"); // label falls back to key
  assert.equal(p.windows[0]!.used_percent, null); // non-number coerced to null
  assert.equal(p.windows[0]!.window_minutes, 300); // inferred from the stable key
  assert.equal(p.windows[0]!.resets_at, 1783288112);
});

test("normalizeProviders skips non-object / provider-less entries and non-array payloads", () => {
  assert.deepEqual(normalizeProviders({ providers: [null, 3, {}, { label: "x" }] }), []);
  assert.deepEqual(normalizeProviders({}), []);
  assert.deepEqual(normalizeProviders(null), []);
  assert.deepEqual(normalizeProviders({ providers: "nope" }), []);
});

test("normalizeProviders preserves an ok:false provider with its error string", () => {
  const out = normalizeProviders({
    providers: [{ provider: "codex", ok: false, error: "no rollout files found" }],
  });
  assert.equal(out[0]!.ok, false);
  assert.equal(out[0]!.error, "no rollout files found");
});

test("normalizeProviders accepts allowlisted reason codes and nested agent-session errors", () => {
  const out = normalizeProviders({
    providers: [
      {
        id: "claude",
        label: "Claude",
        ok: false,
        reason_code: "organization_disabled",
        error: { code: "request-failed", message: "provider access disabled" },
      },
      {
        id: "codex",
        label: "Codex",
        ok: false,
        reason_code: "future_secret_reason",
        error: { code: "request-failed", message: "generic failure" },
      },
    ],
  });

  assert.equal(out[0]!.reason_code, "organization_disabled");
  assert.equal(out[0]!.error, "provider access disabled");
  assert.equal(out[1]!.reason_code, null);
  assert.equal(out[1]!.error, "generic failure");
});

test("normalizeProviders clamps used_percent into [0, 100]", () => {
  const out = normalizeProviders({
    providers: [
      {
        provider: "codex",
        windows: [
          { key: "over", used_percent: 150 },
          { key: "under", used_percent: -5 },
          { key: "ok", used_percent: 42 },
        ],
      },
    ],
  });
  const byKey = Object.fromEntries(out[0]!.windows.map((w) => [w.key, w.used_percent]));
  assert.equal(byKey.over, 100);
  assert.equal(byKey.under, 0);
  assert.equal(byKey.ok, 42);
});

test("normalizeProviders dedupes providers by id (keeps the first)", () => {
  const out = normalizeProviders({
    providers: [
      { provider: "codex", label: "First" },
      { provider: "codex", label: "Second" },
      { provider: "claude", label: "Claude" },
    ],
  });
  assert.deepEqual(
    out.map((p) => `${p.provider}:${p.label}`),
    ["codex:First", "claude:Claude"],
  );
});

test("normalizeProviders keeps multiple same-provider entries distinguished by account", () => {
  // codex reports one entry per configured account (all provider:"codex"); they
  // must survive as distinct cards, deduped only on the (provider, account) pair.
  const out = normalizeProviders({
    providers: [
      { provider: "codex", account: "galaxy", label: "Codex", plan: "pro" },
      { provider: "codex", account: "poies", label: "Codex", plan: "team" },
      { provider: "codex", account: "galaxy", label: "dup" }, // (codex,galaxy) dupe -> dropped
      { provider: "claude", label: "Claude" },
    ],
  });
  assert.deepEqual(
    out.map((p) => `${p.provider}:${p.account}`),
    ["codex:galaxy", "codex:poies", "claude:null"],
  );
});

test("normalizeProviders defaults a missing/empty account to null", () => {
  const out = normalizeProviders({ providers: [{ provider: "codex" }, { provider: "claude", account: "" }] });
  assert.equal(out[0]!.account, null);
  assert.equal(out[1]!.account, null); // empty string is not a usable nickname
});

test("normalizeProviders dedupes windows by key (keeps the first)", () => {
  const out = normalizeProviders({
    providers: [
      {
        provider: "codex",
        windows: [
          { key: "5h", label: "first 5h" },
          { key: "5h", label: "dup 5h" },
          { key: "weekly", label: "Weekly" },
        ],
      },
    ],
  });
  assert.deepEqual(
    out[0]!.windows.map((w) => `${w.key}:${w.label}`),
    ["5h:first 5h", "weekly:Weekly"],
  );
});

test("normalizeProviders keeps a bounded, deduped host list and keys entries by it", () => {
  const out = normalizeProviders({
    providers: [
      { provider: "claude", account: "a@example.com", hosts: ["cedar", "mesa", "cedar", "", 7, "x".repeat(65)] },
      { provider: "claude", account: null, ok: false, hosts: ["maple"] },
      { provider: "claude", account: null, ok: false, hosts: ["m5"] },
      { provider: "claude", account: null, ok: false, hosts: ["m5"] },
      { provider: "claude", account: "x@example.com", hosts: [] },
      { provider: "claude", account: "y@example.com", hosts: ["x".repeat(65), 3] },
      { provider: "claude", account: "z@example.com", hosts: "m2" },
      { provider: "claude" },
    ],
  });
  // An entry that claims hosts but names no valid one is dropped, never sent unscoped.
  assert.deepEqual(out.map((p) => p.hosts), [["cedar", "mesa"], ["maple"], ["m5"], undefined]);
});

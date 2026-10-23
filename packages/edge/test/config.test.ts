import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadConfig, isRootPrincipal, principalCanAccessMachine, principalCanUseTerminal, parseCoordinationRelays, parseMachines, parsePrincipals, parseSpeechProviders, parseTitleSummarizer } from "../src/config.ts";

test("machine activity is explicit and defaults to enabled", () => {
  const machine = { name: "fixture-retired", url: "https://daemon.example.test", token: "fixture-token" };
  assert.deepEqual(parseMachines(JSON.stringify([{ ...machine, active: false }])), [{ ...machine, active: false }]);
  assert.deepEqual(parseMachines(JSON.stringify([machine])), [machine]);
  assert.throws(() => parseMachines(JSON.stringify([{ ...machine, active: "false" }])));
});

test("coordination relays bind known machines and reject credentials shared with browser or operator", () => {
  const machines = [{ name: "cedar", url: "https://daemon.example.test", token: "operator" }];
  const principals = [{ id: "tess", token: "browser", machines: ["cedar"], permissions: [] }];
  const relays = [{ machine: "cedar", token: "a".repeat(32), ingress_token: "b".repeat(32) }];
  assert.deepEqual(parseCoordinationRelays(undefined, machines, principals), []);
  assert.deepEqual(parseCoordinationRelays(JSON.stringify(relays), machines, principals), relays);
  assert.throws(() => parseCoordinationRelays(JSON.stringify(relays), machines, []));
  assert.throws(() => parseCoordinationRelays(JSON.stringify([relays[0], relays[0]]), machines, principals));
  assert.throws(() => parseCoordinationRelays(JSON.stringify([{ ...relays[0], machine: "unknown" }]), machines, principals));
  for (const token of ["operator", "browser", relays[0]!.ingress_token]) {
    assert.throws(() => parseCoordinationRelays(JSON.stringify([{ ...relays[0], token }]), machines, principals));
  }
  assert.throws(() => parseCoordinationRelays(JSON.stringify([{ ...relays[0], ingress_token: "operator" }]), machines, principals));
  assert.throws(() => parseCoordinationRelays(JSON.stringify([{ ...relays[0], url: "https://evil.example.test" }]), machines, principals));
});

test("speech providers accept scoped remote and local origins but reject unsafe or duplicate endpoints", () => {
  const machines = [{ name: "summit", url: "http://127.0.0.1:8781", token: "machine-secret" }];
  const providers = [
    { id: "summit", label: "Summit", url: "http://127.0.0.1:8798", token: "speech-secret", machine: "summit" },
    { id: "remote", label: "Remote", url: "https://speech.example.test", token: "remote-secret" },
  ];
  assert.deepEqual(parseSpeechProviders(JSON.stringify(providers), machines), providers);
  assert.throws(() => parseSpeechProviders(JSON.stringify([{ ...providers[0], url: "http://speech.example.test" }]), machines));
  assert.throws(() => parseSpeechProviders(JSON.stringify([{ ...providers[0], url: "https://speech.example.test/path" }]), machines));
  assert.throws(() => parseSpeechProviders(JSON.stringify([{ ...providers[0], machine: "unknown" }]), machines));
  assert.throws(() => parseSpeechProviders(JSON.stringify([providers[0], providers[0]]), machines));
});

test("parseMachines returns [] for undefined/empty", () => {
  assert.deepEqual(parseMachines(undefined), []);
  assert.deepEqual(parseMachines(""), []);
  assert.deepEqual(parseMachines("   "), []);
});

test("parseMachines parses a well-formed array", () => {
  const raw = JSON.stringify([
    { name: "summit", url: "http://127.0.0.1:8781", token: "secret" },
  ]);
  assert.deepEqual(parseMachines(raw), [
    { name: "summit", url: "http://127.0.0.1:8781", token: "secret" },
  ]);
});

test("parseMachines strips a trailing slash from url", () => {
  const raw = JSON.stringify([
    { name: "s", url: "http://127.0.0.1:8781/", token: "t" },
  ]);
  assert.equal(parseMachines(raw)[0]?.url, "http://127.0.0.1:8781");
});

test("parseMachines rejects malformed json", () => {
  assert.throws(() => parseMachines("{not json"));
});

test("parseMachines rejects a non-array", () => {
  assert.throws(() => parseMachines(JSON.stringify({ name: "x" })));
});

test("parseMachines rejects entries missing fields", () => {
  assert.throws(() => parseMachines(JSON.stringify([{ name: "x", url: "http://y" }])));
  assert.throws(() => parseMachines(JSON.stringify([{ url: "http://y", token: "t" }])));
  assert.throws(() => parseMachines(JSON.stringify([{ name: "x", token: "t" }])));
});

test("parseMachines rejects duplicate machine names", () => {
  const raw = JSON.stringify([
    { name: "dup", url: "http://a", token: "t" },
    { name: "dup", url: "http://b", token: "u" },
  ]);
  assert.throws(() => parseMachines(raw));
});

test("parsePrincipals resolves stable identities, machine grants, and operator permissions", () => {
  const machines = parseMachines(JSON.stringify([
    { name: "summit", url: "http://127.0.0.1:8781", token: "upstream-a" },
    { name: "maple", url: "http://127.0.0.1:8782", token: "upstream-b" },
    { name: "mesa", url: "http://127.0.0.1:8783", token: "upstream-c" },
  ]));
  assert.deepEqual(parsePrincipals(JSON.stringify([
    {
      id: "tess",
      token: "tess-token",
      machines: ["summit", "mesa"],
      permissions: ["debug", "usage", "codex_reset"],
    },
    {
      id: "dana", token: "dana-token", machines: ["summit", "maple"], permissions: [],
      defaultVisibleMachines: ["maple"], defaultCreateMachine: "maple",
    },
  ]), machines), [
    {
      id: "tess",
      token: "tess-token",
      machines: ["summit", "mesa"],
      permissions: ["debug", "usage", "codex_reset"],
    },
    {
      id: "dana", token: "dana-token", machines: ["summit", "maple"], permissions: [],
      defaultVisibleMachines: ["maple"], defaultCreateMachine: "maple",
    },
  ]);
});

test("parsePrincipals rejects ambiguous or unsafe grants", () => {
  const machines = parseMachines(JSON.stringify([
    { name: "summit", url: "http://127.0.0.1:8781", token: "upstream" },
    { name: "mesa", url: "http://127.0.0.1:8782", token: "upstream-mesa" },
  ]));
  assert.throws(() => parsePrincipals("not-json", machines));
  assert.throws(() => parsePrincipals("[]", machines));
  assert.throws(() => parsePrincipals(JSON.stringify([
    { id: "../tess", token: "a", machines: ["summit"], permissions: [] },
  ]), machines));
  assert.throws(() => parsePrincipals(JSON.stringify([
    { id: "tess", token: "same", machines: ["summit"], permissions: [] },
    { id: "dana", token: "same", machines: ["summit"], permissions: [] },
  ]), machines));
  assert.throws(() => parsePrincipals(JSON.stringify([
    { id: "tess", token: "a", machines: ["missing"], permissions: [] },
  ]), machines));
  assert.throws(() => parsePrincipals(JSON.stringify([
    { id: "tess", token: "a", machines: ["summit"], permissions: ["root"] },
  ]), machines));
  assert.throws(() => parsePrincipals(JSON.stringify([
    { id: "tess", token: "a", machines: ["summit"], permissions: [], defaultVisibleMachines: ["mesa"] },
  ]), machines), /defaultVisibleMachines/);
  assert.throws(() => parsePrincipals(JSON.stringify([
    { id: "tess", token: "a", machines: ["summit"], permissions: [], defaultCreateMachine: "mesa" },
  ]), machines), /defaultCreateMachine/);
  assert.throws(() => parsePrincipals(JSON.stringify([
    { id: "tess", token: "a", machines: ["summit", "mesa"], permissions: [], defaultCreateMachine: "mesa" },
  ]), machines), /visible by default/);
});

test("loadConfig enables multi-user mode only with an absolute durable state path", () => {
  const env = {
    AGENT_CONSOLE_MACHINES: JSON.stringify([
      { name: "summit", url: "http://127.0.0.1:8781", token: "upstream" },
    ]),
    AGENT_CONSOLE_PRINCIPALS: JSON.stringify([
      { id: "tess", token: "tess-token", machines: ["summit"], permissions: ["debug"] },
    ]),
  };
  assert.throws(() => loadConfig(env));
  assert.throws(() => loadConfig({ ...env, AGENT_CONSOLE_STATE_DB: "relative.sqlite" }));
  assert.throws(() => loadConfig({ ...env, AGENT_CONSOLE_STATE_DB: "/state/access.sqlite", AGENT_CONSOLE_NO_AUTH: "1" }));
  assert.throws(() => loadConfig({ ...env, AGENT_CONSOLE_STATE_DB: "/state/access.sqlite", AGENT_CONSOLE_TOKEN: "legacy" }));

  const config = loadConfig({ ...env, AGENT_CONSOLE_STATE_DB: "/state/access.sqlite" });
  assert.equal(config.multiUser, true);
  assert.equal(config.accessDbPath, "/state/access.sqlite");
  assert.deepEqual(config.principals.map((principal) => principal.id), ["tess"]);
});

test("loadConfig requires a client token unless open-access is set", () => {
  assert.throws(() => loadConfig({ AGENT_CONSOLE_TOKEN: "" }));
  assert.throws(() => loadConfig({}));
});

test("loadConfig openAccess defaults false; AGENT_CONSOLE_NO_AUTH enables it + drops the token requirement", () => {
  assert.equal(loadConfig({ AGENT_CONSOLE_TOKEN: "t" }).openAccess, false);
  const open = loadConfig({ AGENT_CONSOLE_NO_AUTH: "1" }); // no token needed
  assert.equal(open.openAccess, true);
  assert.equal(open.clientToken, "");
});

test("loadConfig: a falsy AGENT_CONSOLE_NO_AUTH does not enable open-access (token still required)", () => {
  assert.throws(() => loadConfig({ AGENT_CONSOLE_NO_AUTH: "0" }));
  assert.throws(() => loadConfig({ AGENT_CONSOLE_NO_AUTH: "false" }));
  // ...but with a token present, a falsy flag is simply normal (gated) mode.
  assert.equal(loadConfig({ AGENT_CONSOLE_NO_AUTH: "0", AGENT_CONSOLE_TOKEN: "t" }).openAccess, false);
});

test("loadConfig: AGENT_CONSOLE_NO_AUTH=1 with a token keeps openAccess true and preserves the token (device auth)", () => {
  const cfg = loadConfig({ AGENT_CONSOLE_NO_AUTH: "1", AGENT_CONSOLE_TOKEN: "keepme" });
  assert.equal(cfg.openAccess, true);
  assert.equal(cfg.clientToken, "keepme");
});

test("loadConfig applies defaults and reads machines", () => {
  const cfg = loadConfig({
    AGENT_CONSOLE_TOKEN: "client-secret",
    AGENT_CONSOLE_MACHINES: JSON.stringify([
      { name: "summit", url: "http://127.0.0.1:8781", token: "m" },
    ]),
  });
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 8790);
  assert.equal(cfg.clientToken, "client-secret");
  assert.equal(cfg.secureCookie, true); // fail-closed: Secure on by default
  assert.equal(cfg.maxAttachmentBytes, 1024 * 1024 * 1024);
  assert.equal(cfg.machines.length, 1);
  assert.equal(cfg.machines[0]?.name, "summit");
  assert.equal(cfg.usage, null); // unset -> usage panel disabled
  assert.equal(cfg.codexReset, null); // unset -> earned reset redemption disabled
  assert.equal(cfg.layout, null); // unset -> cross-device layout store disabled (UI falls back to localStorage)
  assert.equal(cfg.titleSummarizer, null);
});

test("loadConfig bounds the attachment byte ceiling", () => {
  assert.equal(
    loadConfig({ AGENT_CONSOLE_TOKEN: "t", AGENT_CONSOLE_MAX_ATTACHMENT_BYTES: "2147483648" })
      .maxAttachmentBytes,
    2 * 1024 * 1024 * 1024,
  );
  assert.throws(() => loadConfig({ AGENT_CONSOLE_TOKEN: "t", AGENT_CONSOLE_MAX_ATTACHMENT_BYTES: "0" }));
  assert.throws(() => loadConfig({
    AGENT_CONSOLE_TOKEN: "t",
    AGENT_CONSOLE_MAX_ATTACHMENT_BYTES: String(16 * 1024 * 1024 * 1024 + 1),
  }));
  assert.throws(() => loadConfig({ AGENT_CONSOLE_TOKEN: "t", AGENT_CONSOLE_MAX_ATTACHMENT_BYTES: "1.5" }));
});

test("parseTitleSummarizer parses a JSON argv command", () => {
  assert.deepEqual(parseTitleSummarizer(undefined), null);
  assert.deepEqual(parseTitleSummarizer("   "), null);
  assert.deepEqual(parseTitleSummarizer('["codex","exec","-m","gpt-5.4-mini"]'), {
    command: ["codex", "exec", "-m", "gpt-5.4-mini"],
    timeoutMs: 8000,
  });
});

test("parseTitleSummarizer rejects malformed or unsafe command config", () => {
  assert.throws(() => parseTitleSummarizer("codex exec"));
  assert.throws(() => parseTitleSummarizer("[]"));
  assert.throws(() => parseTitleSummarizer('["codex", ""]'));
});

test("loadConfig threads the title summarizer command and timeout", () => {
  const cfg = loadConfig({
    AGENT_CONSOLE_TOKEN: "t",
    AGENT_CONSOLE_TITLE_SUMMARIZER: '["codex","exec","-m","gpt-5.4-mini"]',
    AGENT_CONSOLE_TITLE_SUMMARIZER_TIMEOUT_MS: "12000",
  });
  assert.deepEqual(cfg.titleSummarizer, {
    command: ["codex", "exec", "-m", "gpt-5.4-mini"],
    timeoutMs: 12000,
  });
});

test("loadConfig wires the usage reader url (trailing slash stripped) and optional token", () => {
  const cfg = loadConfig({
    AGENT_CONSOLE_TOKEN: "t",
    AGENT_CONSOLE_USAGE_URL: "http://127.0.0.1:8793/",
    AGENT_CONSOLE_USAGE_TOKEN: "usage-secret",
  });
  assert.deepEqual(cfg.usage, { url: "http://127.0.0.1:8793", token: "usage-secret" });
});

test("loadConfig: a usage url without a token yields token:null (loopback, no auth)", () => {
  assert.deepEqual(loadConfig({ AGENT_CONSOLE_TOKEN: "t", AGENT_CONSOLE_USAGE_URL: "http://127.0.0.1:8793" }).usage, {
    url: "http://127.0.0.1:8793",
    token: null,
  });
});

test("loadConfig: a blank/unset usage url means the panel is disabled (null)", () => {
  assert.equal(loadConfig({ AGENT_CONSOLE_TOKEN: "t", AGENT_CONSOLE_USAGE_URL: "   " }).usage, null);
  assert.equal(loadConfig({ AGENT_CONSOLE_TOKEN: "t" }).usage, null);
});


test("loadConfig wires the Codex rate-limit reset controller", () => {
  const cfg = loadConfig({
    AGENT_CONSOLE_TOKEN: "t",
    AGENT_CONSOLE_CODEX_RESET_URL: "http://127.0.0.1:8797/",
    AGENT_CONSOLE_CODEX_RESET_TOKEN: "reset-secret",
  });
  assert.deepEqual(cfg.codexReset, { url: "http://127.0.0.1:8797", token: "reset-secret" });
});

test("loadConfig wires the layout store url (trailing slash stripped) and optional token", () => {
  const cfg = loadConfig({
    AGENT_CONSOLE_TOKEN: "t",
    AGENT_CONSOLE_LAYOUT_URL: "http://127.0.0.1:8794/",
    AGENT_CONSOLE_LAYOUT_TOKEN: "layout-secret",
  });
  assert.deepEqual(cfg.layout, { url: "http://127.0.0.1:8794", token: "layout-secret" });
});

test("loadConfig: a layout url without a token yields token:null (loopback, no auth)", () => {
  assert.deepEqual(loadConfig({ AGENT_CONSOLE_TOKEN: "t", AGENT_CONSOLE_LAYOUT_URL: "http://127.0.0.1:8794" }).layout, {
    url: "http://127.0.0.1:8794",
    token: null,
  });
});

test("loadConfig: a blank/unset layout url means the cross-device store is disabled (null)", () => {
  assert.equal(loadConfig({ AGENT_CONSOLE_TOKEN: "t", AGENT_CONSOLE_LAYOUT_URL: "   " }).layout, null);
  assert.equal(loadConfig({ AGENT_CONSOLE_TOKEN: "t" }).layout, null);
});

test("loadConfig honors overrides and the insecure-cookie opt-out", () => {
  const cfg = loadConfig({
    AGENT_CONSOLE_TOKEN: "t",
    AGENT_CONSOLE_EDGE_HOST: "0.0.0.0",
    AGENT_CONSOLE_EDGE_PORT: "9999",
    AGENT_CONSOLE_INSECURE_COOKIE: "1",
    AGENT_CONSOLE_UI_DIR: "/tmp/dist",
  });
  assert.equal(cfg.host, "0.0.0.0");
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.secureCookie, false); // explicit local-dev opt-out
  assert.equal(cfg.uiDir, "/tmp/dist");
});

test("loadConfig requires both dedicated relay credentials to contain at least 32 bytes", () => {
  const relays = [{ machine: "cedar", token: "a".repeat(32), ingress_token: "b".repeat(32) }];
  const env = {
    AGENT_CONSOLE_MACHINES: JSON.stringify([{ name: "cedar", url: "https://daemon.example.test", token: "operator" }]),
    AGENT_CONSOLE_PRINCIPALS: JSON.stringify([{ id: "tess", token: "browser", machines: ["cedar"], permissions: [] }]),
    AGENT_CONSOLE_STATE_DB: "/tmp/relay-config-test.sqlite",
    AGENT_CONSOLE_COORDINATION_RELAYS: JSON.stringify(relays),
  };
  assert.deepEqual(loadConfig(env).coordinationRelays, relays);
  for (const field of ["token", "ingress_token"]) {
    assert.throws(() => loadConfig({ ...env, AGENT_CONSOLE_COORDINATION_RELAYS: JSON.stringify([{ ...relays[0], [field]: "x".repeat(31) }]) }));
  }
});

test("loadConfig wires agent-session serve usage and reset paths", () => {
  const cfg = loadConfig({
    AGENT_CONSOLE_TOKEN: "t",
    AGENT_CONSOLE_USAGE_URL: "http://127.0.0.1:8781",
    AGENT_CONSOLE_USAGE_TOKEN: "serve-secret",
    AGENT_CONSOLE_USAGE_PATH: "/usage/v1",
    AGENT_CONSOLE_CODEX_RESET_URL: "http://127.0.0.1:8781/",
    AGENT_CONSOLE_CODEX_RESET_TOKEN: "serve-secret",
    AGENT_CONSOLE_CODEX_RESET_PATH: "/codex/reset/v1",
    AGENT_CONSOLE_CLAUDE_RESET_URL: "http://127.0.0.1:8781/",
    AGENT_CONSOLE_CLAUDE_RESET_TOKEN: "serve-secret",
  });
  assert.deepEqual(cfg.usage, { url: "http://127.0.0.1:8781", token: "serve-secret", path: "/usage/v1" });
  assert.deepEqual(cfg.codexReset, { url: "http://127.0.0.1:8781", token: "serve-secret", path: "/codex/reset/v1" });
  assert.deepEqual(cfg.claudeReset, { url: "http://127.0.0.1:8781", token: "serve-secret" });
  assert.equal(loadConfig({ AGENT_CONSOLE_TOKEN: "t" }).claudeReset, null);
  // A blank path keeps the helper default.
  assert.deepEqual(
    loadConfig({ AGENT_CONSOLE_TOKEN: "t", AGENT_CONSOLE_USAGE_URL: "http://127.0.0.1:8793", AGENT_CONSOLE_USAGE_PATH: " " }).usage,
    { url: "http://127.0.0.1:8793", token: null },
  );
});

test("loadConfig rejects an unsafe usage or reset path at startup", () => {
  for (const value of ["usage/v1", "/usage?refresh=1", "/usage/../reset", "//evil.example/usage", "/usage#x", "/usage v1"]) {
    assert.throws(
      () => loadConfig({ AGENT_CONSOLE_TOKEN: "t", AGENT_CONSOLE_USAGE_URL: "http://127.0.0.1:8781", AGENT_CONSOLE_USAGE_PATH: value }),
      /AGENT_CONSOLE_USAGE_PATH/,
    );
    assert.throws(
      () => loadConfig({ AGENT_CONSOLE_TOKEN: "t", AGENT_CONSOLE_CODEX_RESET_URL: "http://127.0.0.1:8781", AGENT_CONSOLE_CODEX_RESET_PATH: value }),
      /AGENT_CONSOLE_CODEX_RESET_PATH/,
    );
    assert.throws(
      () => loadConfig({ AGENT_CONSOLE_TOKEN: "t", AGENT_CONSOLE_CLAUDE_RESET_URL: "http://127.0.0.1:8781", AGENT_CONSOLE_CLAUDE_RESET_PATH: value }),
      /AGENT_CONSOLE_CLAUDE_RESET_PATH/,
    );
  }
});


test("root is a separate principal with fleet scope, never a permission on Tess", () => {
  const machines = [{ name: "maple", url: "http://127.0.0.1:8781", token: "upstream" }];
  const [root, tess] = parsePrincipals(JSON.stringify([
    { id: "root", token: "root-token", machines: [], permissions: [] },
    { id: "tess", token: "tess-token", machines: [], permissions: [] },
  ]), machines);
  assert.equal(isRootPrincipal(root!), true);
  assert.equal(principalCanAccessMachine(root!, "maple"), true);
  assert.equal(principalCanAccessMachine(tess!, "maple"), false);
  assert.equal(principalCanUseTerminal(root!), false);
  assert.equal(principalCanUseTerminal(tess!), true, "ordinary authorization remains machine/owner scoped");
  assert.throws(() => parsePrincipals(JSON.stringify([
    { id: "root", token: "same-token", machines: [], permissions: [] },
    { id: "tess", token: "same-token", machines: [], permissions: [] },
  ]), machines), /unique/);
});

test("root terminal permission is an explicit opt-in independent of its fleet visibility", () => {
  const machines = [{ name: "maple", url: "http://127.0.0.1:8781", token: "upstream" }];
  const [root] = parsePrincipals(JSON.stringify([
    { id: "root", token: "root-token", machines: [], permissions: ["terminal"] },
  ]), machines);
  assert.equal(principalCanAccessMachine(root!, "maple"), true);
  assert.equal(principalCanUseTerminal(root!), true);
});

import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import net from "node:net";
import {
  createServer as createHttpServer,
  request as createHttpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEdgeServer } from "../src/server.ts";
import { cookieFrom, listenOnLoopback, loginCookie, makeEdgeConfig } from "./support.ts";

// Every browser create is a console root (session-lineage-work-v1).
const CONSOLE_ROOT_LINEAGE = {
  schema_version: "agent-session.session-lineage.v1",
  parent: null,
  root: null,
  depth: 0,
  starter: { kind: "console", via: "console" },
};

// A configured machine on a closed loopback port: reachable-name, unreachable-daemon.
// Lets us test the auth gate + aggregation tolerance without a live daemon.
const uiDir = mkdtempSync(join(tmpdir(), "ac-srv-ui-"));
writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>ac</title>");
const config = makeEdgeConfig({
  clientToken: "client-secret",
  machines: [{ name: "maple", url: "http://127.0.0.1:9", token: "machine-secret" }],
  uiDir,
  openAccess: false,
});

const server = createEdgeServer(config);
let base = "";
let serverPort = 0;

before(async () => {
  const listening = await listenOnLoopback(server);
  base = listening.base;
  serverPort = listening.port;
});
after(() => {
  server.close();
  rmSync(uiDir, { recursive: true, force: true });
});

async function login(): Promise<string> {
  return loginCookie(base);
}

test("healthz is open", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("/api/* requires auth", async () => {
  const res = await fetch(`${base}/api/sessions`);
  assert.equal(res.status, 401);
});

test("an unreachable auto-resume mutation reports an indeterminate outcome", async () => {
  const cookie = await login();
  const res = await fetch(`${base}/api/sessions/maple/s1/auto-resume`, {
    method: "PUT",
    headers: { cookie, origin: base, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(res.status, 504);
  assert.deepEqual((await res.json()).error, {
    code: "auto-resume-outcome-unknown",
    message: "auto-resume outcome is unknown",
  });
});

// The edge cannot tell a Codex from a Claude session before the daemon answers,
// so the unknown outcome names neither provider.
test("an unreachable account mutation reports an indeterminate provider-neutral outcome", async () => {
  const cookie = await login();
  const res = await fetch(`${base}/api/sessions/maple/s1/account`, {
    method: "PUT",
    headers: { cookie, origin: base, "content-type": "application/json" },
    body: JSON.stringify({ account: "galaxy", expected_session_incarnation: "launch-s1" }),
  });
  assert.equal(res.status, 504);
  assert.deepEqual((await res.json()).error, {
    code: "account-switch-outcome-unknown",
    message: "account switch outcome is unknown",
  });
});

test("login rejects a wrong token and sets no cookie", async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "nope" }),
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("login issues an httpOnly session cookie that authorizes the API", async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "client-secret" }),
  });
  assert.equal(res.status, 200);
  const sc = res.headers.get("set-cookie") ?? "";
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  const cookie = sc.split(";")[0] ?? "";
  const status = await (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json();
  assert.equal(status.authenticated, true);
  assert.equal(status.openAccess, false); // gated deploy reports openAccess:false
  assert.deepEqual(status.principal.permissions,
    ["debug", "usage", "codex_reset"]);
});

test("machines list is namespaced under data and hides url/token", async () => {
  const cookie = await login();
  const res = await fetch(`${base}/api/machines`, { headers: { cookie } });
  const body = await res.json();
  assert.deepEqual(body.data.machines, [{ name: "maple" }]);
  assert.equal(JSON.stringify(body).includes("machine-secret"), false);
});

test("title summary route returns an authenticated fallback title", async () => {
  const cookie = await login();
  const res = await fetch(`${base}/api/title-summary`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ baseTitle: "agent-console", prompt: "Fix auto titles\nwith more detail" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.title, "agent-console - Fix auto titles");
  assert.equal(body.data.source, "fallback");
  assert.equal(body.data.diagnosticReason, "fallback_not_configured");
});

test("retired clipboard model endpoint never forwards selected text upstream", async () => {
  let calls = 0;
  const daemon = createHttpServer((_req, res) => { calls++; res.writeHead(500); res.end(); });
  const { port } = await listenOnLoopback(daemon);
  const edge = createEdgeServer({ ...config, machines: [{ name: "maple", url: `http://127.0.0.1:${port}`, token: "machine-secret" }] });
  try {
    const { base: edgeBase } = await listenOnLoopback(edge);
    const cookie = await loginCookie(edgeBase);
    const response = await fetch(`${edgeBase}/api/clipboard/unwrap`, {
      method: "POST", headers: { cookie, origin: edgeBase, "content-type": "application/json" },
      body: JSON.stringify({ machine: "maple", selection: "https://example.test/private" }),
    });
    assert.equal(response.status, 404);
    assert.equal(calls, 0);
  } finally {
    edge.close(); daemon.close();
  }
});

test("title summary route forwards expanded context through the summarizer contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-title-route-"));
  const routeUiDir = mkdtempSync(join(tmpdir(), "ac-srv-ui-"));
  const captureFile = join(dir, "input.json");
  const script = join(dir, "summary.mjs");
  const routeServer = createEdgeServer({
    ...config,
    uiDir: routeUiDir,
    titleSummarizer: { command: [process.execPath, script], timeoutMs: 8000 },
  });
  writeFileSync(join(routeUiDir, "index.html"), "<!doctype html><title>ac</title>");
  writeFileSync(script, `
import { writeFileSync } from "node:fs";
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk.toString("utf8"); });
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(captureFile)}, raw);
  console.log("Route summary");
});
`);
  try {
    const { base: routeBase } = await listenOnLoopback(routeServer);
    const loginRes = await fetch(`${routeBase}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "client-secret" }),
    });
    const cookie = cookieFrom(loginRes);
    const res = await fetch(`${routeBase}/api/title-summary`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        baseTitle: "agent-console",
        currentTitle: "DATABASE_URL=postgres://alice:hunter2@db/prod",
        prompt: "please refresh the title after this turn",
        recentOutput: "TOKEN=secret-value\nImplemented the route context.",
        agent: "codex",
        repoName: "example-org/agent-console",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.title, "agent-console - Route summary");
    assert.equal(body.data.source, "summarizer");
    const childInput = JSON.parse(readFileSync(captureFile, "utf8"));
    assert.equal(childInput.prompt, "please refresh the title after this turn");
    assert.equal(childInput.base_title, "agent-console");
    assert.equal(childInput.current_title, undefined);
    assert.equal(childInput.recent_output, "Implemented the route context.");
    assert.equal(childInput.agent, "codex");
    assert.equal(childInput.repo_name, "example-org/agent-console");
  } finally {
    routeServer.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(routeUiDir, { recursive: true, force: true });
  }
});

test("title summary route enforces auth, method, and prompt validation", async () => {
  const unauth = await fetch(`${base}/api/title-summary`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Fix title" }),
  });
  assert.equal(unauth.status, 401);

  const cookie = await login();
  const wrongMethod = await fetch(`${base}/api/title-summary`, { headers: { cookie } });
  assert.equal(wrongMethod.status, 405);

  const blankPrompt = await fetch(`${base}/api/title-summary`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ prompt: "   " }),
  });
  assert.equal(blankPrompt.status, 422);
  assert.equal((await blankPrompt.json()).error.message, "prompt is required");
});

test("aggregated list tolerates a down machine (never fails the whole view)", async () => {
  const cookie = await login();
  const res = await fetch(`${base}/api/sessions`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.sessions, []);
  assert.equal(body.data.machines[0].name, "maple");
  assert.equal(body.data.machines[0].ok, false);
});

test("unknown machine → 404 (no network dial)", async () => {
  const cookie = await login();
  const res = await fetch(`${base}/api/sessions/ghost/x/glance`, { headers: { cookie } });
  assert.equal(res.status, 404);
});

test("method mismatch on a known route → 405", async () => {
  const cookie = await login();
  const res = await fetch(`${base}/api/sessions/maple/x/glance`, { method: "POST", headers: { cookie } });
  assert.equal(res.status, 405);
});

test("method mismatch on the buffer route → 405", async () => {
  const cookie = await login();
  const res = await fetch(`${base}/api/sessions/maple/x/buffer`, { method: "POST", headers: { cookie } });
  assert.equal(res.status, 405);
});

test("retired Services routes are unavailable", async () => {
  const cookie = await login();
  assert.equal((await fetch(`${base}/api/hermes/units`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(`${base}/api/hermes/logs/hermes-serve.service`, { headers: { cookie } })).status, 404);
});

test("device HTTP auth: a valid bearer client token authorizes without a cookie", async () => {
  const ok = await fetch(`${base}/api/sessions`, { headers: { authorization: "Bearer client-secret" } });
  assert.equal(ok.status, 200);
  const bad = await fetch(`${base}/api/sessions`, { headers: { authorization: "Bearer nope" } });
  assert.equal(bad.status, 401);
});

test("device HTTP bearer writes are not rejected by the cross-origin gate", async () => {
  const create = await fetch(`${base}/api/sessions/maple`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer client-secret",
      origin: "http://tauri.localhost",
    },
    body: JSON.stringify({ agent: "codex" }),
  });
  assert.notEqual(create.status, 403);
});

test("history message paging forwards only the bounded daemon query contract", async () => {
  let seenUrl: string | undefined;
  const daemon = createHttpServer((req, res) => {
    seenUrl = req.url;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, data: { messages: [], older_cursor: "21" } }));
  });
  const { port: daemonPort } = await listenOnLoopback(daemon);
  const edge = createEdgeServer({
    ...config,
    machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
  });
  const { base: edgeBase } = await listenOnLoopback(edge);
  try {
    const response = await fetch(
      `${edgeBase}/api/history/sessions/maple/h1/messages?direction=older&cursor=42&limit=50&private=x`,
      { headers: { authorization: "Bearer client-secret" } },
    );
    assert.equal(response.status, 200);
    assert.equal(seenUrl, "/history/sessions/h1/messages?cursor=42&limit=50&direction=older");
    assert.deepEqual(await response.json(), { ok: true, data: { messages: [], older_cursor: "21" } });
  } finally {
    edge.close();
    daemon.close();
  }
});

test("create requests forward only safe, advertised launch profile ids", async () => {
  const seen: unknown[] = [];
  const daemon = createHttpServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/sessions") {
      res.end(JSON.stringify({
        ok: true,
        data: {
          sessions: [],
          capabilities: { profile_resume_import: true },
          agent_profiles: [{
            id: "custom-claude",
            label: "Custom Claude",
            agent: "claude",
            provider_resume_import_supported: true,
          }],
        },
      }));
      return;
    }
    const body = await readRaw(req);
    const parsed = JSON.parse(body.toString()) as {
      agent?: unknown;
      agent_profile?: unknown;
      provider_resume_id?: unknown;
    };
    seen.push(parsed);
    if (req.method === "POST" && req.url === "/sessions") {
      const session = {
        id: "c1",
        agent: "claude",
        agent_profile: "custom-claude",
        status: "running",
        ...(typeof parsed.provider_resume_id === "string"
          ? { provider_resume: { provider: "claude", session_id: parsed.provider_resume_id } }
          : {}),
      };
      res.end(JSON.stringify({ ok: true, data: { session } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: { message: "unexpected daemon request" } }));
  });
  const { port: daemonPort } = await listenOnLoopback(daemon);
  const edge = createEdgeServer({
    ...config,
    machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
  });
  const { base: edgeBase } = await listenOnLoopback(edge);
  try {
    const cookie = cookieFrom(
      await fetch(`${edgeBase}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "client-secret" }),
      }),
    );
    const customClaude = await fetch(`${edgeBase}/api/sessions/maple`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        agent: "claude",
        agent_profile: "custom-claude",
        agent_bin: "/browser/must-not-control",
        provider_config_dir: "/browser/must-not-control",
        agent_profile_provider_config_dir: "/browser/must-not-control",
        readiness_args: ["--browser-must-not-control"],
      }),
    });
    assert.equal(customClaude.status, 200);
    const customClaudeResume = await fetch(edgeBase + "/api/sessions/maple", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        agent: "claude",
        agent_profile: "custom-claude",
        provider_resume_id: "profile-provider-id",
        provider_config_dir: "/browser/must-not-control",
        agent_profile_provider_config_dir: "/browser/must-not-control",
        readiness_args: ["--browser-must-not-control"],
      }),
    });
    assert.equal(customClaudeResume.status, 200);
    // The profile owning its launch command also means the browser cannot append
    // to it: without this, a profiled create's argv is only the prefix of whatever
    // a caller supplies.
    const profileWithArgs = await fetch(`${edgeBase}/api/sessions/maple`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        agent: "claude",
        agent_profile: "custom-claude",
        agent_args: ["chat", "--browser-must-not-control"],
      }),
    });
    assert.equal(profileWithArgs.status, 200);
    const unsafeProfile = await fetch(`${edgeBase}/api/sessions/maple`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ agent: "claude", agent_profile: "../unsafe" }),
    });
    assert.equal(unsafeProfile.status, 422);
    assert.deepEqual(seen, [
      {
        agent: "claude",
        agent_profile: "custom-claude",
        lineage: CONSOLE_ROOT_LINEAGE,
      },
      {
        agent: "claude",
        agent_profile: "custom-claude",
        provider_resume_id: "profile-provider-id",
        lineage: CONSOLE_ROOT_LINEAGE,
      },
      {
        agent: "claude",
        agent_profile: "custom-claude",
        lineage: CONSOLE_ROOT_LINEAGE,
      },
    ]);
  } finally {
    edge.close();
    daemon.close();
  }
});

test("profile resume import rejects a daemon that does not advertise the additive capability", async () => {
  const seenMethods: string[] = [];
  const daemon = createHttpServer(async (req, res) => {
    seenMethods.push(req.method ?? "");
    await readRaw(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, data: {
      sessions: [],
      agent_profiles: [{ id: "custom-claude", label: "Custom Claude", agent: "claude" }],
    } }));
  });
  const { port: daemonPort } = await listenOnLoopback(daemon);
  const edge = createEdgeServer({
    ...config,
    machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
  });
  const { base: edgeBase } = await listenOnLoopback(edge);
  try {
    const cookie = cookieFrom(
      await fetch(`${edgeBase}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "client-secret" }),
      }),
    );
    const create = await fetch(`${edgeBase}/api/sessions/maple`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        agent: "claude",
        agent_profile: "custom-claude",
        provider_resume_id: "profile-provider-id",
      }),
    });
    assert.equal(create.status, 409);
    assert.deepEqual((await create.json()).error, {
      code: "agent-profile-unavailable",
      message: "agent launch profile is unavailable on this machine",
    });
    const aliasCreate = await fetch(`${edgeBase}/api/sessions/maple`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        agent: "claude",
        agent_profile: "custom-claude",
        resume_id: "profile-provider-id",
      }),
    });
    assert.equal(aliasCreate.status, 409);
    assert.deepEqual((await aliasCreate.json()).error, {
      code: "agent-profile-unavailable",
      message: "agent launch profile is unavailable on this machine",
    });
    assert.deepEqual(seenMethods, ["GET", "GET"]);
  } finally {
    edge.close();
    daemon.close();
  }
});

test("issue 17 and durable-session routes proxy title, workdirs, repo URL, resume, and raw attachment uploads", async () => {
  const repoCwd = "/home/runner/Project/summit/agent-console";
  const seen: Array<{ method: string; url: string; auth: string; contentType?: string; body: Buffer }> = [];
  const daemon = createHttpServer(async (req, res) => {
    const body = await readRaw(req);
    const rawType = req.headers["content-type"];
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: req.headers.authorization ?? "",
      contentType: Array.isArray(rawType) ? rawType[0] : rawType,
      body,
    });
    res.setHeader("content-type", "application/json");
    if (req.method === "PATCH" && req.url === "/sessions/s1") {
      res.end(JSON.stringify({ ok: true, data: { session: { id: "s1", title: "Renamed" } } }));
      return;
    }
    if (req.method === "GET" && req.url === "/workdirs?q=agent&limit=5&git_only=true&exclude_worktrees=true") {
      res.end(JSON.stringify({ ok: true, data: { workdirs: [{ path: "/home/runner/Project/agent-console" }] } }));
      return;
    }
    if (req.method === "GET" && req.url === `/repos/remote-url?cwd=${encodeURIComponent(repoCwd)}`) {
      res.end(JSON.stringify({ ok: true, data: { machine: "maple", url: "https://github.com/example-org/agent-console" } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions") {
      res.end(
        JSON.stringify({
          ok: true,
          data: {
            session: {
              id: "imported",
              agent: "claude",
              status: "running",
              provider_resume: { provider: "claude", session_id: "external-claude-id" },
            },
          },
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/s1/resume") {
      res.end(JSON.stringify({ ok: true, data: { session: { id: "s1", status: "running", repo_name: "agent-console" } } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/s1/attachments?filename=clip.png") {
      res.end(JSON.stringify({ ok: true, data: { attachment: { path: "/tmp/clip.png", bytes: body.length } } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: { message: "unexpected daemon request" } }));
  });
  const { port: daemonPort } = await listenOnLoopback(daemon);
  const edge = createEdgeServer({
    ...config,
    machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
  });
  const { base: edgeBase } = await listenOnLoopback(edge);
  try {
    const cookie = cookieFrom(
      await fetch(`${edgeBase}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "client-secret" }),
      }),
    );
    const title = await fetch(`${edgeBase}/api/sessions/maple/s1`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "Renamed" }),
    });
    assert.equal(title.status, 200);
    assert.equal((await title.json()).data.session.title, "Renamed");

    const workdirs = await fetch(
      `${edgeBase}/api/machines/maple/workdirs?q=agent&limit=5&git_only=true&exclude_worktrees=true`,
      { headers: { cookie } },
    );
    assert.equal(workdirs.status, 200);
    assert.equal((await workdirs.json()).data.workdirs[0].path, "/home/runner/Project/agent-console");

    const repoUrl = await fetch(`${edgeBase}/api/machines/maple/repo-url?cwd=${encodeURIComponent(repoCwd)}`, {
      headers: { cookie },
    });
    assert.equal(repoUrl.status, 200);
    assert.equal((await repoUrl.json()).data.url, "https://github.com/example-org/agent-console");

    const create = await fetch(`${edgeBase}/api/sessions/maple`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ agent: "claude", provider_resume_id: "external-claude-id" }),
    });
    assert.equal(create.status, 200);
    assert.equal((await create.json()).data.session.id, "imported");

    const resume = await fetch(`${edgeBase}/api/sessions/maple/s1/resume`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    assert.equal(resume.status, 200);
    assert.equal((await resume.json()).data.session.repo_name, "agent-console");

    const upload = await fetch(`${edgeBase}/api/sessions/maple/s1/attachments?filename=clip.png`, {
      method: "POST",
      headers: { "content-type": "image/png", cookie },
      body: Buffer.from("png-bytes"),
    });
    assert.equal(upload.status, 200);
    assert.equal((await upload.json()).data.attachment.path, "/tmp/clip.png");

    assert.deepEqual(
      seen.map((r) => [r.method, r.url, r.auth]),
      [
        ["PATCH", "/sessions/s1", "Bearer machine-secret"],
        ["GET", "/workdirs?q=agent&limit=5&git_only=true&exclude_worktrees=true", "Bearer machine-secret"],
        ["GET", `/repos/remote-url?cwd=${encodeURIComponent(repoCwd)}`, "Bearer machine-secret"],
        ["POST", "/sessions", "Bearer machine-secret"],
        ["POST", "/sessions/s1/resume", "Bearer machine-secret"],
        ["POST", "/sessions/s1/attachments?filename=clip.png", "Bearer machine-secret"],
      ],
    );
    assert.deepEqual(JSON.parse(seen[3]?.body.toString() ?? "{}"), {
      agent: "claude",
      provider_resume_id: "external-claude-id",
      lineage: CONSOLE_ROOT_LINEAGE,
    });
    assert.equal(seen[5]?.contentType, "image/png");
    assert.equal(seen[5]?.body.toString(), "png-bytes");
  } finally {
    edge.close();
    daemon.close();
  }
});

test("attachment uploads reach the daemon before the client request completes", async () => {
  let markFirstChunk: (() => void) | undefined;
  const firstChunk = new Promise<void>((resolve) => {
    markFirstChunk = resolve;
  });
  const daemon = createHttpServer((req, res) => {
    let body = Buffer.alloc(0);
    req.on("data", (chunk: Buffer) => {
      body = Buffer.concat([body, chunk]);
      if (body.equals(Buffer.from("first chunk"))) markFirstChunk?.();
    });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, data: { attachment: { bytes: body.length } } }));
    });
  });
  const { port: daemonPort } = await listenOnLoopback(daemon);
  const edge = createEdgeServer({
    ...config,
    machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
  });
  const { base: edgeBase } = await listenOnLoopback(edge);
  let upload: ClientRequest | undefined;
  let response: Promise<{ status: number; body: string }> | undefined;
  try {
    const cookie = await loginCookie(edgeBase);
    response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      upload = createHttpRequest(
        `${edgeBase}/api/sessions/maple/s1/attachments?filename=recording.mp4`,
        {
          method: "POST",
          headers: { cookie, origin: edgeBase, "content-type": "video/mp4" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      upload.on("error", reject);
    });

    upload.write("first chunk");
    await Promise.race([
      firstChunk,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("daemon did not receive the first chunk before request completion")), 500);
      }),
    ]);
    upload.end(" and second chunk");

    const result = await response;
    assert.equal(result.status, 200, result.body);
    assert.equal(JSON.parse(result.body).data.attachment.bytes, "first chunk and second chunk".length);
  } finally {
    upload?.destroy();
    await response?.catch(() => undefined);
    edge.close();
    daemon.close();
  }
});

test("attachment uploads reject declared and observed bytes above the configured ceiling", async () => {
  let daemonRequests = 0;
  let markObservedFirstChunk: (() => void) | undefined;
  let markObservedClosed: (() => void) | undefined;
  const observedFirstChunk = new Promise<void>((resolve) => {
    markObservedFirstChunk = resolve;
  });
  const observedClosed = new Promise<void>((resolve) => {
    markObservedClosed = resolve;
  });
  const daemon = createHttpServer((req, res) => {
    daemonRequests += 1;
    req.on("error", () => {});
    if (req.url?.includes("observed.bin")) {
      req.once("data", () => markObservedFirstChunk?.());
      req.once("aborted", () => markObservedClosed?.());
      req.once("close", () => markObservedClosed?.());
    }
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, data: { attachment: { bytes: 64 } } }));
    });
  });
  const { port: daemonPort } = await listenOnLoopback(daemon);
  const edge = createEdgeServer({
    ...config,
    maxAttachmentBytes: 64,
    machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
  });
  const { base: edgeBase } = await listenOnLoopback(edge);
  let chunkedUpload: ClientRequest | undefined;
  try {
    const cookie = await loginCookie(edgeBase);

    const exactDeclared = await fetch(`${edgeBase}/api/sessions/maple/s1/attachments?filename=exact-declared.bin`, {
      method: "POST",
      headers: { cookie, origin: edgeBase },
      body: Buffer.alloc(64),
    });
    assert.equal(exactDeclared.status, 200);
    assert.equal(daemonRequests, 1);

    const exactChunked = new Promise<{ status: number; body: string }>((resolve, reject) => {
      chunkedUpload = createHttpRequest(
        `${edgeBase}/api/sessions/maple/s1/attachments?filename=exact-chunked.bin`,
        { method: "POST", headers: { cookie, origin: edgeBase } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      chunkedUpload.on("error", reject);
    });
    chunkedUpload.write(Buffer.alloc(32));
    chunkedUpload.end(Buffer.alloc(32));
    assert.equal((await exactChunked).status, 200);
    assert.equal(daemonRequests, 2);

    const declared = await fetch(`${edgeBase}/api/sessions/maple/s1/attachments?filename=declared.bin`, {
      method: "POST",
      headers: { cookie, origin: edgeBase },
      body: Buffer.alloc(65),
    });
    assert.equal(declared.status, 413);
    assert.equal(daemonRequests, 2, "declared oversize must be rejected before dialing the daemon");

    const observed = new Promise<{ status: number; body: string }>((resolve, reject) => {
      chunkedUpload = createHttpRequest(
        `${edgeBase}/api/sessions/maple/s1/attachments?filename=observed.bin`,
        { method: "POST", headers: { cookie, origin: edgeBase } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      chunkedUpload.on("error", reject);
    });
    chunkedUpload.write(Buffer.alloc(32));
    await Promise.race([
      observedFirstChunk,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("daemon did not receive the in-limit prefix")), 500);
      }),
    ]);
    chunkedUpload.end(Buffer.alloc(33));
    const result = await observed;
    assert.equal(result.status, 413, result.body);
    await Promise.race([
      observedClosed,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("daemon request remained open after observed overflow")), 500);
      }),
    ]);
  } finally {
    chunkedUpload?.destroy();
    edge.close();
    daemon.close();
  }
});

test("early attachment admission rejections close incomplete client uploads", async () => {
  const edge = createEdgeServer({ ...config, maxAttachmentBytes: 64 });
  const { base: edgeBase } = await listenOnLoopback(edge);
  try {
    const cookie = await loginCookie(edgeBase);
    const attempt = async (
      path: string,
      expectedStatus: number,
      extraHeaders: Record<string, string> = {},
    ): Promise<void> => {
      let responseStarted = false;
      let upload: ClientRequest | undefined;
      let markClosed: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => {
        markClosed = resolve;
      });
      const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
        upload = createHttpRequest(
          `${edgeBase}${path}`,
          { method: "POST", headers: { cookie, origin: edgeBase, ...extraHeaders } },
          (res) => {
            responseStarted = true;
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        upload.on("error", (error) => {
          if (!responseStarted) reject(error);
        });
        upload.on("close", () => markClosed?.());
      });
      upload.write("x");
      const result = await response;
      assert.equal(result.status, expectedStatus, result.body);
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("edge left an admission-rejected upload open")), 500);
        }),
      ]);
      assert.equal(upload.destroyed, true);
    };

    await attempt("/api/sessions/unknown/s1/attachments?filename=unknown.bin", 404);
    await attempt(
      "/api/sessions/maple/s1/attachments?filename=declared.bin",
      413,
      { "content-length": "65" },
    );
  } finally {
    edge.close();
  }
});

test("a client-disconnected attachment upload promptly aborts the daemon request", async () => {
  let markFirstChunk: (() => void) | undefined;
  let markDaemonClosed: (() => void) | undefined;
  const firstChunk = new Promise<void>((resolve) => {
    markFirstChunk = resolve;
  });
  const daemonClosed = new Promise<void>((resolve) => {
    markDaemonClosed = resolve;
  });
  const daemon = createHttpServer((req) => {
    req.once("data", () => markFirstChunk?.());
    req.once("aborted", () => markDaemonClosed?.());
    req.once("close", () => {
      if (!req.complete) markDaemonClosed?.();
    });
  });
  const { port: daemonPort } = await listenOnLoopback(daemon);
  const edge = createEdgeServer({
    ...config,
    machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
  });
  const { base: edgeBase } = await listenOnLoopback(edge);
  let upload: ClientRequest | undefined;
  try {
    const cookie = await loginCookie(edgeBase);
    upload = createHttpRequest(
      `${edgeBase}/api/sessions/maple/s1/attachments?filename=cancelled.mp4`,
      { method: "POST", headers: { cookie, origin: edgeBase } },
    );
    upload.on("error", () => {});
    upload.write("first chunk");
    await firstChunk;
    upload.destroy();
    await Promise.race([
      daemonClosed,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("daemon request remained open after client disconnect")), 500);
      }),
    ]);
  } finally {
    upload?.destroy();
    edge.close();
    daemon.close();
  }
});

test("an early daemon attachment rejection aborts the upstream request before client EOF", async () => {
  let markDaemonClosed: (() => void) | undefined;
  let markClientClosed: (() => void) | undefined;
  const daemonClosed = new Promise<void>((resolve) => {
    markDaemonClosed = resolve;
  });
  const clientClosed = new Promise<void>((resolve) => {
    markClientClosed = resolve;
  });
  const daemon = createHttpServer((req, res) => {
    req.once("data", () => {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "attachment-too-large" } }));
    });
    req.once("aborted", () => markDaemonClosed?.());
    req.once("end", () => markDaemonClosed?.());
    req.once("close", () => markDaemonClosed?.());
  });
  const { port: daemonPort } = await listenOnLoopback(daemon);
  const edge = createEdgeServer({
    ...config,
    maxAttachmentBytes: 32,
    machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
  });
  const { base: edgeBase } = await listenOnLoopback(edge);
  let upload: ClientRequest | undefined;
  try {
    const cookie = await loginCookie(edgeBase);
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      upload = createHttpRequest(
        `${edgeBase}/api/sessions/maple/s1/attachments?filename=rejected.mp4`,
        { method: "POST", headers: { cookie, origin: edgeBase } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      upload.on("error", reject);
      upload.on("close", () => markClientClosed?.());
    });
    upload.write("first chunk");
    const result = await response;
    assert.equal(result.status, 413, result.body);
    upload.write(Buffer.alloc(64), () => {});
    await Promise.race([
      clientClosed,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("edge kept accepting the client body after the daemon response")), 500);
      }),
    ]);
    assert.equal(upload.destroyed, true);
    await Promise.race([
      daemonClosed,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("daemon request remained open after its early response")), 500);
      }),
    ]);
  } finally {
    upload?.destroy();
    edge.close();
    daemon.close();
  }
});

test("a daemon connection failure terminates an attachment upload before client EOF", async () => {
  const closedDaemon = createHttpServer();
  const { port: closedPort } = await listenOnLoopback(closedDaemon);
  await new Promise<void>((resolve, reject) => {
    closedDaemon.close((error) => error ? reject(error) : resolve());
  });
  const edge = createEdgeServer({
    ...config,
    machines: [{ name: "maple", url: `http://127.0.0.1:${closedPort}`, token: "machine-secret" }],
  });
  const { base: edgeBase } = await listenOnLoopback(edge);
  let upload: ClientRequest | undefined;
  try {
    const cookie = await loginCookie(edgeBase);
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      upload = createHttpRequest(
        `${edgeBase}/api/sessions/maple/s1/attachments?filename=unreachable.mp4`,
        { method: "POST", headers: { cookie, origin: edgeBase } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      upload.on("error", reject);
    });
    upload.write("first chunk");
    const result = await Promise.race([
      response,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("edge did not terminate upload after daemon connection failure")), 500);
      }),
    ]);
    assert.equal(result.status, 500, result.body);
  } finally {
    upload?.destroy();
    edge.close();
  }
});

test("a daemon timeout terminates an attachment upload before client EOF", async () => {
  let markFirstChunk: (() => void) | undefined;
  let markDaemonClosed: (() => void) | undefined;
  const firstChunk = new Promise<void>((resolve) => {
    markFirstChunk = resolve;
  });
  const daemonClosed = new Promise<void>((resolve) => {
    markDaemonClosed = resolve;
  });
  const daemon = createHttpServer((req) => {
    req.once("data", () => markFirstChunk?.());
    req.once("aborted", () => markDaemonClosed?.());
    req.once("close", () => markDaemonClosed?.());
  });
  const { port: daemonPort } = await listenOnLoopback(daemon);
  const edge = createEdgeServer({
    ...config,
    machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
  }, { attachmentUploadTimeoutMs: 50 });
  const { base: edgeBase } = await listenOnLoopback(edge);
  let upload: ClientRequest | undefined;
  try {
    const cookie = await loginCookie(edgeBase);
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      upload = createHttpRequest(
        `${edgeBase}/api/sessions/maple/s1/attachments?filename=timed-out.mp4`,
        { method: "POST", headers: { cookie, origin: edgeBase } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      upload.on("error", reject);
    });
    upload.write("first chunk");
    await firstChunk;
    const result = await Promise.race([
      response,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("edge did not terminate upload after daemon timeout")), 500);
      }),
    ]);
    assert.equal(result.status, 500, result.body);
    await Promise.race([
      daemonClosed,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("daemon request remained open after timeout")), 500);
      }),
    ]);
  } finally {
    upload?.destroy();
    edge.close();
    daemon.close();
  }
});

test("session title mutations stay ordered after an older client request aborts", async () => {
  const seenTitles: string[] = [];
  let currentTitle = "New Codex session";
  let releaseFirst: (() => void) | null = null;
  let markFirstStarted: (() => void) | null = null;
  let markSecondReached: (() => void) | null = null;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const secondReached = new Promise<void>((resolve) => {
    markSecondReached = resolve;
  });
  const daemon = createHttpServer(async (req, res) => {
    const body = JSON.parse((await readRaw(req)).toString() || "{}");
    if (req.method !== "PATCH" || req.url !== "/sessions/s1" || typeof body.title !== "string") {
      res.writeHead(404).end();
      return;
    }
    seenTitles.push(body.title);
    if (seenTitles.length === 1) {
      markFirstStarted?.();
      await firstGate;
    } else {
      markSecondReached?.();
    }
    currentTitle = body.title;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, data: { session: { id: "s1", title: currentTitle } } }));
  });
  const { port: daemonPort } = await listenOnLoopback(daemon);
  const edge = createEdgeServer({
    ...config,
    machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
  });
  const { base: edgeBase } = await listenOnLoopback(edge);
  try {
    const cookie = cookieFrom(
      await fetch(`${edgeBase}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "client-secret" }),
      }),
    );
    const firstController = new AbortController();
    const firstRequest = fetch(`${edgeBase}/api/sessions/maple/s1`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "Older automatic title" }),
      signal: firstController.signal,
    }).catch(() => null);
    await firstStarted;
    firstController.abort();
    const secondRequest = fetch(`${edgeBase}/api/sessions/maple/s1`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "Newer manual title" }),
    });
    const reachedBeforeFirstFinished = await Promise.race([
      secondReached.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 75)),
    ]);
    assert.equal(reachedBeforeFirstFinished, false);
    releaseFirst?.();
    await firstRequest;
    const secondResponse = await secondRequest;
    assert.equal(secondResponse.status, 200);
    assert.equal((await secondResponse.json()).data.session.title, "Newer manual title");
    assert.deepEqual(seenTitles, ["Older automatic title", "Newer manual title"]);
    assert.equal(currentTitle, "Newer manual title");
  } finally {
    edge.close();
    daemon.close();
  }
});

test("resume-id create rejects old daemons that do not confirm provider resume metadata", async () => {
  const daemon = createHttpServer(async (req, res) => {
    await readRaw(req);
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/sessions") {
      res.end(JSON.stringify({ ok: true, data: { session: { id: "fresh-session", status: "running" } } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: { message: "unexpected daemon request" } }));
  });
  const { port: daemonPort } = await listenOnLoopback(daemon);
  const edge = createEdgeServer({
    ...config,
    machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
  });
  const { base: edgeBase } = await listenOnLoopback(edge);
  try {
    const cookie = cookieFrom(
      await fetch(`${edgeBase}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "client-secret" }),
      }),
    );
    const create = await fetch(`${edgeBase}/api/sessions/maple`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ agent: "claude", provider_resume_id: "external-claude-id" }),
    });
    assert.equal(create.status, 502);
    const body = await create.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "provider-resume-unsupported-daemon");
  } finally {
    edge.close();
    daemon.close();
  }
});

test("create sanitizes valid startup metadata and nulls an invalid supplied projection", async () => {
  let createCount = 0;
  const daemon = createHttpServer(async (req, res) => {
    await readRaw(req);
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/sessions") {
      createCount += 1;
      res.end(JSON.stringify({ ok: true, data: { session: createCount === 1 ? {
        id: "valid-startup",
        agent: "codex",
        status: "running",
        startup: {
          schema_version: "agent-session.startup.v1",
          state: "starting",
          stage: "runtime",
          started_at: "2026-07-14T10:00:00Z",
          runtime_fallback: "codex-app-server-runtime-dir-unsafe",
          stderr: "Bearer daemon-secret",
          cwd: "/home/runner/repo",
        },
      } : {
        id: "invalid-startup",
        agent: "codex",
        status: "stopped",
        startup: { schema_version: "future", prompt: "private prompt" },
      } } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: { message: "unexpected daemon request" } }));
  });
  const { port: daemonPort } = await listenOnLoopback(daemon);
  const edge = createEdgeServer({
    ...config,
    machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
  });
  const { base: edgeBase } = await listenOnLoopback(edge);
  try {
    const cookie = cookieFrom(await fetch(`${edgeBase}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "client-secret" }),
    }));
    const create = () => fetch(`${edgeBase}/api/sessions/maple`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ agent: "codex" }),
    });
    const validBody = await (await create()).json();
    assert.deepEqual(validBody.data.session.startup, {
      schema_version: "agent-session.startup.v1",
      state: "starting",
      stage: "runtime",
      started_at: "2026-07-14T10:00:00Z",
      runtime_fallback: "codex-app-server-runtime-dir-unsafe",
    });
    assert.equal(JSON.stringify(validBody).includes("daemon-secret"), false);
    assert.equal(JSON.stringify(validBody).includes("/home/runner"), false);

    const invalidBody = await (await create()).json();
    assert.equal(invalidBody.data.session.startup, null);
    assert.equal(JSON.stringify(invalidBody).includes("private prompt"), false);
  } finally {
    edge.close();
    daemon.close();
  }
});

test("glance sanitizes startup metadata, preserves omission, and nulls invalid supplied projections", async () => {
  const daemon = createHttpServer(async (req, res) => {
    await readRaw(req);
    res.setHeader("content-type", "application/json");
    if (req.method !== "GET") {
      res.writeHead(404);
      res.end(JSON.stringify({ ok: false, error: { message: "unexpected daemon request" } }));
      return;
    }
    const glance = req.url === "/sessions/valid/glance" ? {
      id: "valid",
      status: "running",
      startup: {
        schema_version: "agent-session.startup.v1",
        state: "failed",
        stage: "proxy",
        failure_code: "proxy-start-failed",
        message: "Agent Console could not connect the terminal to the agent runtime.",
        retry_safe: true,
        started_at: "2026-07-14T10:00:00Z",
        occurred_at: "2026-07-14T10:00:01Z",
        stderr: "Bearer daemon-secret",
        cwd: "/home/runner/repo",
      },
    } : req.url === "/sessions/old/glance" ? {
      id: "old",
      status: "running",
    } : req.url === "/sessions/invalid/glance" ? {
      id: "invalid",
      status: "stopped",
      startup: { schema_version: "future", prompt: "private prompt" },
    } : undefined;
    if (glance) {
      res.end(JSON.stringify({ ok: true, data: { glance } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: { message: "unexpected daemon request" } }));
  });
  const { port: daemonPort } = await listenOnLoopback(daemon);
  const edge = createEdgeServer({
    ...config,
    machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
  });
  const { base: edgeBase } = await listenOnLoopback(edge);
  try {
    const cookie = cookieFrom(await fetch(`${edgeBase}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "client-secret" }),
    }));
    const glance = async (id: string): Promise<{ startup?: unknown }> => {
      const res = await fetch(`${edgeBase}/api/sessions/maple/${id}/glance`, { headers: { cookie } });
      assert.equal(res.status, 200);
      return (await res.json()).data.glance;
    };

    const valid = await glance("valid");
    assert.deepEqual(valid.startup, {
      schema_version: "agent-session.startup.v1",
      state: "failed",
      stage: "proxy",
      failure_code: "proxy-start-failed",
      message: "Agent Console could not connect the terminal to the agent runtime.",
      retry_safe: true,
      started_at: "2026-07-14T10:00:00Z",
      occurred_at: "2026-07-14T10:00:01Z",
    });
    assert.equal(JSON.stringify(valid).includes("daemon-secret"), false);
    assert.equal(JSON.stringify(valid).includes("/home/runner"), false);

    const old = await glance("old");
    assert.equal(Object.hasOwn(old, "startup"), false);

    const invalid = await glance("invalid");
    assert.equal(invalid.startup, null);
    assert.equal(JSON.stringify(invalid).includes("private prompt"), false);
  } finally {
    edge.close();
    daemon.close();
  }
});

test("workdirs proxy supports empty and single query strings", async () => {
  const seenUrls: string[] = [];
  const daemon = createHttpServer(async (req, res) => {
    await readRaw(req);
    seenUrls.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, data: { workdirs: [] } }));
  });
  const { port: daemonPort } = await listenOnLoopback(daemon);
  const edge = createEdgeServer({
    ...config,
    machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
  });
  const { base: edgeBase } = await listenOnLoopback(edge);
  try {
    const cookie = cookieFrom(
      await fetch(`${edgeBase}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "client-secret" }),
      }),
    );

    const noQuery = await fetch(`${edgeBase}/api/machines/maple/workdirs`, { headers: { cookie } });
    assert.equal(noQuery.status, 200);
    const singleQuery = await fetch(`${edgeBase}/api/machines/maple/workdirs?limit=3`, { headers: { cookie } });
    assert.equal(singleQuery.status, 200);

    assert.deepEqual(seenUrls, ["/workdirs", "/workdirs?limit=3"]);
  } finally {
    edge.close();
    daemon.close();
  }
});

test("device WS auth: a valid ac-token subprotocol passes the gate even with a foreign Origin", async () => {
  // A real WebView sends Origin: http://tauri.localhost (!= the server host). The
  // token subprotocol must exempt the CSRF gate, so this is accepted (proceeds to
  // proxy; the fixture daemon is down -> "(closed)"), crucially NOT 401/403.
  const accepted = await rawUpgrade(
    "/api/sessions/maple/x/attach",
    "Origin: http://tauri.localhost\r\nSec-WebSocket-Protocol: ac-token.client-secret\r\n",
  );
  assert.doesNotMatch(accepted, /401|403/);
  // A wrong token subprotocol is still rejected at the gate.
  const rejected = await rawUpgrade("/api/sessions/maple/x/attach", "Sec-WebSocket-Protocol: ac-token.wrong\r\n");
  assert.match(rejected, /401/);
});

test("device WS ticket auth passes the gate when the front proxy strips subprotocols", async () => {
  const ticketRes = await fetch(`${base}/api/sessions/maple/x/attach-ticket`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer client-secret",
      origin: "http://tauri.localhost",
    },
    body: "{}",
  });
  assert.equal(ticketRes.status, 200);
  const ticketBody = (await ticketRes.json()) as { data?: { ticket?: string } };
  const ticket = ticketBody.data?.ticket ?? "";
  assert.match(ticket, /^[A-Za-z0-9_-]{32,}$/);

  const accepted = await rawUpgrade(
    `/api/sessions/maple/x/attach?ticket=${encodeURIComponent(ticket)}`,
    "Origin: http://tauri.localhost\r\n",
  );
  assert.doesNotMatch(accepted, /401|403/);

  const replay = await rawUpgrade(
    `/api/sessions/maple/x/attach?ticket=${encodeURIComponent(ticket)}`,
    "Origin: http://tauri.localhost\r\n",
  );
  assert.match(replay, /403/);
});

test("logout invalidates the session", async () => {
  const cookie = await login();
  await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie } });
  const status = await fetch(`${base}/api/auth/status`, { headers: { cookie } });
  assert.equal((await status.json()).authenticated, false);
});

test("open-access mode: /api/* works with no cookie or token", async () => {
  const openServer = createEdgeServer({ ...config, openAccess: true, clientToken: "" });
  const { base: openBase } = await listenOnLoopback(openServer);
  try {
    const sessions = await fetch(`${openBase}/api/sessions`); // no cookie, no token
    assert.equal(sessions.status, 200);
    const status = await (await fetch(`${openBase}/api/auth/status`)).json();
    assert.equal(status.authenticated, true);
    assert.equal(status.openAccess, true); // open deploy reports openAccess:true (UI hides sign out)
    assert.deepEqual(status.principal.permissions,
      ["debug", "usage", "codex_reset"]);
  } finally {
    openServer.close();
  }
});

test("open-access mode still enforces the same-origin gate on write routes (no drive-by CSRF)", async () => {
  const openServer = createEdgeServer({ ...config, openAccess: true, clientToken: "" });
  const { base: openBase, port: openPort } = await listenOnLoopback(openServer);
  // Raw cross-origin WS upgrade helper against THIS open-mode server.
  const openUpgrade = (path: string, extra: string): Promise<string> =>
    new Promise((resolve) => {
      let buf = "";
      let done = false;
      const fin = (fb: string) => {
        if (done) return;
        done = true;
        s.destroy();
        resolve(buf.includes("\r\n") ? (buf.split("\r\n")[0] ?? "") : fb);
      };
      const s = net.connect(openPort, "127.0.0.1", () => {
        s.write(
          `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${openPort}\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
            extra +
            `\r\n`,
        );
      });
      s.setTimeout(1500);
      s.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("\r\n")) fin("");
      });
      s.on("timeout", () => fin("(no status)"));
      s.on("close", () => fin("(closed)"));
      s.on("error", () => fin("(error)"));
    });
  try {
    // A drive-by page (foreign Origin, no token) must NOT be able to write —
    // every state-changing route (send, delete, create) and the WS attach.
    const evilSend = await fetch(`${openBase}/api/sessions/maple/x/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ data: "rm -rf /\n" }),
    });
    assert.equal(evilSend.status, 403);
    const evilDelete = await fetch(`${openBase}/api/sessions/maple/x`, {
      method: "DELETE",
      headers: { origin: "http://evil.example" },
    });
    assert.equal(evilDelete.status, 403);
    const evilCreate = await fetch(`${openBase}/api/sessions/maple`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ agent: "codex" }),
    });
    assert.equal(evilCreate.status, 403);
    // issue 17 write routes are gated too: a foreign-Origin title rename and a
    // foreign-Origin attachment upload must be rejected before any daemon dial.
    const evilPatch = await fetch(`${openBase}/api/sessions/maple/x`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ title: "pwned" }),
    });
    assert.equal(evilPatch.status, 403);
    const evilUpload = await fetch(`${openBase}/api/sessions/maple/x/attachments?filename=x.png`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", origin: "http://evil.example" },
      body: Buffer.from([1, 2, 3]),
    });
    assert.equal(evilUpload.status, 403);
    const evilResume = await fetch(`${openBase}/api/sessions/maple/x/resume`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({}),
    });
    assert.equal(evilResume.status, 403);
    const evilTitleSummary = await fetch(`${openBase}/api/title-summary`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ prompt: "drive-by title" }),
    });
    assert.equal(evilTitleSummary.status, 403);
    const evilWs = await openUpgrade("/api/sessions/maple/x/attach", "Origin: http://evil.example\r\n");
    assert.match(evilWs, /403/);
    // A same-origin write (no cross-origin Origin) still passes the gate — reaches
    // the down fixture daemon, so NOT 403 (the gate let it through).
    const okSend = await fetch(`${openBase}/api/sessions/maple/x/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "hi" }),
    });
    assert.notEqual(okSend.status, 403);
    const okTitleSummary = await fetch(`${openBase}/api/title-summary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "same-origin title" }),
    });
    assert.equal(okTitleSummary.status, 200);
    // The headline open-access positive path: a same-origin, credential-less WS
    // attach must NOT be rejected (auth gate is dropped) — it proceeds to the down
    // fixture daemon. In default mode this exact request is a 401.
    const okWs = await openUpgrade("/api/sessions/maple/x/attach", "");
    assert.doesNotMatch(okWs, /401|403/);
    // Native Tauri app shells run on their own origin (macOS:
    // http://tauri.localhost). In open-access private-network mode there may be no
    // configured client token, so this trusted app-shell origin must pass the
    // write/attach gate while arbitrary web origins stay blocked above.
    const tauriCreate = await fetch(`${openBase}/api/sessions/__codex_probe_unknown_machine__`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://tauri.localhost" },
      body: JSON.stringify({ agent: "codex" }),
    });
    assert.equal(tauriCreate.status, 404);
    const tauriTicket = await fetch(`${openBase}/api/sessions/maple/x/attach-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://tauri.localhost" },
      body: "{}",
    });
    assert.equal(tauriTicket.status, 200);
    const tauriWs = await openUpgrade("/api/sessions/maple/x/attach", "Origin: http://tauri.localhost\r\n");
    assert.doesNotMatch(tauriWs, /401|403/);
    // The token exemption still applies on HTTP writes: a foreign-Origin write
    // bearing the (still-configured) client token is NOT CSRF-able, so not 403.
    const tokenServer = createEdgeServer({ ...config, openAccess: true, clientToken: "client-secret" });
    const { base: tokenBase } = await listenOnLoopback(tokenServer);
    try {
      const tokSend = await fetch(`${tokenBase}/api/sessions/maple/x/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://evil.example",
          authorization: "Bearer client-secret",
        },
        body: JSON.stringify({ data: "hi" }),
      });
      assert.notEqual(tokSend.status, 403);
    } finally {
      tokenServer.close();
    }
  } finally {
    openServer.close();
  }
});

// --- WebSocket upgrade auth gate (raw socket) ---

function rawUpgrade(path: string, extraHeaders: string): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = (fallback: string) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(buf.includes("\r\n") ? (buf.split("\r\n")[0] ?? "") : fallback);
    };
    const s = net.connect(serverPort, "127.0.0.1", () => {
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${serverPort}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
          extraHeaders +
          `\r\n`,
      );
    });
    s.setTimeout(1500);
    // Resolve on the first line, on close, on timeout, or on error — never hang
    // and never reject (an accepted upgrade whose down upstream closes the socket
    // yields "(closed)", which is the "not 401" signal the auth test wants).
    s.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\r\n")) finish("");
    });
    s.on("timeout", () => finish("(no status)"));
    s.on("close", () => finish("(closed)"));
    s.on("error", () => finish("(error)"));
  });
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks);
}

test("WS upgrade without a cookie is rejected 401 before any upstream dial", async () => {
  const line = await rawUpgrade("/api/sessions/maple/x/attach", "");
  assert.match(line, /401/);
});

test("WS upgrade with a bad cookie is rejected 401", async () => {
  const line = await rawUpgrade("/api/sessions/maple/x/attach", "Cookie: ac_session=bogus\r\n");
  assert.match(line, /401/);
});

test("WS upgrade with a valid cookie but unknown machine → 404", async () => {
  const cookie = await login();
  const line = await rawUpgrade("/api/sessions/ghost/x/attach", `Cookie: ${cookie}\r\n`);
  assert.match(line, /404/);
});

test("WS upgrade from a cross-origin page → 403", async () => {
  const cookie = await login();
  const line = await rawUpgrade("/api/sessions/maple/x/attach", `Cookie: ${cookie}\r\nOrigin: http://evil.example\r\n`);
  assert.match(line, /403/);
});

test("rejected upgrades do not crash the shared process", async () => {
  // Fire several unauthenticated upgrades and abruptly drop them, then confirm
  // the process still serves — regression guard for the socket 'error' listener.
  for (let i = 0; i < 20; i++) {
    await rawUpgrade("/api/sessions/maple/x/attach", "").catch(() => "");
  }
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
});

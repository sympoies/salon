import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { strict as assert } from "node:assert";
import test from "node:test";
import { listenOnLoopback } from "./support.ts";

function runScript(
  script: string,
  env: NodeJS.ProcessEnv,
  input: unknown,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [script], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin.end(JSON.stringify(input));
  return once(child, "close").then(([code]) => ({ code, stdout, stderr }));
}

test("openai-compatible title summarizer script preserves legacy plain output", async () => {
  let seenBody: unknown;
  let seenAuth: string | undefined;
  const server = createServer((req, res) => {
    seenAuth = req.headers.authorization;
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      seenBody = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: " Mobile title flow \n" } }],
      }));
    });
  });
  const { base } = await listenOnLoopback(server);

  try {
    const result = await runScript("scripts/title-summarizer-openai-compatible.ts", {
      AGENT_CONSOLE_TITLE_SUMMARIZER_BASE_URL: `${base}/v1`,
      AGENT_CONSOLE_TITLE_SUMMARIZER_MODEL: "tiny-title-model",
      AGENT_CONSOLE_TITLE_SUMMARIZER_API_KEY: "local-key",
      AGENT_CONSOLE_TITLE_SUMMARIZER_SLOT_ID: "1",
    }, {
      prompt: "fix mobile title flow\nwith implementation details",
      base_title: "agent-console",
      current_title: "agent-console - Old title",
      recent_output: "Implemented the idle title refresh.",
      agent: "codex",
      repo_name: "example-org/agent-console",
      max_chars: 120,
      instruction: "Return only a concise session title suffix.",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "Mobile title flow");
    assert.equal(seenAuth, "Bearer local-key");
    assert.deepEqual(seenBody, {
      model: "tiny-title-model",
      id_slot: 1,
      messages: [
        {
          role: "system",
          content: "Return only a concise session title suffix.",
        },
        {
          role: "user",
          content: JSON.stringify({
            base_title: "agent-console",
            prompt: "fix mobile title flow\nwith implementation details",
            max_chars: 120,
            current_title: "agent-console - Old title",
            recent_output: "Implemented the idle title refresh.",
            agent: "codex",
            repo_name: "example-org/agent-console",
          }),
        },
      ],
      max_tokens: 96,
      temperature: 0.2,
      stream: false,
    });
  } finally {
    server.close();
  }
});

test("openai-compatible title summarizer strips a model-generated leading bullet", async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "- Verifying deterministic Retitle routing" } }],
      }));
    });
  });
  const { base } = await listenOnLoopback(server);

  try {
    const result = await runScript("scripts/title-summarizer-openai-compatible.ts", {
      AGENT_CONSOLE_TITLE_SUMMARIZER_BASE_URL: `${base}/v1`,
      AGENT_CONSOLE_TITLE_SUMMARIZER_MODEL: "tiny-title-model",
    }, { prompt: "verify deterministic Retitle routing" });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "Verifying deterministic Retitle routing");
  } finally {
    server.close();
  }
});

test("openai-compatible title summarizer strips a leading bullet from JSON title output", async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ title: "- Safe JSON title" }) } }],
      }));
    });
  });
  const { base } = await listenOnLoopback(server);

  try {
    const result = await runScript("scripts/title-summarizer-openai-compatible.ts", {
      AGENT_CONSOLE_TITLE_SUMMARIZER_BASE_URL: `${base}/v1`,
      AGENT_CONSOLE_TITLE_SUMMARIZER_MODEL: "tiny-title-model",
    }, { prompt: "verify JSON title normalization" });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "Safe JSON title");
  } finally {
    server.close();
  }
});

test("openai-compatible title summarizer parses pretty-printed structured decisions", async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          topic_action: "set",
          topic: "Structured retitle",
          activity: "Implement contract",
        }, null, 2) } }],
      }));
    });
  });
  const { base } = await listenOnLoopback(server);

  try {
    const result = await runScript("scripts/title-summarizer-openai-compatible.ts", {
      AGENT_CONSOLE_TITLE_SUMMARIZER_BASE_URL: `${base}/v1`,
      AGENT_CONSOLE_TITLE_SUMMARIZER_MODEL: "tiny-title-model",
    }, { prompt: "implement structured retitle" });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      topic_action: "set",
      topic: "Structured retitle",
      activity: "Implement contract",
    });
  } finally {
    server.close();
  }
});

test("openai-compatible title summarizer script requires endpoint and model env", async () => {
  const result = await runScript("scripts/title-summarizer-openai-compatible.ts", {
    AGENT_CONSOLE_TITLE_SUMMARIZER_BASE_URL: "",
    AGENT_CONSOLE_TITLE_SUMMARIZER_MODEL: "",
  }, { prompt: "fix title" });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /AGENT_CONSOLE_TITLE_SUMMARIZER_BASE_URL/);
});

test("openai-compatible title summarizer script omits id_slot when unconfigured", async () => {
  let seenBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      seenBody = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: " Compatible request" } }] }));
    });
  });
  const { base } = await listenOnLoopback(server);

  try {
    const result = await runScript("scripts/title-summarizer-openai-compatible.ts", {
      AGENT_CONSOLE_TITLE_SUMMARIZER_BASE_URL: `${base}/v1`,
      AGENT_CONSOLE_TITLE_SUMMARIZER_MODEL: "tiny-title-model",
      AGENT_CONSOLE_TITLE_SUMMARIZER_SLOT_ID: "",
    }, { prompt: "keep provider compatibility" });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "Compatible request");
    assert.equal(Object.hasOwn(seenBody ?? {}, "id_slot"), false);
  } finally {
    server.close();
  }
});

test("openai-compatible title summarizer script rejects an invalid slot id", async () => {
  const result = await runScript("scripts/title-summarizer-openai-compatible.ts", {
    AGENT_CONSOLE_TITLE_SUMMARIZER_BASE_URL: "http://127.0.0.1:1234/v1",
    AGENT_CONSOLE_TITLE_SUMMARIZER_MODEL: "tiny-title-model",
    AGENT_CONSOLE_TITLE_SUMMARIZER_SLOT_ID: "slot-one",
  }, { prompt: "fix title" });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /AGENT_CONSOLE_TITLE_SUMMARIZER_SLOT_ID/);
});

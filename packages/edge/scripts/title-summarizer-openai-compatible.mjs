#!/usr/bin/env node

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_TOKENS = 96;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_INSTRUCTION = "Return strict JSON with exactly topic_action (keep, set, or clear), topic (string or null), and activity (string or null). Keep a user-owned topic. Set or revise an automatic topic only after the session has a clear durable subject; leave the topic unset while discussion is exploratory. Activity is the concise current action. For an exploratory turn with no stable topic or useful status, return activity null so the title remains unset. Never invent issue or pull-request references, repeat the topic, include secrets, Markdown, or commentary.";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalPositiveNumber(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function optionalNonNegativeInteger(name) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

async function readStdinJson() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString("utf8");
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`stdin must be JSON: ${err.message}`);
  }
}

function firstLine(value) {
  if (typeof value !== "string") {
    return null;
  }
  const line = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return line ? line.replace(/\s+/g, " ") : null;
}

function normalizeModelOutput(value) {
  if (typeof value !== "string") {
    return null;
  }
  const unfenced = value
    .trim()
    .replace(/^```(?:text|json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!unfenced) {
    return null;
  }
  try {
    const parsed = JSON.parse(unfenced);
    if (
      parsed
      && typeof parsed === "object"
      && ["keep", "set", "clear"].includes(parsed.topic_action)
      && (typeof parsed.topic === "string" || parsed.topic === null)
      && (typeof parsed.activity === "string" || parsed.activity === null)
    ) {
      return JSON.stringify({
        topic_action: parsed.topic_action,
        topic: parsed.topic,
        activity: parsed.activity,
      });
    }
    if (parsed && typeof parsed === "object" && typeof parsed.title === "string") {
      const line = firstLine(parsed.title);
      if (!line) {
        return null;
      }
      return line
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
        .replace(/^(?:[-*•]\s+)+/, "")
        .replace(/^title\s*:\s*/i, "")
        .trim();
    }
  } catch {
    if (/^[{[]/.test(unfenced)) {
      return null;
    }
  }
  const line = firstLine(unfenced);
  if (!line) {
    return null;
  }
  return line
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/^(?:[-*•]\s+)+/, "")
    .replace(/^title\s*:\s*/i, "")
    .trim();
}

function extractContent(payload) {
  const choice = payload?.choices?.[0];
  if (typeof choice?.message?.content === "string") {
    return choice.message.content;
  }
  if (typeof choice?.text === "string") {
    return choice.text;
  }
  return null;
}

async function main() {
  const input = await readStdinJson();
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (!prompt.trim()) {
    throw new Error("stdin prompt must be a non-empty string");
  }
  const instruction = typeof input.instruction === "string" && input.instruction.trim()
    ? input.instruction.trim().slice(0, 4096)
    : DEFAULT_INSTRUCTION;

  const baseUrl = requiredEnv("AGENT_CONSOLE_TITLE_SUMMARIZER_BASE_URL").replace(/\/+$/, "");
  const model = requiredEnv("AGENT_CONSOLE_TITLE_SUMMARIZER_MODEL");
  const apiKey = process.env.AGENT_CONSOLE_TITLE_SUMMARIZER_API_KEY?.trim() ?? "";
  const timeoutMs = optionalPositiveNumber("AGENT_CONSOLE_TITLE_SUMMARIZER_REQUEST_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const maxTokens = optionalPositiveNumber("AGENT_CONSOLE_TITLE_SUMMARIZER_MAX_TOKENS", DEFAULT_MAX_TOKENS);
  const temperature = Number(process.env.AGENT_CONSOLE_TITLE_SUMMARIZER_TEMPERATURE ?? DEFAULT_TEMPERATURE);
  const slotId = optionalNonNegativeInteger("AGENT_CONSOLE_TITLE_SUMMARIZER_SLOT_ID");
  if (!Number.isFinite(temperature) || temperature < 0) {
    throw new Error("AGENT_CONSOLE_TITLE_SUMMARIZER_TEMPERATURE must be a non-negative number");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const modelInput = {
      base_title: typeof input.base_title === "string" ? input.base_title : null,
      prompt,
      max_chars: typeof input.max_chars === "number" ? input.max_chars : 120,
    };
    if (input.title_state && typeof input.title_state === "object") {
      modelInput.title_state = input.title_state;
    }
    if (typeof input.current_title === "string" && input.current_title.trim()) {
      modelInput.current_title = input.current_title;
    }
    if (typeof input.recent_output === "string" && input.recent_output.trim()) {
      modelInput.recent_output = input.recent_output;
    }
    if (typeof input.agent === "string" && input.agent.trim()) {
      modelInput.agent = input.agent;
    }
    if (typeof input.repo_name === "string" && input.repo_name.trim()) {
      modelInput.repo_name = input.repo_name;
    }
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        ...(slotId === null ? {} : { id_slot: slotId }),
        messages: [
          {
            role: "system",
            content: instruction,
          },
          {
            role: "user",
            content: JSON.stringify(modelInput),
          },
        ],
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
    });
    if (!response.ok) {
      throw new Error(`title model request failed: HTTP ${response.status}`);
    }
    const payload = await response.json();
    const title = normalizeModelOutput(extractContent(payload));
    if (!title) {
      throw new Error("title model returned an empty title");
    }
    process.stdout.write(`${title}\n`);
  } finally {
    clearTimeout(timer);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});

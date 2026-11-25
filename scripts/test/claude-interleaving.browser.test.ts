import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createEdgeServer } from "../../packages/edge/src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "../../packages/edge/test/support.ts";
import { launchPage } from "../../packages/ui/test/support/browserPage.ts";

const uiRoot = new URL("../../packages/ui/", import.meta.url);
const uiRequire = createRequire(new URL("package.json", uiRoot));
const { build } = await import(uiRequire.resolve("vite"));
const { default: react } = await import(uiRequire.resolve("@vitejs/plugin-react"));
type BundleItem = { type: "chunk"; code: string } | { type: "asset"; fileName: string; source: string | Uint8Array };

type Block = { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: { command: string } }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }
  | { type: "thinking" };
type Entry = { uuid: string; message: { id?: string; role: "user" | "assistant"; content: string | [Block] } };
type FixtureRow = { id: string; role: Entry["message"]["role"]; text: string; parts: Record<string, unknown>[] };

// The runtime projects parts=v1 by transcript offset. The inner Claude message
// ID is not a row ID and is not sent to Salon. Only the fixture shapes are
// mapped here; this test exercises Salon rather than the runtime parser.
function fixtureRows() {
  const lines = readFileSync(new URL("../fixtures/claude-interleaved-tools.jsonl", import.meta.url), "utf8").trimEnd().split("\n");
  const entries = lines.map(line => JSON.parse(line) as Entry);
  assert.ok(entries[4]?.message.id);
  assert.equal(entries[4].message.id, entries[5]?.message.id);
  let offset = 0;
  return entries.flatMap<FixtureRow>(({ uuid, message: { role, content } }, index) => {
    const id = `fixture-${offset}`;
    offset += Buffer.byteLength(lines[index]!) + 1;
    if (typeof content === "string") return [{ id, role, text: content, parts: [] }];
    const [block] = content;
    if (block.type === "thinking") return [];
    if (block.type === "text") return [{ id, role, text: block.text, parts: [{ kind: "text", id: uuid, text: block.text }] }];
    const part = block.type === "tool_use"
      ? { kind: "tool_call", id: uuid, call_id: block.id, name: block.name, input_summary: block.input.command }
      : { kind: "tool_result", id: uuid, call_id: block.tool_use_id, summary: block.content, is_error: block.is_error };
    return [{ id, role, text: "", parts: [part] }];
  });
}

const history = {
  id: "history", machine: "fixture", provider: "claude", provider_session_id: "fixture-provider",
  cwd: "/workspace/sample", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:01:00Z",
};

async function buildClient(out: string) {
  const built = await build({
    root: fileURLToPath(uiRoot), configFile: false, logLevel: "silent",
    resolve: { conditions: ["source"] }, define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "claude-interleaving-fixture",
      resolveId(id: string) { if (id.endsWith("interleaving-fixture")) return "\0interleaving-fixture"; },
      load(id: string) {
        if (id !== "\0interleaving-fixture") return;
        return `
          import { createElement as h, useEffect } from 'react';
          import { createRoot } from 'react-dom/client';
          import { useLiveConversation } from '/src/useLiveConversation.ts';
          import { HistoryConversationView, useHistoryConversation } from '/src/HistoryConversation.tsx';
          import '/src/styles.css';

          const history = ${JSON.stringify(history)};
          const live = { id:'fixture-live', status:'running', agent:'claude', machine:history.machine,
            provider_resume:{ provider:'claude', session_id:history.provider_session_id } };
          const fetchOrigin = window.fetch.bind(window);
          let offline = false;
          let stream;
          let holdLatest = false;
          window.holdLatest = () => { holdLatest = true; };
          const requests = { stream: 0, latest: 0 };
          window.dropStream = () => { offline = true; stream?.abort(); };
          window.restoreStream = () => { offline = false; };
          window.fetch = (path, init) => {
            const url = new URL(path, location.origin);
            if (url.pathname === '/api/resources/events') {
              if (offline) return Promise.resolve(new Response(null, { status: 503 }));
              requests.stream++;
              stream = new AbortController();
              return fetchOrigin(path, { ...init, signal: AbortSignal.any([stream.signal, init.signal]) });
            }
            if (url.pathname.endsWith('/messages') && url.searchParams.get('direction') === 'latest') {
              requests.latest++;
              if (holdLatest) return Promise.resolve(new Response(null, { status: 503 }));
            }
            return fetchOrigin(path, init);
          };
          function Conversation({ conversation, working }) {
            window.readConversation = () => {
              const rows = document.querySelectorAll('.history-messages > .conversation-tool-group, .history-messages > .history-message.is-assistant');
              const items = [...rows].map(row => row.querySelector('.conversation-tool-group-summary, .conversation-tool-toggle, .history-bubble'));
              return {
                loaded: conversation.messagesLoaded,
                ids: conversation.messages.map(row => row.id),
                items: items.map(item => item?.getClientRects().length ? item.getAttribute('aria-label') ?? item.textContent : null),
                statuses: [...document.querySelectorAll('.conversation-tool-toggle')].map(button => button.querySelector('.conversation-tool-status')?.textContent ?? null),
                working: !!document.querySelector('.history-working'),
                width: innerWidth,
                requests: { ...requests },
              };
            };
            return h(HistoryConversationView, { conversation, working, onJumpToLatest() {} });
          }
          function Live() {
            const { conversation } = useLiveConversation(live);
            return h(Conversation, { conversation, working: true });
          }
          const savedError = message => { window.fixtureError = message; };
          function Saved() {
            const conversation = useHistoryConversation(savedError);
            const { open } = conversation;
            useEffect(() => { void open(history, true); }, [open]);
            return h(Conversation, { conversation, working: false });
          }
          createRoot(document.querySelector('#root')).render(h(location.search ? Saved : Live));`;
      },
    }],
    build: { write: false, lib: { entry: "interleaving-fixture", name: "Fixture", formats: ["iife"] } },
  });
  const bundle = (Array.isArray(built) ? built[0] : built) as { output?: BundleItem[] } | undefined;
  assert.ok(bundle?.output);
  const script = bundle.output.find(file => file.type === "chunk");
  const style = bundle.output.find(file => file.type === "asset" && file.fileName.endsWith(".css"));
  assert.ok(script?.type === "chunk" && style?.type === "asset");
  writeFileSync(join(out, "fixture.js"), script.code);
  writeFileSync(join(out, "fixture.css"), style.source);
  writeFileSync(join(out, "index.html"), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js" defer></script>');
}

interface ConversationState {
  loaded: boolean;
  ids: string[];
  items: Array<string | null>;
  statuses: Array<string | null>;
  working: boolean;
  width: number;
  requests: { stream: number; latest: number };
}

test("Claude interleaved text stays visible in saved history and while live tools run", { timeout: 90_000 }, async t => {
  const throughResult = fixtureRows();
  const complete = throughResult.slice(0, 5);
  const [prompt, first, result, text, second] = complete;
  assert.ok(prompt && first && result && text && second);
  assert.notEqual(text.id, second.id);
  const twoToolsAndText = ["Bash", text.text, "Bash"];
  let visible = [prompt, first];
  let spokeOffline = false;
  const queries: URLSearchParams[] = [];
  const frames: Array<{ type: string; delta: boolean; ids: string[] }> = [];

  const uiDir = mkdtempSync("/tmp/salon-interleaving-");
  t.after(() => rmSync(uiDir, { recursive: true, force: true }));
  await buildClient(uiDir);
  const daemon = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    if (url.pathname.endsWith("/messages")) {
      queries.push(url.searchParams);
      if (spokeOffline) {
        req.socket.destroy();
        return;
      }
    }
    const data = url.pathname === "/history/sessions" ? { sessions: [history], capabilities: { latest_message_paging: true } }
      : url.pathname === "/history/sessions/history/messages" && url.searchParams.get("parts") === "v1" ? { messages: visible } : undefined;
    res.writeHead(data ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify({ ok: !!data, data }));
  });
  t.after(() => {
    daemon.closeAllConnections();
    return new Promise<void>(resolve => daemon.close(() => resolve()));
  });
  const { base: upstream } = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({ uiDir, machines: [{ name: "fixture", url: upstream, token: "" }] }));
  t.after(() => {
    edge.closeAllConnections();
    return edge.shutdown();
  });
  edge.prependListener("request", (req, res) => {
    if (!req.url?.startsWith("/api/resources/events?")) return;
    const write = res.write.bind(res);
    res.write = ((chunk: unknown, ...args: unknown[]) => {
      if (typeof chunk === "string") {
        const data = chunk.split("\n").find(line => line.startsWith("data: "));
        if (data) {
          const event = JSON.parse(data.slice(6));
          frames.push({ type: event.type, delta: !!event.conversation_delta,
            ids: event.conversation?.messages.map((row: { id: string }) => row.id) ?? [] });
        }
      }
      return Reflect.apply(write, res, [chunk, ...args]);
    }) as typeof res.write;
  });
  const { base } = await listenOnLoopback(edge);
  const page = await launchPage();
  t.after(() => page.close());
  await page.addInitScript('window.addEventListener("error", event => { window.fixtureError = event.message; });');

  const ids = (rows: typeof complete) => rows.map(row => row.id);
  const expectState = async (items: string[], ready: (state: ConversationState) => boolean = () => true) => {
    const expectedIds = JSON.stringify(ids(visible));
    let state: ConversationState | undefined;
    const deadline = Date.now() + 10_000;
    do {
      state = await page.evaluate<ConversationState | undefined>('(() => { if (window.fixtureError) throw new Error(window.fixtureError); return window.readConversation?.(); })()');
      if (state?.loaded && JSON.stringify(state.ids) === expectedIds && ready(state)) {
        assert.deepEqual(state.items, items);
        return state;
      }
      await sleep(75);
    } while (Date.now() < deadline);
    assert.fail(`Conversation did not reach ${expectedIds}: ${JSON.stringify(state)}`);
  };
  const assertPending = (state: ConversationState, working: boolean, width: number) => {
    assert.deepEqual(state.statuses, ["OK", null], "first call completed; second still pending");
    assert.equal(state.working, working);
    assert.equal(state.width, width);
  };

  await t.test("saved and latest HTTP retain distinct text and call rows", async () => {
    visible = complete;
    for (const query of ["", "?direction=latest"]) {
      const response = await fetch(`${base}/api/history/sessions/fixture/history/messages${query}`);
      assert.equal(response.status, 200);
      const { data } = await response.json();
      assert.deepEqual(data.messages.map((row: typeof prompt) => row.id), ids(complete));
      assert.equal(data.messages[3].text, text.text);
      assert.equal(data.messages[4].tool_parts[0].kind, "tool_call");
    }
    for (const [width, height] of [[384, 832], [1280, 900]] as const) {
      await page.setViewport(width, height, 1);
      await page.navigate(`${base}/?saved`);
      assertPending(await expectState(twoToolsAndText), false, width);
    }
  });

  await t.test("live SSE preserves the text when the pending call follows it", async () => {
    await page.setViewport(384, 832, 1);
    visible = [prompt, first];
    await page.navigate(base);
    const initial = await expectState(["Bash"], state => state.requests.stream > 0);
    visible = [...visible, result];
    await expectState(["Bash"]);
    visible = [...visible, text];
    await expectState(["Bash", text.text]);
    visible = complete;
    const final = await expectState(twoToolsAndText);
    assert.equal(final.requests.latest, initial.requests.latest, "successive rows arrived on the stream");
    assertPending(final, true, 384);
    await page.setViewport(1280, 900, 1);
    assertPending(await expectState(twoToolsAndText, state => state.width === 1280), true, 1280);
  });

  await t.test("live SSE restores order when the call is observed before its text", async () => {
    visible = [prompt, first, result];
    await page.navigate(base);
    const initial = await expectState(["Bash"], state => state.requests.stream > 0);
    visible = [...visible, second];
    await expectState(["2 tool calls · Bash 2"]);
    visible = complete;
    const final = await expectState(twoToolsAndText);
    assert.equal(final.requests.latest, initial.requests.latest);
    assertPending(final, true, 1280);
  });

  await t.test("latest GET reconciles the pending call during a stream interruption", async () => {
    visible = [prompt, first, result, text];
    await page.navigate(base);
    const initial = await expectState(["Bash", text.text], state => state.requests.stream > 0);
    await page.evaluate("window.dropStream()");
    visible = complete;
    const fallback = await expectState(twoToolsAndText, state => state.requests.latest > initial.requests.latest);
    assertPending(fallback, true, 1280);
    await page.evaluate("window.restoreStream()");
    const reconnected = await expectState(twoToolsAndText, state => state.requests.stream > initial.requests.stream);
    assertPending(reconnected, true, 1280);
  });

  await t.test("edge recovery from a daemon outage sends an authoritative page", async () => {
    visible = complete;
    const initialFrame = frames.length;
    await page.navigate(base);
    await expectState(twoToolsAndText, () => frames.slice(initialFrame).some(frame => frame.ids.length === complete.length));
    // Isolate the recovery frame from the browser's independent latest-GET fallback.
    await page.evaluate("window.holdLatest()");
    spokeOffline = true;
    const duringOutage = frames.length;
    const deadline = Date.now() + 10_000;
    while (!frames.slice(duringOutage).some(frame => frame.type === "unavailable") && Date.now() < deadline) await sleep(75);
    assert.ok(frames.slice(duringOutage).some(frame => frame.type === "unavailable"));
    visible = throughResult;
    const reconnectQueries = queries.length;
    spokeOffline = false;
    const recovered = await expectState(twoToolsAndText);
    const update = frames.slice(duringOutage).find(frame => frame.type === "changed");
    assert.deepEqual(update, { type: "changed", delta: false, ids: ids(throughResult) });
    assert.equal(queries[reconnectQueries]?.get("direction"), "latest");
    assert.equal(queries[reconnectQueries]?.has("cursor"), false);
    assert.deepEqual(recovered.statuses, ["OK", "OK"]);
  });
});

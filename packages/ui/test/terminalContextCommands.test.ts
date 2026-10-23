import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import type { SpecialKey } from "../src/frames.ts";
import type { TerminalPaneProps } from "../src/TerminalPane.tsx";
import { createUiSsrHarness } from "./support/ssr.ts";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";

interface Input { text?: string; keys?: readonly SpecialKey[] }
interface Fixture {
  socket: boolean;
  inputs: Input[];
  rejectNext?: boolean;
  rejectionUnknown?: boolean;
  deferNext?: boolean;
  rejectDeferred?: () => void;
  deps?: {
    sendTextFrame(text: string): void;
    sendKeyFrame(key: SpecialKey): void;
    terminalPasteInputRef: { current: boolean };
    onProviderPromptCapability(mode: "fallback"): void;
    onInputRejected(rejection: {message: string; outcomeUnknown?: boolean}): void;
  };
}
declare global { var __terminalContextFixture: Fixture | undefined; }

// Keep the real component, clipboard and HTTP input owner. Replace only the
// terminal's DOM/connection adapter so tests can deliver actual onData callbacks.
const terminalAdapter: Plugin = {
  name: "context-command-terminal-adapter", enforce: "pre",
  resolveId(id, importer) {
    if (id === "./terminalInstance.ts" && importer?.includes("/src/")) return "\0context-terminal";
  },
  load(id) {
    if (id !== "\0context-terminal") return;
    return `
      export const BASE_TERMINAL_FONT_SIZE = 14;
      export const TERMINAL_TOUCH_MENU_HEIGHT_PX = 40;
      export const TERMINAL_TOUCH_MENU_WIDTH_PX = 200;
      export function createTerminalInstance(host, deps) {
        const fixture = globalThis.__terminalContextFixture;
        fixture.deps = deps;
        deps.termRef.current = {focus(){},blur(){},hasSelection(){return false;},
          paste(text){deps.sendTextFrame(text);}};
        deps.transportRef.current = fixture.socket ? {
          sendInput(body){if(fixture.rejectNext){fixture.rejectNext=false;return Promise.resolve().then(()=>deps.onInputRejected({message:'not sent',retryable:true,outcomeUnknown:fixture.rejectionUnknown ?? false}));}fixture.inputs.push(body);return Promise.resolve();},wake(){},
        } : null;
        return () => {deps.termRef.current=null;deps.transportRef.current=null;};
      }
    `;
  },
};

async function withPane(agent: string, socket: boolean, run: (fixture: {
  inputs: Input[];
  rejectNext(unknown?: boolean): void;
  rejectLater(unknown?: boolean): Promise<void>;
  deferNext(): void;
  rejectDeferred(): Promise<void>;
  text(text: string, paste?: boolean): Promise<void>;
  key(key: SpecialKey): Promise<void>;
  enter(): Promise<void>;
  click(label: string): Promise<void>;
  prompts: string[];
  notice(): string;
  html(): string;
  remount(props: Partial<TerminalPaneProps>): Promise<void>;
}) => Promise<void>) {
  const window = new Window({ url: "http://localhost" });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previous = {
    window: globalThis.window, document: globalThis.document,
    Element: globalThis.Element, HTMLElement: globalThis.HTMLElement, Event: globalThis.Event,
    fetch: globalThis.fetch, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
  Object.assign(globalThis, { window, document: window.document, Element: window.Element,
    HTMLElement: window.HTMLElement, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const fixture: Fixture = { socket, inputs: [] };
  globalThis.__terminalContextFixture = fixture;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/api\/sessions\/fixture\/session-one\/send$/);
    const body = JSON.parse(String(init?.body));
    if (fixture.deferNext) {
      fixture.deferNext = false;
      return await new Promise<Response>((resolve) => {
        fixture.rejectDeferred = () => resolve(new Response(JSON.stringify({error: "not sent"}), {status: 409}));
      });
    }
    assert.equal(body.allow_blocked, true, "human permission replies retain their HTTP intent");
    if(fixture.rejectNext){fixture.rejectNext=false;return new Response(JSON.stringify({error:'not sent'}),{status:fixture.rejectionUnknown ? 503 : 409});}
    fixture.inputs.push({ ...(body.text === undefined ? {} : {text: body.text}),
      ...(body.keys === undefined ? {} : {keys: body.keys}) });
    return new Response(JSON.stringify({ ok: true }), {status: 200});
  };
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = createRoot(host);
  const ssr = createUiSsrHarness([terminalAdapter]);
  try {
    const { TerminalPane } = await ssr.loadModule<typeof import("../src/TerminalPane.tsx")>("/src/TerminalPane.tsx");
    const prompts: string[] = [];
    let props: TerminalPaneProps = { machine: "fixture", id: "session-one", agent, showKeyBar: true,
      onTurnPromptSubmit: prompt => { prompts.push(prompt); } };
    const remount = async (changes: Partial<TerminalPaneProps>) => {
      props = { ...props, ...changes };
      await act(async () => root.render(createElement(TerminalPane, props)));
      assert.ok(fixture.deps);
      fixture.deps.onProviderPromptCapability("fallback");
    };
    await remount({});
    const click = async (label: string) => {
      const button = [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find(b => b.textContent === label || b.getAttribute("aria-label") === label);
      assert.ok(button);
      await act(async () => button.click());
    };
    await run({
      inputs: fixture.inputs,
      deferNext: () => {fixture.deferNext=true;},
      rejectDeferred: async () => {await act(async () => fixture.rejectDeferred!());},
      rejectNext: (unknown = false) => {fixture.rejectNext=true;fixture.rejectionUnknown=unknown;},
      rejectLater: async (unknown = false) => {await act(async () => {
        await Promise.resolve();
        fixture.deps!.onInputRejected({message: "rejected callback", outcomeUnknown: unknown});
      });},
      text: async (text, paste = false) => {
        await act(async () => {
          fixture.deps!.terminalPasteInputRef.current = paste;
          try { fixture.deps!.sendTextFrame(text); }
          finally { fixture.deps!.terminalPasteInputRef.current = false; }
        });
      },
      key: async key => { await act(async () => fixture.deps!.sendKeyFrame(key)); },
      enter: () => click("Enter"),
      click,
      prompts,
      notice: () => host.querySelector(".upload-status.error")?.textContent ?? "",
      html: () => host.innerHTML,
      remount,
    });
  } finally {
    await act(async () => root.unmount());
    await ssr.close();
    delete globalThis.__terminalContextFixture;
    Object.assign(globalThis, previous);
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
    await window.happyDOM.close();
  }
}

for (const socket of [true, false]) {
  for (const [agent, command] of [["codex", "/new"], ["claude", "/clear"]]) {
    test(`${agent} refuses incremental ${command} before ${socket ? "socket" : "HTTP"} Enter`, async () => {
      await withPane(agent, socket, async p => {
        for (const char of command) await p.text(char);
        const before = p.inputs.length;
        await p.key("enter");
        await p.enter();
        assert.equal(p.inputs.length, before, "neither physical nor repeated touch Enter may reach the provider");
        assert.match(p.notice(), /managed|thread|context/i);
        assert.match(p.notice(), /restart/i);
      });
    });
  }
}

test("embedded submit bytes do not bypass the context guard", async () => {
  await withPane("codex", true, async p => {
    await p.text("/new\r");
    assert.equal(p.inputs.length, 0, "reject the whole unsent frame, including its submission");
    assert.match(p.notice(), /restart/i);
  });
});

test("bracketed clipboard context commands cannot be submitted through the key bar", async () => {
  await withPane("claude", true, async p => {
    await p.text("\x1b[200~/clear named task\x1b[201~", true);
    const before = p.inputs.length;
    await p.enter();
    assert.equal(p.inputs.length, before);
    assert.match(p.notice(), /restart/i);
  });
});

test("safe slash commands, IME and permission answers retain their input bytes", async () => {
  await withPane("codex", false, async p => {
    for (const text of ["/model", "/compact", "/usage", "中文問題", "y", "explain /new in docs"]) {
      await p.text(text);
      await p.enter();
    }
    await p.key("c-c");
    await p.key("escape");
    assert.deepEqual(p.inputs, [
      ...["/model", "/compact", "/usage", "中文問題", "y", "explain /new in docs"]
        .flatMap(text => [{text}, {keys: ["enter"]}]),
      {keys: ["c-c"]}, {keys: ["escape"]},
    ]);
    assert.equal(p.notice(), "");
  });
});

for (const agent of ["shell", "dsh", "constructor", "__proto__"]) {
  test(`${agent} keeps its ordinary slash text and Enter`, async () => {
    await withPane(agent, true, async p => {
      await p.text("/new"); await p.enter();
      assert.deepEqual(p.inputs, [{text: "/new"}, {keys: ["enter"]}]);
    });
  });
}

test("provider-specific fresh and switched conversation commands are refused", async () => {
  for (const [agent, commands] of [
    ["codex", ["/new", "/clear", "/resume previous", "/fork"]],
    ["claude", ["/clear named", "/new", "/reset", "/resume previous", "/branch", "/teleport", "/tp"]],
  ] as const) {
    await withPane(agent, true, async p => {
      for (const command of commands) {
        await p.key("c-c");
        await p.text(command);
        const before = p.inputs.length;
        await p.enter();
        assert.equal(p.inputs.length, before, command);
      }
    });
  }
});

test("editing into a destructive command is refused and editing away from it permits Enter", async () => {
  await withPane("claude", true, async p => {
    await p.text("/clxear");
    for (let n = 0; n < 3; n++) await p.key("left");
    await p.key("backspace");
    for (let n = 0; n < 3; n++) await p.key("right");
    const before = p.inputs.length;
    await p.enter();
    assert.equal(p.inputs.length, before, "cursor edits assembled /clear");
    await p.key("c-c");
    await p.text("/new");
    for (let n = 0; n < 3; n++) await p.key("backspace");
    await p.text("model");
    await p.enter();
    assert.deepEqual(p.inputs.at(-1), {keys: ["enter"]});
    await p.text("/newspaper");
    await p.enter();
    assert.deepEqual(p.inputs.at(-1), {keys: ["enter"]}, "command boundaries matter");
  });
});

test("Escape and reconnect do not discard the guarded draft; a new session does", async () => {
  await withPane("codex", true, async p => {
    await p.text("/new");
    await p.key("escape");
    let before = p.inputs.length;
    await p.enter();
    assert.equal(p.inputs.length, before, "Escape may dismiss a menu without clearing its draft");
    await p.remount({ reconnectToken: 1 });
    before = p.inputs.length;
    await p.enter();
    assert.equal(p.inputs.length, before, "reconnect does not clear the provider draft");
    await p.remount({ id: "session-two" });
    await p.enter();
    assert.deepEqual(p.inputs.at(-1), {keys: ["enter"]});
  });
});

test("Ctrl+U at the beginning leaves the guarded command intact", async () => {
  await withPane("codex", true, async p => {
    await p.text("/new");
    await p.text("\x01");
    await p.text("\x15");
    const before = p.inputs.length;
    await p.enter();
    assert.equal(p.inputs.length, before, "Ctrl+U clears before the cursor, not the entire prompt");
    await p.text("\x05\x15");
    await p.text("ordinary prompt");
    await p.enter();
    assert.deepEqual(p.inputs.at(-1), {keys: ["enter"]});
  });
});

test("risky slash-menu completion stays guarded and terminal cursor reports do not clear a draft", async () => {
  await withPane("codex", true, async p => {
    await p.text("/n");
    await p.key("tab");
    let before = p.inputs.length;
    await p.enter();
    assert.equal(p.inputs.length, before);
    await p.key("c-c");
    await p.text("/new");
    await p.text("\x1b[1;2R");
    before = p.inputs.length;
    await p.enter();
    assert.equal(p.inputs.length, before);
  });
});

test("Codex Answer Q keeps its literal sequence and ordinary Enter", async () => {
  await withPane("codex", true, async p => {
    await p.text("ordinary prompt");
    await p.click("Show agent actions");
    await p.click("Answer queued question (Shift+Left)");
    await p.enter();
    assert.deepEqual(p.inputs, [{text: "ordinary prompt"}, {text: "\x1b[1;2D"}, {keys: ["enter"]}]);
  });
});

test("a large ordinary clipboard draft keeps its complete original payload", async () => {
  await withPane("codex", true, async p => {
    const text = "ordinary code example\n" + "x".repeat(100_000);
    await p.text(text, true);
    await p.enter();
    assert.deepEqual(p.inputs, [{text}, {keys: ["enter"]}]);
    assert.equal(p.notice(), "");
  });
});

// #983: Ctrl+C quits Codex (and a second one quits Claude), so the refusal's
// own remedy must never send or suggest it. Clearing uses edit-only keys.
const QUIT = (input: Input) => input.keys?.includes("c-c") || input.text?.includes("\x03");

// A reference provider line editor (#991 review): the editing keys Codex's and
// Claude's composers share. Printable text inserts, DEL deletes back, Ctrl+A/E
// move to the line's start/end, Ctrl+U deletes to the line's start, CSI C/D and
// the arrow keys move; CR/LF and Enter submit; bracketed paste inserts as is.
function providerBuffer(inputs: readonly Input[]): string {
  let text = "", cursor = 0;
  const lineStart = () => text.lastIndexOf("\n", cursor - 1) + 1;
  const lineEnd = () => { const end = text.indexOf("\n", cursor); return end < 0 ? text.length : end; };
  const insert = (value: string) => { text = text.slice(0, cursor) + value + text.slice(cursor); cursor += value.length; };
  const back = () => { if (cursor > 0) { text = text.slice(0, cursor - 1) + text.slice(cursor); cursor--; } };
  for (const input of inputs) {
    for (const key of input.keys ?? []) {
      if (key === "enter" || key === "c-c") { text = ""; cursor = 0; }
      else if (key === "backspace") back();
      else if (key === "left") cursor = Math.max(0, cursor - 1);
      else if (key === "right") cursor = Math.min(text.length, cursor + 1);
    }
    const value = input.text ?? "";
    if (value.startsWith("\x1b[200~") && value.endsWith("\x1b[201~")) { insert(value.slice(6, -6)); continue; }
    for (let index = 0; index < value.length; index++) {
      const char = value[index]!;
      if (char === "\r" || char === "\n") { text = ""; cursor = 0; }
      else if (char === "\x7f" || char === "\b") back();
      else if (char === "\x01") cursor = lineStart();
      else if (char === "\x05") cursor = lineEnd();
      else if (char === "\x15") { const start = lineStart(); text = text.slice(0, start) + text.slice(cursor); cursor = start; }
      else if (char === "\x1b") {
        const sequence = value.slice(index).match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)/)?.[0] ?? "\x1b";
        if (sequence.endsWith("C")) cursor = Math.min(text.length, cursor + 1);
        else if (sequence.endsWith("D")) cursor = Math.max(0, cursor - 1);
        index += sequence.length - 1;
      } else if (char >= " ") insert(char);
    }
  }
  return text;
}

for (const [agent, command] of [["codex", "/new"], ["claude", "/clear"]] as const) {
  test(`${agent}: Clear draft empties a cursor-edited ${command} with one edit-only frame`, async () => {
    await withPane(agent, true, async p => {
      await p.text(command);
      await p.key("left");
      await p.enter();
      assert.doesNotMatch(p.notice(), /Ctrl\+C/, "the notice never suggests the provider's quit key");
      const before = p.inputs.length;
      await p.click("Clear draft");
      assert.deepEqual(p.inputs.slice(before), [{text: "\x05\x15"}], "end of line, then delete to its start");
      assert.equal(providerBuffer(p.inputs), "", "the provider's draft is empty");
      assert.equal(p.notice(), "", "the refusal is gone");
      await p.text("ordinary prompt"); await p.enter();
      assert.deepEqual(p.inputs.at(-1), {keys: ["enter"]});
      assert.deepEqual(p.prompts, ["ordinary prompt"], "the next prompt is captured for the title (#991 F2)");
      assert.equal(p.inputs.some(QUIT), false, "no quit key reaches the provider");
    });
  });

  test(`${agent}: Clear draft empties an oversized ${command} draft regardless of its length (#991 F1)`, async () => {
    await withPane(agent, true, async p => {
      await p.text(`\x1b[200~${command}${" ".repeat(10_000)}\x1b[201~`, true);
      await p.enter();
      assert.match(p.notice(), /restart/i);
      await p.click("Clear draft");
      assert.equal(providerBuffer(p.inputs), "", "no slash command or padding remains");
      await p.text("ordinary prompt"); await p.enter();
      assert.deepEqual(p.inputs.at(-1), {keys: ["enter"]});
      assert.equal(p.inputs.some(QUIT), false);
    });
  });
}

test("Clear draft on an edited slash-menu draft empties it and keeps prompt capture (#991 F2)", async () => {
  await withPane("codex", true, async p => {
    await p.text("/n"); await p.key("tab"); await p.enter();
    assert.equal(p.inputs.some(QUIT), false, "the guard must not inject cancellation automatically");
    const before = p.inputs.length;
    await p.click("Clear draft");
    assert.deepEqual(p.inputs.slice(before), [{text: "\x05\x15"}]);
    assert.equal(providerBuffer(p.inputs), "");
    assert.doesNotMatch(p.notice(), /canceled|delivered|sent/i, "clearing does not prove remote delivery");
    await p.text("ordinary prompt"); await p.enter();
    assert.deepEqual(p.inputs.at(-1), {keys: ["enter"]});
    assert.deepEqual(p.prompts, ["ordinary prompt"]);
    assert.equal(p.inputs.some(QUIT), false);
  });
});

test("Clear draft is one ordered request over HTTP, so a cursor move cannot land after the deletes (#991 F3)", async () => {
  await withPane("codex", false, async p => {
    await p.text("/new"); await p.text("\x01"); await p.enter();
    const before = p.inputs.length;
    await p.click("Clear draft");
    assert.equal(p.inputs.length - before, 1, "a single request carries the whole clear");
    assert.equal(providerBuffer(p.inputs), "");
  });
});

test("Clear draft deletes a tracked multi-line paste exactly", async () => {
  await withPane("claude", true, async p => {
    await p.text("\x1b[200~/clear\nsecond line\x1b[201~", true);
    await p.key("left"); await p.key("left");
    await p.enter();
    const before = p.inputs.length;
    await p.click("Clear draft");
    assert.deepEqual(p.inputs.slice(before), [{text: "\x1b[C".repeat(2) + "\x7f".repeat("/clear\nsecond line".length)}]);
    assert.equal(providerBuffer(p.inputs), "");
    await p.text("ordinary prompt"); await p.enter();
    assert.deepEqual(p.inputs.at(-1), {keys: ["enter"]});
  });
});

test("an oversized multi-line draft that cannot be proven empty stays refused (#991 F1)", async () => {
  await withPane("codex", true, async p => {
    await p.text(`\x1b[200~/new\n${"x".repeat(5_000)}\x1b[201~`, true);
    await p.enter();
    await p.click("Clear draft");
    assert.match(p.notice(), /could not confirm/i);
    const before = p.inputs.length;
    await p.text("ordinary prompt"); await p.enter();
    assert.equal(p.inputs.slice(before).some(input => input.keys?.includes("enter")), false, "Enter stays blocked");
    assert.equal(p.inputs.some(QUIT), false);
  });
});

// A line break after the tracked storage limit still makes the draft
// multi-line, so its clear cannot be proven (#991 review, F1 follow-up).
for (const socket of [true, false]) {
  for (const [agent, command] of [["codex", "/new"], ["claude", "/clear"]] as const) {
    test(`${agent} ${socket ? "socket" : "HTTP"}: a line break beyond the tracked limit keeps an uncleared command refused`, async () => {
      await withPane(agent, socket, async p => {
        await p.text(`\x1b[200~${command}${" ".repeat(10_000)}\nsecond line\x1b[201~`, true);
        await p.enter();
        await p.click("Clear draft");
        const remaining = providerBuffer(p.inputs);
        const before = p.inputs.length;
        await p.enter();
        assert.ok(remaining === "" || p.inputs.length === before,
          `a retained guarded first line must keep Enter refused: ${JSON.stringify(remaining.slice(0, 20))}`);
        assert.match(p.notice(), /could not confirm|restart/i);
      });
    });
  }
}

test("repeated refusals and clears never send a quit", async () => {
  await withPane("codex", true, async p => {
    for (let round = 0; round < 3; round++) {
      await p.text("/new"); await p.enter();
      await p.click("Clear draft");
    }
    assert.equal(p.inputs.some(QUIT), false);
    assert.equal(p.inputs.filter(input => input.keys?.includes("enter")).length, 0, "no refused Enter was sent");
    assert.equal(providerBuffer(p.inputs), "");
  });
});

test("correcting a refused command clears its stale notice on permitted Enter", async () => {
  await withPane("codex", true, async p => {
    for (const raw of [false, true]) {
      await p.key("c-c");
      await p.text("/new"); await p.enter();
      assert.match(p.notice(), /restart/i);
      for (let n = 0; n < 3; n++) await p.key("backspace");
      await p.text(raw ? "model\r" : "model");
      if (!raw) await p.enter();
      assert.deepEqual(p.inputs.at(-1), raw ? {text: "model\r"} : {keys: ["enter"]});
      assert.equal(p.notice(), "", "the previous local refusal no longer applies to the corrected draft");
    }
  });
});

for (const width of [360, 1280]) {
  test(`${width}px refusal wraps its full explanation and exposes a clickable cancel action`, async t => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    await withPane("codex", true, async p => {
      await p.text("/new"); await p.enter();
      const profile = mkdtempSync(join(tmpdir(), "terminal-context-chrome-"));
      try {
        const result = measureUiMarkup<{
          lines: number; visible: boolean; hit: boolean; width: number;
          right: number; left: number; animation: string; text: string;
        }>(`<div style="height:600px;position:relative">${p.html()}</div>`, width, `
          const notice=document.querySelector('.context-command-refusal');
          const button=notice.querySelector('button');
          const rect=notice.getBoundingClientRect(), target=button.getBoundingClientRect();
          const style=getComputedStyle(notice);
          const result={lines:notice.querySelector('span').getClientRects().length,
            visible:style.opacity==='1' && rect.height>0,
            hit:document.elementFromPoint(target.x+target.width/2,target.y+target.height/2)===button,
            width:target.width,left:rect.left,right:rect.right,animation:style.animationName,
            text:notice.textContent};`, false, 800, [`--user-data-dir=${profile}`]);
        assert.ok(result.lines > 1, "the full explanation wraps instead of being ellipsized");
        assert.equal(result.visible, true);
        assert.equal(result.hit, true, "pointer hit-testing reaches the actual cancel button");
        assert.ok(result.width > 0 && result.left >= 0 && result.right <= width);
        assert.equal(result.animation, "none", "the guard notice does not use the transient upload fade");
        assert.match(result.text, /New session|restart/);
      } finally { rmSync(profile, {recursive: true, force: true}); }
    });
  });
}

for (const socket of [true, false]) {
  test('reviewer overflow leading-whitespace command refuses '+(socket?'socket':'HTTP'), async () => {
    await withPane("codex", socket, async p => {
      await p.text(" ".repeat(2048)+"/new", true);
      const before = p.inputs.length;
      await p.enter();
      assert.equal(p.inputs.length, before, "local overflow /new must not dispatch Enter");
      assert.match(p.notice(), /restart/i);
    });
  });
}

for (const socket of [true, false]) {
  test('reviewer raw paste submit refuses '+(socket?'socket':'HTTP'), async () => {
    await withPane("codex", socket, async p => {
      await p.text("/new\r", true);
      assert.equal(p.inputs.length, 0, "unbracketed pasted CR must not dispatch unsafe submit");
      assert.match(p.notice(), /restart/i);
    });
  });
  test('reviewer rejected input retry refuses '+(socket?'socket':'HTTP'), async () => {
    await withPane("codex", socket, async p => {
      p.rejectNext();
      await p.text("/new");
      assert.equal(p.inputs.length, 0, "first draft was definitively rejected as not sent");
      await p.text("/new");
      assert.deepEqual(p.inputs, [{text:"/new"}], "only retry reached provider");
      const before=p.inputs.length;
      await p.enter();
      assert.equal(p.inputs.length, before, "retry of locally rejected /new must not dispatch Enter");
    });
  });
}


for (const socket of [true, false]) {
  for (const unknown of [false, true]) {
    test(`${socket ? "socket" : "HTTP"} ${unknown ? "unconfirmed" : "rejected"} input stays latched through cancel and reconnect`, async () => {
      await withPane("codex", socket, async p => {
        p.rejectNext(unknown);
        await p.text("/new");
        assert.match(p.notice(), /uncertain.*rejected|unconfirmed/i);
        p.rejectNext(unknown);
        await p.click("Clear draft");
        assert.match(p.notice(), /does not confirm/);
        assert.doesNotMatch(p.notice(), /Ctrl\+C/);
        p.rejectNext(unknown);
        await p.key("backspace");
        await p.text("ordinary replacement");
        let before = p.inputs.length;
        await p.text("\r", true);
        await p.text("\n");
        await p.enter();
        assert.equal(p.inputs.length, before, "neither raw nor key submit clears uncertainty");
        await p.key("escape");
        await p.remount({reconnectToken: 1});
        before = p.inputs.length;
        await p.enter();
        assert.equal(p.inputs.length, before, "reconnect/menu dismissal is not a session reset");
        await p.remount({sessionIncarnation: "replacement"});
        await p.enter();
        assert.deepEqual(p.inputs.at(-1), {keys: ["enter"]});
        assert.doesNotMatch(p.html(), /context-command-refusal/);
      });
    });
  }
}

test("an asynchronous rejection callback latches only its pane", async () => {
  await withPane("claude", true, async p => {
    await p.text("/clear");
    await p.rejectLater(true);
    await p.key("c-c");
    const before = p.inputs.length;
    await p.enter();
    assert.equal(p.inputs.length, before);
    assert.match(p.notice(), /New session.*restart/);
  });
  await withPane("claude", true, async p => {
    await p.text("ordinary prompt"); await p.enter();
    assert.deepEqual(p.inputs, [{text: "ordinary prompt"}, {keys: ["enter"]}]);
  });
});

for (const [agent, command] of [["codex", "/new"], ["claude", "/clear"]]) {
  test(`${agent} classifies the leading command at and beyond the draft cap`, async () => {
    await withPane(agent!, true, async p => {
      for (const spaces of [2047, 2048, 2049, 4096]) {
        for (const bracketed of [false, true]) {
          await p.key("c-c");
          const content = " ".repeat(spaces) + command;
          await p.text(bracketed ? "\x1b[200~" + content + "\x1b[201~" : content, true);
          const before = p.inputs.length;
          await p.enter();
          assert.equal(p.inputs.length, before, `${spaces} leading spaces, bracketed=${bracketed}`);
        }
      }
      await p.key("c-c");
      const ordinary = " ".repeat(4096) + "ordinary " + "x".repeat(100_000);
      await p.text("\x1b[200~" + ordinary + "\x1b[201~", true);
      await p.enter();
      assert.deepEqual(p.inputs.at(-1), {keys: ["enter"]});
      assert.equal(p.notice(), "");
    });
  });
  test(`${agent} raw paste submissions are guarded while bracketed ordinary multiline paste is preserved`, async () => {
    await withPane(agent!, false, async p => {
      for (const submit of ["\r", "\n", "\r\n"]) {
        const before = p.inputs.length;
        await p.text(command + submit, true);
        assert.equal(p.inputs.length, before);
      }
      const text = "\x1b[200~ordinary code\nsecond line\x1b[201~";
      await p.text(text, true); await p.enter();
      assert.deepEqual(p.inputs, [{text}, {keys: ["enter"]}]);
      assert.equal(p.notice(), "");
    });
  });
}


test("a late HTTP rejection from the previous identity cannot latch its replacement", async () => {
  await withPane("codex", false, async p => {
    p.deferNext();
    await p.text("/new");
    await p.remount({sessionIncarnation: "replacement"});
    await p.rejectDeferred();
    await p.text("ordinary prompt"); await p.enter();
    assert.deepEqual(p.inputs.at(-1), {keys: ["enter"]});
    assert.doesNotMatch(p.html(), /context-command-refusal/);
  });
});


for (const agent of ["codex", "claude"]) {
  test(`${agent} old socket rejection cannot latch replacement identity`, async () => {
    await withPane(agent, true, async p => {
      await p.text("first identity prompt");
      const oldDeps = globalThis.__terminalContextFixture!.deps!;
      await p.remount({sessionIncarnation: "replacement-incarnation"});
      for (const outcomeUnknown of [false, true]) {
        await act(async () => oldDeps.onInputRejected({message: "old input rejection", outcomeUnknown}));
      }
      await p.text("new identity prompt");
      const before = p.inputs.length;
      await p.enter();
      assert.equal(p.inputs.length, before + 1, "old socket rejection must not block replacement Enter");
      assert.doesNotMatch(p.html(), /provider draft is uncertain/);
    });
  });

  test(`${agent} replacement socket binds its own current rejection latch`, async () => {
    await withPane(agent, true, async p => {
      const oldDeps = globalThis.__terminalContextFixture!.deps!;
      await p.remount({sessionIncarnation: "replacement-incarnation"});
      assert.notEqual(globalThis.__terminalContextFixture!.deps, oldDeps,
        "genuine incarnation change replaces the terminal adapter and transport");
      p.rejectNext(true);
      await p.text("current identity prompt");
      const before = p.inputs.length;
      await p.enter();
      assert.equal(p.inputs.length, before, "current socket rejection must still latch Enter");
      assert.match(p.notice(), /uncertain.*unconfirmed/);
      await p.key("c-c");
      const afterCancel = p.inputs.length;
      await p.enter();
      assert.equal(p.inputs.length, afterCancel, "cancel request cannot clear the current uncertainty latch");
    });
  });
}

for (const socket of [false,true]) for (const form of ["csi","ss3"] as const) {
  test(`safe compact edited with ${form} horizontal arrows submits over ${socket?"socket":"HTTP"}`,async()=>{
    await withPane("codex",socket,async p=>{
      await p.text("/compaxt");
      await p.text(form==="csi"?"\x1b[D":"\x1bOD");
      await p.text("\x7fc");
      await p.text(form==="csi"?"\x1b[C":"\x1bOC");
      const before=p.inputs.length;
      await p.enter();
      assert.equal(p.inputs.length,before+1,"known cursor edits yield /compact and permit Enter");
      assert.deepEqual(p.inputs.at(-1),{keys:["enter"]});
      assert.equal(p.notice(),"");
    });
  });
  test(`unsafe command assembled with ${form} arrows remains blocked over ${socket?"socket":"HTTP"}`,async()=>{
    await withPane("codex",socket,async p=>{
      await p.text("/nexw");
      await p.text(form==="csi"?"\x1b[D":"\x1bOD");
      await p.text("\x7f");
      await p.text(form==="csi"?"\x1b[C":"\x1bOC");
      const before=p.inputs.length;await p.enter();
      assert.equal(p.inputs.length,before,"the actual /new command must remain blocked");
    });
  });
}

for (const socket of [false, true]) {
  test(`unknown history and modified navigation stays guarded over ${socket ? "socket" : "HTTP"}`, async () => {
    // Over a slash token, Claude's Up moves its menu highlight, which may be a
    // context command; modified arrows leave the draft unknown.
    for (const [agent, navigation] of [["claude", "\x1b[A"], ["claude", "\x1bOA"], ["codex", "\x1b[1;5D"]]) {
      await withPane(agent, socket, async p => {
        await p.text("/compact");
        await p.text(navigation);
        await p.text("\x1b[D\x1b[C");
        const before = p.inputs.length;
        await p.enter();
        assert.equal(p.inputs.length, before, "known arrows cannot clear an unknown draft");
        assert.match(p.notice(), /may replace the managed session's provider thread/);
      });
    }
  });
  test(`full safe compact paste and raw Enter remain allowed over ${socket ? "socket" : "HTTP"}`, async () => {
    await withPane("codex", socket, async p => {
      await p.text("\x1b[200~/compact\x1b[201~", true);
      await p.text("\r");
      assert.deepEqual(p.inputs.at(-1), {text: "\r"});
      assert.equal(p.notice(), "");
    });
  });
}

// One rule for every provider (#1033): Tab and Up/Down over a typed slash
// token act on the provider's slash menu, and Enter is refused while the
// highlighted item may be a context command. Codex 0.162.1 lists only commands
// whose names match the typed prefix, so /mo and /st are safe there. Claude
// Code 2.1.296 also matches descriptions (/st lists /clear), so any menu choice
// may be a context command there. Every refusal recovers by Clear draft or by
// editing the slash token away.
const MENU_SAFE = {codex: true, claude: false} as const;
for (const agent of ["codex", "claude"] as const) for (const socket of [false, true]) for (const tab of ["key", "text"] as const) {
  const pressTab = (p: {key(key: SpecialKey): Promise<void>; text(text: string): Promise<void>}) =>
    tab === "key" ? p.key("tab") : p.text("\t");
  const via = `${socket ? "socket" : "HTTP"} (${tab})`;
  test(`${agent} Tab-completed /mo follows the shared menu rule and recovers over ${via}`, async () => {
    await withPane(agent, socket, async p => {
      await p.text("/mo");
      await pressTab(p);
      let before = p.inputs.length;
      await p.enter();
      if (MENU_SAFE[agent]) {
        assert.equal(p.inputs.length, before + 1, "the completed /model reaches the provider once");
        assert.deepEqual(p.inputs.at(-1), {keys: ["enter"]});
        assert.equal(p.notice(), "");
        return;
      }
      assert.equal(p.inputs.length, before, "the completed item may be a context command");
      assert.match(p.notice(), /Type the command in full/);
      await p.click("Clear draft");
      assert.equal(providerBuffer(p.inputs), "", "Clear draft empties the completed command");
      assert.equal(p.notice(), "", "the refusal is gone");
      await p.text("/model");
      before = p.inputs.length;
      await p.enter();
      assert.equal(p.inputs.length, before + 1, "the command typed in full reaches the provider once");
    });
  });
  test(`${agent} Tab completion that can reach a context command stays guarded over ${via}`, async () => {
    for (const prefix of ["/re", "/", "/rm", "/w"]) {
      await withPane(agent, socket, async p => {
        await p.text(prefix);
        await pressTab(p);
        const before = p.inputs.length;
        await p.enter();
        assert.equal(p.inputs.length, before, `${prefix} may complete to a context command`);
        assert.match(p.notice(), /selected slash menu item.*Type the command in full/);
      });
    }
  });
  test(`${agent} edits after a Tab completion stay guarded over ${via}`, async () => {
    for (const edit of ["\x7f", "\x1b[D", "\x15"]) {
      await withPane(agent, socket, async p => {
        await p.text("/mo");
        await pressTab(p);
        await p.text(edit);
        const before = p.inputs.length;
        await p.enter();
        assert.equal(p.inputs.length, before, "the completed text is not tracked character by character");
      });
    }
  });
}

// Up/Down over a typed slash token move only the menu highlight on both
// providers; the composer text stays as typed (local probes, nothing sent).
for (const agent of ["codex", "claude"] as const) for (const socket of [false, true]) for (const form of ["key", "csi", "ss3"] as const) {
  const down = (p: {key(key: SpecialKey): Promise<void>; text(text: string): Promise<void>}) =>
    form === "key" ? p.key("down") : p.text(form === "csi" ? "\x1b[B" : "\x1bOB");
  const via = `${socket ? "socket" : "HTTP"} (${form})`;
  test(`${agent} plain text after a refused menu selection submits over ${via}`, async () => {
    await withPane(agent, socket, async p => {
      await p.text("/");
      await down(p);
      let before = p.inputs.length;
      await p.enter();
      assert.equal(p.inputs.length, before, "a bare / menu selection may be a context command");
      await p.text("\x7fhi");
      before = p.inputs.length;
      await p.enter();
      assert.equal(p.inputs.length, before + 1, "plain hi reaches the provider once");
      assert.deepEqual(p.inputs.at(-1), {keys: ["enter"]});
      assert.equal(p.notice(), "");
    });
  });
  test(`${agent} menu selection under /st follows the shared rule and recovers over ${via}`, async () => {
    await withPane(agent, socket, async p => {
      await p.text("/st");
      await down(p);
      let before = p.inputs.length;
      await p.enter();
      if (MENU_SAFE[agent]) {
        assert.equal(p.inputs.length, before + 1, "every /st item is safe");
        assert.equal(p.notice(), "");
        return;
      }
      assert.equal(p.inputs.length, before, "the highlighted item may be /clear");
      assert.match(p.notice(), /selected slash menu item.*Type the command in full/);
      await p.click("Clear draft");
      assert.equal(providerBuffer(p.inputs), "", "Clear draft empties the selection");
      assert.equal(p.notice(), "", "the refusal is gone");
      await p.text("hi");
      before = p.inputs.length;
      await p.enter();
      assert.equal(p.inputs.length, before + 1, "the next message reaches the provider once");
    });
  });
  test(`${agent} a command typed in full after editing a menu choice submits over ${via}`, async () => {
    for (const edit of ["\x7f\x7f\x7f/status", "\x15/status", "atus"]) {
      await withPane(agent, socket, async p => {
        await p.text("/st");
        await down(p);
        await p.text(edit);
        const before = p.inputs.length;
        await p.enter();
        assert.equal(p.inputs.length, before + 1, "editing the token resets the menu highlight to the typed command");
        assert.equal(p.notice(), "");
      });
    }
  });
  test(`${agent} an edit that deletes nothing keeps a menu choice guarded over ${via}`, async () => {
    // A token the menu can reach without being a context-command prefix.
    const token = agent === "codex" ? "/rm" : "/st";
    for (const noop of ["\x1b[D".repeat(token.length) + "\x7f", "\x01\x15"]) {
      await withPane(agent, socket, async p => {
        await p.text(token);
        await down(p);
        await p.text(noop);
        const before = p.inputs.length;
        await p.enter();
        assert.equal(p.inputs.length, before, "the highlight is unchanged and may be a context command");
        assert.match(p.notice(), /may replace the managed session's provider thread/);
      });
    }
  });
  test(`${agent} menu selection that can reach a context command stays guarded over ${via}`, async () => {
    for (const prefix of ["/", "/re", "/n"]) {
      await withPane(agent, socket, async p => {
        await p.text(prefix);
        await down(p);
        const before = p.inputs.length;
        await p.enter();
        assert.equal(p.inputs.length, before, `${prefix} may select a context command`);
        assert.match(p.notice(), /selected slash menu item.*Type the command in full/);
      });
    }
  });
}

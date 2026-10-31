import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { createUiSsrHarness } from "./support/ssr.ts";
import { assertNoElement } from "./support/domAssert.ts";
import { jsonResponse, restoreFetch, setFetchMock } from "./fetchHelper.ts";

const ssr = createUiSsrHarness();
after(async () => ssr.close());

const PROVIDERS = { ok: true, data: { providers: [{ id: "summit", label: "Summit GPU", max_duration_seconds: 90, max_bytes: 8388608 }] } };
const ENGINES = { ok: true, data: { engines: [
  { id: "qwen", label: "Qwen", available: true },
  { id: "gpt-transcribe", label: "GPT Transcribe", available: true },
], default: "qwen" } };

function installDom() {
  const window = new Window({ url: "http://localhost" });
  window.history.back = () => {};
  const keys = ["window", "document", "Element", "HTMLElement", "MouseEvent", "Event", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, (globalThis as Record<string, unknown>)[key]]));
  const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const recorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  Object.assign(globalThis, {
    window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const click = async (label: string) => {
    const button = [...window.document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
    assert.ok(button, `button ${label} is present`);
    await act(async () => button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  };
  const restore = async () => {
    await act(async () => root.unmount());
    restoreFetch();
    Object.assign(globalThis, previous);
    if (navigator) Object.defineProperty(globalThis, "navigator", navigator); else Reflect.deleteProperty(globalThis, "navigator");
    if (recorder) Object.defineProperty(globalThis, "MediaRecorder", recorder); else Reflect.deleteProperty(globalThis, "MediaRecorder");
    await window.happyDOM.abort();
  };
  return { window, root, click, restore };
}

test("the stored engine is sent, a 400 keeps the audio retryable, and a different answering engine is shown", async () => {
  const { SpeechComposer } = await ssr.loadModule<{ SpeechComposer: ComponentType<{ machine: string; id: string; sessionIncarnation: string; onBeforeOpen: () => void }> }>("/src/SpeechComposer.tsx");
  const { saveSpeechEngine } = await ssr.loadModule<typeof import("../src/speechEngine.ts")>("/src/speechEngine.ts");
  const dom = installDom();
  Object.defineProperty(dom.window.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) as unknown as MediaStream },
  });
  class FakeRecorder {
    static isTypeSupported() { return true; }
    state = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["clip"], { type: "audio/webm" }) }); this.onstop?.(); }
  }
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeRecorder });
  const uploads: Array<{ engine: string | null; size: number }> = [];
  let answer: "400" | "fallback" | "default" | "default-fallback" = "400";
  setFetchMock(async (url, init) => {
    if (url === "/api/speech/providers") return jsonResponse(PROVIDERS);
    if (url === "/api/speech/summit/engines") return jsonResponse(ENGINES);
    if (url === "/api/speech/summit/transcriptions") {
      const headers = new Headers(init?.headers);
      uploads.push({ engine: headers.get("x-speech-engine"), size: (init?.body as Blob).size });
      if (answer === "400") return jsonResponse({ ok: false, error: { message: "engine gone" } }, { status: 400 });
      return jsonResponse({ ok: true, data: { text: "hello", language: null, provider: "summit", engine: answer === "fallback" ? "qwen" : answer === "default-fallback" ? "gpt-transcribe" : null } });
    }
    throw new Error(`unexpected URL ${url}`);
  });
  try {
    saveSpeechEngine("gpt-transcribe");
    await act(async () => dom.root.render(createElement(SpeechComposer, { machine: "mesa", id: "s1", sessionIncarnation: "inc", onBeforeOpen: () => {} })));
    await dom.click("Voice");
    await dom.click("Record");
    const stopButton = () => [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent === "Stop recording");
    await act(async () => stopButton()?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(uploads, [{ engine: "gpt-transcribe", size: 4 }]);
    assert.match(dom.window.document.querySelector(".speech-error")?.textContent ?? "", /engine gone/);
    answer = "fallback";
    await dom.click("Retry transcription");
    assert.deepEqual(uploads[1], { engine: "gpt-transcribe", size: 4 }, "the same recording is re-sent");
    assert.match(dom.window.document.body.textContent ?? "", /Answered by qwen/);

    saveSpeechEngine(null);
    answer = "default";
    await dom.click("Record again");
    await act(async () => stopButton()?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(uploads[2]?.engine, null, "the default sends no header");
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Answered by/);

    // Default selected and a fallback answered: compare with the list default.
    answer = "default-fallback";
    await dom.click("Record again");
    await act(async () => stopButton()?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(uploads[3]?.engine, null);
    assert.match(dom.window.document.body.textContent ?? "", /Answered by gpt-transcribe/);
  } finally {
    await dom.restore();
  }
});

test("the settings picker lists engines, remembers the choice, and stays hidden for a legacy server", async () => {
  const { SpeechEngineSettings } = await ssr.loadModule<{ SpeechEngineSettings: ComponentType }>("/src/SpeechEngineSettings.tsx");
  const store = await ssr.loadModule<typeof import("../src/speechEngine.ts")>("/src/speechEngine.ts");
  const dom = installDom();
  let legacy = false;
  setFetchMock(async (url) => {
    if (url === "/api/speech/providers") return jsonResponse(PROVIDERS);
    if (url === "/api/speech/summit/engines") return legacy ? jsonResponse({ ok: false, error: { message: "nope" } }, { status: 404 }) : jsonResponse(ENGINES);
    throw new Error(`unexpected URL ${url}`);
  });
  try {
    await act(async () => dom.root.render(createElement(SpeechEngineSettings)));
    const select = dom.window.document.querySelector('select[aria-label="Speech engine"]') as HTMLSelectElement | null;
    assert.ok(select);
    assert.deepEqual([...select.options].map((o) => o.textContent), ["Default (Qwen)", "Qwen", "GPT Transcribe"]);
    const choose = async (value: string) => {
      select.value = value;
      await act(async () => select.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    };
    await choose("gpt-transcribe");
    assert.equal(store.loadSpeechEngine(), "gpt-transcribe");
    await choose("");
    assert.equal(store.loadSpeechEngine(), null);

    legacy = true;
    await act(async () => dom.root.render(createElement("div")));
    await act(async () => dom.root.render(createElement(SpeechEngineSettings)));
    assertNoElement(dom.window.document, 'select[aria-label="Speech engine"]');
  } finally {
    await dom.restore();
  }
});

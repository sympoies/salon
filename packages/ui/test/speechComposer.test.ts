import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { createUiSsrHarness } from "./support/ssr.ts";
import { jsonResponse, restoreFetch, setFetchMock } from "./fetchHelper.ts";
import { assertNoElement } from "./support/domAssert.ts";

const ssr = createUiSsrHarness();
after(async () => ssr.close());

test("voice prompt records, exposes an editable transcript, and sends only on confirmation", async () => {
  const { SpeechComposer } = await ssr.loadModule<typeof import("../src/SpeechComposer.tsx")>("/src/SpeechComposer.tsx");
  const window = new Window({ url: "http://localhost" });
  window.history.back = () => {};
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    MediaRecorder: Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder"),
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window, document: window.document, Element: window.Element,
    HTMLElement: window.HTMLElement, MouseEvent: window.MouseEvent,
    Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
  let trackStopped = false;
  let captureCalls = 0;
  let resolveCapture: ((stream: MediaStream) => void) | undefined;
  Object.defineProperty(window.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => {
      captureCalls += 1;
      return new Promise<MediaStream>((resolve) => { resolveCapture = resolve; });
    } },
  });
  class FakeRecorder {
    static isTypeSupported() { return true; }
    state = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["voice-canary"], { type: "audio/webm" }) });
      this.onstop?.();
    }
  }
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeRecorder });
  const requests: Array<{ url: string; body: BodyInit | null | undefined }> = [];
  setFetchMock(async (url, init) => {
    requests.push({ url, body: init?.body });
    if (url === "/api/speech/providers") return jsonResponse({ ok: true, data: { providers: [{ id: "summit", label: "Summit GPU", max_duration_seconds: 90, max_bytes: 8388608 }] } });
    if (url === "/api/speech/summit/transcriptions") return jsonResponse({ ok: true, data: { text: "original transcript", language: "English", provider: "summit" } });
    if (url === "/api/sessions/mesa/session-1/prompt/v2") return jsonResponse({ ok: true, data: { submitted: true, session_incarnation: "inc-1" } });
    throw new Error(`unexpected URL ${url}`);
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const click = async (label: string) => {
    const button = [...window.document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
    assert.ok(button, `button ${label} is present`);
    await act(async () => button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  };
  const pressEnter = async (target?: Element | null) => {
    const dialog = window.document.querySelector('[role="dialog"][aria-label="Voice prompt"]');
    assert.ok(dialog);
    await act(async () => (target ?? dialog).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  };
  try {
    await act(async () => root.render(createElement(SpeechComposer, { machine: "mesa", id: "session-1", sessionIncarnation: "inc-1", onBeforeOpen: () => {} })));
    await click("Voice");
    await pressEnter();
    await pressEnter();
    assert.equal(captureCalls, 1);
    await act(async () => resolveCapture?.({ getTracks: () => [{ stop: () => { trackStopped = true; } }] } as MediaStream));
    assert.match(window.document.querySelector('[role="status"]')?.textContent ?? "", /Recording/);
    await pressEnter();
    assert.equal(trackStopped, true);
    assert.match(window.document.body.textContent ?? "", /Record up to 90 seconds/);
    const textarea = window.document.querySelector("#speech-transcript") as HTMLTextAreaElement | null;
    assert.equal(textarea?.value, "original transcript");
    const reviewHint = [...window.document.querySelectorAll(".speech-hint")]
      .find(hint => hint.textContent?.startsWith("Check negation"))?.textContent ?? "";
    assert.doesNotMatch(reviewHint, /\p{Script=Han}/u, "speech review guidance uses English");
    assert.match(reviewHint, /voice-input tag/);
    assert.equal(requests.some((request) => request.url.includes("/prompt")), false);
    assert.equal(textarea?.disabled, false);
    // Happy DOM does not synthesize React's controlled textarea change from
    // InputEvent; invoke the installed handler to cover the review edit path.
    const propsKey = Object.keys(textarea ?? {}).find((key) => key.startsWith("__reactProps$"));
    assert.ok(propsKey);
    const props = (textarea as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[propsKey];
    await act(async () => {
      props?.onChange({ target: { value: "edited transcript" } });
    });
    assert.equal(textarea?.value, "edited transcript");
    await pressEnter(textarea);
    assert.equal(requests.some((request) => request.url.includes("/prompt")), false);
    await act(async () => root.render(createElement(SpeechComposer, { machine: "mesa", id: "session-1", sessionIncarnation: "inc-2", onBeforeOpen: () => {} })));
    await pressEnter();
    assert.equal(requests.filter((request) => request.url.includes("/prompt")).length, 1);
    assert.deepEqual(JSON.parse(String(requests.find((request) => request.url.includes("/prompt"))?.body)), {
      text: "🎙️ edited transcript",
      expected_session_incarnation: "inc-1",
    });
    assertNoElement(window.document, '[role="dialog"][aria-label="Voice prompt"]');

    // A busy Claude session (#669): an unknown outcome keeps the transcript in
    // review and says how to check delivery; a prompt the daemon reports queued
    // behind the running turn is sent, so the dialog closes.
    let promptAnswer: "unknown" | "queued" = "unknown";
    setFetchMock(async (url) => {
      if (url === "/api/speech/providers") return jsonResponse({ ok: true, data: { providers: [{ id: "summit", label: "Summit GPU", max_duration_seconds: 90, max_bytes: 8388608 }] } });
      if (url === "/api/speech/summit/transcriptions") return jsonResponse({ ok: true, data: { text: "busy session prompt", language: "English", provider: "summit" } });
      if (url === "/api/sessions/mesa/session-1/prompt/v2") {
        return promptAnswer === "unknown"
          ? jsonResponse({ ok: false, error: { message: "provider prompt submission failed" } }, { status: 500 })
          : jsonResponse({ ok: true, data: { submitted: true, queued: true, session_incarnation: "inc-2" } });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    await click("Voice");
    await click("Record");
    await act(async () => resolveCapture?.({ getTracks: () => [{ stop: () => {} }] } as MediaStream));
    await click("Stop recording");
    await click("Send");
    assert.match(window.document.querySelector('[role="alert"]')?.textContent ?? "", /may have been sent.*queued message/);
    assert.equal((window.document.querySelector("#speech-transcript") as HTMLTextAreaElement | null)?.value, "busy session prompt");
    promptAnswer = "queued";
    await click("Send");
    assertNoElement(window.document, '[role="dialog"][aria-label="Voice prompt"]');

    let pendingSignal: AbortSignal | undefined;
    setFetchMock(async (url, init) => {
      if (url === "/api/speech/providers") return jsonResponse({ ok: true, data: { providers: [{ id: "summit", label: "Summit GPU", max_duration_seconds: 90, max_bytes: 8388608 }] } });
      assert.equal(url, "/api/speech/summit/transcriptions");
      pendingSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        pendingSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    await act(async () => root.render(createElement(SpeechComposer, {
      machine: "mesa", id: "session-1", sessionIncarnation: "inc-2", onBeforeOpen: () => {}, openRequestToken: 1,
    })));
    assert.ok(window.document.querySelector('[role="dialog"][aria-label="Voice prompt"]'));
    await click("Record");
    await act(async () => resolveCapture?.({ getTracks: () => [{ stop: () => { trackStopped = true; } }] } as MediaStream));
    await click("Stop recording");
    assert.equal(pendingSignal?.aborted, false);
    await click("Cancel");
    assert.equal(pendingSignal?.aborted, true);
    assert.equal(requests.filter((request) => request.url.includes("/prompt")).length, 1);

    const drafts: string[] = [];
    const sent: string[] = [];
    setFetchMock(async (url) => {
      if (url === "/api/speech/providers") return jsonResponse({ ok: true, data: { providers: [{ id: "summit", label: "Speech", max_duration_seconds: 90, max_bytes: 8388608 }] } });
      assert.equal(url, "/api/speech/summit/transcriptions", "draft mode never calls the prompt API");
      return jsonResponse({ ok: true, data: { text: "reviewed voice reply", language: "English", provider: "summit" } });
    });
    await act(async () => root.render(createElement(SpeechComposer, {
      machine: "mesa", id: "session-1", sessionIncarnation: "inc-2", onBeforeOpen: () => {},
      onTranscript: (text) => drafts.push(text),
      onSendTranscript: async (text) => { sent.push(text); return true; },
    })));
    await click("Voice");
    await click("Record");
    await act(async () => resolveCapture?.({ getTracks: () => [{ stop: () => {} }] } as MediaStream));
    await click("Stop recording");
    assert.deepEqual(drafts, []);
    await pressEnter();
    assert.deepEqual(sent, ["> 🎙️ reviewed voice reply"], "Enter sends the reviewed transcript through the reply path");
    assert.deepEqual(drafts, [], "sending does not insert a duplicate draft");
    assertNoElement(window.document, '[role="dialog"][aria-label="Voice prompt"]');

    await click("Voice");
    await click("Record");
    await act(async () => resolveCapture?.({ getTracks: () => [{ stop: () => {} }] } as MediaStream));
    await click("Stop recording");
    await click("Insert to edit");
    assert.deepEqual(drafts, ["> 🎙️ reviewed voice reply"]);
    assert.deepEqual(sent, ["> 🎙️ reviewed voice reply"], "the secondary action does not send");
    assertNoElement(window.document, '[role="dialog"][aria-label="Voice prompt"]');

    // The response label shows after the transcript and rides in the tag verbatim.
    const labelled: string[] = [];
    setFetchMock(async (url) => {
      if (url === "/api/speech/providers") return jsonResponse({ ok: true, data: { providers: [{ id: "summit", label: "Speech", max_duration_seconds: 90, max_bytes: 8388608 }] } });
      return jsonResponse({ ok: true, data: { text: "first line\nsecond line", language: "English", provider: "summit", label: "Fast · local" } });
    });
    await act(async () => root.render(createElement(SpeechComposer, {
      machine: "mesa", id: "session-1", sessionIncarnation: "inc-2", onBeforeOpen: () => {},
      onTranscript: (text) => labelled.push(text),
    })));
    await click("Voice");
    await click("Record");
    await act(async () => resolveCapture?.({ getTracks: () => [{ stop: () => {} }] } as MediaStream));
    assert.doesNotMatch(window.document.querySelector('[role="dialog"]')?.textContent ?? "", /Fast · local/);
    await click("Stop recording");
    assert.match(window.document.querySelector('[role="dialog"]')?.textContent ?? "", /Fast · local/);
    await click("Insert to edit");
    assert.deepEqual(labelled, ["> 🎙️ (Fast · local) first line\n> second line"]);
    setFetchMock(async (url) => {
      if (url === "/api/speech/providers") return jsonResponse({ ok: true, data: { providers: [{ id: "summit", label: "Speech", max_duration_seconds: 90, max_bytes: 8388608 }] } });
      return jsonResponse({ ok: true, data: { text: "reviewed voice reply", language: "English", provider: "summit" } });
    });

    let replyDraft = "'report.txt'\n";
    await act(async () => root.render(createElement(SpeechComposer, {
      machine: "mesa", id: "session-1", sessionIncarnation: "inc-2", onBeforeOpen: () => {},
      onTranscript: (text) => { replyDraft = `${replyDraft}${text}`; },
      onSendTranscript: async (text) => {
        replyDraft = `${replyDraft}${text}`;
        return false;
      },
    })));
    await click("Voice");
    await click("Record");
    await act(async () => resolveCapture?.({ getTracks: () => [{ stop: () => {} }] } as MediaStream));
    await click("Stop recording");
    await pressEnter();
    assert.equal(replyDraft, "'report.txt'\n> 🎙️ reviewed voice reply", "a failed send leaves the tagged transcript beside existing composer attachments");
    assert.ok(window.document.querySelector('[role="dialog"][aria-label="Voice prompt"]'), "a refused send keeps the reviewed transcript available");
    assert.match(window.document.querySelector('[role="alert"]')?.textContent ?? "", /not sent.*remains in your reply draft/i);
    assert.equal([...window.document.querySelectorAll('[role="dialog"] button')].some(button => button.textContent?.trim() === "Send"), false);
    assert.equal([...window.document.querySelectorAll('[role="dialog"] button')].some(button => button.textContent?.trim() === "Insert to edit"), false);
    await pressEnter();
    assert.equal(replyDraft, "'report.txt'\n> 🎙️ reviewed voice reply", "a retained transcript cannot be appended again from the dialog");
    await click("Return to draft");
    assertNoElement(window.document, '[role="dialog"][aria-label="Voice prompt"]');

    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Android" });
    Object.defineProperty(window.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => { throw new DOMException("Permission denied", "NotAllowedError"); } },
    });
    await click("Voice");
    await click("Record");
    assert.match(window.document.querySelector('[role="alert"]')?.textContent ?? "", /Android Settings, then tap Record again/);
    await click("Cancel");
  } finally {
    await act(async () => root.unmount());
    restoreFetch();
    Object.assign(globalThis, {
      window: previous.window, document: previous.document, Element: previous.Element,
      HTMLElement: previous.HTMLElement, MouseEvent: previous.MouseEvent,
      Event: previous.Event, IS_REACT_ACT_ENVIRONMENT: previous.IS_REACT_ACT_ENVIRONMENT,
    });
    if (previous.navigator) Object.defineProperty(globalThis, "navigator", previous.navigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (previous.MediaRecorder) Object.defineProperty(globalThis, "MediaRecorder", previous.MediaRecorder);
    else Reflect.deleteProperty(globalThis, "MediaRecorder");
    await window.happyDOM.abort();
  }
});

test("Android Back dismisses the voice prompt without leaving the focused session", async () => {
  const { SpeechComposer } = await ssr.loadModule<{ SpeechComposer: ComponentType<{ machine: string; id: string; sessionIncarnation: string; onBeforeOpen: () => void }> }>("/src/SpeechComposer.tsx");
  const { useAndroidBackEntry } = await ssr.loadModule<{ useAndroidBackEntry: (entry: string, active: boolean, onBack: () => void) => void }>("/src/useAndroidBackEntry.ts");
  const window = new Window({ url: "tauri://localhost" });
  const previous = {
    window: globalThis.window, document: globalThis.document, Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement, MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window, document: window.document, Element: window.Element,
    HTMLElement: window.HTMLElement, MouseEvent: window.MouseEvent,
    Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Android" });
  window.history.back = () => {};
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  function FocusedSessionFixture() {
    const [focused, setFocused] = useState(true);
    useAndroidBackEntry("focused-session", focused, () => setFocused(false));
    return focused
      ? createElement("section", null, createElement("span", null, "Focused session active"), createElement(SpeechComposer, {
          machine: "mesa", id: "session-1", sessionIncarnation: "inc-1", onBeforeOpen: () => {},
        }))
      : createElement("section", null, "Session list");
  }
  try {
    await act(async () => root.render(createElement(FocusedSessionFixture)));
    const voiceButton = window.document.querySelector('button[aria-label="Record voice prompt"]');
    assert.ok(voiceButton);
    await act(async () => voiceButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(window.history.state.agentConsoleBack, "voice-prompt-mesa-session-1");
    const dialog = window.document.querySelector('[role="dialog"][aria-label="Voice prompt"]');
    assert.ok(dialog);
    await act(async () => {
      window.dispatchEvent(new window.PopStateEvent("popstate", { state: { agentConsoleBack: "focused-session" } }));
    });
    assert.match(container.textContent ?? "", /Focused session active/);
    assert.equal(dialog.isConnected, false);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, {
      window: previous.window, document: previous.document, Element: previous.Element,
      HTMLElement: previous.HTMLElement, MouseEvent: previous.MouseEvent,
      Event: previous.Event, IS_REACT_ACT_ENVIRONMENT: previous.IS_REACT_ACT_ENVIRONMENT,
    });
    if (previous.navigator) Object.defineProperty(globalThis, "navigator", previous.navigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    await window.happyDOM.abort();
  }
});

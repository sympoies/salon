import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { createElement, useState } from "react";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAndroidBackEntry } from "../src/useAndroidBackEntry.ts";

const cleanupStack: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupStack.length > 0) {
    await cleanupStack.pop()?.();
  }
});

interface MountedDom {
  readonly window: Window;
  readonly root: Root;
  readonly container: HTMLElement;
  readonly pushedStates: unknown[];
  readonly backCalls: unknown[];
  cleanup(): Promise<void>;
}

function installDom(): MountedDom {
  const window = new Window({ url: "tauri://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    PopStateEvent: globalThis.PopStateEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  const pushedStates: unknown[] = [];
  const backCalls: unknown[] = [];
  const originalPushState = window.history.pushState.bind(window.history);
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    PopStateEvent: window.PopStateEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(window, "__TAURI__", { value: {}, configurable: true });
  window.history.pushState = (data, unused, url) => {
    pushedStates.push({ agentConsoleBack: (data as { agentConsoleBack: string }).agentConsoleBack });
    return originalPushState(data, unused, url);
  };
  window.history.back = () => {
    backCalls.push({ agentConsoleBack: window.history.state.agentConsoleBack });
  };

  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let cleaned = false;
  return {
    window,
    root,
    container,
    pushedStates,
    backCalls,
    async cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      await act(async () => {
        root.unmount();
      });
      Object.assign(globalThis, previous);
      await window.happyDOM.close();
    },
  };
}

function popState(window: Window, state: unknown): PopStateEvent {
  return new window.PopStateEvent("popstate", { state });
}

test("Android Back closes the top keyed entry before the focused session", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const closed: string[] = [];
  let setFocused: ((active: boolean) => void) | null = null;
  let setHeader: ((active: boolean) => void) | null = null;

  function Probe() {
    const [focused, updateFocused] = useState(true);
    const [header, updateHeader] = useState(false);
    setFocused = updateFocused;
    setHeader = updateHeader;
    useAndroidBackEntry("focused-session", focused, () => {
      closed.push("focused-session");
      updateFocused(false);
    });
    useAndroidBackEntry("header-menu", header, () => {
      closed.push("header-menu");
      updateHeader(false);
    });
    return createElement("output", null, `focused=${focused} header=${header}`);
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  assert.deepEqual(mounted.pushedStates, [{ agentConsoleBack: "focused-session" }]);

  await act(async () => {
    setHeader?.(true);
  });
  assert.deepEqual(mounted.pushedStates, [
    { agentConsoleBack: "focused-session" },
    { agentConsoleBack: "header-menu" },
  ]);

  await act(async () => {
    mounted.window.dispatchEvent(popState(mounted.window, { agentConsoleBack: "focused-session" }));
  });
  assert.deepEqual(closed, ["header-menu"]);
  assert.equal(mounted.container.textContent, "focused=true header=false");

  await act(async () => {
    mounted.window.dispatchEvent(popState(mounted.window, null));
  });
  assert.deepEqual(closed, ["header-menu", "focused-session"]);
  assert.equal(mounted.container.textContent, "focused=false header=false");
  assert.deepEqual(mounted.backCalls, []);

  await act(async () => {
    setFocused?.(false);
  });
});

test("in-app close consumes the active keyed history entry without closing lower layers", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const closed: string[] = [];
  let setHeader: ((active: boolean) => void) | null = null;

  function Probe() {
    const [focused, updateFocused] = useState(true);
    const [header, updateHeader] = useState(true);
    setHeader = updateHeader;
    useAndroidBackEntry("focused-session", focused, () => {
      closed.push("focused-session");
      updateFocused(false);
    });
    useAndroidBackEntry("header-menu", header, () => {
      closed.push("header-menu");
      updateHeader(false);
    });
    return createElement("output", null, `focused=${focused} header=${header}`);
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  assert.deepEqual(mounted.pushedStates, [
    { agentConsoleBack: "focused-session" },
    { agentConsoleBack: "header-menu" },
  ]);

  await act(async () => {
    setHeader?.(false);
  });
  assert.deepEqual(mounted.backCalls, [{ agentConsoleBack: "header-menu" }]);
  assert.equal(mounted.container.textContent, "focused=true header=false");

  await act(async () => {
    mounted.window.dispatchEvent(popState(mounted.window, { agentConsoleBack: "focused-session" }));
  });
  assert.deepEqual(closed, []);
  assert.equal(mounted.container.textContent, "focused=true header=false");
});

test("a cleanup pop repairs a replacement layer activated in the same render", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const closed: string[] = [];
  let replaceLayer: (() => void) | null = null;

  function Probe() {
    const [menuOpen, setMenuOpen] = useState(true);
    const [panelOpen, setPanelOpen] = useState(false);
    replaceLayer = () => {
      setMenuOpen(false);
      setPanelOpen(true);
    };
    useAndroidBackEntry("header-menu", menuOpen, () => {
      closed.push("header-menu");
      setMenuOpen(false);
    });
    useAndroidBackEntry("secondary-panel", panelOpen, () => {
      closed.push("secondary-panel");
      setPanelOpen(false);
    });
    return createElement("output", null, `menu=${menuOpen} panel=${panelOpen}`);
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    replaceLayer?.();
  });
  assert.deepEqual(mounted.pushedStates, [
    { agentConsoleBack: "header-menu" },
    { agentConsoleBack: "secondary-panel" },
  ]);
  assert.equal(mounted.backCalls.length, 1);

  await act(async () => {
    mounted.window.dispatchEvent(popState(mounted.window, null));
  });

  assert.deepEqual(mounted.pushedStates, [
    { agentConsoleBack: "header-menu" },
    { agentConsoleBack: "secondary-panel" },
    { agentConsoleBack: "secondary-panel" },
  ]);
  assert.equal(mounted.container.textContent, "menu=false panel=true");
  assert.deepEqual(closed, []);

  await act(async () => {
    mounted.window.dispatchEvent(popState(mounted.window, null));
  });
  assert.equal(mounted.container.textContent, "menu=false panel=false");
  assert.deepEqual(closed, ["secondary-panel"]);
});

test("a layer reopened before cleanup popstate repairs its active Back entry", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const closed: string[] = [];
  let setOpen: ((active: boolean) => void) | null = null;

  function Probe() {
    const [open, updateOpen] = useState(true);
    setOpen = updateOpen;
    useAndroidBackEntry("select-menu-group", open, () => {
      closed.push("select-menu-group");
      updateOpen(false);
    });
    return createElement("output", null, `open=${open}`);
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  assert.deepEqual(mounted.pushedStates, [{ agentConsoleBack: "select-menu-group" }]);

  await act(async () => {
    setOpen?.(false);
  });
  assert.equal(mounted.backCalls.length, 1);

  await act(async () => {
    setOpen?.(true);
  });
  assert.equal(mounted.pushedStates.length, 2);

  await act(async () => {
    mounted.window.dispatchEvent(popState(mounted.window, null));
  });
  assert.equal(mounted.container.textContent, "open=true");
  assert.deepEqual(closed, []);
  assert.deepEqual(mounted.pushedStates, [
    { agentConsoleBack: "select-menu-group" },
    { agentConsoleBack: "select-menu-group" },
    { agentConsoleBack: "select-menu-group" },
  ]);
});

test("top-layer cleanup popstate cannot close an active lower Back layer", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const closed: string[] = [];
  let setTop: ((active: boolean) => void) | null = null;

  function Probe() {
    const [lower, setLower] = useState(true);
    const [top, updateTop] = useState(true);
    setTop = updateTop;
    useAndroidBackEntry("focused-session", lower, () => {
      closed.push("focused-session");
      setLower(false);
    });
    useAndroidBackEntry("select-menu-group", top, () => {
      closed.push("select-menu-group");
      updateTop(false);
    });
    return createElement("output", null, `lower=${lower} top=${top}`);
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    setTop?.(false);
  });
  await act(async () => {
    setTop?.(true);
  });

  await act(async () => {
    mounted.window.dispatchEvent(popState(mounted.window, { agentConsoleBack: "select-menu-group" }));
  });
  assert.deepEqual(closed, []);
  assert.equal(mounted.container.textContent, "lower=true top=true");
});

test("internal cleanup cascades past inactive stacked entries", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const closed: string[] = [];
  let setMiddle: ((active: boolean) => void) | null = null;
  let setTop: ((active: boolean) => void) | null = null;

  function Probe() {
    const [bottom, setBottom] = useState(true);
    const [middle, updateMiddle] = useState(true);
    const [top, updateTop] = useState(true);
    setMiddle = updateMiddle;
    setTop = updateTop;
    useAndroidBackEntry("focused-session", bottom, () => {
      closed.push("focused-session");
      setBottom(false);
    });
    useAndroidBackEntry("middle-layer", middle, () => {
      closed.push("middle-layer");
      updateMiddle(false);
    });
    useAndroidBackEntry("top-layer", top, () => {
      closed.push("top-layer");
      updateTop(false);
    });
    return createElement("output", null, `bottom=${bottom} middle=${middle} top=${top}`);
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    setMiddle?.(false);
    setTop?.(false);
  });
  assert.equal(mounted.backCalls.length, 1);

  await act(async () => {
    mounted.window.dispatchEvent(popState(mounted.window, { agentConsoleBack: "middle-layer" }));
    await Promise.resolve();
  });
  assert.equal(mounted.backCalls.length, 2);

  await act(async () => {
    mounted.window.dispatchEvent(popState(mounted.window, { agentConsoleBack: "focused-session" }));
  });
  assert.deepEqual(closed, []);
  assert.equal(mounted.container.textContent, "bottom=true middle=false top=false");
});

test("revealing an inactive middle entry closes only the popped top layer", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const closed: string[] = [];
  let setMiddle: ((active: boolean) => void) | null = null;

  function Probe() {
    const [bottom, setBottom] = useState(true);
    const [middle, updateMiddle] = useState(true);
    const [top, setTop] = useState(true);
    setMiddle = updateMiddle;
    useAndroidBackEntry("focused-session", bottom, () => {
      closed.push("focused-session");
      setBottom(false);
    });
    useAndroidBackEntry("middle-layer", middle, () => {
      closed.push("middle-layer");
      updateMiddle(false);
    });
    useAndroidBackEntry("top-layer", top, () => {
      closed.push("top-layer");
      setTop(false);
    });
    return createElement("output", null, `bottom=${bottom} middle=${middle} top=${top}`);
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    setMiddle?.(false);
  });

  await act(async () => {
    mounted.window.dispatchEvent(popState(mounted.window, { agentConsoleBack: "middle-layer" }));
    await Promise.resolve();
  });
  assert.deepEqual(closed, ["top-layer"]);
  assert.equal(mounted.backCalls.length, 1);
  assert.equal(mounted.container.textContent, "bottom=true middle=false top=false");
});

test("external pop snapshots the stack before an earlier listener mutates it", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const closed: string[] = [];
  let setMiddle: ((active: boolean) => void) | null = null;
  let setTop: ((active: boolean) => void) | null = null;

  function Probe() {
    const [middle, updateMiddle] = useState(false);
    const [bottom, setBottom] = useState(true);
    const [top, updateTop] = useState(false);
    setMiddle = updateMiddle;
    setTop = updateTop;
    // Deliberately register the buried entry's listener before the lower one.
    useAndroidBackEntry("middle-layer", middle, () => {
      closed.push("middle-layer");
      updateMiddle(false);
    });
    useAndroidBackEntry("focused-session", bottom, () => {
      closed.push("focused-session");
      setBottom(false);
    });
    useAndroidBackEntry("top-layer", top, () => {
      closed.push("top-layer");
      updateTop(false);
    });
    return createElement("output", null, `bottom=${bottom} middle=${middle} top=${top}`);
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    setMiddle?.(true);
  });
  await act(async () => {
    setTop?.(true);
  });
  await act(async () => {
    setMiddle?.(false);
  });

  await act(async () => {
    mounted.window.dispatchEvent(popState(mounted.window, { agentConsoleBack: "middle-layer" }));
    await Promise.resolve();
  });
  assert.deepEqual(closed, ["top-layer"]);
  assert.equal(mounted.container.textContent, "bottom=true middle=false top=false");
});

test("a busy top layer restores its Back entry until dismissal is allowed", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  let setBusy: ((busy: boolean) => void) | null = null;

  function Probe() {
    const [focused, setFocused] = useState(true);
    const [overlay, setOverlay] = useState(true);
    const [busy, updateBusy] = useState(true);
    setBusy = updateBusy;
    useAndroidBackEntry("focused-session", focused, () => setFocused(false));
    useAndroidBackEntry("voice-prompt", overlay, () => {
      if (busy) return false;
      setOverlay(false);
    });
    return createElement("output", null, `focused=${focused} overlay=${overlay} busy=${busy}`);
  }

  await act(async () => mounted.root.render(createElement(Probe)));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await act(async () => mounted.window.dispatchEvent(popState(mounted.window, { agentConsoleBack: "focused-session" })));
    assert.equal(mounted.container.textContent, "focused=true overlay=true busy=true");
    assert.equal(mounted.window.history.state.agentConsoleBack, "voice-prompt");
  }
  assert.equal(mounted.pushedStates.length, 4);

  await act(async () => setBusy?.(false));
  await act(async () => mounted.window.dispatchEvent(popState(mounted.window, { agentConsoleBack: "focused-session" })));
  assert.equal(mounted.container.textContent, "focused=true overlay=false busy=false");
});

test("unmount retires only its exact Back instance after StrictMode effect replay", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  function Layer() {
    useAndroidBackEntry("dialog", true, () => {});
    return null;
  }
  await act(async () => mounted.root.render(createElement(StrictMode, null, createElement(Layer))));
  assert.equal(mounted.pushedStates.length, 1);
  assert.equal(mounted.backCalls.length, 0, "effect replay must preserve the live entry");
  await act(async () => mounted.root.render(null));
  assert.equal(mounted.backCalls.length, 1, "closing the top dialog consumes its entry");
});

test("a buried unmounted layer is consumed only after the top layer closes", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const closed: string[] = [];
  function Layer({ name }: { name: string }) {
    useAndroidBackEntry(name, true, () => { closed.push(name); });
    return null;
  }
  const render = (middle: boolean) => createElement("div", null,
    createElement(Layer, { key: "base", name: "base" }),
    middle ? createElement(Layer, { key: "middle", name: "dialog" }) : null,
    createElement(Layer, { key: "top", name: "confirmation" }),
  );
  // Mount the confirmation later so it owns the top entry.
  await act(async () => mounted.root.render(createElement("div", null,
    createElement(Layer, { key: "base", name: "base" }),
    createElement(Layer, { key: "middle", name: "dialog" }),
  )));
  const retired = mounted.window.history.state;
  await act(async () => mounted.root.render(render(true)));
  await act(async () => mounted.root.render(render(false)));
  assert.equal(mounted.backCalls.length, 0, "buried cleanup must not pop the confirmation");
  await act(async () => {
    mounted.window.history.replaceState(retired, "");
    mounted.window.dispatchEvent(popState(mounted.window, retired));
  });
  assert.deepEqual(closed, ["confirmation"]);
  assert.equal(mounted.backCalls.length, 1, "the revealed retired dialog is skipped");
});

test("remounting the same logical label cannot revive an old retired Back instance", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const closed: string[] = [];
  function Layer({ name }: { name: string }) {
    useAndroidBackEntry(name, true, () => { closed.push(name); });
    return null;
  }
  const layer = (key: string, name: string) => createElement(Layer, { key, name });
  await act(async () => mounted.root.render(createElement("div", null, layer("base", "base"), layer("old", "dialog"))));
  const oldState = mounted.window.history.state;
  await act(async () => mounted.root.render(createElement("div", null, layer("base", "base"), layer("old", "dialog"), layer("top", "confirmation"))));
  await act(async () => mounted.root.render(createElement("div", null, layer("base", "base"), layer("top", "confirmation"))));
  await act(async () => mounted.root.render(createElement("div", null, layer("base", "base"), layer("new", "dialog"), layer("top", "confirmation"))));
  const newState = mounted.window.history.state;
  assert.notEqual(oldState.agentConsoleBackId, newState.agentConsoleBackId);
  await act(async () => {
    mounted.window.history.replaceState(oldState, "");
    mounted.window.dispatchEvent(popState(mounted.window, oldState));
  });
  assert.deepEqual(closed, ["confirmation", "dialog"], "the new instance is popped rather than treated as the old target");
  assert.equal(mounted.backCalls.length, 1, "only the old retired history target is swept");
});

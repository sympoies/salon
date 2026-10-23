import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAsyncAction, type AsyncActionOptions } from "../src/useAsyncAction.ts";

// Core state-machine tests use immediate timings so `pending` mirrors the action
// exactly; the anti-flicker smoothing has its own dedicated tests below.
const IMMEDIATE: AsyncActionOptions = { showDelayMs: 0, minVisibleMs: 0 };

const cleanupStack: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupStack.length > 0) {
    await cleanupStack.pop()?.();
  }
});

function installDom(): { readonly window: Window; readonly root: Root; readonly container: HTMLElement; cleanup(): Promise<void> } {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let cleaned = false;
  return {
    window,
    root,
    container,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await act(async () => {
        root.unmount();
      });
      Object.assign(globalThis, previous);
    },
  };
}

// A deferred promise whose resolution we drive from the test.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface ProbeProps {
  readonly action: () => Promise<unknown>;
  readonly onRun: (run: () => Promise<void>, pending: boolean) => void;
  readonly options?: AsyncActionOptions;
}

function Probe({ action, onRun, options }: ProbeProps) {
  const { pending, run } = useAsyncAction(action, options);
  onRun(run, pending);
  return createElement("button", { "data-pending": String(pending) }, pending ? "busy" : "idle");
}

test("useAsyncAction flips pending for the life of the async action", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);

  const gate = deferred();
  let calls = 0;
  let latestRun: () => Promise<void> = async () => {};
  const action = () => {
    calls += 1;
    return gate.promise;
  };

  await act(async () => {
    mounted.root.render(createElement(Probe, { action, onRun: (run) => (latestRun = run), options: IMMEDIATE }));
  });
  const button = () => mounted.container.querySelector("button");
  assert.equal(button()?.getAttribute("data-pending"), "false");

  await act(async () => {
    void latestRun();
  });
  assert.equal(button()?.getAttribute("data-pending"), "true", "pending is true while the action is in flight");
  assert.equal(calls, 1);

  await act(async () => {
    gate.resolve();
    await gate.promise;
  });
  assert.equal(button()?.getAttribute("data-pending"), "false", "pending clears after the action settles");
});

test("useAsyncAction ignores re-entrant runs while one is pending", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);

  const gate = deferred();
  let calls = 0;
  let latestRun: () => Promise<void> = async () => {};
  const action = () => {
    calls += 1;
    return gate.promise;
  };

  await act(async () => {
    mounted.root.render(createElement(Probe, { action, onRun: (run) => (latestRun = run), options: IMMEDIATE }));
  });
  await act(async () => {
    void latestRun();
    void latestRun();
    void latestRun();
  });
  assert.equal(calls, 1, "a second click while pending is a no-op");

  await act(async () => {
    gate.resolve();
    await gate.promise;
  });
  // After it settles the action can run again (gate.promise is already resolved).
  await act(async () => {
    void latestRun();
  });
  assert.equal(calls, 2);
});

test("useAsyncAction does not warn or throw when its action settles after unmount", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);

  const gate = deferred();
  let latestRun: () => Promise<void> = async () => {};
  await act(async () => {
    mounted.root.render(createElement(Probe, { action: () => gate.promise, onRun: (run) => (latestRun = run), options: IMMEDIATE }));
  });
  await act(async () => {
    void latestRun();
  });
  // The in-flight path is genuinely taken — the guard only matters if pending was set.
  assert.equal(mounted.container.querySelector("button")?.getAttribute("data-pending"), "true");

  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    await act(async () => {
      mounted.root.unmount();
    });
    // Resolving after unmount must not throw and must log no React warning. React
    // 19 makes post-unmount setState a silent no-op, so the liveRef guard is
    // defensive; this still fails loudly if a React upgrade re-introduces the warn.
    await assert.doesNotReject(async () => {
      await act(async () => {
        gate.resolve();
        await gate.promise;
      });
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(errors, [], "no React warning about setting state after unmount");
});

test("useAsyncAction never shows the spinner for an action faster than the show-delay", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);

  const seen: boolean[] = [];
  let latestRun: () => Promise<void> = async () => {};
  await act(async () => {
    mounted.root.render(
      createElement(Probe, {
        action: () => Promise.resolve(), // resolves well under the 40ms delay
        onRun: (run, pending) => {
          latestRun = run;
          seen.push(pending);
        },
        options: { showDelayMs: 40, minVisibleMs: 40 },
      }),
    );
  });
  await act(async () => {
    await latestRun();
  });
  // Wait past the show-delay to prove the (cancelled) show timer cannot fire late.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  assert.ok(!seen.includes(true), "spinner never becomes visible for a fast action (no flash)");
  assert.equal(mounted.container.querySelector("button")?.getAttribute("data-pending"), "false");
});

test("useAsyncAction shows after the delay and holds for the minimum visible window", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);

  const gate = deferred();
  let latestRun: () => Promise<void> = async () => {};
  await act(async () => {
    mounted.root.render(
      createElement(Probe, {
        action: () => gate.promise,
        onRun: (run) => (latestRun = run),
        // Wide min-visible so "held immediately after resolve" (the one assertion
        // with absolute-timing dependence) keeps generous slack on a loaded CI box.
        options: { showDelayMs: 40, minVisibleMs: 300 },
      }),
    );
  });
  const pendingAttr = () => mounted.container.querySelector("button")?.getAttribute("data-pending");

  await act(async () => {
    void latestRun();
  });
  assert.equal(pendingAttr(), "false", "hidden during the show-delay");

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  assert.equal(pendingAttr(), "true", "shown once the action outlives the show-delay");

  // Resolve now: the spinner must linger for the min-visible window, not blink off.
  await act(async () => {
    gate.resolve();
    await gate.promise;
  });
  assert.equal(pendingAttr(), "true", "held immediately after resolve (min-visible)");

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 360));
  });
  assert.equal(pendingAttr(), "false", "clears after the minimum visible window");
});

test("useAsyncAction keeps the spinner continuous across a rapid re-run during the hold", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);

  const gateA = deferred();
  const gateB = deferred();
  const seen: boolean[] = [];
  let latestRun: () => Promise<void> = async () => {};
  let phase: "A" | "B" = "A";
  await act(async () => {
    mounted.root.render(
      createElement(Probe, {
        action: () => (phase === "A" ? gateA.promise : gateB.promise),
        onRun: (run, pending) => {
          latestRun = run;
          seen.push(pending);
        },
        options: { showDelayMs: 40, minVisibleMs: 160 },
      }),
    );
  });
  const pendingAttr = () => mounted.container.querySelector("button")?.getAttribute("data-pending");

  // Run A and let the spinner appear.
  await act(async () => {
    void latestRun();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  assert.equal(pendingAttr(), "true", "A shows the spinner");

  // Resolve A → enters the min-visible hold (hide timer armed, pending still true).
  await act(async () => {
    gateA.resolve();
    await gateA.promise;
  });
  assert.equal(pendingAttr(), "true", "held after A resolves");

  // Re-run (B) before the hold elapses: the pending hide must be cancelled and the
  // spinner stay continuously visible (no blink) while B is in flight.
  phase = "B";
  const seenBefore = seen.length;
  await act(async () => {
    void latestRun();
  });
  await act(async () => {
    // Past A's original hide (~120ms after A resolved) — proving it was cancelled,
    // not fired. B is still in flight, so pending must remain true.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  assert.equal(pendingAttr(), "true", "spinner stays up: A's hide was cancelled and B restarted the window");
  assert.ok(!seen.slice(seenBefore).includes(false), "pending never flipped false during the A→B handoff");

  // Resolve B and let its window elapse → clears.
  await act(async () => {
    gateB.resolve();
    await gateB.promise;
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
  assert.equal(pendingAttr(), "false", "clears after B settles");
});

test("useAsyncAction clears a pending show timer on unmount without warning", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);

  const gate = deferred();
  const seen: boolean[] = [];
  let latestRun: () => Promise<void> = async () => {};
  await act(async () => {
    mounted.root.render(
      createElement(Probe, {
        action: () => gate.promise,
        onRun: (run, pending) => {
          latestRun = run;
          seen.push(pending);
        },
        options: { showDelayMs: 60, minVisibleMs: 60 },
      }),
    );
  });
  await act(async () => {
    void latestRun(); // arms the show timer (60ms); not yet fired
  });

  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    // Unmount while the show timer is still pending, then let time pass: a leaked
    // timer would try to setPending on an unmounted tree.
    await act(async () => {
      mounted.root.unmount();
    });
    await act(async () => {
      gate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
  } finally {
    console.error = originalError;
  }
  assert.ok(!seen.includes(true), "the delayed spinner never became visible after unmount");
  assert.deepEqual(errors, [], "no React warning from a timer firing after unmount");
});

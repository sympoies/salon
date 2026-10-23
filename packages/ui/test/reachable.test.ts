import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  HostReaderUnavailable,
  hostReaderUnavailableText,
  runReachablePollRefresh,
} from "../src/reachable.ts";
import { renderComponent } from "./support/ssr.ts";
import { uiSource } from "./support/source.ts";

test("HostReaderUnavailable renders the shared host-reader outage banner", () => {
  assert.equal(
    hostReaderUnavailableText("Usage", "reader down"),
    "Usage is unavailable: reader down",
  );

  const html = renderComponent(HostReaderUnavailable, { label: "Usage", error: "reader down" });
  assert.match(html, /class="banner warn"/);
  assert.match(html, /Usage is unavailable/);
  assert.match(html, /reader down/);
});

test("a fresh refresh queued behind an in-flight poll stays fresh", () => {
  assert.match(
    uiSource("reachable.ts"),
    /inFlightRef\.current\.promise\.then\(\(\) => refresh\(tick, true\)\)/,
  );
});

interface SampleResult {
  readonly reachable: boolean;
  readonly error?: string;
  readonly values: readonly string[];
}

function pollState() {
  const state = {
    data: [] as readonly string[],
    reachable: true,
    error: null as string | null,
    loaded: false,
  };
  return {
    state,
    sink: {
      setData: (data: readonly string[]) => {
        state.data = data;
      },
      setReachable: (reachable: boolean) => {
        state.reachable = reachable;
      },
      setError: (error: string | null) => {
        state.error = error;
      },
      setLoaded: (loaded: boolean) => {
        state.loaded = loaded;
      },
    },
  };
}

test("reachable poll refresh applies success and unreachable envelope transitions", async () => {
  const { state, sink } = pollState();
  const successes: SampleResult[] = [];

  await runReachablePollRefresh({
    fetcher: async () => ({ reachable: true, values: ["usage"] }),
    selectData: (result: SampleResult) => result.values,
    isCurrent: () => true,
    sink,
    onSuccess: (result) => successes.push(result),
  });

  assert.deepEqual(state, {
    data: ["usage"],
    reachable: true,
    error: null,
    loaded: true,
  });
  assert.equal(successes.length, 1);

  await runReachablePollRefresh({
    fetcher: async () => ({ reachable: false, error: "reader down", values: [] }),
    selectData: (result: SampleResult) => result.values,
    isCurrent: () => true,
    sink,
    onSuccess: (result) => successes.push(result),
  });

  assert.deepEqual(state, {
    data: [],
    reachable: false,
    error: "reader down",
    loaded: true,
  });
  assert.equal(successes.length, 2);
});

test("reachable poll refresh marks rejected fetches loaded and unreachable", async () => {
  const { state, sink } = pollState();
  state.data = ["cached"];

  await runReachablePollRefresh({
    fetcher: async () => {
      throw new Error("network down");
    },
    selectData: (result: SampleResult) => result.values,
    isCurrent: () => true,
    sink,
  });

  assert.deepEqual(state, {
    data: ["cached"],
    reachable: false,
    error: "network down",
    loaded: true,
  });
});

test("reachable poll can retain last-good data for an unreachable envelope", async () => {
  const { state, sink } = pollState();
  state.data = ["cached codex"];

  await runReachablePollRefresh({
    fetcher: async () => ({ reachable: false, error: "usage reader timed out", values: [] }),
    selectData: (result: SampleResult) => result.values,
    retainDataWhenUnreachable: true,
    isCurrent: () => true,
    sink,
  });

  assert.deepEqual(state, {
    data: ["cached codex"],
    reachable: false,
    error: "usage reader timed out",
    loaded: true,
  });
});

test("reachable poll refresh suppresses stale results and callbacks", async () => {
  const { state, sink } = pollState();
  const successes: SampleResult[] = [];
  let current = true;

  await runReachablePollRefresh({
    fetcher: async () => {
      current = false;
      return { reachable: true, values: ["late"] };
    },
    selectData: (result: SampleResult) => result.values,
    isCurrent: () => current,
    sink,
    onSuccess: (result) => successes.push(result),
  });

  assert.deepEqual(state, {
    data: [],
    reachable: true,
    error: null,
    loaded: false,
  });
  assert.deepEqual(successes, []);
});

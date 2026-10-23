import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { CreateBody } from "../src/types.ts";
import { copySessionCommandToClipboard } from "../src/resumeClipboard.ts";
import { assertNoElement } from "./support/domAssert.ts";
import { createUiSsrHarness } from "./support/ssr.ts";
import { uiSource } from "./support/source.ts";

const source = uiSource("CreateDialog.tsx");
const ssr = createUiSsrHarness();

after(async () => {
  await ssr.close();
});

for (const label of ["Title", "Working dir", "Initial prompt"]) {
  test(`CreateDialog keeps the ${label} optional hint with its field label`, () => {
    assert.match(
      source,
      new RegExp(
        `<span className="field-label">\\s*${label} <span className="hint">optional</span>\\s*</span>`,
      ),
    );
  });
}

test("CreateDialog orders Working dir before Title for new sessions", () => {
  const workingDirField = source.indexOf('Working dir <span className="hint">optional</span>');
  const titleField = source.indexOf('Title <span className="hint">optional</span>');

  assert.notEqual(workingDirField, -1);
  assert.notEqual(titleField, -1);
  assert.ok(workingDirField < titleField);
});

test("CreateDialog exposes one optional nickname-only account selector for every provider", () => {
  assert.match(source, /accountsByProvider/);
  assert.match(source, /function AccountPicker\(/);
  assert.match(source, /`\$\{ACCOUNT_PROVIDER_LABELS\[provider\]\} account`/);
  assert.doesNotMatch(source, /access_token|auth\.json/);
});

test("CreateDialog renders fixed-choice selectors inside the app", () => {
  assert.doesNotMatch(source, /<select/);
  assert.match(source, /<SelectMenu/);
});

test("CreateDialog scopes a launch-profile choice to machines advertising it ready", async () => {
  const { CreateDialog } = await ssr.loadModule<{
    CreateDialog: ComponentType<{
      machines: readonly string[];
      agentProfilesByMachine: Readonly<Record<string, readonly {
        id: string;
        label: string;
        agent: "codex" | "claude" | "dsh";
        provider_resume_import_supported?: boolean;
      }[]>>;
      accountsByProvider: Readonly<Record<"codex" | "claude", Readonly<Record<string, unknown>>>>;
      busy: boolean;
      onCreate: (machine: string, body: CreateBody) => void;
      onClose: () => void;
    }>;
  }>("/src/CreateDialog.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let submitted: { machine: string; body: CreateBody } | undefined;
  try {
    await act(async () => {
      root.render(createElement(CreateDialog, {
        machines: ["maple", "m2"],
        agentProfilesByMachine: {
          maple: [
            {
              id: "custom-claude",
              label: "Custom Claude",
              agent: "claude",
              provider_resume_import_supported: true,
            },
            { id: "claude-legacy", label: "Claude Legacy", agent: "claude" },
          ],
          m2: [],
        },
        accountsByProvider: { codex: { maple: { accounts: [] }, m2: { accounts: [] } }, claude: {} },
        busy: false,
        onCreate: (machine, body) => {
          submitted = { machine, body };
        },
        onClose: () => {},
      }));
    });

    const openSelect = async (label: string) => {
      const trigger = container.querySelector<HTMLButtonElement>(
        `button[role="combobox"][aria-label^="${label}:"]`,
      );
      assert.ok(trigger);
      await act(async () => {
        trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    };
    const option = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
      .find((candidate) => candidate.textContent?.trim() === label);

    await openSelect("Agent");
    assert.ok(option("Custom Claude"));
    await act(async () => {
      option("Custom Claude")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await openSelect("Machine");
    const machineTwo = option("m2");
    assert.ok(machineTwo);
    await act(async () => {
      machineTwo.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    await openSelect("Agent");
    assert.equal(option("Custom Claude"), undefined);

    await openSelect("Machine");
    const machineOne = option("maple");
    assert.ok(machineOne);
    await act(async () => {
      machineOne.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const resumeMode = [...container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')]
      .find((button) => button.textContent?.trim() === "Resume by ID");
    assert.ok(resumeMode);
    await act(async () => {
      resumeMode.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await openSelect("Agent");
    assert.ok(option("Custom Claude"));
    assert.equal(option("Claude Legacy"), undefined);
    await act(async () => {
      option("Custom Claude")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    let copiedText = "";
    const copied = await copySessionCommandToClipboard({
      id: "managed-profile",
      agent: "claude",
      agent_profile: "custom-claude",
      status: "stopped",
      provider_resume: { provider: "claude", session_id: "profile-provider-id" },
    }, {
      writeText: (value) => {
        copiedText = value;
      },
    });
    assert.deepEqual(copied, {
      ok: true,
      command: "profile-provider-id",
      kind: "provider-session-id",
    });

    const resumeInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Session ID or pasted resume command"]',
    );
    assert.ok(resumeInput);
    await act(async () => {
      const paste = new window.Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { getData: (type: string) => type === "text" ? copiedText : "" },
      });
      resumeInput.dispatchEvent(paste);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const createButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Create");
    assert.ok(createButton);
    assert.equal(createButton.disabled, false);
    await act(async () => {
      createButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(submitted, {
      machine: "maple",
      body: {
        agent: "claude",
        agent_profile: "custom-claude",
        provider_resume_id: "profile-provider-id",
      },
    });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

test("CreateDialog resumes a history-backed DSH profile by its session id", async () => {
  const { CreateDialog } = await ssr.loadModule<{
    CreateDialog: ComponentType<{
      machines: readonly string[];
      agentProfilesByMachine: Readonly<Record<string, readonly {
        id: string;
        label: string;
        agent: "codex" | "claude" | "dsh";
        provider_resume_import_supported?: boolean;
        history_resume_supported?: boolean;
      }[]>>;
      accountsByProvider: Readonly<Record<"codex" | "claude", Readonly<Record<string, unknown>>>>;
      busy: boolean;
      onCreate: (machine: string, body: CreateBody) => void;
      onResumeFromHistory: (
        machine: string,
        target: { agentProfile: string; providerSessionId: string; label: string },
      ) => void;
      onClose: () => void;
    }>;
  }>("/src/CreateDialog.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let created: unknown;
  let resumed: unknown;
  try {
    await act(async () => {
      root.render(createElement(CreateDialog, {
        machines: ["maple"],
        agentProfilesByMachine: {
          maple: [{ id: "dsh-workbench", label: "DSH", agent: "dsh", history_resume_supported: true }],
        },
        accountsByProvider: { codex: { maple: { accounts: [] } }, claude: {} },
        busy: false,
        onCreate: (machine, body) => {
          created = { machine, body };
        },
        onResumeFromHistory: (machine, target) => {
          resumed = { machine, target };
        },
        onClose: () => {},
      }));
    });
    const click = async (element: Element | undefined) => {
      assert.ok(element);
      await act(async () => {
        element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    };
    const option = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
      .find((candidate) => candidate.textContent?.trim() === label);
    const agentTrigger = () => container.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label^="Agent:"]',
    ) ?? undefined;

    await click([...container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')]
      .find((button) => button.textContent?.trim() === "Resume by ID"));
    await click(agentTrigger());
    await click(option("DSH"));
    assert.match(agentTrigger()?.getAttribute("aria-label") ?? "", /DSH/);

    const resumeInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Session ID or pasted resume command"]',
    );
    assert.ok(resumeInput);
    await act(async () => {
      const paste = new window.Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { getData: (type: string) => type === "text" ? "dsh-session-1" : "" },
      });
      resumeInput.dispatchEvent(paste);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const createButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Create");
    assert.equal(createButton?.disabled, false);
    await click(createButton);

    assert.equal(created, undefined);
    assert.deepEqual(resumed, {
      machine: "maple",
      target: { agentProfile: "dsh-workbench", providerSessionId: "dsh-session-1", label: "DSH" },
    });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

test("CreateDialog repo picker opens as an anchored fixed popover", async () => {
  const { CreateDialog } = await ssr.loadModule<{
    CreateDialog: ComponentType<{
      machines: readonly string[];
      accountsByProvider: Readonly<Record<"codex" | "claude", Readonly<Record<string, unknown>>>>;
      busy: boolean;
      onCreate: () => void;
      onClose: () => void;
    }>;
  }>("/src/CreateDialog.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(CreateDialog, {
        machines: ["maple"],
        accountsByProvider: { codex: { maple: { accounts: [] } }, claude: {} },
        busy: false,
        onCreate: () => {},
        onClose: () => {},
      }));
    });
    const workdirInput = container.querySelector<HTMLInputElement>('input[role="combobox"]');
    assert.ok(workdirInput);
    await act(async () => {
      workdirInput.dispatchEvent(new window.Event("focusin", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const options = container.querySelector<HTMLElement>("#workdir-options");
    assert.ok(options);
    // Repo list shares useAnchoredFloating with the select menus: fixed,
    // anchored to the input, escaping the modal's scroll clip. Assert props only
    // the computed style sets (the hidden fallback is also `fixed`).
    assert.equal(options.style.position, "fixed");
    assert.notEqual(options.style.visibility, "hidden");
    assert.match(options.style.maxHeight, /^\d+px$/);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

test("CreateDialog submits the selected Codex account nickname", async () => {
  const { CreateDialog } = await ssr.loadModule<{
    CreateDialog: ComponentType<{
      machines: readonly string[];
      accountsByProvider: Readonly<Record<"codex" | "claude", Readonly<Record<string, unknown>>>>;
      busy: boolean;
      onCreate: (machine: string, body: CreateBody) => void;
      onClose: () => void;
    }>;
  }>("/src/CreateDialog.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let submitted: { machine: string; body: CreateBody } | undefined;
  try {
    await act(async () => {
      root.render(createElement(CreateDialog, {
        machines: ["maple"],
        accountsByProvider: { codex: { maple: { accounts: [{ account: "sym", label: "Sym" }] } }, claude: {} },
        busy: false,
        onCreate: (machine, body) => { submitted = { machine, body }; },
        onClose: () => {},
      }));
    });
    const accountTrigger = container.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label^="Codex account:"]',
    );
    assert.ok(accountTrigger);
    await act(async () => {
      accountTrigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const accountOption = [...container.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
      .find((option) => option.textContent?.includes("Sym"));
    assert.ok(accountOption);
    await act(async () => {
      accountOption.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const createButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Create");
    assert.ok(createButton);
    await act(async () => {
      createButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(submitted, { machine: "maple", body: { agent: "codex", codex_account: "sym" } });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

for (const [reason, expectedCopy] of [
  ["codex-version-too-old", /Codex account selection is unavailable for Codex 0\.143\.9/],
  ["codex-app-server-runtime-dir-unavailable", /private runtime directory is unavailable/],
  ["codex-app-server-runtime-dir-unsafe", /private runtime directory is unsafe/],
  ["codex-app-server-socket-path-too-long", /runtime socket path is too long/],
  ["codex-app-server-runtime-unavailable", /app-server runtime is unavailable/],
] as const) {
test(`CreateDialog explains ${reason} and keeps default Codex creation available`, async () => {
  const { CreateDialog } = await ssr.loadModule<{
    CreateDialog: ComponentType<{
      machines: readonly string[];
      accountsByProvider: Readonly<Record<"codex" | "claude", Readonly<Record<string, unknown>>>>;
      busy: boolean;
      onCreate: (machine: string, body: CreateBody) => void;
      onClose: () => void;
    }>;
  }>("/src/CreateDialog.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let submitted: { machine: string; body: CreateBody } | undefined;
  try {
    await act(async () => {
      root.render(createElement(CreateDialog, {
        machines: ["maple"],
        accountsByProvider: { codex: { maple: {
          accounts: [{ account: "sym", label: "Sym" }],
          readiness: {
            schema_version: "agent-session.codex-account-readiness.v1",
            supported: false,
            provider_version: "0.143.9",
            reason_code: reason,
          },
        } }, claude: {} },
        busy: false,
        onCreate: (machine, body) => { submitted = { machine, body }; },
        onClose: () => {},
      }));
    });
    assertNoElement(container, 'button[role="combobox"][aria-label^="Codex account:"]');
    assert.match(container.textContent ?? "", expectedCopy);
    const createButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Create");
    assert.ok(createButton);
    await act(async () => {
      createButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(submitted, { machine: "maple", body: { agent: "codex" } });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

}

test("CreateDialog creates a second DSH profile on the dsh base", async () => {
  const { CreateDialog } = await ssr.loadModule<{
    CreateDialog: ComponentType<{
      machines: readonly string[];
      agentProfilesByMachine: Readonly<Record<string, readonly {
        id: string;
        label: string;
        agent: "codex" | "claude" | "dsh";
      }[]>>;
      accountsByProvider: Readonly<Record<"codex" | "claude", Readonly<Record<string, unknown>>>>;
      busy: boolean;
      onCreate: (machine: string, body: CreateBody) => void;
      onClose: () => void;
    }>;
  }>("/src/CreateDialog.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let submitted: { machine: string; body: CreateBody } | undefined;
  try {
    await act(async () => {
      root.render(createElement(CreateDialog, {
        machines: ["maple"],
        agentProfilesByMachine: { maple: [{ id: "dsh-tui", label: "DSH TUI", agent: "dsh" }] },
        accountsByProvider: { codex: { maple: { accounts: [] } }, claude: {} },
        busy: false,
        onCreate: (machine, body) => {
          submitted = { machine, body };
        },
        onClose: () => {},
      }));
    });
    const click = async (element: Element | undefined) => {
      assert.ok(element);
      await act(async () => {
        element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    };
    const options = () => [...container.querySelectorAll<HTMLButtonElement>('button[role="option"]')];
    await click(container.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label^="Agent:"]') ?? undefined);
    assert.deepEqual(options().map((option) => option.textContent?.trim()), ["codex", "claude", "DSH TUI"]);
    await click(options().find((option) => option.textContent?.trim() === "DSH TUI"));
    await click([...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Create"));
    assert.deepEqual(submitted, {
      machine: "maple",
      body: { agent: "dsh", agent_profile: "dsh-tui" },
    });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

test("CreateDialog marks Machine and Agent choices with their badges", async () => {
  const { CreateDialog } = await ssr.loadModule<{
    CreateDialog: ComponentType<{
      machines: readonly string[];
      defaultMachine?: string;
      machineColors: Readonly<Record<string, string>>;
      agentProfilesByMachine: Readonly<Record<string, readonly {
        id: string;
        label: string;
        agent: "codex" | "claude" | "dsh";
      }[]>>;
      accountsByProvider: Readonly<Record<"codex" | "claude", Readonly<Record<string, unknown>>>>;
      busy: boolean;
      onCreate: () => void;
      onClose: () => void;
    }>;
  }>("/src/CreateDialog.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(CreateDialog, {
        machines: ["maple", "m2"],
        defaultMachine: "m2",
        // maple carries a user override; m2 falls back to the default palette.
        machineColors: { maple: "#22da6e" },
        agentProfilesByMachine: {
          maple: [{ id: "dsh-workbench", label: "DSH", agent: "dsh" }],
          m2: [{ id: "dsh-workbench", label: "DSH", agent: "dsh" }],
        },
        accountsByProvider: { codex: { maple: { accounts: [] }, m2: { accounts: [] } }, claude: {} },
        busy: false,
        onCreate: () => {},
        onClose: () => {},
      }));
    });
    const openSelect = async (label: string) => {
      const trigger = container.querySelector<HTMLButtonElement>(
        `button[role="combobox"][aria-label^="${label}:"]`,
      );
      assert.ok(trigger);
      await act(async () => {
        trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    };
    const triggerMark = (label: string, selector: string): string | null => container
      .querySelector<HTMLElement>(`button[role="combobox"][aria-label^="${label}:"] ${selector}`)
      ?.className ?? null;
    const optionAccents = () => [...container.querySelectorAll<HTMLElement>('[role="option"] .machine-badge')]
      .map((mark) => mark.style.getPropertyValue("--machine-accent").trim());
    const optionAgentMarks = () => [...container.querySelectorAll<HTMLElement>('[role="option"] .agent-badge')]
      .map((mark) => mark.className);

    // Both triggers carry a mark, so the two stacked selects keep a shared text
    // baseline instead of Agent alone being indented.
    assert.equal(container.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label^="Machine:"]')?.getAttribute("aria-label"), "Machine: m2");
    assert.equal(triggerMark("Machine", ".machine-badge"), "machine-badge");
    assert.equal(triggerMark("Agent", ".agent-badge"), "agent-badge codex");

    await openSelect("Machine");
    assert.deepEqual(optionAccents(), ["#22da6e", "#82aaff"]);

    await openSelect("Agent");
    // Each kind gets its own mark; the DSH profile carries the fish.
    assert.deepEqual(optionAgentMarks(), [
      "agent-badge codex",
      "agent-badge claude",
      "agent-badge dsh",
    ]);
    assert.equal(container.querySelectorAll('[role="option"] .dsh-mark').length, 1);
    // Marks stay decorative: the option name is still the plain label.
    assert.equal(
      container.querySelector('[role="option"]')?.getAttribute("aria-label") ?? null,
      "codex",
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

async function renderClaudeCreateDialog(
  claudeAccountsByMachine: Readonly<Record<string, { readonly accounts: readonly { account: string; label?: string }[] }>> | undefined,
  run: (helpers: {
    readonly container: HTMLElement;
    readonly click: (element: Element) => Promise<void>;
    readonly chooseAgent: (label: string) => Promise<void>;
    readonly submitted: () => { machine: string; body: CreateBody } | undefined;
  }) => Promise<void>,
): Promise<void> {
  const { CreateDialog } = await ssr.loadModule<{
    CreateDialog: ComponentType<{
      machines: readonly string[];
      accountsByProvider: Readonly<Record<"codex" | "claude", Readonly<Record<string, unknown>>>>;
      busy: boolean;
      onCreate: (machine: string, body: CreateBody) => void;
      onClose: () => void;
    }>;
  }>("/src/CreateDialog.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let submitted: { machine: string; body: CreateBody } | undefined;
  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };
  try {
    await act(async () => {
      root.render(createElement(CreateDialog, {
        machines: ["maple"],
        accountsByProvider: { codex: { maple: { accounts: [] } }, claude: claudeAccountsByMachine ?? {} },
        busy: false,
        onCreate: (machine, body) => { submitted = { machine, body }; },
        onClose: () => {},
      }));
    });
    await run({
      container: container as unknown as HTMLElement,
      click,
      chooseAgent: async (label) => {
        const trigger = container.querySelector('button[role="combobox"][aria-label^="Agent:"]');
        assert.ok(trigger);
        await click(trigger);
        const option = [...container.querySelectorAll('button[role="option"]')]
          .find((candidate) => candidate.getAttribute("aria-label") === label);
        assert.ok(option, `agent option ${label}`);
        await click(option);
      },
      submitted: () => submitted,
    });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
}

test("CreateDialog offers a Claude account picker with the default preselected", async () => {
  await renderClaudeCreateDialog(
    { maple: { accounts: [{ account: "alpha", label: "Alpha" }, { account: "beta" }] } },
    async ({ container, click, chooseAgent, submitted }) => {
      assertNoElement(container, 'button[role="combobox"][aria-label^="Claude account:"]');
      await chooseAgent("claude");
      const trigger = container.querySelector('button[role="combobox"][aria-label^="Claude account:"]');
      assert.ok(trigger);
      assert.match(trigger.getAttribute("aria-label") ?? "", /Default account/);
      const create = () => [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Create");
      await click(create()!);
      assert.deepEqual(submitted(), { machine: "maple", body: { agent: "claude" } });

      await click(trigger);
      const option = [...container.querySelectorAll('button[role="option"]')]
        .find((candidate) => candidate.textContent?.includes("Alpha"));
      assert.ok(option);
      await click(option);
      await click(create()!);
      assert.deepEqual(submitted(), { machine: "maple", body: { agent: "claude", claude_account: "alpha" } });
    },
  );
});

test("CreateDialog hides the Claude account picker when the machine reports no accounts", async () => {
  for (const inventory of [undefined, { maple: { accounts: [] } }]) {
    await renderClaudeCreateDialog(inventory, async ({ container, chooseAgent }) => {
      await chooseAgent("claude");
      assertNoElement(container, 'button[role="combobox"][aria-label^="Claude account:"]');
    });
  }
});

test("CreateDialog falls back to the first enabled machine and reselects when it changes", async () => {
  const { CreateDialog } = await ssr.loadModule<{
    CreateDialog: ComponentType<{
      machines: readonly string[];
      defaultMachine?: string;
      accountsByProvider: Readonly<Record<"codex" | "claude", Readonly<Record<string, unknown>>>>;
      busy: boolean;
      onCreate: (machine: string, body: CreateBody) => void;
      onClose: () => void;
    }>;
  }>("/src/CreateDialog.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const created: string[] = [];
  const render = (machines: readonly string[]) => createElement(CreateDialog, {
    machines,
    defaultMachine: "not-enabled",
    accountsByProvider: { codex: {}, claude: {} },
    busy: false,
    onCreate: (machine) => created.push(machine),
    onClose: () => {},
  });
  const create = async () => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === "Create");
    assert.ok(button);
    await act(async () => {
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };
  try {
    await act(async () => root.render(render(["maple", "m2"])));
    await create();
    assert.equal(created[0], "maple");

    await act(async () => root.render(render(["m2", "m3"])));
    await create();
    assert.equal(created[1], "m2");
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

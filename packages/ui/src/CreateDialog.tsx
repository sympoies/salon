import { useEffect, useRef, useState } from "react";
import { searchWorkdirs, type WorkdirSuggestion } from "./api.ts";
import {
  ACCOUNT_PROVIDER_LABELS,
  type AccountProvider,
  type AccountSummary,
  type AgentLaunchProfileSummary,
  type CodexAccountReadiness,
} from "@agent-console/shared/api";
import { AgentBadge } from "./AgentBadge.tsx";
import { AsyncButton } from "./AsyncButton.tsx";
import { codexRuntimeFallbackReason } from "./codexRuntimeFallback.ts";
import { MachineBadge } from "./MachineBadge.tsx";
import type { MachineColorMap } from "./machineColors.ts";
import { Modal } from "./Modal.tsx";
import { SelectMenu, SelectMenuGroup } from "./SelectMenu.tsx";
import { createSessionBody, type CreateSessionMode } from "./createSessionBody.ts";
import { useShortcutClose } from "./useShortcutClose.ts";
import { AGENT_KINDS, type AgentKind } from "./frames.ts";
import {
  isProviderResumeAgent,
  parseProviderResumeInput,
  planResumeFieldInput,
  planResumePaste,
} from "./providerResume.ts";
import type { CreateBody } from "./types.ts";
import { boundedInitialPromptUpdate, validateInitialPrompt } from "./createLifecycle.ts";
import {
  filterWorkdirOptions,
  primaryWorkdirLabel,
  secondaryWorkdirLabel,
  WORKDIR_CONTEXT_HINT,
  selectWorkdir,
  type WorkdirSelection,
} from "./workdirPicker.ts";
import { useAnchoredFloating } from "./useAnchoredFloating.ts";
import {
  NO_ACCOUNT_INVENTORIES,
  accountChoices,
  launchProfileOwnsAccount,
  sessionAccountProvider,
  type AccountInventoriesByProvider,
} from "./sessionAccounts.ts";

export interface CreateDialogProps {
  readonly machines: readonly string[];
  readonly defaultMachine?: string;
  readonly machineColors?: MachineColorMap;
  readonly agentProfilesByMachine?: Readonly<Record<string, readonly AgentLaunchProfileSummary[]>>;
  /** Only machines serving a provider's account switch carry its inventory. */
  readonly accountsByProvider?: AccountInventoriesByProvider;
  readonly busy: boolean;
  readonly error?: string;
  readonly onCreate: (machine: string, body: CreateBody) => void;
  readonly onClose: () => void;
}

export function CreateDialog({
  machines,
  defaultMachine,
  machineColors = {},
  agentProfilesByMachine = {},
  accountsByProvider = NO_ACCOUNT_INVENTORIES,
  busy,
  error,
  onCreate,
  onClose,
}: CreateDialogProps) {
  const initialMachine = defaultMachine && machines.includes(defaultMachine) ? defaultMachine : machines[0] ?? "";
  const [machine, setMachine] = useState(initialMachine);
  const [mode, setMode] = useState<CreateSessionMode>("new");
  const [agentChoice, setAgentChoice] = useState<string>("codex");
  const [title, setTitle] = useState("");
  const [workdirSelection, setWorkdirSelection] = useState<WorkdirSelection>({
    displayValue: "",
    selectedPath: "",
  });
  const [workdirOpen, setWorkdirOpen] = useState(false);
  const workdirInputRef = useRef<HTMLInputElement>(null);
  const [activeWorkdirIndex, setActiveWorkdirIndex] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [promptInputError, setPromptInputError] = useState<string | null>(null);
  const [providerResumeId, setProviderResumeId] = useState("");
  const [resumeHint, setResumeHint] = useState<string | null>(null);
  const [workdirs, setWorkdirs] = useState<WorkdirSuggestion[]>([]);
  const [workdirError, setWorkdirError] = useState<string | null>(null);
  const [chosenAccounts, setChosenAccounts] = useState<Partial<Record<AccountProvider, string>>>({});
  useShortcutClose("create", onClose);
  useEffect(() => {
    if (!machines.includes(machine)) {
      setMachine(defaultMachine && machines.includes(defaultMachine) ? defaultMachine : machines[0] ?? "");
    }
  }, [defaultMachine, machine, machines]);
  const availableProfiles = agentProfilesByMachine[machine] ?? [];
  const selectableProfiles = mode === "resume"
    ? availableProfiles.filter((profile) =>
      profile.provider_resume_import_supported === true)
    : availableProfiles;
  const selectedProfile = agentChoice.startsWith("profile:")
    ? selectableProfiles.find((profile) => `profile:${profile.id}` === agentChoice)
    : undefined;
  const agent = selectedProfile?.agent
    ?? (AGENT_KINDS.includes(agentChoice as AgentKind) ? agentChoice as AgentKind : "codex");
  // Marks mirror the ones every downstream surface uses for a running session,
  // so the dialog teaches the icon-to-agent mapping at the point of choice.
  const agentOptions = [
    ...AGENT_KINDS
      .map((value) => ({ value, label: value, icon: <AgentBadge agent={value} decorative /> })),
    ...selectableProfiles.map((profile) => ({
      value: `profile:${profile.id}`,
      // The daemon advertises a validated human label, so it keeps owning the
      // option text. Deriving it from the mark instead would rename any future
      // profile that shares a mark, and put two naming styles in one dropdown.
      label: profile.label,
      icon: <AgentBadge agent={profile.agent} decorative />,
    })),
  ];

  useEffect(() => {
    if (
      agentChoice.startsWith("profile:")
      && !selectableProfiles.some((profile) => `profile:${profile.id}` === agentChoice)
    ) {
      setAgentChoice("codex");
    }
  }, [agentChoice, selectableProfiles]);

  useEffect(() => {
    if (!machine || mode !== "new") {
      setWorkdirs([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchWorkdirs(machine, workdirSelection.displayValue, 30)
        .then((items) => {
          if (!cancelled) {
            setWorkdirs(items);
            setWorkdirError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setWorkdirs([]);
            setWorkdirError((err as Error).message);
          }
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [machine, mode, workdirSelection.displayValue]);

  // The machine's accounts for the chosen agent's provider. A launch profile
  // that owns its provider configuration (Claude) leaves no account to choose.
  const accountProvider = sessionAccountProvider(agent);
  const accountInventory = machine && mode === "new" && accountProvider
    && !(selectedProfile && launchProfileOwnsAccount(accountProvider))
    ? accountsByProvider[accountProvider][machine]
    : undefined;
  const accountOptions = accountChoices(accountInventory);
  const accountReadiness = accountInventory?.readiness;
  const chosenAccount = accountProvider ? chosenAccounts[accountProvider] : undefined;
  // A choice the current machine no longer lists falls back to the default.
  const account = accountOptions.some((item) => item.account === chosenAccount) ? chosenAccount ?? "" : "";

  useEffect(() => {
    setActiveWorkdirIndex(0);
  }, [workdirSelection.displayValue, workdirs.length]);

  const visibleWorkdirs = filterWorkdirOptions(workdirs, workdirSelection.displayValue);
  const { style: workdirFloatingStyle } = useAnchoredFloating(workdirInputRef, workdirOpen, { maxHeight: 280 });

  const chooseWorkdir = (item: WorkdirSuggestion) => {
    setWorkdirSelection(selectWorkdir(item));
    setWorkdirOpen(false);
    setActiveWorkdirIndex(0);
  };

  const submit = () => {
    if (!machine) {
      return;
    }
    const body = createSessionBody({
      mode,
      agent,
      agentProfile: selectedProfile?.id,
      title,
      workdirSelection,
      prompt,
      providerResumeId,
      account,
    });
    if (!body) {
      return;
    }
    onCreate(machine, body);
  };
  const parsedResumeId = parseProviderResumeInput(providerResumeId).id;
  const resumeInputHasNoId = mode === "resume" && providerResumeId.trim().length > 0 && !parsedResumeId;
  const promptValidationError = mode === "new" ? promptInputError ?? validateInitialPrompt(prompt) : null;
  const canSubmit =
    Boolean(machine)
    && promptValidationError === null
    && (mode === "new" || (isProviderResumeAgent(agent) && Boolean(parsedResumeId)));

  return (
    <Modal androidBackEntry="new-session" onClose={onClose} busy={busy} ariaLabel="New session">
      <SelectMenuGroup>
        <h2>New session</h2>
        <div className="segmented-control" role="radiogroup" aria-label="Session mode">
          {(["new", "resume"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={"control-segment " + (mode === value ? "active" : "")}
              role="radio"
              aria-checked={mode === value}
              onClick={() => {
                setMode(value);
                setResumeHint(null);
              }}
              disabled={busy}
            >
              {value === "new" ? "New" : "Resume by ID"}
            </button>
          ))}
        </div>
        <div className="form-field">
          <span className="field-label">Machine</span>
          <SelectMenu
            ariaLabel="Machine"
            value={machine}
            disabled={busy}
            options={machines.map((value) => ({
              value,
              label: value,
              icon: <MachineBadge machine={value} machineColors={machineColors} />,
            }))}
            onChange={(value) => {
              setMachine(value);
              setWorkdirSelection({ displayValue: "", selectedPath: "" });
              setWorkdirOpen(false);
            }}
          />
        </div>
        <div className="form-field">
          <span className="field-label">Agent</span>
          <SelectMenu
            ariaLabel="Agent"
            value={agentChoice}
            disabled={busy}
            options={agentOptions}
            onChange={(value) => {
              setAgentChoice(value);
              setResumeHint(null);
            }}
          />
        </div>
        {accountProvider && accountOptions.length > 0 ? (
          <AccountPicker
            provider={accountProvider}
            accounts={accountOptions}
            value={account}
            disabled={busy}
            onChange={(value) => setChosenAccounts((current) => ({ ...current, [accountProvider]: value }))}
          />
        ) : null}
        {accountReadiness?.supported === false ? (
          <p className="hint" role="status">
            {codexAccountReadinessMessage(accountReadiness)}
          </p>
        ) : null}
        {mode === "new" ? (
          <label>
            <span className="field-label">
              Working dir <span className="hint">optional</span>
            </span>
            <div
              className="workdir-combobox"
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) {
                  setWorkdirOpen(false);
                }
              }}
            >
              <input
                ref={workdirInputRef}
                value={workdirSelection.displayValue}
                disabled={busy}
                onChange={(e) => {
                  setWorkdirSelection({ displayValue: e.target.value, selectedPath: "" });
                  setWorkdirOpen(true);
                }}
                onFocus={() => setWorkdirOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    // When the suggestions are open, Escape only closes them —
                    // stop it here so it does not also close the whole dialog.
                    if (workdirOpen) {
                      e.stopPropagation();
                      setWorkdirOpen(false);
                    }
                    return;
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setWorkdirOpen(true);
                    setActiveWorkdirIndex((index) => Math.min(index + 1, Math.max(visibleWorkdirs.length - 1, 0)));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setWorkdirOpen(true);
                    setActiveWorkdirIndex((index) => Math.max(index - 1, 0));
                    return;
                  }
                  if (e.key === "Enter" && workdirOpen && visibleWorkdirs[activeWorkdirIndex]) {
                    e.preventDefault();
                    chooseWorkdir(visibleWorkdirs[activeWorkdirIndex]);
                  }
                }}
                placeholder="Repository"
                role="combobox"
                aria-expanded={workdirOpen}
                aria-controls="workdir-options"
                aria-autocomplete="list"
                aria-activedescendant={
                  workdirOpen && visibleWorkdirs[activeWorkdirIndex]
                    ? `workdir-option-${activeWorkdirIndex}`
                    : undefined
                }
                autoComplete="off"
              />
              {workdirOpen ? (
                <div
                  id="workdir-options"
                  className="workdir-options"
                  style={workdirFloatingStyle}
                  role="listbox"
                >
                  {visibleWorkdirs.length > 0 ? (
                    visibleWorkdirs.map((item, index) => {
                      const secondary = secondaryWorkdirLabel(item, visibleWorkdirs);
                      return (
                        <button
                          key={item.path}
                          id={`workdir-option-${index}`}
                          type="button"
                          className={`control-menu workdir-option${index === activeWorkdirIndex ? " active" : ""}`}
                          role="option"
                          aria-selected={index === activeWorkdirIndex}
                          tabIndex={-1}
                          disabled={busy}
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseEnter={() => setActiveWorkdirIndex(index)}
                          onClick={() => chooseWorkdir(item)}
                        >
                          <span className="workdir-option-name">{primaryWorkdirLabel(item)}</span>
                          {secondary ? <span className="workdir-option-meta">{secondary}</span> : null}
                        </button>
                      );
                    })
                  ) : (
                    <div className="workdir-empty">No matching repositories</div>
                  )}
                </div>
              ) : null}
            </div>
            <span className="hint">{WORKDIR_CONTEXT_HINT}</span>
            {workdirError ? <span className="hint">{workdirError}</span> : null}
          </label>
        ) : null}
        <label>
          <span className="field-label">
            Title <span className="hint">optional</span>
          </span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. refactor edge"
            disabled={busy}
          />
        </label>
        {mode === "new" ? (
            <label>
              <span className="field-label">
                Initial prompt <span className="hint">optional</span>
              </span>
              <textarea
                value={prompt}
                onChange={(e) => {
                  const update = boundedInitialPromptUpdate(prompt, e.target.value);
                  setPrompt(update.prompt);
                  setPromptInputError(update.error);
                }}
                rows={3}
                disabled={busy}
              />
              {promptValidationError ? <span className="hint">{promptValidationError}</span> : null}
            </label>
        ) : (
          <label>
            Provider resume ID
            <input
              value={providerResumeId}
              disabled={busy}
              onChange={(e) => {
                const inputType = (e.nativeEvent as InputEvent).inputType;
                const plan = planResumeFieldInput(e.target.value, inputType);
                setProviderResumeId(plan.value);
                if (plan.provider && plan.provider !== agent) {
                  setAgentChoice(plan.provider);
                }
                setResumeHint(plan.hint);
              }}
              onPaste={(e) => {
                const plan = planResumePaste(e.clipboardData.getData("text"));
                if (!plan.intercept) {
                  if (!plan.id) {
                    return;
                  }
                  // Bare IDs need no normalization, but owning the paste keeps
                  // controlled-input behavior deterministic across WebView and
                  // desktop browser event implementations.
                  e.preventDefault();
                  setProviderResumeId(plan.id);
                  setResumeHint(null);
                  return;
                }
                e.preventDefault();
                setProviderResumeId(plan.id);
                if (plan.provider && plan.provider !== agent) {
                  setAgentChoice(plan.provider);
                }
                setResumeHint(plan.hint);
              }}
              placeholder="Session ID or pasted resume command"
              autoComplete="off"
            />
            {resumeHint ? (
              <span className="hint">{resumeHint}</span>
            ) : resumeInputHasNoId ? (
              <span className="hint">No session ID found — paste a full resume command or a bare id.</span>
            ) : null}
          </label>
        )}
        {error ? <p className="err">{error}</p> : null}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <AsyncButton className="btn primary" onClick={submit} pending={busy} disabled={!canSubmit}>
            Create
          </AsyncButton>
        </div>
      </SelectMenuGroup>
    </Modal>
  );
}

function AccountPicker({
  provider,
  accounts,
  value,
  disabled,
  onChange,
}: {
  readonly provider: AccountProvider;
  readonly accounts: readonly AccountSummary[];
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (account: string) => void;
}) {
  const label = `${ACCOUNT_PROVIDER_LABELS[provider]} account`;
  return (
    <div className="form-field">
      <span className="field-label">
        {label} <span className="hint">optional</span>
      </span>
      <SelectMenu
        ariaLabel={label}
        value={value}
        disabled={disabled}
        onChange={onChange}
        options={[
          { value: "", label: "Default account" },
          ...accounts.map((item) => ({
            value: item.account,
            label: item.label ?? item.account,
            ...(item.plan ? { meta: item.plan } : {}),
          })),
        ]}
      />
    </div>
  );
}

// Only a Codex inventory reports readiness: the installed Codex must support
// account selection through its app-server.
function codexAccountReadinessMessage(readiness: CodexAccountReadiness): string {
  const version = readiness.provider_version ? ` for Codex ${readiness.provider_version}` : " on this machine";
  if (readiness.reason_code === "codex-unavailable") {
    return "Codex account selection is unavailable because the Codex CLI could not be checked. Install or update Codex, or use the default account.";
  }
  if (readiness.reason_code === "codex-app-server-runtime-dir-unavailable"
    || readiness.reason_code === "codex-app-server-runtime-dir-unsafe"
    || readiness.reason_code === "codex-app-server-runtime-unavailable"
    || readiness.reason_code === "codex-app-server-socket-path-too-long") {
    return `Codex account selection is unavailable because ${codexRuntimeFallbackReason(readiness.reason_code)}. Use the default account.`;
  }
  return `Codex account selection is unavailable${version}. Update Codex or use the default account.`;
}

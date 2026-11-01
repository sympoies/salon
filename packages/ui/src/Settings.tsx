import { usePhoneLayout } from "./usePhoneLayout.ts";
import { ExtensionSettingsPanels } from "./extensions.tsx";
import { HostPreferencesSettings } from "./HostPreferencesSettings.tsx";
import { SpeechEngineSettings } from "./SpeechEngineSettings.tsx";
import { useEffect, useRef, useState } from "react";
import { AsyncButton } from "./AsyncButton.tsx";
import { BrandTitle } from "./BrandTitle.tsx";
import {
  loadServerUrl,
  saveServerUrl,
  loadToken,
  saveToken,
  normalizeServerUrl,
  isTauri,
} from "./runtime.ts";
import { logout, type AuthStatus, type ConnectFailure } from "./api.ts";
import {
  createMachineColorMap,
  machineColorOverride,
  resolveMachineColor,
  type MachineColorMap,
} from "./machineColors.ts";
import { useUiExtensions } from "./extensions.tsx";
import type { TerminalRenderMode } from "./terminalRenderMode.ts";
import type { CardPreview } from "./cardPreview.ts";
import { parseAndroidLayout, type AndroidLayout } from "./androidLayout.ts";
import { isAndroidTauri } from "./runtime.ts";
import type { SessionListDisplay } from "./sessionListDisplay.ts";
import { browserNotificationPermission } from "./attentionAlerts.ts";
import { clientVersionInfo, versionCopyText } from "./clientVersion.ts";
import { writeTerminalClipboardText } from "./terminalClipboard.ts";
import { THEME_MODES, useTheme, type ThemeMode } from "./theme.ts";
import { AppSelect } from "./AppSelect.tsx";

export interface SettingsProps {
  // The connect variant waits for the returned connection check and shows its outcome.
  readonly onSaved: () => void | Promise<ConnectFailure | undefined>;
  readonly onCancel?: () => void;
  // "connect" is the native first-run onboarding screen (connection form only).
  // "manage" is the settings hub reached from the header gear (all sections).
  readonly variant?: "connect" | "manage";
  readonly startupFailure?: AuthStatus["startupFailure"];
  readonly startupTimeoutElapsedMs?: number | null;
  readonly startupRecoveryElapsedMs?: number | null;
  readonly machines: readonly string[];
  readonly machineColors: MachineColorMap;
  readonly defaultAutoResume: boolean;
  readonly attentionAlerts: boolean;
  readonly terminalRenderMode: TerminalRenderMode;
  readonly terminalSelectedPaneRealtime: boolean;
  readonly phoneSessionOpen?: SessionListDisplay;
  readonly onPhoneSessionOpenChange?: (display: SessionListDisplay) => void;
  readonly phoneFocusCounts?: boolean;
  readonly onPhoneFocusCountsChange?: (shown: boolean) => void;
  readonly sessionListDisplay?: SessionListDisplay;
  readonly androidLayout?: AndroidLayout;
  readonly onAndroidLayoutChange?: (layout: AndroidLayout) => void;
  readonly cardPreview?: CardPreview;
  readonly onCardPreviewChange?: (preview: CardPreview) => void;
  readonly onSessionListDisplayChange?: (display: SessionListDisplay) => void;
  readonly onMachineColorChange: (name: string, color: string) => void;
  readonly onMachineColorReset: (name: string) => void;
  readonly onDefaultAutoResumeChange: (enabled: boolean) => void;
  readonly onAttentionAlertsChange: (enabled: boolean) => void;
  readonly onTerminalRenderModeChange: (mode: TerminalRenderMode) => void;
  readonly onTerminalSelectedPaneRealtimeChange: (enabled: boolean) => void;
  readonly openAccess: boolean;
  readonly onSignedOut: () => void;
  readonly onHostPreferenceMigrationDone?: () => void;
}

const CONNECT_FAILURE_MESSAGE: Record<ConnectFailure, string> = {
  rejected: "The token was rejected. Check the access token and try again.",
  unreachable: "The server could not be reached. Check the server URL and your connection.",
  unexpected: "The server gave an unexpected response. Try again later.",
};

// The device console settings. Connection secrets (server URL + token) are never
// baked into the app — they live only in device-local storage. On web the
// connection is cookie-based, so that section is hidden and the page holds
// per-device preferences (machine spokes) and account actions.
export function Settings({
  onSaved,
  onCancel,
  variant = "manage",
  startupFailure,
  startupTimeoutElapsedMs = null,
  startupRecoveryElapsedMs = null,
  machines,
  machineColors,
  defaultAutoResume,
  attentionAlerts,
  terminalRenderMode,
  terminalSelectedPaneRealtime,
  phoneSessionOpen = "conversation",
  onPhoneSessionOpenChange,
  phoneFocusCounts = true,
  onPhoneFocusCountsChange,
  sessionListDisplay = "terminal",
  androidLayout = "mobile",
  onAndroidLayoutChange,
  cardPreview = "latest-message",
  onCardPreviewChange,
  onSessionListDisplayChange,
  onMachineColorChange,
  onMachineColorReset,
  onDefaultAutoResumeChange,
  onAttentionAlertsChange,
  onTerminalRenderModeChange,
  onTerminalSelectedPaneRealtimeChange,
  openAccess,
  onSignedOut,
  onHostPreferenceMigrationDone,
}: SettingsProps) {
  const { machineColorDefaults } = useUiExtensions();
  const phone = usePhoneLayout();
  const theme = useTheme();
  const serverInput = useRef<HTMLInputElement>(null);
  const tokenInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // The stored token is never rendered into the DOM: Android WebView accessibility
  // reports input values and attributes. The field only ever holds a replacement.
  const [tokenSaved, setTokenSaved] = useState(() => loadToken() !== "");
  const [versionCopyStatus, setVersionCopyStatus] = useState<string | null>(null);
  const [draftMachineColors, setDraftMachineColors] = useState<Record<string, string>>(() => createMachineColorMap());

  useEffect(() => {
    const next = createMachineColorMap();
    for (const machine of machines) {
      next[machine] = resolveMachineColor(machine, machineColors, machineColorDefaults);
    }
    setDraftMachineColors(next);
  }, [machines, machineColors, machineColorDefaults]);

  const saveConnection = (): boolean => {
    // Native accessibility/autofill may update the controls without a React
    // change event. Read the submitted values, including replacement/clearing.
    const server = serverInput.current?.value ?? "";
    const token = tokenInput.current?.value ?? "";
    const normalized = normalizeServerUrl(server);
    if (!normalized) {
      setError("Enter a valid server URL, e.g. https://console.example.net:8791");
      return false;
    }
    // An untouched field keeps the saved token, but only for the server it was
    // saved for: a changed origin must never receive it (#1072).
    const untouched = token === "" && loadToken() !== "";
    const keepSaved = untouched && normalized === loadServerUrl();
    if (!keepSaved && !token.trim()) {
      setError(untouched ? "Enter the access token for this server." : "Enter the console access token.");
      return false;
    }
    saveServerUrl(normalized);
    if (!keepSaved) saveToken(token);
    if (tokenInput.current) tokenInput.current.value = "";
    setTokenSaved(true);
    setError(null);
    return true;
  };

  const clearSavedToken = () => {
    saveToken("");
    if (tokenInput.current) tokenInput.current.value = "";
    setTokenSaved(false);
  };

  const connect = async () => {
    if (checking || !saveConnection()) return;
    setChecking(true);
    const failure = await onSaved();
    setChecking(false);
    if (!failure) return;
    // A rejected token must not keep looking like a valid saved one.
    if (failure === "rejected") clearSavedToken();
    setError(CONNECT_FAILURE_MESSAGE[failure]);
  };

  const savedTokenStatus = tokenSaved ? (
    <div className="settings-actions">
      <span className="settings-hint" role="status">Access token saved on this device.</span>
      <button type="button" className="btn ghost" onClick={clearSavedToken}>
        Clear saved token
      </button>
    </div>
  ) : null;

  // First-run onboarding: a single centered card, unchanged in look.
  if (variant === "connect") {
    return (
      <div className="login">
        <form
          className="login-card"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <BrandTitle />
          <p className="sub">Connect to your server.</p>
          {startupFailure ? (
            <p className="err" role="alert">
              {startupFailure === "timeout"
                ? "The console connection timed out during startup. Check your connection and try again."
                : "The app could not reach the console during startup. Check your connection and try again."}
            </p>
          ) : null}
          {startupFailure === "timeout" && startupTimeoutElapsedMs !== null ? (
            <p className="startup-timing" aria-label="Startup recovery timing">
              Timeout fired at {(startupTimeoutElapsedMs / 1000).toFixed(2)} s
              {startupRecoveryElapsedMs !== null
                ? ` · Recovery rendered at ${(startupRecoveryElapsedMs / 1000).toFixed(2)} s`
                : " · Measuring recovery render"}
            </p>
          ) : null}
          <label>
            Server URL
            <input
              type="url"
              inputMode="url"
              ref={serverInput}
              defaultValue={loadServerUrl()}
              placeholder="https://console.example.net:8791"
              autoFocus
            />
          </label>
          <label>
            Access token
            <input
              data-testid="console-access-token"
              aria-label="Console access token"
              type="password"
              autoComplete="current-password"
              ref={tokenInput}
              placeholder={tokenSaved ? "replace access token" : "access token"}
            />
          </label>
          {savedTokenStatus}
          {error ? <p className="err" role="alert">{error}</p> : null}
          <div className="modal-actions">
            {onCancel ? (
              <button type="button" className="btn ghost" onClick={onCancel}>
                Cancel
              </button>
            ) : null}
            <button data-testid="console-sign-in" className="btn primary" type="submit" disabled={checking}>
              {checking ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  // Settings hub.
  const native = isTauri();
  const clientVersion = clientVersionInfo();
  const notificationPermission = browserNotificationPermission();
  const signOut = async () => {
    if (native) {
      // Device sign-out is local; a stalled cookie logout must not delay it.
      clearSavedToken();
      onSignedOut();
      await logout().catch(() => {});
      return;
    }
    await logout();
    onSignedOut();
  };
  const commitMachineColor = (machine: string, color: string) => {
    if (color !== resolveMachineColor(machine, machineColors, machineColorDefaults)) {
      onMachineColorChange(machine, color);
    }
  };
  const machineColorControl = (machine: string) => {
    const color = machineColorOverride(draftMachineColors, machine) ?? resolveMachineColor(machine, machineColors, machineColorDefaults);
    const hasOverride = Object.prototype.hasOwnProperty.call(machineColors, machine);
    return (
      <span className="settings-machine-color">
        <input
          type="color"
          className="settings-color-input"
          value={color}
          onChange={(e) => {
            const next = e.currentTarget.value;
            setDraftMachineColors((prev) => {
              const draft = createMachineColorMap(Object.entries(prev));
              draft[machine] = next;
              return draft;
            });
          }}
          onBlur={(e) => commitMachineColor(machine, e.currentTarget.value)}
          aria-label={`Color for ${machine}`}
          title={`${machine} color ${color}`}
        />
        {hasOverride ? (
          <button
            type="button"
            className="settings-color-reset"
            onClick={() => {
              setDraftMachineColors((prev) => {
                const draft = createMachineColorMap(Object.entries(prev));
                draft[machine] = resolveMachineColor(machine, {}, machineColorDefaults);
                return draft;
              });
              onMachineColorReset(machine);
            }}
            title={`Reset ${machine} color`}
          >
            reset
          </button>
        ) : (
          <span className="settings-color-reset-placeholder" aria-hidden="true" />
        )}
      </span>
    );
  };

  return (
    <div className="settings-page">
      <header className="dash-head">
        <button className="btn ghost" onClick={onCancel} aria-label="Back to dashboard">
          ‹ Back
        </button>
        <h1 className="settings-title">Settings</h1>
      </header>

      <div className="settings-body">
        <section className="settings-section" aria-label="Version information">
          <h2 className="settings-section-title">Version</h2>
          <p>Client version: {clientVersion.version ?? "Unavailable"}</p>
          <p>Client build: {clientVersion.build ?? "Unavailable"}</p>
          <p>Surface: {clientVersion.surface}</p>
          <p>Server version: Unavailable</p>
          <p className="settings-hint">The server does not provide Console version metadata.</p>
          <div className="settings-actions">
            <AsyncButton className="btn ghost" onClick={async () => {
              try {
                await writeTerminalClipboardText(versionCopyText(clientVersion));
                setVersionCopyStatus("Copied version information.");
              } catch {
                setVersionCopyStatus("Could not copy version information. Try again.");
              }
            }}>Copy version information</AsyncButton>
          </div>
          {versionCopyStatus ? <p className="settings-hint" role="status">{versionCopyStatus}</p> : null}
        </section>
        {native ? (
          <section className="settings-section">
            <h2 className="settings-section-title">Connection</h2>
            <p className="settings-hint">The server URL and access token for this device.</p>
            <label className="settings-field">
              Server URL
              <input
                type="url"
                inputMode="url"
                ref={serverInput}
                defaultValue={loadServerUrl()}
                placeholder="https://console.example.net:8791"
              />
            </label>
            <label className="settings-field">
              Access token
              <input
                data-testid="console-access-token"
                aria-label="Console access token"
                type="password"
                autoComplete="current-password"
                ref={tokenInput}
                placeholder={tokenSaved ? "replace access token" : "access token"}
              />
            </label>
            {savedTokenStatus}
            {error ? <p className="err" role="alert">{error}</p> : null}
            <div className="settings-actions">
              <button
                data-testid="console-sign-in"
                className="btn primary"
                onClick={() => {
                  if (saveConnection()) onSaved();
                }}
              >
                Save connection
              </button>
            </div>
          </section>
        ) : null}

        {machines.length > 0 ? (
          <section className="settings-section">
            <h2 className="settings-section-title">Machines</h2>
            <p className="settings-hint">Choose visible hosts in Session filters. Machine colors stay on this device.</p>
            <ul className="settings-machines">
              {machines.map(m => <li key={m} className="settings-row">
                <span className="settings-row-label">{m}</span>
                <span className="settings-row-actions">{machineColorControl(m)}</span>
              </li>)}
            </ul>
          </section>
        ) : null}

        <HostPreferencesSettings machines={machines} onMigrationDone={onHostPreferenceMigrationDone} />

        <section className="settings-section">
          <h2 className="settings-section-title">Terminal</h2>
          <label className="settings-field">
            Output rendering
            <AppSelect
              aria-label="Output rendering"
              value={terminalRenderMode}
              onChange={(event) => onTerminalRenderModeChange(event.currentTarget.value as TerminalRenderMode)}
            >
              <option value="realtime">Realtime</option>
              <option value="focus-aware-smooth">Focus-aware · Smooth (100 ms)</option>
              <option value="focus-aware-balanced">Focus-aware · Balanced (250 ms)</option>
              <option value="focus-aware-efficient">Focus-aware · Efficient (500 ms)</option>
            </AppSelect>
          </label>
          <p className="settings-hint">
            Focused sessions always stay realtime. Other panes render at the selected interval.
          </p>
          <div className="settings-preference-row">
            <div className="settings-preference-copy">
              <span className="settings-preference-label">Selected pane stays realtime</span>
              <p className="settings-hint">
                Keep the outlined pane in the session list smooth while batching the rest.
              </p>
            </div>
            <button
              type="button"
              className={`settings-switch${terminalSelectedPaneRealtime ? " is-on" : " is-off"}`}
              role="switch"
              aria-checked={terminalSelectedPaneRealtime}
              disabled={terminalRenderMode === "realtime"}
              onClick={() => onTerminalSelectedPaneRealtimeChange(!terminalSelectedPaneRealtime)}
            >
              {terminalSelectedPaneRealtime ? "on" : "off"}
            </button>
          </div>
        </section>

        <section className="settings-section">
          <h2 className="settings-section-title">Appearance</h2>
          <label className="settings-field">
            Theme
            <AppSelect aria-label="Theme" value={theme.mode} onChange={(event) => theme.setMode(event.currentTarget.value as ThemeMode)}>
              {THEME_MODES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </AppSelect>
          </label>
          <p className="settings-hint">
            System follows the device appearance. Paper is the light theme. The choice stays on this device.
          </p>
        </section>

        <section className="settings-section">
          <h2 className="settings-section-title">Sessions</h2>
          <label className="settings-field">
            Card preview
            <AppSelect aria-label="Card preview" value={cardPreview}
              onChange={event => onCardPreviewChange?.(event.currentTarget.value as CardPreview)}>
              <option value="latest-message">Latest message</option>
              <option value="last-prompt">My last prompt</option>
            </AppSelect>
          </label>
          <p className="settings-hint">Choose the session card preview on this device.</p>
          <label className="settings-field">
            {phone ? "Open session as" : "Session list display"}
            <AppSelect aria-label={phone ? "Open session as" : "Session list display"}
              value={phone ? phoneSessionOpen : sessionListDisplay}
              onChange={event => (phone ? onPhoneSessionOpenChange : onSessionListDisplayChange)?.(event.currentTarget.value as SessionListDisplay)}>
              {phone ? <option value="conversation">Conversation (default)</option> : <option value="terminal">Terminal</option>}
              {phone ? <option value="terminal">Terminal</option> : <option value="conversation">Conversation</option>}
            </AppSelect>
          </label>
          <p className="settings-hint">{phone ? "Choose what opens when you tap a session." : "Choose what desktop session tiles show."}</p>
          {isAndroidTauri() && onAndroidLayoutChange ? <>
            <label className="settings-field">
              Layout
              <AppSelect aria-label="Layout" value={androidLayout}
                onChange={event => onAndroidLayoutChange(parseAndroidLayout(event.currentTarget.value))}>
                <option value="mobile">Mobile (default)</option>
                <option value="desktop">Desktop</option>
              </AppSelect>
            </label>
            <p className="settings-hint">Desktop shows the desktop grid on the session list. An opened session always uses the mobile view.</p>
          </> : null}
          {phone ? <div className="settings-preference-row">
            <div className="settings-preference-copy">
              <span className="settings-preference-label">Single-session count row</span>
              <p className="settings-hint">
                Show the session status counts in a third header row while one session is open on this device.
              </p>
            </div>
            <button
              type="button"
              className={`settings-switch${phoneFocusCounts ? " is-on" : " is-off"}`}
              role="switch"
              aria-label="Single-session count row"
              aria-checked={phoneFocusCounts}
              onClick={() => onPhoneFocusCountsChange?.(!phoneFocusCounts)}
            >
              {phoneFocusCounts ? "on" : "off"}
            </button>
          </div> : null}
          <div className="settings-preference-row">
            <div className="settings-preference-copy">
              <span className="settings-preference-label">Default auto-resume</span>
              <p className="settings-hint">
                New supported sessions will enable auto-resume before their first prompt is submitted.
                Existing sessions are unchanged.
              </p>
            </div>
            <button
              type="button"
              className={`settings-switch${defaultAutoResume ? " is-on" : " is-off"}`}
              role="switch"
              aria-checked={defaultAutoResume}
              onClick={() => onDefaultAutoResumeChange(!defaultAutoResume)}
            >
              {defaultAutoResume ? "on" : "off"}
            </button>
          </div>
          <div className="settings-preference-row">
            <div className="settings-preference-copy">
              <span className="settings-preference-label">Attention alerts</span>
              <p className="settings-hint">
                Play a sound on this device when a session needs input or finishes a turn while the console
                is open. {notificationPermission === "unsupported"
                  ? "System notifications are not available in this app."
                  : notificationPermission === "denied"
                    ? "Browser notifications are blocked, so only the sound plays."
                    : "In the background, the browser also shows a notification."}
              </p>
            </div>
            <button
              type="button"
              className={`settings-switch${attentionAlerts ? " is-on" : " is-off"}`}
              role="switch"
              aria-checked={attentionAlerts}
              onClick={() => onAttentionAlertsChange(!attentionAlerts)}
            >
              {attentionAlerts ? "on" : "off"}
            </button>
          </div>
          <SpeechEngineSettings />
          <ExtensionSettingsPanels />
        </section>

        {!openAccess ? (
          <section className="settings-section">
            <h2 className="settings-section-title">Account</h2>
            <div className="settings-actions">
              <AsyncButton className="btn ghost" onClick={() => signOut()}>
                Sign out
              </AsyncButton>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

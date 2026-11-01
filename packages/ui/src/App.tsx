import { ShellPage } from "./ShellPage.tsx";
import { resolveDashboardShortcutAction } from "./dashboardShortcuts.ts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getAuthStatus, listMachineNames, type AuthStatus, type ConnectFailure } from "./api.ts";
import { Login } from "./Login.tsx";
import { Settings } from "./Settings.tsx";
import { loadPhoneSessionOpen, savePhoneSessionOpen } from "./phoneSessionOpen.ts";
import { loadAndroidLayout, saveAndroidLayout, type AndroidLayout } from "./androidLayout.ts";
import { loadPhoneFocusCounts, savePhoneFocusCounts } from "./phoneFocusCounts.ts";
import { loadCardPreview, saveCardPreview, type CardPreview } from "./cardPreview.ts";
import { loadSessionListDisplay, saveSessionListDisplay, type SessionListDisplay } from "./sessionListDisplay.ts";
import { Dashboard } from "./Dashboard.tsx";
import { DebugPanel } from "./DebugPanel.tsx";
import { UsagePanel } from "./UsagePanel.tsx";
import { appBootElapsedMs, isAndroidTauri, isMacTauri, isTauri, needsDeviceConfig } from "./runtime.ts";
import { hostVisibilityMigrationPending, acknowledgeHostVisibilityMigration, resolveEnabledMachines } from "./enabledMachines.ts";
import { loadMachineColors, resetMachineColor, saveMachineColors, setMachineColor, type MachineColorMap } from "./machineColors.ts";
import { loadDefaultAutoResume, saveDefaultAutoResume } from "./autoResumeDefault.ts";
import { ExtensionAppProviders } from "./extensions.tsx";
import { loadAttentionAlerts, requestBrowserNotificationPermission, saveAttentionAlerts } from "./attentionAlerts.ts";
import {
  loadTerminalRenderMode,
  loadTerminalSelectedPaneRealtime,
  saveTerminalRenderMode,
  saveTerminalSelectedPaneRealtime,
  type TerminalRenderMode,
} from "./terminalRenderMode.ts";
import { setTerminalPerformancePreferences } from "./terminalPerformance.ts";
import { Modal } from "./Modal.tsx";
import { setPrincipalStorageNamespace } from "./storage.ts";
import { flushDebugEvents, hydrateDebugEventsFromStorage, recordDebugEvent } from "./debugLog.ts";
import { ANDROID_STARTUP_RECOVERY_DEADLINE_MS, runStartupAuthCheck } from "./startupDeadline.ts";
import type { AgentConsolePrincipal } from "@agent-console/shared/api";
import { useUiExtensions } from "./extensions.tsx";

type View = { kind: "shell" } | { kind: "dashboard" } | { kind: "debug" } | { kind: "usage"; anchor?: { element: HTMLElement; center: number; bottom: number } } | { kind: "settings" };

function overlayLabel(view: View): string {
  switch (view.kind) {
    case "shell": return "Shell";
    case "usage":
      return "Usage";
    case "settings":
      return "Settings";
    case "debug":
      return "Debug";
    case "dashboard":
      return "Dashboard";
  }
}

function activatePrincipalStorage(principalId: string | null): void {
  flushDebugEvents();
  setPrincipalStorageNamespace(principalId);
  hydrateDebugEventsFromStorage();
}

export default function App() {
  const initialAuthCheck = useRef(true);
  const startupRecoveryRendered = useRef(false);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [openAccess, setOpenAccess] = useState(false);
  const [startupFailure, setStartupFailure] = useState<AuthStatus["startupFailure"]>();
  const [startupTimingVisible, setStartupTimingVisible] = useState(false);
  const [startupTimeoutElapsedMs, setStartupTimeoutElapsedMs] = useState<number | null>(null);
  const [startupRecoveryElapsedMs, setStartupRecoveryElapsedMs] = useState<number | null>(null);
  const [principal, setPrincipal] = useState<AgentConsolePrincipal | null>(null);
  const [machines, setMachines] = useState<string[]>([]);
  const [view, setView] = useState<View>({ kind: "dashboard" });
  const closeOverlay = useCallback(() => setView({ kind: "dashboard" }), []);
  const openShell = useCallback(() => setView({ kind: "shell" }), []);
  const openUsage = useCallback((anchor?: HTMLElement) => {
    if (!principal?.permissions.includes("usage")) return;
    if (!anchor) {
      setView({ kind: "usage" });
      return;
    }
    const rect = anchor.getBoundingClientRect();
    setView({ kind: "usage", anchor: { element: anchor, center: rect.left + rect.width / 2, bottom: rect.bottom } });
  }, [principal]);
  const usageAnchor = view.kind === "usage" ? view.anchor?.element : undefined;
  useEffect(() => {
    if (!usageAnchor) return;
    const update = () => {
      if (!usageAnchor.isConnected) return;
      const rect = usageAnchor.getBoundingClientRect();
      setView((current) => {
        if (current.kind !== "usage" || current.anchor?.element !== usageAnchor) return current;
        const center = rect.left + rect.width / 2;
        if (current.anchor.center === center && current.anchor.bottom === rect.bottom) return current;
        return { ...current, anchor: { element: usageAnchor, center, bottom: rect.bottom } };
      });
    };
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(usageAnchor);
    const positionObserver = typeof MutationObserver === "function" ? new MutationObserver(update) : null;
    positionObserver?.observe(usageAnchor, { attributes: true, attributeFilter: ["style"] });
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
      positionObserver?.disconnect();
    };
  }, [usageAnchor]);
  const shellOpen = view.kind === "shell";
  useEffect(() => {
    if (!authed) return;
    const handle = (event: KeyboardEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      const terminal = Boolean(element?.closest(".terminal-pane"));
      // A second press closes the Shell in the macOS app only.
      const closeShell = shellOpen && isMacTauri();
      const editable = !terminal && Boolean(element?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'));
      // Modal editors/confirmations take priority even when a terminal is under them.
      if (document.querySelector('.modal-backdrop, .modal-overlay')) return;
      if (resolveDashboardShortcutAction({ key:event.key, code:event.code, metaKey:event.metaKey,
        ctrlKey:event.ctrlKey, shiftKey:event.shiftKey, altKey:event.altKey,
        isMacTauri:false, editableTarget:editable && !closeShell }) !== "shell") return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (closeShell) closeOverlay(); else openShell();
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [authed, closeOverlay, openShell, shellOpen]);

  const [hostMigrationNotice, setHostMigrationNotice] = useState(false);
  // Host color defaults come from the distribution's extensions (#918).
  const { machineColorDefaults } = useUiExtensions();
  const [machineColors, setMachineColors] = useState<MachineColorMap>(() => loadMachineColors(undefined, machineColorDefaults));
  const [defaultAutoResume, setDefaultAutoResume] = useState(() => loadDefaultAutoResume());
  const [attentionAlerts, setAttentionAlerts] = useState(() => loadAttentionAlerts());
  const [phoneSessionOpen, setPhoneSessionOpen] = useState<SessionListDisplay>(() => loadPhoneSessionOpen());
  const [phoneFocusCounts, setPhoneFocusCounts] = useState(() => loadPhoneFocusCounts());
  const [cardPreview, setCardPreview] = useState<CardPreview>(() => loadCardPreview());
  const [sessionListDisplay, setSessionListDisplay] = useState<SessionListDisplay>(() => loadSessionListDisplay());
  const [androidLayout, setAndroidLayout] = useState<AndroidLayout>(() => loadAndroidLayout());
  const [terminalRenderMode, setTerminalRenderMode] = useState<TerminalRenderMode>(() => loadTerminalRenderMode());
  const [terminalSelectedPaneRealtime, setTerminalSelectedPaneRealtime] = useState(
    () => loadTerminalSelectedPaneRealtime(),
  );
  const enabledMachines = useMemo(
    () => resolveEnabledMachines(machines),
    [machines],
  );
  const dismissHostMigrationNotice = useCallback(() => {
    acknowledgeHostVisibilityMigration();
    setHostMigrationNotice(false);
  }, []);
  const updateMachineColor = useCallback((name: string, color: string) => {
    setMachineColors((prev) => {
      const next = setMachineColor(prev, name, color, machineColorDefaults);
      saveMachineColors(next, undefined, machineColorDefaults);
      return next;
    });
  }, [machineColorDefaults]);
  const resetMachineColorOverride = useCallback((name: string) => {
    setMachineColors((prev) => {
      const next = resetMachineColor(prev, name, machineColorDefaults);
      saveMachineColors(next, undefined, machineColorDefaults);
      return next;
    });
  }, [machineColorDefaults]);
  const updateDefaultAutoResume = useCallback((enabled: boolean) => {
    if (saveDefaultAutoResume(enabled)) {
      setDefaultAutoResume(enabled);
    }
  }, []);
  const updateAttentionAlerts = useCallback((enabled: boolean) => {
    if (saveAttentionAlerts(enabled)) {
      setAttentionAlerts(enabled);
      // Still inside the switch's click, so the browser accepts the prompt.
      if (enabled) void requestBrowserNotificationPermission();
    }
  }, []);
  const updateAndroidLayout = useCallback((layout: AndroidLayout) => {
    if (saveAndroidLayout(layout)) setAndroidLayout(layout);
  }, []);
  const updateTerminalRenderMode = useCallback((mode: TerminalRenderMode) => {
    if (saveTerminalRenderMode(mode)) {
      setTerminalRenderMode(mode);
    }
  }, []);
  const updatePhoneSessionOpen = useCallback((display: SessionListDisplay) => {
    if (savePhoneSessionOpen(display)) setPhoneSessionOpen(display);
  }, []);
  const updatePhoneFocusCounts = useCallback((shown: boolean) => {
    if (savePhoneFocusCounts(shown)) setPhoneFocusCounts(shown);
  }, []);
  const updateCardPreview = useCallback((preview: CardPreview) => {
    if (saveCardPreview(preview)) setCardPreview(preview);
  }, []);
  const updateSessionListDisplay = useCallback((display: SessionListDisplay) => {
    if (saveSessionListDisplay(display)) setSessionListDisplay(display);
  }, []);
  const updateTerminalSelectedPaneRealtime = useCallback((enabled: boolean) => {
    if (saveTerminalSelectedPaneRealtime(enabled)) {
      setTerminalSelectedPaneRealtime(enabled);
    }
  }, []);

  useEffect(() => {
    setTerminalPerformancePreferences(terminalRenderMode, terminalSelectedPaneRealtime);
  }, [terminalRenderMode, terminalSelectedPaneRealtime]);

  const loadMachines = useCallback(async () => {
    setMachines(await listMachineNames().catch(() => []));
  }, []);

  const recheck = useCallback(async (): Promise<ConnectFailure | undefined> => {
    // On device without a server URL + token, no request can succeed yet.
    const initialStartup = initialAuthCheck.current;
    initialAuthCheck.current = false;
    setStartupFailure(undefined);
    if (!initialStartup) {
      setStartupTimeoutElapsedMs(null);
      setStartupRecoveryElapsedMs(null);
      setStartupTimingVisible(false);
      startupRecoveryRendered.current = false;
    }
    if (needsDeviceConfig()) {
      activatePrincipalStorage(null);
      setPrincipal(null);
      setAuthed(false);
      return undefined;
    }
    const status = await runStartupAuthCheck({
      initialStartup,
      deadlineMs: initialStartup && isAndroidTauri() ? ANDROID_STARTUP_RECOVERY_DEADLINE_MS : undefined,
      elapsedMs: appBootElapsedMs(),
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: handle => window.clearTimeout(handle as number),
      read: () => getAuthStatus({ initialStartup }),
      onTimeout: () => {
        activatePrincipalStorage(null);
        const elapsedMs = Math.round(appBootElapsedMs());
        setStartupTimeoutElapsedMs(elapsedMs);
        setStartupTimingVisible(true);
        setStartupFailure("timeout");
        setAuthed(false);
        recordDebugEvent({
          source: "client", method: "GET", route: "/startup/timeout-fired",
          ok: false, duration_ms: elapsedMs, error: "Android startup recovery deadline fired",
        });
      },
    });
    if (status === null) return undefined;
    // Only the first check on app start speaks of startup; later checks report
    // their outcome to the caller.
    setStartupFailure(initialStartup ? status.startupFailure : undefined);
    activatePrincipalStorage(status.principal?.id ?? null);
    setPrincipal(status.principal);
    setAuthed(status.authenticated);
    setOpenAccess(status.openAccess);
    if (status.authenticated) {
      setHostMigrationNotice(hostVisibilityMigrationPending());
      setMachineColors(loadMachineColors(undefined, machineColorDefaults));
      setDefaultAutoResume(loadDefaultAutoResume());
      setAttentionAlerts(loadAttentionAlerts());
      setSessionListDisplay(loadSessionListDisplay());
      setCardPreview(loadCardPreview());
      setPhoneSessionOpen(loadPhoneSessionOpen());
      setPhoneFocusCounts(loadPhoneFocusCounts());
      setAndroidLayout(loadAndroidLayout());
      setTerminalRenderMode(loadTerminalRenderMode());
      setTerminalSelectedPaneRealtime(loadTerminalSelectedPaneRealtime());
      void loadMachines();
    }
    return status.authenticated ? undefined : status.connectFailure;
  }, [loadMachines]);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  useLayoutEffect(() => {
    if (authed !== false || startupFailure !== "timeout" || !startupTimingVisible || !isAndroidTauri() || startupRecoveryRendered.current) return;
    startupRecoveryRendered.current = true;
    const rendered = () => {
      const elapsedMs = Math.round(appBootElapsedMs());
      setStartupRecoveryElapsedMs(elapsedMs);
      recordDebugEvent({
        source: "client", method: "GET", route: "/startup/recovery-rendered",
        ok: true, duration_ms: elapsedMs, error: null,
      });
    };
    const frame = window.requestAnimationFrame(rendered);
    return () => window.cancelAnimationFrame(frame);
  }, [authed, startupFailure, startupTimingVisible]);

  const onSignedIn = () => {
    void recheck();
  };

  const onSignedOut = () => {
    activatePrincipalStorage(null);
    setPrincipal(null);
    setAuthed(false);
    setView({ kind: "dashboard" });
  };

  if (authed === null) {
    return <div className="boot">…</div>;
  }
  // On device, connection settings (server URL + token) stand in for browser login.
  if (!authed && isTauri()) {
    return (
      <Settings
        variant="connect"
        startupFailure={startupFailure}
        startupTimeoutElapsedMs={startupTimeoutElapsedMs}
        startupRecoveryElapsedMs={startupRecoveryElapsedMs}
        machines={machines}
        machineColors={machineColors}
        defaultAutoResume={defaultAutoResume}
        attentionAlerts={attentionAlerts}
        phoneSessionOpen={phoneSessionOpen}
        phoneFocusCounts={phoneFocusCounts}
        sessionListDisplay={sessionListDisplay}
        cardPreview={cardPreview}
        onPhoneSessionOpenChange={updatePhoneSessionOpen}
        onPhoneFocusCountsChange={updatePhoneFocusCounts}
        onSessionListDisplayChange={updateSessionListDisplay}
        onCardPreviewChange={updateCardPreview}
        terminalRenderMode={terminalRenderMode}
        terminalSelectedPaneRealtime={terminalSelectedPaneRealtime}
        onMachineColorChange={updateMachineColor}
        onMachineColorReset={resetMachineColorOverride}
        onDefaultAutoResumeChange={updateDefaultAutoResume}
        onAttentionAlertsChange={updateAttentionAlerts}
        onTerminalRenderModeChange={updateTerminalRenderMode}
        onTerminalSelectedPaneRealtimeChange={updateTerminalSelectedPaneRealtime}
        openAccess={openAccess}
        onSignedOut={onSignedOut}
        onSaved={() => {
          setView({ kind: "dashboard" });
          return recheck();
        }}
        onCancel={undefined}
      />
    );
  }
  if (!authed) {
    return <Login onSignedIn={onSignedIn} />;
  }

  const dashboardActive = view.kind === "dashboard";
  const permissions = new Set(principal?.permissions ?? []);
  const operatorCapabilities = {
    debug: permissions.has("debug"),
    usage: permissions.has("usage"),
  };

  const shell = (
    <div className={`app-shell ${dashboardActive ? "" : "has-overlay"}`}>
    <div className={`app-dashboard-layer ${dashboardActive ? "" : "is-backgrounded"}`}>
      <Dashboard
        key={principal?.id ?? "anonymous"}
        active={dashboardActive}
        machines={machines}
        enabledMachines={enabledMachines}
        hostMigrationNotice={hostMigrationNotice}
        onDismissHostMigration={dismissHostMigrationNotice}
        defaultCreateMachine={principal?.defaultCreateMachine}
        machineColors={machineColors}
        defaultAutoResume={defaultAutoResume}
        attentionAlerts={attentionAlerts}
        phoneSessionOpen={phoneSessionOpen}
        phoneFocusCounts={phoneFocusCounts}
        sessionListDisplay={sessionListDisplay}
        cardPreview={cardPreview}
        androidLayout={androidLayout}
        terminalRenderMode={terminalRenderMode}
        terminalSelectedPaneRealtime={terminalSelectedPaneRealtime}
        operatorCapabilities={operatorCapabilities}
        onDebug={() => operatorCapabilities.debug && setView({ kind: "debug" })}
        onUsage={openUsage}
        onSettings={() => setView({ kind: "settings" })}
        onShell={openShell}
      />
    </div>
    {view.kind === "shell" ? (
      <div className="app-overlay">
        <ShellPage key={principal?.id ?? "anonymous"} machines={machines} onExit={closeOverlay} />
      </div>
    ) : null}
    {view.kind === "usage" && operatorCapabilities.usage ? (
      <Modal
        className={`page-overlay ${view.anchor ? "usage-anchored" : ""}`}
        backdropClassName={view.anchor ? "usage-anchored-backdrop" : "app-overlay"}
        androidBackEntry="secondary-panel"
        onClose={closeOverlay}
        lightDismiss={!!view.anchor}
        ariaLabel={overlayLabel(view)}
        style={view.anchor ? {
          "--usage-anchor-center": `${view.anchor.center}px`,
          "--usage-anchor-bottom": `${view.anchor.bottom}px`,
        } as CSSProperties : undefined}
      >
        <UsagePanel
          onExit={closeOverlay}
          canResetRateLimits={permissions.has("codex_reset")}
        />
      </Modal>
    ) : null}
    {view.kind === "debug" && operatorCapabilities.debug ? (
      <Modal className="page-overlay" backdropClassName="app-overlay" androidBackEntry="secondary-panel" onClose={closeOverlay} ariaLabel={overlayLabel(view)}>
        <DebugPanel onExit={closeOverlay} />
      </Modal>
    ) : null}
    {view.kind === "settings" ? (
      <Modal className="page-overlay" backdropClassName="app-overlay" androidBackEntry="secondary-panel" onClose={closeOverlay} ariaLabel={overlayLabel(view)}>
        <Settings
          variant="manage"
          onHostPreferenceMigrationDone={dismissHostMigrationNotice}
          machines={machines}
          machineColors={machineColors}
          defaultAutoResume={defaultAutoResume}
          attentionAlerts={attentionAlerts}
          phoneSessionOpen={phoneSessionOpen}
          phoneFocusCounts={phoneFocusCounts}
          sessionListDisplay={sessionListDisplay}
          cardPreview={cardPreview}
          androidLayout={androidLayout}
          onAndroidLayoutChange={updateAndroidLayout}
          onPhoneSessionOpenChange={updatePhoneSessionOpen}
          onPhoneFocusCountsChange={updatePhoneFocusCounts}
          onSessionListDisplayChange={updateSessionListDisplay}
          onCardPreviewChange={updateCardPreview}
          terminalRenderMode={terminalRenderMode}
          terminalSelectedPaneRealtime={terminalSelectedPaneRealtime}
          onMachineColorChange={updateMachineColor}
          onMachineColorReset={resetMachineColorOverride}
          onDefaultAutoResumeChange={updateDefaultAutoResume}
          onAttentionAlertsChange={updateAttentionAlerts}
          onTerminalRenderModeChange={updateTerminalRenderMode}
          onTerminalSelectedPaneRealtimeChange={updateTerminalSelectedPaneRealtime}
          openAccess={openAccess}
          onSignedOut={onSignedOut}
          onSaved={() => {
            closeOverlay();
            void recheck();
          }}
          onCancel={closeOverlay}
        />
      </Modal>
    ) : null}
    </div>
  );

  return <ExtensionAppProviders permissions={permissions}>{shell}</ExtensionAppProviders>;
}

import { useUiExtensions } from "./extensions.tsx";
import { FilterDisclosure } from "./FilterDisclosure.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchEdgeDebugEvents,
  fetchSessionRetitleReceipts,
  runDebugDiagnostics,
  type DebugDiagnosticResult,
  type DebugEvent,
  type SessionRetitleV3Receipts,
} from "./api.ts";
import { AsyncButton } from "./AsyncButton.tsx";
import { createDebugAgentBundle, debugAgentBundleMarkdown } from "./debugBundle.ts";
import {
  DEBUG_FILTER_ALL,
  EMPTY_DEBUG_FILTER,
  debugRouteFamilies,
  debugSessionKey,
  debugSessionKeys,
  describeDebugFilter,
  filterDebugEvents,
  isDebugFilterActive,
  splitDebugSessionKey,
  type DebugFilter,
  type DebugOutcomeFilter,
  type DebugSourceFilter,
} from "./debugFilter.ts";
import {
  clearDebugEvents,
  debugEvents,
  debugLifecycleSuffix,
  subscribeDebugEvents,
} from "./debugLog.ts";
import {
  createPerformanceSummary,
  loadPerformanceCapture,
  startPerformanceCapture,
  stopPerformanceCapture,
  type PerformanceScenario,
} from "./performanceSummary.ts";

export interface DebugPanelProps {
  readonly onExit: () => void;
}

function eventKey(event: DebugEvent): string {
  return `${event.source}:${event.seq}:${event.at}`;
}

function statusLabel(event: DebugEvent): string {
  if (event.status === null) return event.ok === false ? "fail" : "-";
  return String(event.status);
}

async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("clipboard unavailable");
  }
  await navigator.clipboard.writeText(text);
}

interface ReceiptsState {
  readonly key: string;
  readonly supported: boolean;
  readonly receipts: SessionRetitleV3Receipts | null;
}

export function DebugPanel({ onExit }: DebugPanelProps) {
  const { diagnosticProbes } = useUiExtensions();
  const [clientEvents, setClientEvents] = useState<readonly DebugEvent[]>(() => debugEvents());
  const [edgeEvents, setEdgeEvents] = useState<readonly DebugEvent[]>([]);
  const [diagnostics, setDiagnostics] = useState<DebugDiagnosticResult | null>(null);
  const [filter, setFilter] = useState<DebugFilter>(EMPTY_DEBUG_FILTER);
  const [status, setStatus] = useState<string>("");
  const [diagnosticsRunning, setDiagnosticsRunning] = useState(false);
  const [receipts, setReceipts] = useState<ReceiptsState | null>(null);
  const [capture, setCapture] = useState(() => loadPerformanceCapture());
  const [scenario, setScenario] = useState<PerformanceScenario>(() => capture?.scenario ?? "normal");

  useEffect(() => subscribeDebugEvents(setClientEvents), []);

  const refreshEdge = useCallback(async () => {
    try {
      const result = await fetchEdgeDebugEvents();
      setEdgeEvents(result.events);
      setStatus(
        result.max_signal_events === undefined
          ? `edge ${result.events.length}/${result.max_events}`
          : `edge ${result.events.length}/${result.max_events}+${result.max_signal_events}`,
      );
    } catch (err) {
      setStatus((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshEdge();
  }, [refreshEdge]);

  const all = useMemo(() => {
    const byKey = new Map<string, DebugEvent>();
    for (const event of [...edgeEvents, ...clientEvents]) {
      byKey.set(eventKey(event), event);
    }
    return [...byKey.values()].sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq);
  }, [clientEvents, edgeEvents]);

  const merged = useMemo(() => filterDebugEvents(all, filter), [all, filter]);
  const families = useMemo(() => debugRouteFamilies(all), [all]);
  const sessionKeys = useMemo(() => debugSessionKeys(all), [all]);
  const filterActive = isDebugFilterActive(filter);

  // The copy actions export exactly what the list is showing. A bundle pasted
  // into an agent conversation is usually about one failure, and an unfiltered
  // export buries it in successful polling.
  const agentBundle = useMemo(
    () =>
      createDebugAgentBundle({
        clientEvents: filterDebugEvents(clientEvents, filter),
        edgeEvents: filterDebugEvents(edgeEvents, filter),
        diagnostics,
        filter: describeDebugFilter(filter),
        ...(receipts?.receipts ? { retitleReceipts: receipts.receipts } : {}),
      }),
    [clientEvents, diagnostics, edgeEvents, filter, receipts],
  );

  const bundleJson = useMemo(() => JSON.stringify(agentBundle, null, 2), [agentBundle]);

  const runDiagnostics = async () => {
    setDiagnosticsRunning(true);
    setStatus("running diagnostics");
    try {
      const result = await runDebugDiagnostics(diagnosticProbes);
      setDiagnostics(result);
      await refreshEdge();
      setStatus(result.ok ? "diagnostics pass" : "diagnostics found failures");
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setDiagnosticsRunning(false);
    }
  };

  const copyBundle = async (kind: "agent" | "json") => {
    const text = kind === "json" ? bundleJson : debugAgentBundleMarkdown(agentBundle);
    try {
      await copyText(text);
      const scope = filterActive ? " (filtered)" : "";
      setStatus(kind === "json" ? `copied JSON${scope}` : `copied agent bundle${scope}`);
    } catch (err) {
      setStatus((err as Error).message);
    }
  };

  const clearLocal = () => {
    clearDebugEvents();
    setStatus("local cleared");
  };

  const startCapture = () => {
    const started = startPerformanceCapture(scenario);
    setCapture(started);
    setStatus(started ? "performance capture started (up to 30 minutes)" : "local storage unavailable");
  };

  const copyPerformanceSummary = async () => {
    const active = loadPerformanceCapture();
    if (!active) {
      setCapture(null);
      setStatus("performance capture expired; start a new one");
      return;
    }
    const summary = createPerformanceSummary({
      capture: active,
      app: agentBundle.app,
      events: debugEvents(),
    });
    try {
      await copyText(JSON.stringify(summary, null, 2));
      setStatus("copied performance summary");
    } catch (err) {
      setStatus((err as Error).message);
    }
  };

  const stopCapture = () => {
    stopPerformanceCapture();
    setCapture(null);
    setStatus("performance capture stopped");
  };

  const loadReceipts = async (key: string) => {
    const target = splitDebugSessionKey(key);
    if (!target) {
      setStatus("select a machine-scoped session first");
      return;
    }
    try {
      const result = await fetchSessionRetitleReceipts(target.machine, target.sessionId);
      setReceipts({ key, supported: result.supported, receipts: result.receipts });
      setStatus(
        result.supported
          ? `receipts ${result.receipts?.receipts.length ?? 0}`
          : "host runtime does not expose retitle receipts",
      );
    } catch (err) {
      setReceipts(null);
      setStatus((err as Error).message);
    }
  };

  const receiptSession = filter.session !== DEBUG_FILTER_ALL ? filter.session : null;

  return (
    <div className="dash debug-panel">
      <header className="dash-head">
        <button className="btn ghost" onClick={onExit} aria-label="Back to dashboard">
          Back
        </button>
        <h1>Debug</h1>
        <AsyncButton className="btn" onClick={() => refreshEdge()}>
          Refresh
        </AsyncButton>
      </header>

      <FilterDisclosure id="debug-filters" summary={describeDebugFilter(filter) ?? "All events"} className="debug-filter-panel">
        <div className="debug-toolbar debug-filters">
          <select
            value={filter.source}
            onChange={(event) => setFilter({ ...filter, source: event.target.value as DebugSourceFilter })}
            aria-label="Debug source"
          >
            <option value="all">all sources</option>
            <option value="client">client</option>
            <option value="edge">edge</option>
            <option value="daemon">daemon</option>
            <option value="ws">ws</option>
          </select>
          <select
            value={filter.family}
            onChange={(event) => setFilter({ ...filter, family: event.target.value })}
            aria-label="Debug route"
          >
            <option value={DEBUG_FILTER_ALL}>all routes</option>
            {families.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
          </select>
          <select
            value={filter.outcome}
            onChange={(event) => setFilter({ ...filter, outcome: event.target.value as DebugOutcomeFilter })}
            aria-label="Debug outcome"
          >
            <option value="all">all outcomes</option>
            <option value="signal">failures and lifecycle</option>
            <option value="failures">failures</option>
            <option value="lifecycle">lifecycle</option>
          </select>
          <select
            value={filter.session}
            onChange={(event) => setFilter({ ...filter, session: event.target.value })}
            aria-label="Debug session"
          >
            <option value={DEBUG_FILTER_ALL}>all sessions</option>
            {sessionKeys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
          <input
            className="debug-search"
            type="search"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            value={filter.text}
            placeholder="find text"
            onChange={(event) => setFilter({ ...filter, text: event.target.value })}
            aria-label="Debug search"
          />
          {filterActive ? (
            <button className="btn ghost" onClick={() => setFilter(EMPTY_DEBUG_FILTER)}>
              Clear Filters
            </button>
          ) : null}
        </div>
      </FilterDisclosure>
      <div className="debug-body">
        <div className="debug-toolbar">
          <button className="btn ghost" onClick={() => void copyBundle("json")}>
            Copy JSON
          </button>
          <button className="btn ghost" onClick={() => void copyBundle("agent")}>
            Copy Agent Bundle
          </button>
          <AsyncButton className="btn ghost" pending={diagnosticsRunning} onClick={() => void runDiagnostics()}>
            Run Diagnostics
          </AsyncButton>
          <button className="btn ghost" onClick={clearLocal}>
            Clear Local
          </button>
          <span className="debug-status" role="status">
            {status || (filterActive ? `${merged.length}/${all.length} events` : `${merged.length} events`)}
          </span>
        </div>

        <section className="debug-performance" aria-label="Performance capture">
          <strong>Performance capture</strong>
          <select
            aria-label="Performance scenario"
            value={scenario}
            disabled={capture !== null}
            onChange={(event) => setScenario(event.target.value as PerformanceScenario)}
          >
            <option value="normal">Normal network</option>
            <option value="slow-network">Slow network</option>
            <option value="offline-recovery">Offline recovery</option>
          </select>
          {capture ? (
            <>
              <span className="debug-receipts-hint">Started {new Date(capture.started_at).toLocaleTimeString()}</span>
              <button className="btn ghost" onClick={() => void copyPerformanceSummary()}>Copy Summary JSON</button>
              <button className="btn ghost" onClick={stopCapture}>Stop</button>
            </>
          ) : (
            <button className="btn ghost" onClick={startCapture}>Start Capture</button>
          )}
        </section>

        {diagnostics ? (
          <section className="debug-diagnostics" aria-label="Debug diagnostics">
            <div className="debug-diagnostics-head">
              <strong>Diagnostics</strong>
              <span className={diagnostics.ok ? "debug-diag-ok" : "debug-diag-fail"}>
                {diagnostics.ok ? "pass" : "fail"}
              </span>
              <span>{new Date(diagnostics.generated_at).toLocaleTimeString()}</span>
            </div>
            <ol className="debug-diagnostic-list">
              {diagnostics.probes.map((probe) => (
                <li key={`${probe.name}:${probe.request_id}`} className={probe.ok ? "debug-diagnostic" : "debug-diagnostic is-error"}>
                  <span>{probe.name}</span>
                  <span>{probe.route}</span>
                  <span>{probe.status ?? "-"}</span>
                  <span>{probe.duration_ms ?? "-"}ms</span>
                  {probe.version ? <span>v{probe.version}</span> : null}
                  {probe.error ? <span className="debug-error">{probe.error}</span> : null}
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <section className="debug-receipts" aria-label="Retitle receipts">
          <div className="debug-receipts-head">
            <strong>Retitle receipts</strong>
            {receiptSession ? (
              <AsyncButton className="btn ghost" onClick={() => loadReceipts(receiptSession)}>
                Load
              </AsyncButton>
            ) : (
              <span className="debug-receipts-hint">Pick a session above to read the host&apos;s own receipts.</span>
            )}
          </div>
          {receipts && receipts.key === receiptSession ? (
            receipts.supported && receipts.receipts ? (
              <ol className="debug-receipt-list">
                {receipts.receipts.receipts.map((receipt) => (
                  <li
                    key={receipt.operation_hash}
                    className={`debug-receipt ${receipt.outcome === "committed" || receipt.outcome === "unchanged" ? "" : "is-error"}`}
                  >
                    <div className="debug-event-main">
                      <span className="debug-method">{receipt.trigger}</span>
                      <span className="debug-route">{receipt.outcome ?? receipt.state}</span>
                      <span className="debug-status-code">{receipt.duration_bucket}</span>
                    </div>
                    <div className="debug-event-meta">
                      <span>{new Date(receipt.started_at).toLocaleTimeString()}</span>
                      <span>rev {receipt.admission_fence.title_revision}→{receipt.result_fence?.title_revision ?? "-"}</span>
                      <span>memory {receipt.admission_fence.memory_revision}→{receipt.result_fence?.memory_revision ?? "-"}</span>
                      {receipt.result_is_current ? <span>current</span> : null}
                      {receipt.execution_claim_held ? <span>claim held</span> : null}
                      {receipt.failure_class ? <span className="debug-error">{receipt.failure_class}</span> : null}
                      {receipt.failure_stage ? <span className="debug-error">stage {receipt.failure_stage}</span> : null}
                      {receipt.provider_attempts.map((attempt, index) => (
                        <span key={`${receipt.operation_hash}:${index}`}>
                          {attempt.provider_kind} {attempt.outcome}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="debug-receipts-hint">
                This host&apos;s runtime does not expose retitle receipts yet.
              </p>
            )
          ) : null}
        </section>

        <ol className="debug-events">
          {merged.map((event) => {
            const detail = debugLifecycleSuffix(event).trim();
            const sessionKey = debugSessionKey(event);
            return (
              <li key={eventKey(event)} className={`debug-event ${event.ok === false ? "is-error" : ""}`}>
                <div className="debug-event-main">
                  <span className={`debug-source ${event.source}`}>{event.source}</span>
                  <span className="debug-method">{event.method ?? "-"}</span>
                  <span className="debug-route">{event.route}</span>
                  <span className="debug-status-code">{statusLabel(event)}</span>
                </div>
                <div className="debug-event-meta">
                  <span>{new Date(event.at).toLocaleTimeString()}</span>
                  {event.duration_ms !== null ? <span>{event.duration_ms}ms</span> : null}
                  {event.request_id ? <span>{event.request_id}</span> : null}
                  {event.machine ? <span>{event.machine}</span> : null}
                  {sessionKey ? (
                    <button
                      className="control-reference debug-session-link"
                      onClick={() => setFilter({ ...filter, session: sessionKey })}
                      title="Filter to this session"
                    >
                      {event.session_id}
                    </button>
                  ) : null}
                  {detail ? <span className="debug-detail">{detail}</span> : null}
                  {event.error ? <span className="debug-error">{event.error}</span> : null}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

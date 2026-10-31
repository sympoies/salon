import { useEffect, useState } from "react";
import type { SpeechEngineList, SpeechProviderSummary } from "@agent-console/shared/speech";
import { getSpeechEngines, getSpeechProviders } from "./api.ts";
import { loadSpeechEngine, saveSpeechEngine } from "./speechEngine.ts";

interface ProviderEngines {
  readonly provider: SpeechProviderSummary;
  readonly list: SpeechEngineList;
}

/** Per-device speech engine choice for each service; services without an engine list are hidden. */
export function SpeechEngineSettings() {
  const [rows, setRows] = useState<readonly ProviderEngines[]>([]);
  const [selected, setSelected] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const providers = await getSpeechProviders();
        const found = (await Promise.all(providers.map(async (provider) => {
          const list = await getSpeechEngines(provider.id).catch(() => null);
          return list ? { provider, list } : null;
        }))).filter((row): row is ProviderEngines => row !== null);
        if (!alive) return;
        const chosen: Record<string, string> = {};
        for (const { provider, list } of found) {
          const stored = loadSpeechEngine(provider.id);
          if (stored && list.engines.some((engine) => engine.id === stored)) chosen[provider.id] = stored;
          else if (stored) saveSpeechEngine(provider.id, null);
        }
        setSelected(chosen);
        setRows(found);
      } catch { /* no speech service: nothing to choose */ }
    })();
    return () => { alive = false; };
  }, []);
  if (rows.length === 0) return null;
  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Speech engine</h2>
      <p className="settings-hint">Used for voice prompts on this device.</p>
      {rows.map(({ provider, list }) => {
        const fallback = list.engines.find((engine) => engine.id === list.default);
        const name = rows.length > 1 ? `Speech engine (${provider.label})` : "Speech engine";
        return (
          <label key={provider.id}>
            {rows.length > 1 ? provider.label : "Engine"}
            <select
              aria-label={name}
              value={selected[provider.id] ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setSelected((current) => ({ ...current, [provider.id]: value }));
                saveSpeechEngine(provider.id, value || null);
              }}
            >
              <option value="">Default{fallback ? ` (${fallback.label})` : ""}</option>
              {list.engines.map((engine) => (
                <option key={engine.id} value={engine.id} disabled={!engine.available}>
                  {engine.label}{engine.available ? "" : " (unavailable)"}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </section>
  );
}

import { useEffect, useState } from "react";
import type { SpeechEngineList } from "@agent-console/shared/speech";
import { getSpeechEngines, getSpeechProviders } from "./api.ts";
import { loadSpeechEngine, saveSpeechEngine } from "./speechEngine.ts";

/** Per-device speech engine choice; hidden when the speech server offers no engine list. */
export function SpeechEngineSettings() {
  const [list, setList] = useState<SpeechEngineList | null>(null);
  const [selected, setSelected] = useState<string>(() => loadSpeechEngine() ?? "");
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        for (const provider of await getSpeechProviders()) {
          const engines = await getSpeechEngines(provider.id).catch(() => null);
          if (!alive) return;
          if (engines) {
            setList(engines);
            if (!engines.engines.some((engine) => engine.id === loadSpeechEngine())) {
              saveSpeechEngine(null);
              setSelected("");
            }
            return;
          }
        }
      } catch { /* no speech service: nothing to choose */ }
    })();
    return () => { alive = false; };
  }, []);
  if (!list) return null;
  const fallback = list.engines.find((engine) => engine.id === list.default);
  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Speech engine</h2>
      <p className="settings-hint">Used for voice prompts on this device.</p>
      <label>
        Engine
        <select
          aria-label="Speech engine"
          value={selected}
          onChange={(event) => {
            const value = event.target.value;
            setSelected(value);
            saveSpeechEngine(value || null);
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
    </section>
  );
}

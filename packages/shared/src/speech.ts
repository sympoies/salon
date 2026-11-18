export interface SpeechProviderSummary {
  readonly id: string;
  readonly label: string;
  readonly max_duration_seconds: number;
  readonly max_bytes: number;
  readonly synthesis?: SpeechSynthesisCapabilities;
}

export interface SpeechSynthesisVoice {
  readonly id: string;
  readonly label?: string;
}

export interface SpeechSynthesisCapabilities {
  readonly voices: readonly SpeechSynthesisVoice[];
  readonly default_voice: string;
  readonly formats: readonly "pcm_s16le"[];
  readonly sample_rates: readonly number[];
  readonly channels: 1;
  readonly max_text_length: number;
  readonly max_duration_seconds: number;
  readonly max_bytes: number;
}

export interface SpeechTranscription {
  readonly text: string;
  readonly language: string | null;
  readonly provider: string;
  /** The engine that answered; null when the server does not report one. */
  readonly engine: string | null;
  /** Server-provided text naming what produced the transcript; shown verbatim, null when absent. */
  readonly label: string | null;
}

export interface SpeechEngine {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
}

export interface SpeechEngineList {
  readonly engines: readonly SpeechEngine[];
  readonly default: string;
}

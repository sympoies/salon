export interface SpeechProviderSummary {
  readonly id: string;
  readonly label: string;
  readonly max_duration_seconds: number;
  readonly max_bytes: number;
}

export interface SpeechTranscription {
  readonly text: string;
  readonly language: string | null;
  readonly provider: string;
}

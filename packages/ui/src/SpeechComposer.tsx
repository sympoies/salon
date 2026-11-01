import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { SpeechProviderSummary } from "@agent-console/shared/speech";
import { getSpeechEngines, getSpeechProviders, submitSessionPrompt, transcribeSpeechAudio } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { useShortcutClose } from "./useShortcutClose.ts";
import { isAndroidTauri } from "./runtime.ts";
import { loadSpeechEngine } from "./speechEngine.ts";
import { quoteVoiceTranscript } from "./voicePrompt.ts";

const UNKNOWN_PROMPT_OUTCOME = "The prompt may have been sent. A busy session shows it as a queued message; check the session before trying again.";

type Phase = "ready" | "starting" | "recording" | "transcribing" | "review" | "sending";
interface ActiveRecording {
  readonly recorder: MediaRecorder;
  readonly stream: MediaStream;
  readonly interval: ReturnType<typeof setInterval>;
}

function recordingMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"]
    .find((type) => MediaRecorder.isTypeSupported(type));
}

export function SpeechComposer({ machine, id, sessionIncarnation, onBeforeOpen, openRequestToken = 0, showTrigger = true, targetLabel, onTranscript, onSendTranscript, onOpenChange }: {
  readonly machine: string;
  readonly id: string;
  readonly sessionIncarnation: string;
  readonly onBeforeOpen: () => void;
  readonly openRequestToken?: number;
  readonly showTrigger?: boolean;
  readonly targetLabel?: string;
  /** Fill a caller-owned draft for editing instead of sending it. */
  readonly onTranscript?: (text: string) => void;
  /** Send through a caller-owned reply path that also retains failed drafts. */
  readonly onSendTranscript?: (text: string, expectedSessionIncarnation: string) => Promise<boolean>;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<readonly SpeechProviderSummary[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [phase, setPhase] = useState<Phase>("ready");
  const [seconds, setSeconds] = useState(0);
  const [text, setText] = useState("");
  const [replyRetained, setReplyRetained] = useState(false);
  const [language, setLanguage] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [answeredBy, setAnsweredBy] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const retained = useRef<Blob | null>(null);
  const active = useRef<ActiveRecording | null>(null);
  const starting = useRef<number | null>(null);
  const transcription = useRef<AbortController | null>(null);
  const attempt = useRef(0);
  const draftIncarnation = useRef(sessionIncarnation);
  const openRef = useRef(false);
  const generation = useRef(0);
  const previousOpenRequestToken = useRef(0);
  useEffect(() => { onOpenChange?.(open); }, [onOpenChange, open]);

  const stopTracks = () => {
    const current = active.current;
    if (!current) return;
    clearInterval(current.interval);
    current.stream.getTracks().forEach((track) => track.stop());
    if (current.recorder.state !== "inactive") current.recorder.stop();
    active.current = null;
  };

  const close = () => {
    if (phase === "sending") return false;
    generation.current += 1;
    starting.current = null;
    openRef.current = false;
    transcription.current?.abort();
    transcription.current = null;
    retained.current = null;
    setRetryable(false);
    stopTracks();
    setOpen(false);
    setPhase("ready");
    setText("");
    setReplyRetained(false);
    setError("");
  };

  useShortcutClose("voice", () => { close(); }, open);

  useEffect(() => () => {
    generation.current += 1;
    starting.current = null;
    openRef.current = false;
    transcription.current?.abort();
    transcription.current = null;
    stopTracks();
  }, []);

  const show = () => {
    if (openRef.current) return;
    onBeforeOpen();
    draftIncarnation.current = sessionIncarnation;
    const currentGeneration = ++generation.current;
    openRef.current = true;
    setOpen(true);
    setError("");
    setReplyRetained(false);
    setLoadingProviders(true);
    void getSpeechProviders().then((items) => {
      if (generation.current !== currentGeneration) return;
      setProviders(items);
      setProviderId((current) => items.some((item) => item.id === current) ? current : items[0]?.id ?? "");
      setLoadingProviders(false);
    }).catch(() => {
      if (generation.current === currentGeneration) {
        setLoadingProviders(false);
        setError("Speech providers are unavailable. Try again later.");
      }
    });
  };

  useEffect(() => {
    if (openRequestToken === previousOpenRequestToken.current) return;
    previousOpenRequestToken.current = openRequestToken;
    if (openRequestToken > 0) show();
  }, [openRequestToken]);

  const transcribe = (provider: SpeechProviderSummary, blob: Blob, currentGeneration: number) => {
    retained.current = blob;
    setRetryable(false);
    setError("");
    setAnsweredBy(null);
    setLabel(null);
    setPhase("transcribing");
    const controller = new AbortController();
    transcription.current = controller;
    const mine = ++attempt.current;
    const chosen = loadSpeechEngine(provider.id);
    void transcribeSpeechAudio(provider.id, blob, controller.signal, chosen).then((result) => {
      if (transcription.current === controller) transcription.current = null;
      if (generation.current !== currentGeneration) return;
      retained.current = null;
      setText(result.text);
      setLanguage(result.language);
      setLabel(result.label);
      setAnsweredBy(chosen && result.engine && result.engine !== chosen ? result.engine : null);
      if (!chosen && result.engine) {
        const answered = result.engine;
        // No engine was chosen: the server default is the reference. An
        // unavailable list shows nothing.
        void getSpeechEngines(provider.id).then((list) => {
          if (list && list.default !== answered && generation.current === currentGeneration && attempt.current === mine) setAnsweredBy(answered);
        }).catch(() => {});
      }
      setPhase("review");
      if (!result.text.trim()) setError("No speech was detected. Record again.");
    }).catch((cause: unknown) => {
      if (transcription.current === controller) transcription.current = null;
      if (generation.current !== currentGeneration) return;
      setPhase("ready");
      setRetryable(true);
      setError(cause instanceof Error ? cause.message : "Transcription failed. Try again.");
    });
  };

  const start = async () => {
    const currentGeneration = generation.current;
    const provider = providers.find((item) => item.id === providerId);
    if (!provider || starting.current === currentGeneration) return;
    if (typeof navigator.mediaDevices?.getUserMedia !== "function" || typeof MediaRecorder === "undefined") {
      setError("Microphone recording is unavailable in this browser or app.");
      return;
    }
    starting.current = currentGeneration;
    retained.current = null;
    attempt.current += 1;
    setRetryable(false);
    setAnsweredBy(null);
    setPhase("starting");
    setError("");
    setText("");
    setSeconds(0);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      if (starting.current === currentGeneration) starting.current = null;
      if (generation.current !== currentGeneration) return;
      setPhase("ready");
      setError(isAndroidTauri()
        ? "Microphone access was denied or unavailable. Allow microphone access in Android Settings, then tap Record again."
        : "Microphone access was denied or no microphone is available.");
      return;
    }
    if (starting.current === currentGeneration) starting.current = null;
    if (generation.current !== currentGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    let recorder: MediaRecorder;
    try {
      const mimeType = recordingMimeType();
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      setPhase("ready");
      setError("This microphone format is unavailable.");
      return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      if (generation.current !== currentGeneration) return;
      const blob = new Blob(chunks, { type: (recorder.mimeType || chunks[0]?.type || "").split(";")[0] || "audio/mp4" });
      chunks.length = 0;
      if (blob.size === 0) {
        setPhase("ready");
        setError("No audio was recorded. Try again.");
        return;
      }
      if (blob.size > provider.max_bytes) {
        setPhase("ready");
        setError("Recording is too large. Keep it shorter and try again.");
        return;
      }
      transcribe(provider, blob, currentGeneration);
    };
    recorder.onerror = () => {
      recorder.onstop = null;
      stopTracks();
      if (generation.current === currentGeneration) {
        setPhase("ready");
        setError("Recording failed. Try again.");
      }
    };
    const started = Date.now();
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      setSeconds(elapsed);
      if (elapsed >= provider.max_duration_seconds) stopTracks();
    }, 250);
    active.current = { recorder, stream, interval };
    try {
      recorder.start(1000);
    } catch {
      stopTracks();
      setPhase("ready");
      setError("Recording could not start. Try again.");
      return;
    }
    setPhase("recording");
  };

  const send = async () => {
    const currentGeneration = generation.current;
    const edited = text.trim();
    if (!edited || replyRetained) return;
    if (onSendTranscript) {
      setPhase("sending");
      setError("");
      try {
        const sent = await onSendTranscript(quoteVoiceTranscript(edited, label), draftIncarnation.current);
        if (generation.current !== currentGeneration) return;
        if (sent) close();
        else {
          setReplyRetained(true);
          setPhase("review");
          setError("Reply was not sent. The transcript remains in your reply draft.");
        }
      } catch (cause) {
        if (generation.current !== currentGeneration) return;
        setPhase("review");
        setError(cause instanceof Error ? cause.message : "The reply could not be sent.");
      }
      return;
    }
    if (onTranscript) {
      onTranscript(quoteVoiceTranscript(edited, label));
      close();
      return;
    }
    setPhase("sending");
    setError("");
    try {
      const result = await submitSessionPrompt(machine, id, {
        text: quoteVoiceTranscript(edited, label),
        expected_session_incarnation: draftIncarnation.current,
      });
      if (generation.current !== currentGeneration) return;
      if (!result.ok) {
        setError(result.outcomeUnknown
          ? UNKNOWN_PROMPT_OUTCOME
          : result.error ?? "The prompt was not sent.");
        setPhase("review");
        return;
      }
      openRef.current = false;
      setOpen(false);
      setText("");
      setPhase("ready");
    } catch {
      if (generation.current !== currentGeneration) return;
      setPhase("review");
      setError(UNKNOWN_PROMPT_OUTCOME);
    }
  };

  const insert = () => {
    const edited = text.trim();
    if (!edited || !onTranscript) return;
    onTranscript(quoteVoiceTranscript(edited, label));
    close();
  };

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, select, textarea, [contenteditable]")) return;
    if (phase === "ready" && providerId) {
      event.preventDefault();
      void start();
    } else if (phase === "recording") {
      event.preventDefault();
      stopTracks();
    } else if (phase === "review" && text.trim()) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <>
      {showTrigger ? <button type="button" className="control-key key voice-key" aria-label="Record voice prompt" onClick={show}>
        <span aria-hidden="true">●</span> Voice
      </button> : null}
      {open ? createPortal(
        <Modal androidBackEntry={`voice-prompt-${machine}-${id}`} onClose={close} busy={phase === "sending"} className="speech-modal" ariaLabel="Voice prompt" onDialogKeyDown={onDialogKeyDown}>
          <h2>Voice prompt</h2>
          <p>Record up to {providers.find((item) => item.id === providerId)?.max_duration_seconds ?? 90} seconds. Review the transcript before {onSendTranscript ? "sending your reply" : onTranscript ? "adding it to your reply" : `sending it to ${targetLabel ?? machine}`}.</p>
          <p className="speech-hint">Press Enter to start or stop recording, then Enter to {onTranscript && !onSendTranscript ? "use" : "send"} the reviewed transcript. Escape closes this dialog.</p>
          {providers.length > 1 ? (
            <label>Speech service
              <select value={providerId} disabled={phase === "recording" || phase === "transcribing" || phase === "sending"} onChange={(event) => setProviderId(event.target.value)}>
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
              </select>
            </label>
          ) : providers.length === 1 ? <p className="speech-provider">Service: {providers[0]?.label}</p> : null}
          {loadingProviders ? <p role="status">Loading speech services…</p> : null}
          {!loadingProviders && providers.length === 0 && !error ? <p>No speech service is configured.</p> : null}
          {phase === "recording" ? <p className="speech-recording" role="status">● Recording · {seconds}s</p> : null}
          {phase === "starting" ? <p role="status">Waiting for microphone…</p> : null}
          {phase === "transcribing" ? <p role="status">Transcribing…</p> : null}
          {phase === "review" ? (
            <label htmlFor="speech-transcript">Transcript {language ? `· ${language}` : ""}
              <textarea id="speech-transcript" value={text} onChange={(event) => setText(event.target.value)} rows={7} maxLength={12000} disabled={replyRetained} />
            </label>
          ) : null}
          {phase === "review" ? <p className="speech-hint">Check negation, commands, filenames, and paths before sending. A voice-input tag is added so the agent knows this came from speech.</p> : null}
          {phase === "review" && label ? <p className="speech-hint">{label}</p> : null}
          {phase === "review" && answeredBy ? <p className="speech-hint">Answered by {answeredBy}.</p> : null}
          {error ? <p className="speech-error" role="alert">{error}</p> : null}
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={close} disabled={phase === "sending"}>{replyRetained ? "Return to draft" : "Cancel"}</button>
            {phase === "recording" ? <button type="button" className="btn" onClick={stopTracks}>Stop recording</button> : null}
            {phase === "ready" && retryable ? <button type="button" className="btn" onClick={() => { const kept = retained.current; const target = providers.find((item) => item.id === providerId); if (kept && target) transcribe(target, kept, generation.current); }}>Retry transcription</button> : null}
            {phase === "ready" || (phase === "review" && !replyRetained) ? <button type="button" className="btn" onClick={() => void start()} disabled={!providerId}>Record{phase === "review" ? " again" : ""}</button> : null}
            {phase === "review" && !replyRetained && onTranscript ? <button type="button" className="btn" onClick={insert} disabled={!text.trim()}>Insert to edit</button> : null}
            {phase === "review" && !replyRetained ? <button type="button" className="btn primary" onClick={() => void send()} disabled={!text.trim()}>{onTranscript && !onSendTranscript ? "Use transcript" : "Send"}</button> : null}
          </div>
        </Modal>, document.body,
      ) : null}
    </>
  );
}

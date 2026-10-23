import { useEffect, useState } from "react";
import { updateSessionTitle } from "./api.ts";
import { InlineTitleEditor } from "./InlineTitleEditor.tsx";
import { TerminalPane, type TerminalConnectionStatus } from "./TerminalPane.tsx";

export interface TerminalViewProps {
  readonly machine: string;
  readonly id: string;
  readonly title: string;
  readonly titleRevision: number;
  readonly sessionIncarnation: string;
  readonly onExit: () => void;
}

export function TerminalView({ machine, id, title, titleRevision, sessionIncarnation, onExit }: TerminalViewProps) {
  const [status, setStatus] = useState<TerminalConnectionStatus>("connecting");
  const [reconnectToken, setReconnectToken] = useState(0);
  const [currentTitle, setCurrentTitle] = useState(title);
  const [currentTitleRevision, setCurrentTitleRevision] = useState(titleRevision);
  const [editingTitle, setEditingTitle] = useState(false);

  useEffect(() => {
    setCurrentTitle(title);
    setCurrentTitleRevision(titleRevision);
  }, [title, titleRevision]);

  const saveTitle = async (nextTitle: string | null) => {
    let result = await updateSessionTitle(
      machine,
      id,
      nextTitle,
      undefined,
      currentTitleRevision,
      sessionIncarnation,
      currentTitle === id ? null : currentTitle,
    );
    for (let retry = 0; result.conflict && retry < 2; retry += 1) {
      const retryRevision = result.titleRevision;
      if (retryRevision === undefined || result.actualTitle === undefined) break;
      result = await updateSessionTitle(
        machine,
        id,
        nextTitle,
        undefined,
        retryRevision,
        sessionIncarnation,
        result.actualTitle,
      );
    }
    if (result.ok) {
      if (result.titleRevision !== undefined) {
        setCurrentTitleRevision(result.titleRevision);
      }
      setCurrentTitle(nextTitle ?? id);
      setEditingTitle(false);
    }
  };

  return (
    <div className="term-screen">
      <header className="term-head">
        <button className="btn ghost" onClick={onExit} aria-label="Back to dashboard">
          ‹ Back
        </button>
        <div className="term-title">
          {editingTitle ? (
            <InlineTitleEditor
              initialValue={currentTitle === id ? "" : currentTitle}
              formClassName="term-title-form"
              inputClassName="term-title-input"
              onSave={saveTitle}
              onCancel={() => setEditingTitle(false)}
            />
          ) : (
            <button className="control-row term-name title-button" type="button" onClick={() => setEditingTitle(true)}>
              {currentTitle}
            </button>
          )}
          <span className={`dot ${status}`} title={status} />
        </div>
        {status === "closed" ? (
          <button className="btn" onClick={() => setReconnectToken((e) => e + 1)}>
            Reconnect
          </button>
        ) : (
          <span className="term-meta">{machine}</span>
        )}
      </header>

      <TerminalPane
        machine={machine}
        id={id}
        sessionIncarnation={sessionIncarnation}
        autoFocus
        readableFit
        showKeyBar
        scrollback={5000}
        reconnectToken={reconnectToken}
        onStatusChange={setStatus}
      />
    </div>
  );
}

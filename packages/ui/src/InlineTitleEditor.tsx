import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { MAX_SESSION_TITLE_LEN, normalizeSessionTitle } from "./sessionTitle.ts";

export interface InlineTitleEditorProps {
  readonly initialValue: string;
  readonly formClassName: string;
  readonly inputClassName: string;
  readonly onSave: (title: string | null) => void | Promise<void>;
  readonly onCancel: () => void;
  readonly stopClickPropagation?: boolean;
}

export function InlineTitleEditor({
  initialValue,
  formClassName,
  inputClassName,
  onSave,
  onCancel,
  stopClickPropagation = false,
}: InlineTitleEditorProps) {
  const [draft, setDraft] = useState(initialValue);

  useEffect(() => {
    setDraft(initialValue);
  }, [initialValue]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSave(normalizeSessionTitle(draft));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <form
      className={formClassName}
      onClick={stopClickPropagation ? (event) => event.stopPropagation() : undefined}
      onSubmit={submit}
    >
      <input
        className={inputClassName}
        value={draft}
        autoFocus
        maxLength={MAX_SESSION_TITLE_LEN}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
    </form>
  );
}

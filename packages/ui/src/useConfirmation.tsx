import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "./Modal.tsx";

interface Confirmation {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
}

export type RequestConfirmation = (options: Confirmation) => Promise<boolean>;

interface PendingConfirmation extends Confirmation {
  readonly resolve: (confirmed: boolean) => void;
}

export function useConfirmation() {
  const [request, setRequest] = useState<PendingConfirmation | null>(null);
  const pending = useRef<PendingConfirmation | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const messageId = useId();

  const requestConfirmation = useCallback<RequestConfirmation>((options) => {
    if (pending.current) return Promise.resolve(false);
    return new Promise(resolve => {
      const next = { ...options, resolve };
      pending.current = next;
      setRequest(next);
    });
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    const current = pending.current;
    if (!current) return;
    pending.current = null;
    setRequest(null);
    current.resolve(confirmed);
  }, []);
  const dismissConfirmation = useCallback(() => settle(false), [settle]);

  useLayoutEffect(() => () => {
    pending.current?.resolve(false);
    pending.current = null;
  }, []);

  const confirmation = request && createPortal(
    <Modal
      ariaLabel={request.title}
      ariaDescribedby={messageId}
      androidBackEntry="confirmation"
      backdropClassName="confirmation-backdrop"
      initialFocusRef={cancelRef}
      onClose={dismissConfirmation}
    >
      <h2>{request.title}</h2>
      <p id={messageId} className="confirmation-message">{request.message}</p>
      <div className="modal-actions">
        <button ref={cancelRef} type="button" className="btn ghost" onClick={dismissConfirmation}>Cancel</button>
        <button type="button" className={request.destructive ? "btn danger" : "btn primary"} onClick={() => settle(true)}>
          {request.confirmLabel}
        </button>
      </div>
    </Modal>,
    document.body,
  );
  return { requestConfirmation, dismissConfirmation, confirmation };
}

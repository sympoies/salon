import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from "react";
import { useAsyncAction } from "./useAsyncAction.ts";

const NOOP = () => {};

type NativeButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick">;

interface AsyncButtonProps extends NativeButtonProps {
  // Click handler. When it returns a promise the button shows the shared pending
  // state (disabled + aria-busy + spinner) until it settles — unless `pending` is
  // supplied, in which case the caller controls the busy state.
  readonly onClick?: (event: MouseEvent<HTMLButtonElement>) => unknown;
  // Controlled busy, for buttons whose in-flight state is already owned elsewhere
  // (a keyed list resume, a dialog the parent closes on success, a form submit).
  readonly pending?: boolean;
  // Icon-only buttons hide their label and center the spinner while busy.
  readonly iconOnly?: boolean;
  readonly children?: ReactNode;
}

// The one way a button signals "working on it" across the app. Everything else —
// the spinner look, the disabled-while-busy guard, aria-busy, and swallowing a
// second click mid-flight — lives here so call sites stay a one-line swap from a
// plain <button>.
export function AsyncButton({
  onClick,
  pending: controlledPending,
  iconOnly = false,
  className,
  disabled,
  children,
  ...rest
}: AsyncButtonProps) {
  const { pending: internalPending, run } = useAsyncAction(onClick ?? NOOP);
  const controlled = controlledPending !== undefined;
  const busy = controlled ? controlledPending : internalPending;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // UX short-circuit only: `busy` is the delayed display flag, so this does not
    // block a click during the show-delay. The authoritative re-entrancy guard is
    // the synchronous `inFlightRef` inside useAsyncAction's run().
    if (busy) {
      return;
    }
    if (controlled) {
      onClick?.(event);
    } else {
      // Uncontrolled: we own the action, so stop a native submit from also
      // firing if this button is ever used as a submit inside a form (no-op for
      // the plain type="button" callers today).
      event.preventDefault();
      void run(event);
    }
  };

  const classes = [className, iconOnly ? "is-icon-busy" : null].filter(Boolean).join(" ");

  return (
    <button
      {...rest}
      className={classes || undefined}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={handleClick}
    >
      {busy ? <span className="btn-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

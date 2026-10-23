// Android IME composition hygiene for the xterm helper textarea.
//
// xterm's CompositionHelper sets `_isComposing` on `compositionstart` and clears
// it on exactly two events: a `compositionend`, or a keydown whose keyCode is
// not an IME/modifier code. Nothing else resets it — in particular xterm's own
// `blur` handler clears the textarea value but leaves the flag alone.
//
// That matters on Android because Chrome reports keyCode 229 for every
// soft-keyboard character key. A composition that never receives its
// `compositionend` — one interrupted by the file-chooser Activity, or by this
// app blurring the terminal when the visual viewport says the keyboard went
// away — leaves xterm swallowing every subsequent character until the page is
// reloaded. Space (keyCode 32) is the only common key that happens to finalize
// the stranded composition, which is exactly the "press space first or the
// keyboard is dead" symptom users hit after uploading an image.
//
// This guard mirrors the composition state we can observe from the DOM and can
// force a stranded one closed by dispatching a synthetic `compositionend`,
// which drives xterm's own finalizer instead of poking at its private state.
// Anything still uncommitted in the composition is dropped by the blur that
// normally follows — the same as Chrome's behavior when a field loses focus
// mid-composition, and far better than a terminal that cannot be typed into.

// The key codes xterm's `CompositionHelper.keydown` treats as "keep composing":
// CapsLock (20), the IME composition character (229), and the bare modifiers
// Shift (16) / Control (17) / Alt (18). Any other key finalizes the composition
// inside xterm without emitting a DOM `compositionend`, so the tracker below
// has to follow the same rule or it would drift from xterm and later dispatch a
// synthetic `compositionend` that replays the composed text.
const IME_CONTINUATION_KEY_CODES: ReadonlySet<number> = new Set([16, 17, 18, 20, 229]);

export function isImeContinuationKeyCode(keyCode: number): boolean {
  return IME_CONTINUATION_KEY_CODES.has(keyCode);
}

export interface TerminalCompositionGuard {
  /** Whether an IME composition is currently in flight on the helper textarea. */
  readonly isComposing: () => boolean;
  /**
   * Close an in-flight composition so xterm cannot be left with a stranded
   * `_isComposing`. Returns whether a composition was actually finalized.
   */
  readonly finalize: () => boolean;
  readonly dispose: () => void;
}

type CompositionEventCtor = new (type: string, init?: { bubbles?: boolean; data?: string }) => Event;
type EventCtor = new (type: string, init?: { bubbles?: boolean }) => Event;

function compositionEndEvent(textarea: HTMLTextAreaElement): Event {
  // Resolve the constructors through the element's own document so a terminal
  // rendered into a secondary window (or a test DOM) still gets a real event.
  const view = textarea.ownerDocument?.defaultView as unknown as
    | { CompositionEvent?: CompositionEventCtor; Event?: EventCtor }
    | null
    | undefined;
  const composition =
    view?.CompositionEvent ??
    (typeof CompositionEvent === "function" ? (CompositionEvent as unknown as CompositionEventCtor) : undefined);
  if (composition) {
    return new composition("compositionend", { bubbles: true, data: "" });
  }
  const fallback = view?.Event ?? (Event as unknown as EventCtor);
  return new fallback("compositionend", { bubbles: true });
}

export function createTerminalCompositionGuard(
  textarea: HTMLTextAreaElement | null | undefined,
): TerminalCompositionGuard {
  let composing = false;

  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
  };
  const onKeyDown = (event: Event) => {
    if (composing && !isImeContinuationKeyCode((event as KeyboardEvent).keyCode)) {
      composing = false;
    }
  };

  textarea?.addEventListener("compositionstart", onCompositionStart);
  textarea?.addEventListener("compositionend", onCompositionEnd);
  textarea?.addEventListener("keydown", onKeyDown);

  return {
    isComposing: () => composing,
    finalize: () => {
      if (!composing || !textarea) {
        return false;
      }
      composing = false;
      textarea.dispatchEvent(compositionEndEvent(textarea));
      return true;
    },
    dispose: () => {
      composing = false;
      textarea?.removeEventListener("compositionstart", onCompositionStart);
      textarea?.removeEventListener("compositionend", onCompositionEnd);
      textarea?.removeEventListener("keydown", onKeyDown);
    },
  };
}

import { strict as assert } from "node:assert";

// Safe DOM absence / focus assertions for UI tests.
//
// Passing a Happy DOM Node, Window, Document, Event, or live collection directly
// to a `node:assert` comparison is a latent out-of-memory hazard: when the
// assertion fails, Node builds the AssertionError message by running
// `util.inspect` over both operands, which walks the entire (deeply cyclic) DOM
// object graph and can consume tens of GiB of RSS.
//
// These helpers project the DOM lookup to a boolean BEFORE it reaches
// `node:assert`, so a failure only ever inspects booleans. Human-readable
// diagnostics come from an explicit, length-bounded message that describes the
// offending element without embedding the object graph.
//
// The `domAssertSafety` guard enforces that raw DOM lookups never reach a
// `node:assert` operand; use these helpers (or an inline `?.x ?? null`
// projection) instead.

// Structural shapes so the helpers work with Happy DOM and lib.dom types alike
// without importing either.
interface ElementQueryRoot {
  querySelector(selectors: string): DomElementLike | null;
}

interface DomElementLike {
  readonly tagName?: unknown;
  readonly id?: unknown;
  readonly className?: unknown;
  readonly outerHTML?: unknown;
}

interface FocusScope {
  readonly document: { readonly activeElement: DomElementLike | null };
}

const MAX_OUTER_HTML = 200;

// Build a bounded, single-line description of an element. Never returns more
// than a few hundred characters and never surfaces the live object graph.
function describeElement(element: DomElementLike | null): string {
  if (element === null || element === undefined) return "null";
  const tag = typeof element.tagName === "string" ? element.tagName.toLowerCase() : "unknown";
  const id = typeof element.id === "string" && element.id.length > 0 ? `#${element.id}` : "";
  const rawClass = typeof element.className === "string" ? element.className.trim() : "";
  const classes = rawClass.length > 0 ? `.${rawClass.split(/\s+/).join(".")}` : "";
  let outer = "";
  try {
    const html = element.outerHTML;
    if (typeof html === "string") {
      outer =
        html.length > MAX_OUTER_HTML
          ? ` ${html.slice(0, MAX_OUTER_HTML)}…[+${html.length - MAX_OUTER_HTML} chars]`
          : ` ${html}`;
    }
  } catch {
    // Serialization must never widen the failure; fall back to the structural summary.
  }
  return `<${tag}${id}${classes}>${outer}`;
}

/**
 * Assert that no element matches `selector` within `root`.
 *
 * On failure the AssertionError only compares booleans; the message names the
 * selector and a bounded description of the element that was unexpectedly found.
 */
export function assertNoElement(root: ElementQueryRoot, selector: string, message?: string): void {
  const match = root.querySelector(selector);
  const found = match !== null;
  assert.equal(
    found,
    false,
    found
      ? (message ?? `expected no element matching ${JSON.stringify(selector)}, but found ${describeElement(match)}`)
      : message,
  );
}

/**
 * Assert that `scope.document.activeElement` is exactly `expected`.
 *
 * The identity check is reduced to a boolean before `node:assert`; on failure the
 * message carries bounded descriptions of both the expected and actual elements.
 */
export function assertActiveElement(
  scope: FocusScope,
  expected: DomElementLike | null,
  message?: string,
): void {
  const actual = scope.document.activeElement;
  const matches = actual === expected;
  assert.equal(
    matches,
    true,
    matches
      ? message
      : (message ??
          `expected active element ${describeElement(expected)}, but active element was ${describeElement(actual)}`),
  );
}

import type { ComponentPropsWithRef } from "react";

type Preset = "standard" | "compact" | "identity";
type Props = (
  | ({ readonly as?: "button" } & ComponentPropsWithRef<"button">)
  | ({ readonly as: "summary" } & ComponentPropsWithRef<"summary">)
) & { readonly preset?: Preset };

/** Shared icon geometry and name text; consumers retain native semantics, events and refs. */
export function IconButton(props: Props) {
  // Android WebView can drop aria-label on icon-only popup/disclosure nodes.
  const nameText = props["aria-haspopup"] || props["aria-expanded"] !== undefined
    ? <span className="sr-only">{props["aria-label"]}</span> : null;
  if (props.as === "summary") {
    const { as: _, preset = "standard", className, children, ...native } = props;
    return <summary {...native} className={`control-icon control-icon--${preset} ${className ?? ""}`.trim()}>{children}{nameText}</summary>;
  }
  const { as: _, preset = "standard", className, type = "button", children, ...native } = props;
  return <button {...native} type={type} className={`control-icon control-icon--${preset} ${className ?? ""}`.trim()}>{children}{nameText}</button>;
}

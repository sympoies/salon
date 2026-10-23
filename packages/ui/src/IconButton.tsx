import type { ComponentPropsWithRef } from "react";

type Preset = "standard" | "compact" | "identity";
type Props = (
  | ({ readonly as?: "button" } & ComponentPropsWithRef<"button">)
  | ({ readonly as: "summary" } & ComponentPropsWithRef<"summary">)
) & { readonly preset?: Preset };

/** Shared geometry only; consumers retain native semantics, events and refs. */
export function IconButton(props: Props) {
  if (props.as === "summary") {
    const { as: _, preset = "standard", className, ...native } = props;
    return <summary {...native} className={`control-icon control-icon--${preset} ${className ?? ""}`.trim()} />;
  }
  const { as: _, preset = "standard", className, type = "button", ...native } = props;
  return <button {...native} type={type} className={`control-icon control-icon--${preset} ${className ?? ""}`.trim()} />;
}

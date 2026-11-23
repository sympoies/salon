import { Children, Fragment, isValidElement, type ChangeEvent, type ReactElement, type ReactNode, type SelectHTMLAttributes } from "react";
import { isAndroidTauri } from "./runtime.ts";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu.tsx";

type OptionElement = ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>;

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? textOf(node.props.children) : "";
}

/** The `<option>` children of a native select, flattened through fragments and arrays. */
function optionsOf(children: ReactNode): SelectMenuOption[] {
  const options: SelectMenuOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) {
      options.push(...optionsOf((child as ReactElement<{ children?: ReactNode }>).props.children));
      return;
    }
    if (child.type !== "option") return;
    const element = child as OptionElement;
    const label = textOf(element.props.children);
    options.push({
      value: String(element.props.value ?? label),
      label,
      ...(element.props.disabled ? { disabled: true } : {}),
    });
  });
  return options;
}

/**
 * Use a browser-rendered picker when its popup can be styled. The Android app
 * and browsers without that capability use the themed SelectMenu.
 */
export function AppSelect({ children, value, onChange, disabled, className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  const canStylePicker = typeof window === "undefined" || window.CSS?.supports("appearance", "base-select");
  if (canStylePicker && !isAndroidTauri()) {
    return <select {...rest} className={className ? `app-select ${className}` : "app-select"}
      value={value} onChange={onChange} disabled={disabled}>{children}</select>;
  }
  const choose = (next: string) => {
    const target = { value: next };
    onChange?.({ target, currentTarget: target } as unknown as ChangeEvent<HTMLSelectElement>);
  };
  return <SelectMenu ariaLabel={rest["aria-label"] ?? ""} value={String(value ?? "")} options={optionsOf(children)}
    disabled={disabled} className={className} onChange={choose} />;
}

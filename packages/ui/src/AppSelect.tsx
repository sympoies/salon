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
 * A native select everywhere except the Android app, whose native popup does
 * not follow the app theme: there it is the themed SelectMenu. Call sites keep
 * the native shape (`<option>` children, a change event with the new value).
 */
export function AppSelect({ children, value, onChange, disabled, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  if (!isAndroidTauri()) return <select value={value} onChange={onChange} disabled={disabled} {...rest}>{children}</select>;
  const choose = (next: string) => {
    const target = { value: next };
    onChange?.({ target, currentTarget: target } as unknown as ChangeEvent<HTMLSelectElement>);
  };
  return <SelectMenu ariaLabel={rest["aria-label"] ?? ""} value={String(value ?? "")} options={optionsOf(children)}
    disabled={disabled} onChange={choose} />;
}

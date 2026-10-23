import type { SpecialKey } from "./frames.ts";

export type ClassifiedTerminalData =
  | { readonly key: SpecialKey }
  | { readonly text: string };

const EXACT_SPECIAL_KEYS: ReadonlyMap<string, SpecialKey> = new Map([
  ["\r", "enter"],
  ["\n", "enter"],
  ["\r\n", "enter"],
  ["\x1b", "escape"],
  ["\x7f", "backspace"],
  ["\x03", "c-c"],
  ["\t", "tab"],
  ["\x1b[A", "up"],
  ["\x1b[B", "down"],
  ["\x1b[C", "right"],
  ["\x1b[D", "left"],
  ["\x1bOA", "up"],
  ["\x1bOB", "down"],
  ["\x1bOC", "right"],
  ["\x1bOD", "left"],
]);

export function classifyTerminalData(data: string): ClassifiedTerminalData {
  const key = EXACT_SPECIAL_KEYS.get(data);
  return key ? { key } : { text: data };
}

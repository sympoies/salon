export interface ClipboardWriter {
  readonly writeText?: (text: string) => Promise<void> | void;
}

export async function copyTextToClipboard(
  text: string,
  writer?: ClipboardWriter,
): Promise<"copied" | "clipboard-unavailable" | "write-failed"> {
  try {
    const clipboard = writer ?? (typeof navigator === "undefined" ? undefined : navigator.clipboard);
    if (typeof clipboard?.writeText !== "function") return "clipboard-unavailable";
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "write-failed";
  }
}

/** Provider image token, with an optional source (or a required exact source for reply proof). */
export function providerImageLabelPattern(source = "[^\\]\\r\\n]+", sourceRequired = false): string {
  return `\\[Image #\\d+\\](?:\\s*\\[Image: source: ${source}\\])${sourceRequired ? "" : "?"}`;
}

/** Opaque attachments correspond to provider labels in order, not to their numeric IDs. */
export function imageCaption(text: string, imageCount: number): string {
  if (!imageCount) return text;
  let remaining = imageCount;
  return text.replace(new RegExp(providerImageLabelPattern(), "g"), label => remaining-- > 0 ? "" : label);
}

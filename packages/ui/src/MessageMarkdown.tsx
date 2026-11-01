import { Component, createElement, Fragment, memo, useEffect, useMemo, useState, type ElementType, type MouseEvent, type ReactNode } from "react";
import Markdown, { type MarkdownToJSX } from "markdown-to-jsx/react";
import { linkUploadedFiles, type UploadedFile } from "./attachmentPaths.ts";
import { writeTerminalClipboardText } from "./terminalClipboard.ts";
import { openExternalTerminalUrl, validateTerminalUrl } from "./terminalLinks.ts";

/**
 * Only http(s) targets become links, and they open through the same gate as
 * terminal links (the system browser in the native shells). Anything else
 * keeps its text without a target.
 */
function MessageLink({ href, title, children }: {
  readonly href?: string;
  readonly title?: string;
  readonly children?: ReactNode;
}) {
  const safeUrl = href ? validateTerminalUrl(href) : null;
  if (!safeUrl) return <span>{children}</span>;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void openExternalTerminalUrl(safeUrl);
  };
  return <a href={safeUrl} title={title} target="_blank" rel="noopener noreferrer" onClick={open}>{children}</a>;
}

/** A session upload shown by its short label; selecting it copies the full path. */
function AttachmentChip({ file }: { readonly file: UploadedFile }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    void writeTerminalClipboardText(file.path).then(() => setCopied(true), () => {});
  };
  return <button type="button" className="attachment-chip" title="Copy path" aria-label={`Copy path ${file.label}`} onClick={copy}>{copied ? "Copied" : file.label}</button>;
}

// Unsupported sources remain explicit and never fetch an external image.
function MessageImage() { return <span>Image unavailable</span>; }
function HiddenMessageImage() { return null; }

// Message text chooses some element attributes (heading and footnote ids,
// code-fence attributes), so built-in elements keep only what the formatting
// itself needs. Anything else could collide with page ids, take focus, or make
// React throw.
const ALLOWED_PROPS: Readonly<Record<string, readonly string[]>> = {
  input: ["type", "checked", "readOnly", "disabled"],
  ol: ["start"],
  th: ["style"],
  td: ["style"],
};
const TABLE_ALIGNMENTS = new Set(["left", "center", "right"]);

function safeProps(tag: string, props: Record<string, unknown> | null): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (!props) return safe;
  for (const name of ["key", "className", ...(ALLOWED_PROPS[tag] ?? [])]) {
    if (props[name] !== undefined) safe[name] = props[name];
  }
  if (safe.className !== undefined && typeof safe.className !== "string") delete safe.className;
  if (safe.style !== undefined) {
    const align = (safe.style as { textAlign?: unknown } | null)?.textAlign;
    if (typeof align === "string" && TABLE_ALIGNMENTS.has(align)) safe.style = { textAlign: align };
    else delete safe.style;
  }
  return safe;
}

const createSafeElement = (tag: ElementType, props: Record<string, unknown> | null, ...children: ReactNode[]) =>
  createElement(tag, typeof tag === "string" ? safeProps(tag, props) : props, ...children);

const MESSAGE_MARKDOWN_OPTIONS: MarkdownToJSX.Options = {
  // Raw HTML stays literal text; nothing from a message becomes markup.
  disableParsingRawHTML: true,
  // A message that starts with `---` is a thematic break, not metadata.
  disableFrontmatter: true,
  forceBlock: true,
  forceWrapper: true,
  wrapper: Fragment,
  createElement: createSafeElement as MarkdownToJSX.Options["createElement"],
  overrides: {
    a: MessageLink,
    img: MessageImage,
  },
};

/** Text the parser could not render still reads as the original message. */
export class MessageMarkdownBoundary extends Component<{ readonly text: string; readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <p>{this.props.text}</p> : this.props.children;
  }
}

/** One conversation or history message rendered as safe Markdown. */
export const MessageMarkdown = memo(function MessageMarkdown({ text, suppressImages = false, uploadSessionId }: {
  readonly text: string;
  readonly suppressImages?: boolean;
  /** The session whose own quoted upload paths show as chips. */
  readonly uploadSessionId?: string;
}) {
  const linked = useMemo(() => uploadSessionId === undefined ? { text, files: [] } : linkUploadedFiles(text, uploadSessionId), [text, uploadSessionId]);
  const options = useMemo<MarkdownToJSX.Options>(() => {
    const image = suppressImages ? HiddenMessageImage : MessageImage;
    if (linked.files.length === 0) return suppressImages ? { ...MESSAGE_MARKDOWN_OPTIONS, overrides: { a: MessageLink, img: image } } : MESSAGE_MARKDOWN_OPTIONS;
    const link = (props: { readonly href?: string; readonly title?: string; readonly children?: ReactNode }) => {
      const file = /^#salon-attachment-(\d+)$/.exec(props.href ?? "")?.[1];
      const chip = file === undefined ? undefined : linked.files[Number(file)];
      return chip ? <AttachmentChip file={chip} /> : <MessageLink {...props} />;
    };
    return { ...MESSAGE_MARKDOWN_OPTIONS, overrides: { a: link, img: image } };
  }, [linked.files, suppressImages]);
  return (
    <div className="message-markdown">
      <MessageMarkdownBoundary key={text} text={text}>
        <Markdown options={options}>{linked.text}</Markdown>
      </MessageMarkdownBoundary>
    </div>
  );
});

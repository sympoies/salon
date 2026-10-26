import { useState, type ReactNode } from "react";
import { MessageMarkdown, MessageMarkdownBoundary } from "./MessageMarkdown.tsx";
import { writeTerminalClipboardText } from "./terminalClipboard.ts";
import type { SessionNotice as ParsedNotice } from "./parseSessionNotice.ts";

const KIND_LABELS = new Map([
  ["mailbox", "Mailbox"],
  ["schedule.pulse", "Scheduled update"],
  ["runtime.resume", "Resume"],
]);

function NoticeContent({ notice, raw, time, suppressImages, children }: {
  readonly notice: ParsedNotice;
  readonly raw: string;
  readonly time: ReactNode;
  readonly suppressImages: boolean;
  readonly children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState("Copy");
  const preview = notice.body.split(/\r?\n/).find(line => line.trim()) ?? "";
  const copy = async () => {
    try {
      await writeTerminalClipboardText(raw);
      setCopyState("Copied");
    } catch {
      setCopyState("Copy failed");
    }
  };
  return <div className="session-notice">
    <button type="button" className="session-notice-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span aria-hidden="true">ⓘ</span>
      <span className="session-notice-label">{KIND_LABELS.get(notice.kind) ?? "System notice"}</span>
      <span className="session-notice-preview">{preview}</span>
      {time}
    </button>
    {expanded ? <div className="session-notice-body">
      <MessageMarkdown text={notice.body} suppressImages={suppressImages} />
      {children}
      <div className="session-notice-meta">
        <span>{notice.kind} · {notice.source}</span>
        <button type="button" className="btn ghost session-notice-copy" aria-label="Copy raw notice" onClick={() => void copy()}>{copyState}</button>
      </div>
    </div> : null}
  </div>;
}

/** A failed notice render still exposes the parsed body, without its header. */
export function SessionNotice(props: Parameters<typeof NoticeContent>[0]) {
  return <MessageMarkdownBoundary key={props.raw} text={props.notice.body}>
    <NoticeContent {...props} />
  </MessageMarkdownBoundary>;
}

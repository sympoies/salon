import { useState, type ReactNode } from "react";
import { MessageMarkdownBoundary } from "./MessageMarkdown.tsx";
import { writeTerminalClipboardText } from "./terminalClipboard.ts";
import type { SessionNotice as ParsedNotice } from "@agent-console/shared";

const KIND_LABELS = new Map([
  ["mailbox", "Mailbox"],
  ["schedule.pulse", "Scheduled update"],
  ["runtime.resume", "Resume"],
]);

function NoticeContent({ notice, raw, time, children }: {
  readonly notice: ParsedNotice;
  readonly raw: string;
  readonly time: ReactNode;
  readonly suppressImages: boolean;
  readonly children?: ReactNode;
}) {
  const [copyState, setCopyState] = useState("Copy raw");
  const copy = async () => {
    try {
      await writeTerminalClipboardText(raw);
      setCopyState("Copied");
    } catch {
      setCopyState("Copy failed");
    }
  };
  return <div className="session-notice">
    <h3 className="session-notice-title">
      <span className="session-notice-label">{KIND_LABELS.get(notice.kind) ?? "System notice"}</span>
      {time}
    </h3>
    <div className="session-notice-body">{notice.body}</div>
    {children}
    <div className="session-notice-meta">
      <span>{notice.kind} · {notice.source}</span>
      <button type="button" className="btn ghost session-notice-copy" aria-label="Copy raw notice" onClick={() => void copy()}>{copyState}</button>
    </div>
  </div>;
}

/** A failed notice render still exposes the parsed body, without its header. */
export function SessionNotice(props: Parameters<typeof NoticeContent>[0]) {
  return <MessageMarkdownBoundary key={props.raw} text={props.notice.body}>
    <NoticeContent {...props} />
  </MessageMarkdownBoundary>;
}

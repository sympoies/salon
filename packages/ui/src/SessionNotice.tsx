import { useState, type ReactNode } from "react";
import { MessageMarkdown, MessageMarkdownBoundary } from "./MessageMarkdown.tsx";
import type { SessionNotice as ParsedNotice } from "@agent-console/shared";

const KIND_FAMILY_LABELS = new Map([
  ["mailbox", "Mailbox"],
  ["schedule", "Scheduled update"],
  ["compact", "Context"],
  ["runtime", "Resume"],
  ["dispatch", "Dispatch"],
  ["monitoring", "Monitoring"],
  ["role", "Role"],
  ["session", "Session"],
]);

function noticeLabel(kind: string): string {
  if (kind === "mailbox") return "Mailbox";
  const family = kind.split(".", 1)[0]!;
  return family.length < kind.length ? KIND_FAMILY_LABELS.get(family) ?? "System notice" : "System notice";
}

function NoticeContent({ notice, time, suppressImages, children, summary }: {
  readonly notice: ParsedNotice;
  readonly raw: string;
  readonly time: ReactNode;
  readonly suppressImages: boolean;
  readonly children?: ReactNode;
  readonly summary?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const body = notice.body.replace(/^(?:[ \t]*\r?\n)+/, "");
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  const multiline = body.slice(firstLine.length).trim().length > 0;
  if (summary) return <details className="session-notice mailbox-event-disclosure">
    <summary className="session-notice-title">{summary}{time}</summary>
    <div className="session-notice-body"><MessageMarkdown text={notice.body} suppressImages={suppressImages} /></div>
    {children}
    <div className="session-notice-meta"><span>{notice.kind} · {notice.source}</span></div>
  </details>;
  return <div className="session-notice">
    <div className="session-notice-preview">
      <span className="session-notice-label">{noticeLabel(notice.kind)}</span>
      {time}
      <div className="session-notice-first-line"><MessageMarkdown text={firstLine} suppressImages={suppressImages} /></div>
      {multiline && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show more"}</button>}
    </div>
    {expanded && <>
      <div className="session-notice-body"><MessageMarkdown text={notice.body} suppressImages={suppressImages} /></div>
      {children}
      <div className="session-notice-meta"><span>{notice.kind} · {notice.source}</span></div>
    </>}
  </div>;
}

/** A failed notice render still exposes the parsed body, without its header. */
export function SessionNotice(props: Parameters<typeof NoticeContent>[0]) {
  return <MessageMarkdownBoundary key={props.raw} text={props.notice.body}>
    <NoticeContent {...props} />
  </MessageMarkdownBoundary>;
}

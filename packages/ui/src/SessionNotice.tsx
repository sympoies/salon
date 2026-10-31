import type { ReactNode } from "react";
import { MessageMarkdown, MessageMarkdownBoundary } from "./MessageMarkdown.tsx";
import type { SessionNotice as ParsedNotice } from "@agent-console/shared";

const KIND_FAMILY_LABELS = new Map([
  ["mailbox", "Mailbox"],
  ["schedule", "Scheduled update"],
  ["compact", "Context"],
  ["runtime", "Resume"],
  ["dispatch", "Dispatch"],
]);

function noticeLabel(kind: string): string {
  if (kind === "mailbox") return "Mailbox";
  const family = kind.split(".", 1)[0]!;
  return family.length < kind.length ? KIND_FAMILY_LABELS.get(family) ?? "System notice" : "System notice";
}

function NoticeContent({ notice, time, suppressImages, children }: {
  readonly notice: ParsedNotice;
  readonly raw: string;
  readonly time: ReactNode;
  readonly suppressImages: boolean;
  readonly children?: ReactNode;
}) {
  return <div className="session-notice">
    <h3 className="session-notice-title">
      <span className="session-notice-label">{noticeLabel(notice.kind)}</span>
      {time}
    </h3>
    <div className="session-notice-body"><MessageMarkdown text={notice.body} suppressImages={suppressImages} /></div>
    {children}
    <div className="session-notice-meta">
      <span>{notice.kind} · {notice.source}</span>
    </div>
  </div>;
}

/** A failed notice render still exposes the parsed body, without its header. */
export function SessionNotice(props: Parameters<typeof NoticeContent>[0]) {
  return <MessageMarkdownBoundary key={props.raw} text={props.notice.body}>
    <NoticeContent {...props} />
  </MessageMarkdownBoundary>;
}

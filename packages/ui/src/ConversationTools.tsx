import { useId, useState } from "react";
import { SelectChevronIcon } from "./icons.tsx";
import type { HistoryToolPart } from "@agent-console/shared/resources";
import type { HistoryMessage } from "./types.ts";

type Call = Extract<HistoryToolPart, { kind: "tool_call" }>;
type Result = Extract<HistoryToolPart, { kind: "tool_result" }>;
interface ToolRow { readonly call?: Call; readonly result?: Result }

/** Results may follow the call in a separate textless provider row. */
export function conversationToolRows(messages: readonly HistoryMessage[]): ToolRow[][] {
  const calls = new Set<string>();
  const results = new Map<string, Result>();
  for (const message of messages) for (const part of message.tool_parts ?? []) {
    if (!part.call_id) continue;
    if (part.kind === "tool_call") calls.add(part.call_id);
    else results.set(part.call_id, part);
  }
  return messages.map(message => (message.tool_parts ?? []).flatMap((part): ToolRow[] => {
    if (part.kind === "tool_call") return [{ call: part, result: part.call_id ? results.get(part.call_id) : undefined }];
    return part.call_id && calls.has(part.call_id) ? [] : [{ result: part }];
  }));
}

function ToolDisclosure({ call, result }: ToolRow) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const name = call?.name ?? "Tool result";
  const status = result?.status ?? call?.status;
  const input = call?.owner_input_summary ?? call?.input_summary;
  const summary = result?.owner_summary ?? result?.summary;
  const lines = summary?.split("\n") ?? [];
  const diff = result && /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(summary ?? "");
  return <div className="conversation-tool">
    <button type="button" className="conversation-tool-toggle" aria-label={name}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <SelectChevronIcon className="conversation-tool-chevron" /><strong>{name}</strong>
      {input ? <span className="conversation-tool-input">{input}</span> : null}
      {status ? <span className={`conversation-tool-status is-${status}`}>{status === "ok" ? "OK" : "Error"}</span> : null}
    </button>
    <div id={id} hidden={!open} className="conversation-tool-body">
      {open ? <>
        {input ? <pre className="conversation-tool-command">{input}</pre> : null}
        {result ? <>
          {diff ? <pre className="conversation-tool-diff" aria-label="Unified diff"><code>{lines.map((line, index) =>
            <span key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "is-added" : line.startsWith("-") && !line.startsWith("---") ? "is-removed" : undefined}>{line}{index < lines.length - 1 ? "\n" : ""}</span>)}</code></pre>
            : <pre className="conversation-tool-result">{summary}</pre>}
          {result.truncated ? <p className="conversation-tool-truncated">Result truncated</p> : null}
        </> : <p>No result available.</p>}
      </> : null}
    </div>
  </div>;
}

export function ConversationTools({ rows }: { readonly rows: readonly ToolRow[] }) {
  return <div className="conversation-tools">{rows.map((row, index) => <ToolDisclosure key={`${row.call?.id ?? row.result?.id}-${row.call?.call_id ?? index}`} {...row} />)}</div>;
}

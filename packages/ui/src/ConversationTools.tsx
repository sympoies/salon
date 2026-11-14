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

/** Format only the summary already selected for this viewer. */
function readableToolInput(input: string | undefined): { primary?: string; description?: string } {
  if (!input) return { primary: input };
  let value: unknown;
  try { value = JSON.parse(input); } catch { return { primary: input }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { primary: input };
  const fields = value as Record<string, unknown>;
  const description = typeof fields.description === "string" ? fields.description : undefined;
  for (const key of ["command", "cmd", "file_path", "path"]) {
    if (typeof fields[key] === "string" && fields[key]) return { primary: fields[key], description };
  }
  const readable = (item: unknown): string => {
    if (Array.isArray(item)) return item.map(readable).join(", ");
    if (item && typeof item === "object") return Object.entries(item).map(([key, entry]) => `${key}: ${readable(entry)}`).join("; ");
    return String(item);
  };
  return { primary: readable(Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "description"))), description };
}

function ToolDisclosure({ call, result }: ToolRow) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const name = call?.name ?? "Tool result";
  const status = result?.status ?? call?.status;
  const { primary: input, description } = readableToolInput(call?.owner_input_summary ?? call?.input_summary);
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
        {description ? <pre className="conversation-tool-description">{description}</pre> : null}
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

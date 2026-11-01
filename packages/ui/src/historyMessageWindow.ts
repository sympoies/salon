import type { HistoryMessage } from "./types.ts";

const isEvent = (message: HistoryMessage) => message.mailbox !== undefined;

/** Keep the first `rows` provider rows of a page; mailbox events are extra and ride with the rows around them. */
export function boundHistoryMessages(messages: readonly HistoryMessage[], rows: number): HistoryMessage[] {
  let kept = 0;
  const bounded: HistoryMessage[] = [];
  for (const message of messages) {
    if (!isEvent(message)) {
      if (kept === rows) break;
      kept += 1;
    }
    bounded.push(message);
  }
  return bounded;
}

/**
 * Older rows join the front of the window. An event already held keeps its
 * place and is replaced only by a strictly higher revision of the same message.
 */
export function mergeOlderHistoryMessages(current: readonly HistoryMessage[], older: readonly HistoryMessage[], rows: number): HistoryMessage[] {
  const incoming = new Map(older.filter(isEvent).map((message) => [message.id, message]));
  const held = new Set(current.map((message) => message.id));
  const refreshed = current.map((message) => {
    const next = incoming.get(message.id);
    return next?.mailbox && message.mailbox && next.mailbox.revision > message.mailbox.revision ? next : message;
  });
  const fresh = older.filter((message) => !(isEvent(message) && held.has(message.id)));
  return boundHistoryMessages([...fresh, ...refreshed], rows);
}

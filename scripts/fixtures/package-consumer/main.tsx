import { mountApp } from "@agent-console/ui/app";
import type { UiExtension } from "@agent-console/ui/extensions";
import { createRoot } from "react-dom/client";
import { LiveConversationPanel } from "@agent-console/ui/live-conversation-panel";
import { setPrincipalStorageNamespace } from "@agent-console/ui/storage";
import type { HistoryMessage, Session } from "@agent-console/ui/types";

const extension: UiExtension = {
  id: "fixture",
  settingsPanels: [{ id: "details", render: () => <p>Installed package consumer</p> }],
};
if (new URLSearchParams(location.search).has("submitted-fixture")) {
  // Only HTTP is simulated. Public installed components, history normalization
  // and the browser's native IndexedDB journal run unchanged.
  setPrincipalStorageNamespace("fixture");
  const text = "Submitted reply awaiting matching history";
  const session = { id: "fixture-session", machine: "fixture", agent: "codex", status: "running",
    title: "Conversation fixture", session_incarnation: "fixture-incarnation",
    provider_resume: { provider: "codex", session_id: "fixture-thread" } } as Session;
  const item = { id: "fixture-intent", text, state: "submitted", revision: 1, created_at: 1, updated_at: 1,
    session_incarnation: session.session_incarnation, request_id: "fixture-request", edit_hold: null, error_code: null,
    receipt: { request_id: "fixture-request", session_id: session.id, session_incarnation: session.session_incarnation,
      outcome: "submitted", code: null } };
  let historyReads = 0, outboxReads = 0, writes = 0;
  const unexpected: string[] = [];
  let messages: readonly HistoryMessage[] = new URLSearchParams(location.search).has("later")
    ? [{ id: "later-assistant", role: "assistant", text: "Later progress", timestamp: new Date(10).toISOString() }] : [];
  window.fetch = async (input, init) => {
    if (init?.method && !["GET", "HEAD"].includes(init.method)) { writes++; throw Error("Unexpected fixture write"); }
    const url = new URL(String(input), location.origin);
    if (url.pathname === "/api/resources/events") return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(": fixture\n\n"));
      init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    let data: unknown;
    if (url.pathname.endsWith("/outbox")) { outboxReads++; data = { revision: 1, items: [item], compose_holds: [] }; }
    else if (url.pathname.endsWith("/messages")) { historyReads++; data = { messages }; }
    else if (url.pathname === "/api/history/sessions") data = { sessions: [{ id: "fixture-history", machine: "fixture",
      provider: "codex", provider_session_id: "fixture-thread", title: "Conversation fixture", cwd: "/workspace",
      created_at: "2030-01-01T09:00:00Z", updated_at: "2030-01-01T09:01:00Z", resumable: false }],
      capabilities: { latest_message_paging: true } };
    else if (url.pathname.endsWith("/repo-url")) data = {};
    else if (url.pathname === "/api/speech/providers") data = { providers: [] };
    else { unexpected.push(url.pathname); throw Error("Unexpected fixture read"); }
    return Response.json({ ok: true, data });
  };
  createRoot(document.getElementById("root")!).render(<LiveConversationPanel session={session} machineReachable
    onClose={() => {}} docked showComposer replyDrafts={new Map()} />);
  Object.assign(window, { submittedFixture: {
    handover() {
      messages = [{ id: "matching-user-turn", role: "user", text, timestamp: new Date(3).toISOString() }];
      document.querySelector<HTMLButtonElement>('button[aria-label="Refresh conversation"]')!.click();
    },
    async inspect() {
      const rows = await new Promise<Array<{ snapshot: { items: Array<{ state: string }> }; submittedProofs?: Record<string, string> }>>((resolve, reject) => {
        const request = indexedDB.open("agent-console-shared-admissions", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("targets")) { db.close(); resolve([]); return; }
          const tx = db.transaction("targets"), read = tx.objectStore("targets").getAll();
          tx.oncomplete = () => { db.close(); resolve(read.result); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
      });
      const history = document.querySelector(".history-messages");
      return { ready: historyReads > 0 && Boolean(history) && !history!.textContent?.includes("Loading conversation"),
        historyReads, outboxReads, writes, unexpected,
        submittedRows: rows.flatMap(row => row.snapshot.items).filter(item => item.state === "submitted").length,
        proofCount: rows.reduce((count, row) => count + Object.keys(row.submittedProofs ?? {}).length, 0),
        visibleEchoes: document.querySelectorAll('[aria-label="Shared replies"] article[data-status="submitted"]').length,
        matchingHistoryTurns: [...document.querySelectorAll('.history-message.is-user:not(.history-outgoing-reply)')]
          .filter(node => node.textContent?.includes(text)).length };
    },
  } });
} else {
  mountApp(document.getElementById("root"), { extensions: [extension] });
}

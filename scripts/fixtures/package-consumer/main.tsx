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
  const imageId = `${"a".repeat(16)}.0.u0-0.${"b".repeat(32)}`;
  const imageMessage: HistoryMessage = { id: "image-message", role: "user", text: "Image fixture",
    timestamp: new Date(4).toISOString(), images: [{ id: imageId }] };
  const session = { id: "fixture-session", machine: "fixture", agent: "codex", status: "running",
    title: "Conversation fixture", session_incarnation: "fixture-incarnation",
    provider_resume: { provider: "codex", session_id: "fixture-thread" } } as Session;
  const item = { id: sessionStorage.getItem("fixture-intent-id") ?? "fixture-intent", text, state: "submitted", revision: 1, created_at: 1, updated_at: 1,
    session_incarnation: session.session_incarnation, request_id: "fixture-request", edit_hold: null, error_code: null,
    receipt: { request_id: "fixture-request", session_id: session.id, session_incarnation: session.session_incarnation,
      outcome: "submitted", code: null } };
  let historyReads = 0, outboxReads = 0, writes = 0;
  const unexpected: string[] = [];
  let messages: readonly HistoryMessage[] = new URLSearchParams(location.search).has("later")
    ? [{ id: "later-assistant", role: "assistant", text: "Later progress", timestamp: new Date(10).toISOString() }, imageMessage] : [];
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(String(input), location.origin);
    if (init?.method === "PUT" && url.pathname.includes("/outbox/")) {
      writes++;
      item.id = url.pathname.split("/").at(-1)!;
      sessionStorage.setItem("fixture-intent-id", item.id);
      return Response.json({ ok: true, data: { item } }, { status: 201 });
    }
    if (init?.method && !["GET", "HEAD"].includes(init.method)) { writes++; throw Error("Unexpected fixture write"); }
    if (url.pathname.endsWith(`/images/${imageId}`)) {
      const headers = new Headers(init?.headers);
      headers.set("authorization", "Bearer fixture-token");
      return nativeFetch(url, { ...init, headers });
    }
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
    async send() {
      const editor = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to session"]')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, text);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
      document.querySelector<HTMLButtonElement>('button[aria-label="Send reply"]')!.click();
    },
    handover() {
      messages = [{ id: "matching-user-turn", role: "user", text, timestamp: new Date(3).toISOString() }, imageMessage];
      document.querySelector<HTMLButtonElement>('button[aria-label="Refresh conversation"]')!.click();
    },
    async inspect() {
      // Observation must leave schema creation to the production client.
      const exists = (await indexedDB.databases()).some(database => database.name === "agent-console-shared-admissions");
      const rows = exists ? await new Promise<Array<{ snapshot: { items: Array<{ state: string }> }; submittedProofs?: Record<string, string> }>>((resolve, reject) => {
        const request = indexedDB.open("agent-console-shared-admissions", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("targets")) { db.close(); resolve([]); return; }
          const tx = db.transaction("targets"), read = tx.objectStore("targets").getAll();
          tx.oncomplete = () => { db.close(); resolve(read.result); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
      }) : [];
      const history = document.querySelector(".history-messages");
      return { ready: historyReads > 0 && Boolean(history) && !history!.textContent?.includes("Loading conversation"),
        historyReads, outboxReads, writes, unexpected,
        targetRows: rows.length,
        snapshotStates: rows.flatMap(row => row.snapshot.items).map(item => item.state),
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

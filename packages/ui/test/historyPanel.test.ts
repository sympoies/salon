import { strict as assert } from "node:assert";
import { test } from "node:test";
import { uiSource, uiStyles } from "./support/source.ts";

const source = uiSource("HistoryPanel.tsx");
// History and the live-session panel share the conversation pager.
const conversation = uiSource("HistoryConversation.tsx");
const dashboard = uiSource("Dashboard.tsx");
const css = uiStyles();

test("HistoryPanel exposes metadata-only discovery, transcript browsing, and resume", () => {
  assert.match(source, /Searches metadata and the bounded prompt preview only — never conversation text\./);
  assert.match(source, /listHistorySessions/);
  assert.match(conversation, /listHistoryMessages/);
  assert.match(source, /resumeHistorySession\(selected\.machine, selected\.id\)/);
  const resumeBody = source.match(/const resume = useCallback[\s\S]*?resumeHistorySession\(selected\.machine, selected\.id\)[\s\S]*?\}\);/)?.[0];
  assert.ok(resumeBody);
  assert.doesNotMatch(resumeBody, /cwd:/);
  assert.doesNotMatch(resumeBody, /provider_resume_id|agent_args/);
  assert.match(source, /catalogAbortRef\.current\?\.abort\(\)/);
  assert.match(conversation, /abortRef\.current\?\.abort\(\)/);
  assert.match(source, /controller\.signal/);
  assert.match(conversation, /controller\.signal/);
  assert.match(source, /HISTORY_PAGE_SIZE = 50/);
  assert.match(conversation, /HISTORY_MESSAGE_WINDOW = 100/);
  assert.match(conversation, /direction: "latest"/);
  assert.match(conversation, /direction: "older"/);
  assert.match(source, /first_user_prompt_preview/);
  assert.match(source, /last_user_prompt_preview/);
  assert.match(source, /history-harness-badge/);
  assert.match(source, /history-project-badge/);
  assert.match(source, /history-project-path/);
  assert.match(source, /title=\{session\.cwd\}/);
  assert.match(source, /Untitled session/);
  assert.match(conversation, /Load older/);
  assert.match(conversation, /Jump to latest/);
  assert.match(conversation, /scrollTop/);
  assert.match(source, /setSessions\(result\.sessions\.slice\(0, HISTORY_PAGE_SIZE\)\)/);
  assert.match(conversation, /setMessages\(result\.messages\.slice\(0, HISTORY_PAGE_SIZE\)\)/);
  assert.match(source, /sessionPageCursors/);
  assert.match(conversation, /messagePageCursors/);
  // A page replaces the list; it never accumulates. The one functional update is
  // the star toggle, which edits the loaded page in place.
  assert.doesNotMatch(source, /setSessions\(\(current\) => \[/);
  assert.match(
    source,
    /setSessions\(\(current\) => applyHistoryStar\(current, session\.id, result\.starredAt\)\)/,
  );
  assert.match(conversation, /setMessages\(\(current\) => \[\.\.\.result\.messages, \.\.\.current\]\.slice\(0, HISTORY_MESSAGE_WINDOW\)\)/);
  assert.match(source, />Resume<|"Resuming…" : "Resume"/);
  assert.match(source, /<option value="dsh">DSH<\/option>/);
  assert.match(source, /provider === "dsh" \? "DSH"/);
  assert.match(
    source,
    /disabled=\{resuming \|\| resumeOutcomeUnknown \|\| !resumeAvailable \|\| !selected\.resumable\}/,
  );
});

test("Dashboard keeps archive and delete distinct behind one default action", () => {
  assert.match(dashboard, /archiveSession\(\s*session\.machine,\s*session\.id,\s*session\.session_incarnation,/);
  assert.match(dashboard, /"Archive session"/);
  assert.match(dashboard, /"Delete session"/);
  assert.match(dashboard, /Remove the Console record instead/);
  assert.match(dashboard, /const runSelectedCloseAction = deleteInstead \? runDelete : runArchive;/);
  assert.match(dashboard, /machine\.capabilities\?\.history === true/);
  assert.match(dashboard, /machine\.capabilities\?\.archive === true/);
  assert.match(dashboard, /archiveAvailable=\{archiveMachineNames\.has\(closeConfirmSession\.machine\)\}/);
  assert.match(dashboard, /checked=\{deleteInstead\}/);
  assert.match(dashboard, /disabled=\{busy\}/);
});

test("History layout adapts from split desktop browsing to one mobile pane", () => {
  assert.match(
    css,
    /\.modal\.history-modal \{[\s\S]*?width: 92vw;[\s\S]*?height: 90vh;[\s\S]*?max-height: none;/,
    "the History dialog must use the available desktop viewport instead of fixed dimensions",
  );
  assert.match(css, /\.history-body \{[\s\S]*?grid-template-columns:/);
  assert.match(source, /backdropClassName="history-backdrop"/);
  assert.match(
    css,
    /@media \(max-width: 760px\)[\s\S]*?\.modal-backdrop\.history-backdrop \{[\s\S]*?padding: 0;/,
    "the compact History backdrop must outrank the later shared backdrop padding",
  );
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.modal\.history-modal \{[\s\S]*?width: 100%;[\s\S]*?height: 100%;/);
  assert.match(
    css,
    /@media \(max-width: 760px\)[\s\S]*?\.modal\.history-modal \{[^}]*padding:\s*calc\(var\(--space-lg\) \+ var\(--ac-safe-area-top\)\)\s*calc\(var\(--space-lg\) \+ var\(--ac-safe-area-right\)\)\s*calc\(var\(--space-lg\) \+ var\(--ac-safe-area-bottom\)\)\s*calc\(var\(--space-lg\) \+ var\(--ac-safe-area-left\)\);/,
    "compact History must keep its content clear of every Android system-bar and display-cutout inset",
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)[\s\S]*?\.history-body \{[\s\S]*?grid-template-columns: 1fr;[\s\S]*?grid-template-rows: minmax\(0, 1fr\);/,
    "compact History must give the active list or conversation pane the full body height",
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)[\s\S]*?\.history-body:not\(\.is-viewing\) \.history-viewer,[\s\S]*?\.history-body\.is-viewing \.history-list \{[\s\S]*?display: none;/,
    "compact History must never stack an empty conversation below the session list",
  );
  assert.match(source, /className=\{`history-body \$\{selected \? "is-viewing" : "is-listing"\}`\}/);
  assert.match(source, /className="btn ghost history-back"[\s\S]*?>\s*Back to sessions\s*</);
  assert.match(
    css,
    /\.history-viewer-actions \.history-back \{\s*display: none;/,
    "the desktop hide rule must outrank the shared button display rule declared later in the stylesheet",
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)[\s\S]*?\.history-viewer-actions \.history-back \{\s*display: inline-flex;/,
    "the compact single-pane viewer must restore its back-to-list control",
  );
  assert.doesNotMatch(
    css.match(/\.history-load-older \{[^}]*\}/)?.[0] ?? "",
    /position: sticky/,
    "the older-page control must not obscure conversation messages",
  );
  assert.match(
    css,
    /\.history-row strong \{[\s\S]*?min-width: 0;[\s\S]*?overflow-wrap: anywhere;/,
    "unbroken prompt preview text must not widen the compact history list",
  );
  assert.match(
    css,
    /\.history-viewer-head > div \{[^}]*grid-template-columns: minmax\(0, 1fr\);/,
    "selected-session metadata must stay inside the available viewer header width",
  );
  assert.match(
    css,
    /\.history-viewer-head strong \{[^}]*overflow-wrap: anywhere;/,
    "unbroken selected-session titles must wrap inside the compact viewer",
  );
  assert.match(
    css,
    /\.history-viewer-head strong \{[^}]*display: -webkit-box;[^}]*overflow: hidden;[^}]*-webkit-box-orient: vertical;[^}]*-webkit-line-clamp: 2;/,
    "selected-session titles must leave usable vertical space for conversation messages",
  );
  assert.match(
    css,
    /\.history-viewer-meta \.history-project-path \{[^}]*overflow: visible;[^}]*overflow-wrap: anywhere;[^}]*text-overflow: clip;[^}]*white-space: normal;/,
    "the selected-session viewer must visibly wrap the exact project path on touch layouts",
  );
  assert.match(
    css,
    /@media \(min-width: 1200px\)[\s\S]*?\.history-row \{[^}]*padding: 16px 18px;[^}]*\}[\s\S]*?\.history-row strong \{[^}]*font-size: var\(--text-lg\);[^}]*line-height: 1\.35;[^}]*\}[\s\S]*?\.history-row span,[\s\S]*?\.history-row em \{[^}]*font-size: var\(--text-md\);/,
    "large desktop History rows must remain comfortably scannable as the dialog grows",
  );
});

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSync, Visitor, type JSXAttribute } from "oxc-parser";

const source = new URL("../src/", import.meta.url);
const styledInputTypes = new Set(["email", "password", "search", "tel", "text", "url"]);
const nonvisualInputTypes = new Set(["hidden"]);
const themeClasses: Readonly<Record<string, readonly string[]>> = {
  checkbox: ["control-checkbox"],
  color: ["settings-color-input"],
  file: ["conversation-file-input", "terminal-file-input"],
};

function attributeValue(attribute: JSXAttribute): string | undefined {
  const value = attribute.value;
  const literal = value?.type === "JSXExpressionContainer" ? value.expression : value;
  if (literal?.type === "Literal" && typeof literal.value === "string") return literal.value;
}

test("native form controls use the shared theme or an explicitly styled trigger", () => {
  const offenders: string[] = [];
  const files = readdirSync(source, { recursive: true }).filter(file => /\.[jt]sx?$/.test(file)).sort();
  for (const file of files) {
    const text = readFileSync(new URL(file, source), "utf8");
    const { program, errors } = parseSync(file, text);
    assert.deepEqual(errors, [], `parse ${file}`);
    new Visitor({
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const tag = node.name.name;
        if (tag !== "input" && tag !== "select") return;
        const report = (reason: string) => offenders.push(`${file}:${text.slice(0, node.start).split("\n").length}: ${reason}`);
        if (tag === "select") {
          if (file !== "AppSelect.tsx") report("use AppSelect for a themed select popup");
          return;
        }
        const attrs = new Map(node.attributes.flatMap(attr =>
          attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" ? [[attr.name.name, attr]] : []));
        const type = attrs.has("type") ? attributeValue(attrs.get("type")!) : "text";
        if (!type) {
          report("declare a static input type so its theme coverage can be checked");
          return;
        }
        if (styledInputTypes.has(type) || nonvisualInputTypes.has(type)) return;
        // These existing checkboxes have their own themed option rows and focus rings.
        const description = attrs.get("aria-describedby");
        if (file === "Dashboard.tsx" && type === "checkbox" && description &&
          ["close-session-star-description", "close-session-delete-description"].includes(attributeValue(description) ?? "")) return;
        const classAttr = attrs.get("className");
        const classes = classAttr ? (attributeValue(classAttr) ?? "").split(/\s+/) : [];
        if (!themeClasses[type]?.some(name => classes.includes(name))) {
          report(`add theme coverage for input type="${type}"`);
        }
      },
    }).visit(program);
  }
  assert.deepEqual(offenders, []);
});

// These audited titles get their equivalent from a composed label or a nearby
// detail surface. An exact entry keeps another title in the same file checked.
const composedTitleHints = [
  'ConversationComposer.tsx button {sending ? "Sending…" : "Send reply"}', // Button state.
  'DebugPanel.tsx button "Filter to this session"', // Named session-filter action.
  'HeaderCountsNotice.tsx IconButton "Partial counts: tap for offline hosts"', // Offline host details.
  'HeaderUsage.tsx span {windowTitle(w)}', // Usage page.
  'HeaderUsage.tsx span {`${w.label} resets in ${formatResetCountdown(w.resets_at, now)}`}',
  'HistoryPanel.tsx span {session.cwd}', // The selected session shows the full path.
  'HistoryPanel.tsx span {session.cwd}',
  'LayoutPicker.tsx IconButton "Auto layout — grid follows the session count"', // Auto option description.
  'LayoutPicker.tsx IconButton "Choose layout"', // Name includes the current layout.
  'LiveConversationPanel.tsx IconButton "Refresh"', // Named conversation actions.
  'LiveConversationPanel.tsx IconButton "Close"',
  'MessageMarkdown.tsx a {title}', // Optional author-supplied link metadata.
  'MessageMarkdown.tsx button "Copy path"', // Name includes the attachment.
  'OutgoingBubble.tsx div "Reply actions: right-click, long-press or press Enter"', // Visible reply action button.
  'SessionAccountBadge.tsx span {view.statusLabel}', // Account popover on the session.
  'SessionActivityPopover.tsx button {statusDescription}', // Name includes the status.
  'SessionCopyMenu.tsx IconButton {title}', // Action names in the copy menu.
  'SessionFiltersBar.tsx button {chip.label}', // Full names in the filter panel.
  'SessionFiltersBar.tsx button {chip.label}',
  'SessionFiltersBar.tsx span {entry.label}',
  'SessionModelBadge.tsx span {title}', // Runtime rows in the session activity popover.
  'SessionSlot.tsx button "Choose a session"', // Current position in the chooser name.
  'SessionSlot.tsx IconButton "Open session"', // Name includes the session.
  'SessionSlot.tsx summary {s ? "Open session menu" : "Open slot menu"}', // Trigger names.
  'SessionSlot.tsx IconButton {showPhoneConversation ? "Refresh conversation" : "Refresh terminal"}',
  'SessionSlot.tsx SessionCopyMenu {copyAction ? copyAction.kind === "command" ? "Copy session command" : "Copy provider session ID" : copyActions[0]!.label}',
  'SessionSlot.tsx AsyncButton {`${actionLabel}. ${accessibleLabel}`}', // Name and status details.
  'SessionTitleMenu.tsx IconButton "Move here: swap into the current position"', // Named move action.
  'SessionTitleMenu.tsx summary "Open session menu"', // Name includes the session.
  'SessionTitleMenu.tsx span {savedDraftLabel}', // Visible draft text.
  'StatusNotice.tsx span {notice.message}', // Clipped messages expose the full text through the disclosure.
  'TerminalPane.tsx button {`Copy ${visibleTouchMenu.linkUrl}`}', // URL in the Links picker.
  'TerminalPane.tsx button {entry.url}',
];

test("native title hints have a visible or accessible equivalent", () => {
  const remaining = [...composedTitleHints];
  const offenders: string[] = [];
  const files = readdirSync(source, { recursive: true }).filter(file => /\.[jt]sx$/.test(file)).sort();
  for (const file of files) {
    const text = readFileSync(new URL(file, source), "utf8");
    const { program, errors } = parseSync(file, text);
    assert.deepEqual(errors, [], `parse ${file}`);
    new Visitor({
      JSXElement(node) {
        const { openingElement } = node;
        if (openingElement.name.type !== "JSXIdentifier") return;
        if (openingElement.name.name === "SessionWorkRefs") return; // A session data prop.
        const attrs = new Map(openingElement.attributes.flatMap(attr =>
          attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" ? [[attr.name.name, attr]] : []));
        const title = attrs.get("title");
        if (!title?.value) return;
        const hint = text.slice(title.value.start, title.value.end);
        const equivalent = [attrs.get("aria-label"), attrs.get("aria-description")].some(attr =>
          attr?.value && text.slice(attr.value.start, attr.value.end) === hint);
        const literal = attributeValue(title);
        if (equivalent || (literal && node.children.some(child => child.type === "JSXText" && child.value.trim() === literal))) return;
        const key = `${file} ${openingElement.name.name} ${hint}`;
        const existing = remaining.indexOf(key);
        if (existing >= 0) {
          remaining.splice(existing, 1);
          return;
        }
        offenders.push(key);
      },
    }).visit(program);
  }
  assert.deepEqual(offenders, [], "Give the title hint a visible or accessible equivalent");
  assert.deepEqual(remaining, [], "Remove unused title-hint exceptions");
});

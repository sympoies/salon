import { CloseIcon } from "./icons.tsx";
import { IconButton } from "./IconButton.tsx";
import { useEffect } from "react";
import { Modal } from "./Modal.tsx";

const SHORTCUT_GROUPS = [
  {
    title: "Sessions",
    rows: [
      ["⌘I", "Voice prompt"],
      ["⌘Y", "Show / hide conversation"],
      ["⌘T", "New session"],
      ["⌘R", "Reconnect selected session"],
      ["⌘E", "Rename selected session"],
      ["⌘P", "Regenerate selected title"],
      ["⌘W", "Close selected session"],
      ["⌘5", "Repair filtered sessions"],
    ],
  },
  {
    title: "Navigation",
    rows: [
      ["⌘H / ⌘L", "Previous / next session"],
      ["⌘< / ⌘>", "Previous / next page"],
      ["⌘1–4 / ⌘6", "Open session in shortcut order"],
      ["⌘F", "Toggle focused session"],
      ["⌘` / ⌘~", "Back to session list"],
    ],
  },
  {
    title: "Layout and panels",
    rows: [
      ["⌘N / ⌘M", "Fewer / more panes"],
      ["⌘;", "Show / hide usage"],
      ["⌘⇧S", "Open Shell (Ctrl⇧S on other platforms)"],
      ["⌘/", "Show / hide this help"],
    ],
  },
  {
    title: "Terminal clipboard",
    rows: [
      ["⌘C", "Copy selected terminal text"],
      ["⌘⇧C", "Copy selected command or URL as one line"],
      ["⌘V", "Paste"],
    ],
  },
] as const;

export function ShortcutHelpModal({ onClose }: { readonly onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key !== "/" && event.code !== "Slash") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <Modal androidBackEntry="shortcut-help" onClose={onClose} className="shortcut-help-modal" ariaLabelledby="shortcut-help-title">
      <header className="shortcut-help-head">
        <div>
          <h2 id="shortcut-help-title">macOS shortcuts</h2>
          <p>Available in the Agent Console macOS app. Session actions use the selected pane in the desktop grid. In a narrow card list, open a session first.</p>
        </div>
        <IconButton type="button" className="btn icon-btn" aria-label="Close shortcuts" onClick={onClose}><CloseIcon /></IconButton>
      </header>
      <div className="shortcut-help-body">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} aria-label={group.title}>
            <h3>{group.title}</h3>
            <dl>
              {group.rows.map(([keys, action]) => (
                <div key={keys} className="shortcut-help-row">
                  <dt><kbd>{keys}</kbd></dt>
                  <dd>{action}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="shortcut-help-footer">Press ⌘/ or Esc to close.</p>
    </Modal>
  );
}

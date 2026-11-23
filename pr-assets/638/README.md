# Outgoing reply delivery states

The same synthetic conversation was rendered in Chrome 153.0.8010.47 at each
viewport. The production conversation panes and styles use a fixture with one
journaled admission, one admitted row, one claimed row, one accepted row, one
uncertain row and one permission refusal. The menu is closed in all captures.

The baseline uses `fd43ba090e80f17ad0ea367f84eaffe96642edaa`. Every changed
view shows six visible labels across the five delivery states. Each label uses
its existing theme colour token. All bubbles, labels, refusal text and Retry
fit within the pane without horizontal overflow. Retry appears only on the
refused row in both sets of captures.

| View | Viewport | Dark before / after | Paper before / after |
| --- | --- | --- | --- |
| Focused phone | 390 × 880 | [Before](before/phone-dark-390.webp) · [After](after/phone-dark-390.webp) | [Before](before/phone-paper-390.webp) · [After](after/phone-paper-390.webp) |
| Focused phone | 760 × 880 | [Before](before/phone-dark-760.webp) · [After](after/phone-dark-760.webp) | [Before](before/phone-paper-760.webp) · [After](after/phone-paper-760.webp) |
| Conversation tile | 761 × 880 | [Before](before/tile-dark-761.webp) · [After](after/tile-dark-761.webp) | [Before](before/tile-paper-761.webp) · [After](after/tile-paper-761.webp) |
| Conversation tile | 1280 × 880 | [Before](before/tile-dark-1280.webp) · [After](after/tile-dark-1280.webp) | [Before](before/tile-paper-1280.webp) · [After](after/tile-paper-1280.webp) |
| Overlay | 390 × 880 | [Before](before/modal-dark-390.webp) · [After](after/modal-dark-390.webp) | [Before](before/modal-paper-390.webp) · [After](after/modal-paper-390.webp) |
| Overlay | 760 × 880 | [Before](before/modal-dark-760.webp) · [After](after/modal-dark-760.webp) | [Before](before/modal-paper-760.webp) · [After](after/modal-paper-760.webp) |
| Overlay | 761 × 880 | [Before](before/modal-dark-761.webp) · [After](after/modal-dark-761.webp) | [Before](before/modal-paper-761.webp) · [After](after/modal-paper-761.webp) |
| Overlay | 1099 × 880 | [Before](before/modal-dark-1099.webp) · [After](after/modal-dark-1099.webp) | [Before](before/modal-paper-1099.webp) · [After](after/modal-paper-1099.webp) |
| Dock | 1100 × 880 | [Before](before/dock-dark-1100.webp) · [After](after/dock-dark-1100.webp) | [Before](before/dock-paper-1100.webp) · [After](after/dock-paper-1100.webp) |
| Dock | 1280 × 880 | [Before](before/dock-dark-1280.webp) · [After](after/dock-dark-1280.webp) | [Before](before/dock-paper-1280.webp) · [After](after/dock-paper-1280.webp) |

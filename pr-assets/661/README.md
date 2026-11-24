# Outgoing reply menus

The production conversation panes and styles rendered the same synthetic
conversation in headless Chrome 153.0.8010.47. Each capture follows a
right-click on the indicated reply. The baseline is
`7976a3964b1a1e56e6e25aa08021e239524096a8`.

At every viewport, the baseline submitted reply had no menu, and the
Unknown outcome menu contained only **Dismiss reply**. With the change,
both menus offer **Copy text**, and only the Unknown outcome menu offers
**Dismiss reply**. Every action is visible and clickable, including when
the menu opens at the lower-right viewport edge.

| View | Viewport | Handed over | Unknown outcome |
| --- | --- | --- | --- |
| Focused phone | 390 × 880 | [Before](before/phone-390-submitted.webp) · [After](after/phone-390-submitted.webp) | [Before](before/phone-390-unknown.webp) · [After](after/phone-390-unknown.webp) |
| Focused phone | 760 × 880 | [Before](before/phone-760-submitted.webp) · [After](after/phone-760-submitted.webp) | [Before](before/phone-760-unknown.webp) · [After](after/phone-760-unknown.webp) |
| Conversation tile | 761 × 880 | [Before](before/tile-761-submitted.webp) · [After](after/tile-761-submitted.webp) | [Before](before/tile-761-unknown.webp) · [After](after/tile-761-unknown.webp) |
| Conversation tile | 1280 × 880 | [Before](before/tile-1280-submitted.webp) · [After](after/tile-1280-submitted.webp) | [Before](before/tile-1280-unknown.webp) · [After](after/tile-1280-unknown.webp) |
| Overlay | 390 × 880 | [Before](before/overlay-390-submitted.webp) · [After](after/overlay-390-submitted.webp) | [Before](before/overlay-390-unknown.webp) · [After](after/overlay-390-unknown.webp) |
| Overlay | 760 × 880 | [Before](before/overlay-760-submitted.webp) · [After](after/overlay-760-submitted.webp) | [Before](before/overlay-760-unknown.webp) · [After](after/overlay-760-unknown.webp) |
| Overlay | 761 × 880 | [Before](before/overlay-761-submitted.webp) · [After](after/overlay-761-submitted.webp) | [Before](before/overlay-761-unknown.webp) · [After](after/overlay-761-unknown.webp) |
| Overlay | 1099 × 880 | [Before](before/overlay-1099-submitted.webp) · [After](after/overlay-1099-submitted.webp) | [Before](before/overlay-1099-unknown.webp) · [After](after/overlay-1099-unknown.webp) |
| Dock | 1100 × 880 | [Before](before/dock-1100-submitted.webp) · [After](after/dock-1100-submitted.webp) | [Before](before/dock-1100-unknown.webp) · [After](after/dock-1100-unknown.webp) |
| Dock | 1280 × 880 | [Before](before/dock-1280-submitted.webp) · [After](after/dock-1280-submitted.webp) | [Before](before/dock-1280-unknown.webp) · [After](after/dock-1280-unknown.webp) |

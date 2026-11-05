# User image caption alignment

Synthetic HistoryConversationView fixture, using the production components and
emitted CSS. No provider or device data is used. The shared message view is used
by History and conversation panes, including session tiles.

Base production: `ec6cb301d6d34e27d857592696641021a6e37a43`. Run the updated
`packages/ui/test/outgoingLayout.browser.test.ts` against that unchanged CSS
for the base, and against the single auto-margin change for the head.

Chrome 153.0.8010.47; exact iframe viewports are 384 × 1500 and 1280 × 1500.
Screenshots use an 800 px minimum outer browser width because Chrome clamps
narrow windows. The 384 px content occupies the left side of its capture.
The captures focus on the user rows; the JSON includes every row, including
agent controls below the captured area.

| Viewport | Before | After | Before geometry | After geometry |
| --- | --- | --- | --- | --- |
| 384 px | [Base](base/outgoing-384.png) | [Head](head/outgoing-384.png) | [Base measurements](base/outgoing-384.json) | [Head measurements](head/outgoing-384.json) |
| 1280 px | [Base](base/outgoing-1280.png) | [Head](head/outgoing-1280.png) | [Base measurements](base/outgoing-1280.json) | [Head measurements](head/outgoing-1280.json) |

| Case | 384 px caption right edge, base → head | 1280 px caption right edge, base → head |
| --- | --- | --- |
| Wider image | 250.438 → 368 | 604.359 → 1264 |
| Multi-line caption | 244.844 → 368 | 1140.844 → 1264 |
| Narrower image | 368 → 368 | 1264 → 1264 |
| Several images | 271.828 → 368 | 625.750 → 1264 |

The image and plain user bubble right edges are 368 and 1264 px respectively.
The meaningful RED run fails at the wider-image caption assertion at both
widths; the changed CSS passes all cases without horizontal overflow.

The image-only user row, plain user row, agent text row and agent image row have
identical complete measurements before and after. For every row, article,
outer bubble, image and timestamp rectangles are also identical. Each user row
keeps exactly one timestamp to the left of its bubble, preserving the shipped
#305 behavior as clarified in #324. Only the caption position changes.

Reproduce from `packages/ui` with Node 24 and installed workspace dependencies:

```bash
TMPDIR=/tmp NODE_OPTIONS=--conditions=source node --test test/outgoingLayout.browser.test.ts
```

Set `AGENT_CONSOLE_UI_SCREENSHOT_DIR` to a configured output directory to retain
screenshots and JSON. On Linux use the contributor memory-limited scope.
Native shells, physical devices and live provider conversations are unverified;
these captures establish headless synthetic layout only.

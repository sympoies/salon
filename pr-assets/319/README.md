# Conversation image retention evidence

The fixture renders thirteen synthetic image messages through the production
component, observer and CSS. One image always returns HTTP 503. It scrolls to
the last message and back, holding redundant reads so the loading flash is
visible. The same fixture and interaction run against both versions.

- Base product: `ce7875699d56c58566f0d5ea4c4d97e01be56010`.
- Head product: the commit containing these captures.
- Browser: Google Chrome 153.0.8010.47, headless, device scale 1.
- Viewports: 384 × 960 and 1280 × 960.

| Width | Base | Head |
| --- | --- | --- |
| 384 px | [Before](base/conversation-images-384.png) | [After](head/conversation-images-384.png) |
| 1280 px | [Before](base/conversation-images-1280.png) | [After](head/conversation-images-1280.png) |

At both widths the base loses the second image and requests it twice; the head
keeps it visible and requests it once. The base labels the 503 as unavailable;
the head shows “Couldn't load” with Retry. Neither version overflows horizontally.
The adjacent JSON files contain those measurements.

The regression lives in
[the browser test](../../packages/ui/test/conversationImageRetention.browser.test.ts).
Run it from `packages/ui` with `NODE_OPTIONS=--conditions=source` and
`TMPDIR=/tmp`; set `AGENT_CONSOLE_UI_SCREENSHOT_DIR` to the capture destination.
On Linux, use the memory scope documented in [Development](../../DEVELOPMENT.md).
For a base comparison, copy only this test into an isolated checkout of the
base product, install its frozen dependencies and build its packages first.

The shared component serves History, the conversation pane, phone and desktop
tiles. These captures cover its shared message presentation. Separate sizing
checks cover 360, 600, 601 and 1440 px, including both sides of the image column
breakpoint and a reload after real cache eviction. Toolbar and outgoing bubble
fixtures retain their existing viewport coverage. Native shells, real devices
and provider sessions have not been exercised by this evidence; packaged-client
acceptance remains with the designated tester.

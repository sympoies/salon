import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { createUiSsrHarness } from "./support/ssr.ts";

const ssr = createUiSsrHarness({ ssr: { noExternal: ["markdown-to-jsx"] } });
after(async () => { await ssr.close(); });

test("the day separator reads Today for the current day and keeps the date format for other days", async () => {
  const { messageDayLabel } = await ssr.loadModule<typeof import("../src/HistoryConversation.tsx")>("/src/HistoryConversation.tsx");
  const now = new Date(2026, 9, 29, 15, 0);
  assert.equal(messageDayLabel(new Date(2026, 9, 29, 0, 5), now), "Today");
  assert.equal(messageDayLabel(new Date(2026, 9, 29, 23, 59), now), "Today");
  assert.equal(messageDayLabel(new Date(2026, 9, 28, 23, 59), now), "2026/10/28");
  assert.equal(messageDayLabel(new Date(2025, 0, 3, 9, 0), now), "2025/1/3");
});

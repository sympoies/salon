import { strict as assert } from "node:assert";
import { test } from "node:test";
import { imageCaption } from "../src/providerImageLabels.ts";

test("attachment captions preserve Markdown whitespace outside provider labels", () => {
  const caption = "    sample()\n";
  assert.equal(imageCaption(caption, 1), caption, "label-free code indentation is unchanged");
  assert.equal(imageCaption(`[Image #1]\n${caption}`, 1), `\n${caption}`, "removing a label preserves caption formatting");
});

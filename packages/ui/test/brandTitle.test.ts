import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const source = readFileSync(new URL("../src/BrandTitle.tsx", import.meta.url), "utf8");

test("BrandTitle renders the product name with title casing", () => {
  assert.match(source, /<h1>Agent Console<\/h1>/);
  assert.doesNotMatch(source, /<h1>agent-console<\/h1>/);
});

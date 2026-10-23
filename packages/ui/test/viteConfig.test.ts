import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import config from "../vite.config.ts";

test("embedded diagnostic version matches the release app version", () => {
  const rootPackage = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  assert.equal(config.define?.__AGENT_CONSOLE_APP_VERSION__, JSON.stringify(rootPackage.version));
});

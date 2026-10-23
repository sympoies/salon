import { strict as assert } from "node:assert";
import { test } from "node:test";
import { projectPublicAgentSession } from "../src/api.ts";
import { normalizeSessionModelSettings, sessionModelLabel } from "../src/sessionModel.ts";

test("namespaced model IDs survive normalization, projection, and display", () => {
  for (const model of ["meta-llama/llama-3.1-8b-instruct", "hf.co/org/model", "org/local-model:8b", `org/${"m".repeat(124)}`]) {
    assert.deepEqual(normalizeSessionModelSettings({ model, reasoning_effort: "high" }), { model, reasoning_effort: "high" });
    assert.equal(projectPublicAgentSession({ id: "session", agent: "dsh", model }).model, model);
    assert.equal(sessionModelLabel({ model }), `${model} · unknown`);
  }
});

test("namespace separators preserve bounded metadata sanitization", () => {
  for (const model of [
    "/private/model", "./model", "../model", "org/../model", "org/./model", "org//model", "org/",
    "org\\model", "https://org/model", "org/model?token=canary", "org/model\n", `org/${"m".repeat(125)}`,
    "sk-canary/model", "hf_canary/model", "org/sk-canary", "org/ghp_canary", "org/hf_canary", "org/eyJcanary",
  ]) {
    assert.deepEqual(normalizeSessionModelSettings({ model, reasoning_effort: "medium" }), { model: null, reasoning_effort: "medium" });
  }
});

test("public model credentials stay unknown in every namespace component", () => {
  for (const credential of [
    "sk_live_synthetic_canary", "sk_test_synthetic_canary", "pk_live_synthetic_canary",
    "rk_live_synthetic_canary", "pypi-synthetic-canary", "123456:synthetic_public_canary",
  ]) {
    for (const model of [credential, `org/${credential}`]) {
      assert.deepEqual(normalizeSessionModelSettings({ model, reasoning_effort: "medium" }), { model: null, reasoning_effort: "medium" });
      assert.equal(projectPublicAgentSession({ id: "session", agent: "dsh", model }).model, null);
      assert.equal(sessionModelLabel({ model, reasoning_effort: "medium" }), "unknown · medium");
    }
  }
});

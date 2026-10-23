import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeRoleCatalog } from "../src/roleCatalog.ts";

const tester = {
  id: "tester", aliases: [], name: { zh: "測試員", en: "Tester" },
  icon: [{ tag: "path", d: "M9 3h6", "stroke-width": "2" }, { tag: "circle", cx: "12", cy: "12", r: "3", fill: "currentColor" }],
};

test("the generic role catalog keeps ids, aliases, both names and static icon geometry", () => {
  const catalog = normalizeRoleCatalog({ schema_version: "agent-console.role-catalog.v1", roles: [tester, { ...tester, id: "local-model", aliases: ["local"] }] });
  assert.deepEqual(catalog, { schema_version: "agent-console.role-catalog.v1", roles: [tester, { ...tester, id: "local-model", aliases: ["local"] }] });
});

test("the role catalog rejects active content, resource references and malformed entries", () => {
  assert.equal(normalizeRoleCatalog({ schema_version: "agent-console.role-catalog.v2", roles: [tester] }), undefined);
  assert.equal(normalizeRoleCatalog({ schema_version: "agent-console.role-catalog.v1", roles: "tester" }), undefined);
  const hostile = [
    { ...tester, icon: [{ tag: "script", d: "M0 0" }] },
    { ...tester, icon: [{ tag: "path", d: "M0 0", onload: "alert(1)" }] },
    { ...tester, icon: [{ tag: "path", d: "M0 0", fill: "url(https://example.test/x)" }] },
    { ...tester, icon: [{ tag: "path", d: "M0 0", fill: "u\\72l(/x)" }] },
    { ...tester, icon: [{ tag: "image", href: "https://example.test/x" }] },
    { ...tester, icon: [] },
    { ...tester, id: "Bad Id" },
    { ...tester, name: { zh: "測試員" } },
    { ...tester, name: { zh: "測試員", en: "x\u0000" } },
  ];
  const catalog = normalizeRoleCatalog({ schema_version: "agent-console.role-catalog.v1", roles: [...hostile, { ...tester, id: "reviewer" }] });
  assert.deepEqual(catalog?.roles.map(role => role.id), ["reviewer"], "hostile entries are dropped one by one");
});

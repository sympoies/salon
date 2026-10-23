import { strict as assert } from "node:assert";
import { test } from "node:test";
import { selectMachines } from "../src/config.ts";
import type { MachineConfig } from "../src/config.ts";

const m = (n: string): MachineConfig => ({ name: n, url: `http://127.0.0.1/${n}`, token: `${n}-tok` });
const all = [m("summit"), m("mesa")];

test("absent param (null) -> all machines (backward compatible)", () => {
  assert.deepEqual(selectMachines(all, null).map((x) => x.name), ["summit", "mesa"]);
});

test("allowlist filters to the named machines, preserving config order", () => {
  assert.deepEqual(selectMachines(all, "summit").map((x) => x.name), ["summit"]);
  assert.deepEqual(selectMachines(all, "mesa,summit").map((x) => x.name), ["summit", "mesa"]);
});

test("unknown names are ignored", () => {
  assert.deepEqual(selectMachines(all, "ghost,mesa").map((x) => x.name), ["mesa"]);
});

test("empty param (client asked for none) -> no machines", () => {
  assert.deepEqual(selectMachines(all, "").map((x) => x.name), []);
});

test("whitespace and empty entries are tolerated", () => {
  assert.deepEqual(selectMachines(all, " summit , ,mesa ").map((x) => x.name), ["summit", "mesa"]);
});

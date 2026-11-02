import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseRuntimeCommand, projectPublicAgentSession } from "../src/index.ts";

const TITLES: Array<[string, string]> = [
  ["/compact", "Compacting context"],
  ["/exit", "Session restarting"],
  ["/quit", "Session quitting"],
  ["/effort", "Changing effort"],
  ["/model", "Changing model"],
  ["/usage", "Showing usage"],
  ["/login", "Signing in"],
  ["/clear", "Clearing context"],
  ["/new", "Starting a new thread"],
];

test("each runtime command, with or without arguments, names its action", () => {
  for (const [command, title] of TITLES) {
    assert.deepEqual(parseRuntimeCommand(command), { command, title, text: command });
    assert.deepEqual(parseRuntimeCommand(`  ${command} some args \n`), { command, title, text: `${command} some args` });
  }
  assert.equal(parseRuntimeCommand("/compact focus on tests")?.title, "Compacting context");
});

test("other slash text stays an ordinary message", () => {
  for (const text of ["/etc/hosts is unreadable", "/modeling", "/compactx", "/unknown arg", "/", "//exit", "please /exit",
    "/compact\nand then more", "/model gpt\n\nplease explain", ""]) {
    assert.equal(parseRuntimeCommand(text), null, text);
  }
});

test("the card preview follows the same rule for the last prompt and last message", () => {
  const preview = (text: string, field: "last_prompt" | "last_message" = "last_prompt") => {
    const session = projectPublicAgentSession({ id: "s", agent: "claude", [field]: field === "last_message" ? { role: "user", text } : { text } });
    return (session[field] as { text: string } | undefined)?.text;
  };
  assert.equal(preview("/exit"), "Command: Session restarting (/exit)");
  assert.equal(preview("/compact focus on tests", "last_message"), "Command: Compacting context (/compact focus on tests)");
  assert.equal(preview("/etc/hosts is unreadable"), "/etc/hosts is unreadable");
});

import { unwrapPastedContent } from "./pastedContent.ts";

/** Slash commands that act on the runtime. Add a command here to join the rule. */
const RUNTIME_COMMANDS: Readonly<Record<string, string>> = {
  compact: "Compacting context",
  exit: "Session restarting",
  quit: "Session quitting",
  effort: "Changing effort",
  model: "Changing model",
  usage: "Showing usage",
  login: "Signing in",
  clear: "Clearing context",
  new: "Starting a new thread",
};

export interface RuntimeCommand {
  readonly command: string;
  readonly title: string;
  /** The command as sent, trimmed, arguments included. */
  readonly text: string;
}

/** A single-line message that is a listed runtime command, with or without arguments. */
export function parseRuntimeCommand(message: string): RuntimeCommand | null {
  const text = unwrapPastedContent(message).trim();
  const match = /^\/([a-z]+)(?:[ \t][^\n]*)?$/.exec(text);
  const name = match?.[1];
  if (!name || !Object.hasOwn(RUNTIME_COMMANDS, name)) return null;
  return { command: `/${name}`, title: RUNTIME_COMMANDS[name]!, text };
}

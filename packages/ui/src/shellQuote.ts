function singleQuoteForTerminal(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function shellQuoteForTerminalArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : singleQuoteForTerminal(value);
}

// Quote a path for safe insertion into a POSIX shell command line. The whole
// path is wrapped in single quotes and any embedded single quote is escaped as
// '\'' so a hostile attachment filename cannot close the quote and inject
// terminal commands. Everything else ($, ;, &&, backticks, |, spaces) is
// literal inside single quotes.
export function shellQuotePathForTerminal(path: string): string {
  return singleQuoteForTerminal(path);
}

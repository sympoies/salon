// Sanitized command shapes from terminalClipboard.test.ts and clipboardModel.test.ts.
// These are reproducible renderer fixtures, not captures from a private session.
export const commands = [
  'git -C ~/repo status --short',
  'semantic-commit commit --type fix --scope ui --subject "Preserve the complete selected command when Codex renders it across terminal rows"',
  'curl --fail --location "https://example.test/api/results?query=terminal%20copy&next=%2Fhome%3Fa%3D1%26b%3D2#section"',
  'printf "%s" "two  spaces" && git -C ~/repo status --short',
];
export const urls = [
  'https://example.test/path/to/very-long-destination?mode=full&query=a%20b&next=%2Fhome%3Fa%3D1%26b%3D2#section',
  'https://example.test/' + 'x'.repeat(59) + '/resource.html?download=1&name=a%20b',
];

// TUI word-wrap: the renderer adds two spaces, and breaks between words.
export function wordWrap(text: string, columns: number): string {
  const rows: string[] = [];
  let remaining = text;
  let prefix = '';
  while (prefix.length + remaining.length > columns) {
    const boundary = remaining.lastIndexOf(' ', columns - prefix.length);
    if (boundary < 1) break; // A long token is handled by the terminal soft wrap.
    rows.push(prefix + remaining.slice(0, boundary));
    remaining = remaining.slice(boundary + 1);
    prefix = '  ';
  }
  return [...rows, prefix + remaining].join('\n');
}

export function characterWrap(text: string, columns: number): string[] {
  return text.match(new RegExp('.{1,' + columns + '}', 'gu')) ?? [];
}

export function boxWrap(text: string, columns: number): string {
  const width = columns - 4;
  return ['┌' + '─'.repeat(columns - 2) + '┐',
    ...wordWrap(text, width).split('\n').map(row => '│ ' + row.padEnd(width) + ' │'),
    '└' + '─'.repeat(columns - 2) + '┘'].join('\n');
}

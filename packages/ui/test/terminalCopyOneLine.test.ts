import { strict as assert } from "node:assert";
import { test } from "node:test";
import { copyTerminalAsOneLine, readTerminalSelection } from "../src/terminalClipboard.ts";
import { commands, urls, wordWrap, characterWrap, boxWrap } from "./fixtures/terminalCopyCorpus.ts";
import type { Terminal } from "@xterm/xterm";

for (const columns of [80, 40]) {
  for (const command of commands) {
    test(`one-line command at ${columns} columns: ${command.slice(0, 30)}`, () => {
      assert.equal(copyTerminalAsOneLine(wordWrap(command, columns)).text, command);
      assert.equal(copyTerminalAsOneLine(boxWrap('$ ' + command, columns)).text, command);
    });
    test(`soft-wrapped command at ${columns} columns preserves every byte`, () => {
      const rows = characterWrap(command, columns);
      const term = {
        getSelection: () => '',
        getSelectionPosition: () => ({ start: { x: 0, y: 0 }, end: { x: rows.at(-1)!.length, y: rows.length - 1 } }),
        buffer: { active: { getLine: (y: number) => rows[y] === undefined ? undefined : ({
          length: columns, isWrapped: y > 0,
          translateToString: (trim: boolean, start: number, end: number) => {
            const value = rows[y]!.slice(start, end);
            return trim ? value.trimEnd() : value;
          },
        }) } },
      } as unknown as Terminal;
      assert.equal(copyTerminalAsOneLine(readTerminalSelection(term)).text, command);
    });
  }
  for (const url of urls) {
    test(`query URL at ${columns} columns`, () => {
      const rows = characterWrap(url, columns);
      for (const indent of ['', '  ', '    ']) {
        const wrapped = rows.map((row, i) => (i ? indent : '') + row).join('\n') + '\n';
        assert.equal(copyTerminalAsOneLine(wrapped).text, url);
      }
    });
  }
  test(`backslash-continuation command in a ${columns}-column box`, () => {
    const lines = ['$ curl --fail \\', '  --location \\', '  https://example.test/data?format=json&limit=40'];
    const wrapped = lines.map(line => boxWrap(line, columns)).join('\n');
    assert.equal(copyTerminalAsOneLine(wrapped).text, 'curl --fail --location https://example.test/data?format=json&limit=40');
  });
}

test('URL wraps at slash, file-extension, query, and fragment boundaries', () => {
  for (const boundary of ['/', '.html', '?', '&', '#']) {
    const head = 'https://example.test/' + 'x'.repeat(70) + boundary;
    assert.equal(copyTerminalAsOneLine(head + '\n  rest').text, head + 'rest');
  }
});

test('one-line copy strips prompt and leaves argument spacing and literal backslashes intact', () => {
  assert.equal(copyTerminalAsOneLine('$ printf "%s" "two  spaces"\n  "C:\\tmp"').text, 'printf "%s" "two  spaces" "C:\\tmp"');
  assert.equal(copyTerminalAsOneLine('curl --fail \\\n  --location https://example.test/data').text, 'curl --fail --location https://example.test/data');
});

test('a URL embedded in a command spans three hard rows without changing its query', () => {
  const url = urls[0]!;
  const fragments = characterWrap(url, 30);
  const wrapped = 'curl --location "' + fragments.join('\n  ') + '"\n  --fail';
  assert.equal(copyTerminalAsOneLine(wrapped).text, 'curl --location "' + url + '" --fail');
});

test('shell continuation preserves token boundaries and double-quoted indentation', () => {
  assert.equal(copyTerminalAsOneLine('printf foo\\\n  bar').text, 'printf foo bar');
  assert.equal(copyTerminalAsOneLine('printf foo\\\nbar').text, 'printf foobar');
  assert.equal(copyTerminalAsOneLine('printf "%s" "a\\\n  b"').text, 'printf "%s" "a  b"');
  assert.equal(copyTerminalAsOneLine("printf '%s' 'a\\\n  b'").text, "printf '%s' 'a\\ b'");
});

test('word-wrap between positional arguments keeps its separating space', () => {
  assert.equal(copyTerminalAsOneLine('git clone https://example.test/org/repo.git\n  checkout').text, 'git clone https://example.test/org/repo.git checkout');
  assert.equal(copyTerminalAsOneLine('curl https://example.test/\n  --fail').text, 'curl https://example.test/ --fail');
  assert.equal(copyTerminalAsOneLine('cp /tmp/source\n  /tmp/destination').text, 'cp /tmp/source /tmp/destination');
  assert.equal(copyTerminalAsOneLine('cp /tmp/source/\n  /tmp/destination').text, 'cp /tmp/source/ /tmp/destination');
});

test('quoted URL and path fragments rejoin at every hard-wrap offset', () => {
  for (const token of [
    'https://example.test/login?redirect=https://other.test/callback&token=abc--danger#here',
    '/home/runner/Project/README.md',
  ]) {
    for (let offset = 1; offset < token.length; offset++) {
      // The scheme/root itself must be observable before token joining applies.
      if (token.startsWith('https:') && offset < 8) continue;
      const wrapped = 'cat "' + token.slice(0, offset) + '\n  ' + token.slice(offset) + '"';
      assert.equal(copyTerminalAsOneLine(wrapped).text, 'cat "' + token + '"', `offset ${offset}`);
    }
  }
});

test('compact box rails and bounded PS1 prefixes are removed, argument symbols remain', () => {
  assert.equal(copyTerminalAsOneLine('┌──────┐\n│$ git │\n│status│\n└──────┘').text, 'git status');
  assert.equal(copyTerminalAsOneLine('user@host:~/repo$ git status\n  --short').text, 'git status --short');
  assert.equal(copyTerminalAsOneLine('root@host:/repo# git status\n  --short').text, 'git status --short');
  assert.equal(copyTerminalAsOneLine('printf "%s" "$HOME #tag │"').text, 'printf "%s" "$HOME #tag │"');
  assert.equal(copyTerminalAsOneLine('printf "%s" x | cat').text, 'printf "%s" x | cat');
});

test('unquoted rows keep argument boundaries for URLs, directories and executable paths', () => {
  for (const [wrapped, expected] of [
    ['git clone https://example.test/org/repo/\n  checkout', 'git clone https://example.test/org/repo/ checkout'],
    ['cp /tmp/source/\n  destination', 'cp /tmp/source/ destination'],
    ['./build.sh\n  --verbose', './build.sh --verbose'],
    ['/bin/echo\n  hello', '/bin/echo hello'],
  ]) assert.equal(copyTerminalAsOneLine(wrapped).text, expected);
  assert.equal(copyTerminalAsOneLine('cat "/home/runner/Project/\n  .env"').text, 'cat "/home/runner/Project/.env"');
});

test('large quoted URL and word-wrap selections avoid rescanning the growing result', () => {
  const fragments = Array.from({ length: 1000 }, () => 'a'.repeat(79));
  const quoted = 'curl "https://example.test/' + fragments.join('\n  ') + '"';
  const started = performance.now();
  assert.equal(copyTerminalAsOneLine(quoted).text, 'curl "https://example.test/' + fragments.join('') + '"');
  assert.equal(copyTerminalAsOneLine(fragments.join('\n  ')).text, fragments.join(' '));
  assert.ok(performance.now() - started < 500, 'two 79 KB selections should not block the UI for seconds');
});

test('a shell continuation before a quoted URL keeps its token state', () => {
  assert.equal(copyTerminalAsOneLine('curl \\\n"https://example.test/long-\n  path"').text, 'curl "https://example.test/long-path"');
});

test('option and assignment prefixes retain a quoted URL or path across hard rows', () => {
  assert.equal(copyTerminalAsOneLine('curl --url="https://example.test/long-\n  path?q=1"').text, 'curl --url="https://example.test/long-path?q=1"');
  assert.equal(copyTerminalAsOneLine('OUT="/home/runner/Project/\n  README.md" command').text, 'OUT="/home/runner/Project/README.md" command');
  assert.equal(copyTerminalAsOneLine('cat "/home/runner/My Project/\n  README.md"').text, 'cat "/home/runner/My Project/README.md"');
});

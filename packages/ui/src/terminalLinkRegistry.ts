import { validateTerminalUrl } from "./terminalLinks.ts";

// Harvest OSC 8 hyperlink targets out of the terminal byte stream.
//
// xterm's public API does not expose a cell's hyperlink (`IBufferCell` has no
// accessor for it), so nothing can enumerate OSC 8 links from the buffer. The
// stream is the only place the URI appears verbatim — and it appears there
// whole, because an OSC 8 target is metadata that never wraps. A label the
// inner TUI hard-wrapped, or a label that is not a URL at all, still carries
// one intact URI here. That is what lets the picker offer links no amount of
// text scanning at a cell could resolve.
//
// This deliberately does NOT harvest implicit (plain-text) URLs: those are
// subject to the wrapping the buffer-side resolver already handles, with the
// budgets and the hard-wrap heuristic that live in terminalLinks.ts.
//
// Scope: only bytes that cross the wire while this terminal instance is
// attached. The registry is created per instance, so a reconnect or scrollback
// rebuild starts it empty and it refills from whatever the attach replay
// carries. That replay is a tmux capture, which is plain text unless the daemon
// passes -e (nils-cli 1.27.26 and later); against an older daemon the list
// starts empty after every attach.

export interface TerminalLinkEntry {
  // The OSC 8 target. Always http/https: anything else is dropped on ingest.
  readonly url: string;
  // The visible text the link was painted with, whitespace-collapsed. May be
  // empty when the label was blank or arrived without printable characters.
  readonly label: string;
}

export interface TerminalLinkRegistry {
  ingest: (text: string) => void;
  // Newest first, deduplicated by URL.
  list: () => readonly TerminalLinkEntry[];
  clear: () => void;
}

const OSC8_INTRODUCER = "\x1b]8;";
// Labels are for recognition in a list, not for reproduction.
const MAX_LABEL_LENGTH = 120;
// Bound the carry so a stream that never terminates a sequence cannot grow it
// without limit.
const MAX_CARRY_LENGTH = 4096;

function collapseLabel(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
}

interface OscBody {
  // Index just past the sequence.
  readonly end: number;
  // The body text, or null when the sequence was cancelled and the terminal
  // will not act on it either.
  readonly body: string | null;
}

// Where an OSC string starting at `from` ends, matching how xterm terminates
// one. Anything looser and the picker can list a target the terminal never
// created a hyperlink for, or miss the one it did: xterm ends the string on
// BEL, ST, or ANY escape, and CAN/SUB cancel it outright. Returns null when the
// terminator has not arrived yet.
function endOfOscBody(text: string, from: number): OscBody | null {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\x07") {
      return { end: i + 1, body: text.slice(from, i) };
    }
    if (ch === "\x18" || ch === "\x1a") {
      // Cancelled: xterm drops the sequence, so this must record nothing.
      return { end: i + 1, body: null };
    }
    if (ch === "\x1b") {
      if (i + 1 >= text.length) {
        // The terminator may still be split across chunks.
        return null;
      }
      // ESC \ is ST and belongs to the sequence; any other escape ends the
      // string and is re-dispatched from where it starts.
      return text[i + 1] === "\\"
        ? { end: i + 2, body: text.slice(from, i) }
        : { end: i, body: text.slice(from, i) };
    }
  }
  return null;
}

// C0 controls inside an OSC body are ignored by xterm's parser rather than
// becoming URI characters, so strip them before validating or the picker would
// display and open a percent-encoded variant of a different URL.
function stripControls(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, "");
}

// Index just past a non-OSC escape sequence beginning at `at`, or -1 when it is
// still incomplete. Runs for every escape in the stream that is not an OSC.
// Deliberate simplification: string sequences other than OSC (DCS, APC, PM,
// SOS) are not tracked, so their bodies are scanned as ordinary text. That
// matches what xterm does with an embedded escape anyway — an ESC breaks out of
// those states there too — so the two stay in agreement.
function endOfEscape(text: string, at: number): number {
  if (text[at + 1] === undefined) {
    return -1;
  }
  if (text[at + 1] !== "[") {
    return at + 2;
  }
  for (let i = at + 2; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) {
      return i + 1;
    }
  }
  return -1;
}

export function createTerminalLinkRegistry({
  maxLinks = 64,
}: { readonly maxLinks?: number } = {}): TerminalLinkRegistry {
  // Newest first.
  let entries: TerminalLinkEntry[] = [];
  let carry = "";
  let openUrl: string | null = null;
  let openLabel = "";

  const record = (url: string, label: string) => {
    const next = entries.filter((entry) => entry.url !== url);
    next.unshift({ url, label });
    entries = next.slice(0, maxLinks);
  };

  const closeOpenLink = () => {
    if (openUrl) {
      record(openUrl, collapseLabel(openLabel));
    }
    openUrl = null;
    openLabel = "";
  };

  return {
    ingest(text) {
      const scan = carry + text;
      carry = "";
      let i = 0;
      while (i < scan.length) {
        if (scan[i] !== "\x1b") {
          if (openUrl !== null && openLabel.length < MAX_LABEL_LENGTH * 4) {
            openLabel += scan[i];
          }
          i += 1;
          continue;
        }
        const stall = () => {
          // Incomplete at the chunk boundary: keep it for the next chunk rather
          // than consuming a partial sequence and losing the link behind it.
          carry = scan.slice(i);
          if (carry.length > MAX_CARRY_LENGTH) {
            carry = "";
          }
        };
        // An OSC must be recognized before the OSC 8 test: a chunk can end on a
        // bare ESC ] with the `8;` still to come, and stepping over that as a
        // two-byte escape would swallow the introducer.
        if (scan[i + 1] === undefined || (scan[i + 1] === "]" && !scan.startsWith(OSC8_INTRODUCER, i) && OSC8_INTRODUCER.startsWith(scan.slice(i)))) {
          stall();
          return;
        }
        if (scan[i + 1] === "]") {
          const osc = endOfOscBody(scan, i + 2);
          if (!osc) {
            stall();
            return;
          }
          if (osc.body !== null && scan.startsWith(OSC8_INTRODUCER, i)) {
            // Body is `params;URI`; treat everything after the first `;` as the
            // URI so a malformed params field cannot smuggle one past.
            const body = osc.body.slice(OSC8_INTRODUCER.length - 2);
            const separator = body.indexOf(";");
            const uri = separator >= 0 ? stripControls(body.slice(separator + 1)) : "";
            closeOpenLink();
            // validateTerminalUrl is the one URL-semantics owner: it enforces
            // the scheme allowlist and the length bound.
            const safe = validateTerminalUrl(uri);
            if (safe) {
              openUrl = safe;
              openLabel = "";
            }
          }
          i = osc.end;
          continue;
        }
        const end = endOfEscape(scan, i);
        if (end < 0) {
          stall();
          return;
        }
        i = end;
      }
    },
    list() {
      // A link is offered only once its closing sequence has arrived. Offering
      // the open one looked helpful, but a sequence that is never closed stays
      // open forever, pins itself first, and adopts every later line as its
      // caption — so untrusted output could pair an arbitrary target with a
      // trustworthy-looking one. Real output closes its hyperlinks immediately.
      return entries;
    },
    clear() {
      entries = [];
      carry = "";
      openUrl = null;
      openLabel = "";
    },
  };
}

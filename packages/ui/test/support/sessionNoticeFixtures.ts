// Synthetic corpus for the nils-cli#2986 issue draft read on 2026-10-26.
// No upstream spec file or corpus was published at that revision. Header values
// are non-empty printable ASCII tokens; field order and spaces are exact.
export const header = '<!-- agent-notice:v1 kind=mailbox source=fixture -->';
export const validNotices = [
  { name: "without id", raw: `${header}\n\nSynthetic body`, kind: "mailbox", source: "fixture", body: "Synthetic body" },
  { name: "with id and CRLF", raw: '<!-- agent-notice:v1 kind=runtime.resume source=fixture id=sample-1 -->\r\n\r\nBody\r\nunchanged\r\n', kind: "runtime.resume", source: "fixture", id: "sample-1", body: "Body\r\nunchanged\r\n" },
  { name: "empty body", raw: `${header}\n\n`, kind: "mailbox", source: "fixture", body: "" },
  { name: "double header stays body", raw: `${header}\n\n${header}\n\nBody`, kind: "mailbox", source: "fixture", body: `${header}\n\nBody` },
  { name: "unknown", raw: '<!-- agent-notice:v1 kind=future.kind source=fixture -->\n\nBody', kind: "future.kind", source: "fixture", body: "Body" },
  { name: "spoofed markup", raw: '<!-- agent-notice:v1 kind=<script> source=<b> -->\n\nBody', kind: "<script>", source: "<b>", body: "Body" },
];
export const ordinaryMessages = [
  { name: "human", raw: "Synthetic human message" },
  { name: "unknown version", raw: header.replace(":v1", ":v2") + "\n\nBody" },
  { name: "unversioned", raw: header.replace(":v1", "") + "\n\nBody" },
  { name: "no blank line", raw: header + "\nBody" },
  { name: "blank has spaces", raw: header + "\n \nBody" },
  { name: "not first line", raw: "Intro\n" + header + "\n\nBody" },
  { name: "indented code", raw: "    " + header + "\n\nBody" },
  { name: "fenced code", raw: "```text\n" + header + "\n\nBody\n```" },
  { name: "inline code", raw: "`" + header + "`\n\nBody" },
  { name: "quoted", raw: "> " + header + "\n\nBody" },
  { name: "legacy prefix", raw: "[agent-notice] Synthetic body" },
  { name: "pasted wrapper", raw: '<pasted_content id="sample">\n' + header + '\n\nBody\n</pasted_content id="sample">' },
  { name: "reordered fields", raw: '<!-- agent-notice:v1 source=fixture kind=mailbox -->\n\nBody' },
  { name: "extra metadata", raw: header.replace(" -->", " extra=value -->") + "\n\nBody" },
  { name: "empty field", raw: header.replace("mailbox", "") + "\n\nBody" },
  { name: "control metadata", raw: header.replace("mailbox", "mail\tbox") + "\n\nBody" },
  { name: "non ASCII metadata", raw: header.replace("mailbox", "\u00e9") + "\n\nBody" },
  { name: "oversized header", raw: header.replace("mailbox", "x".repeat(512)) + "\n\nBody" },
  { name: "trailing header text", raw: header + " trailing\n\nBody" },
];

export const MAX_TITLE_CHARS = 120;

const TITLE_SEPARATOR = " - ";
const TITLE_BASE_INTERNAL_SEPARATOR = " — ";
const TITLE_ACTION_SEPARATORS = [TITLE_SEPARATOR, " — ", " – "] as const;
const MIN_SUFFIX_CHARS = 32;
const MAX_TITLE_REFERENCES = 2;
const TITLE_REFERENCE_PATTERN = /^(?:[a-z][a-z0-9._-]{1,63} )?#[1-9]\d{0,9}$/;
const SKILL_INVOCATION_PATTERN = /^[$/]([a-z][a-z0-9:_-]*)(?:\s+(.+))?$/;

const GENERIC_LONG_TOKEN_PATTERN = /\b[A-Za-z0-9+\/_=-]{40,}\b/g;
const LONG_TOKEN_SEGMENT_SEPARATOR = /[-_/]+/;
// A word or date part: a lowercase-led or camelCase word, or a 1-4 digit number.
// All-caps groups, digit-mixed runs, and `=`/`+` are excluded so license keys,
// base64, and hex digests keep failing closed.
const LONG_TOKEN_WORD_SEGMENT_PATTERN = /^(?:\d{1,4}|[A-Za-z][a-z]+(?:[A-Z][a-z]+)*)$/;
const WEB_URL_PATTERN = /https?:\/\/[^\s"'`<>]+/gi;
const SENSITIVE_URL_PARAMETER_NAME_PATTERN = /^(?:pass(?:word)?|passwd|pwd|token|secret|auth(?:orization)?|credential|(?:api|access|private)[\s_-]*key|(?:[a-z0-9]+[\s_-]+)+(?:token|secret)|database_url|redis_url|sentry_dsn|dsn|connection_?string|mongo(?:db)?_uri|postgres(?:_?url)?|mysql(?:_?url)?)$/i;
// A credential label anywhere on the line makes an adjacent opaque run a named
// secret, so the line is vetoed instead of salvaged even when no assignment
// pattern above matches (`Set token <opaque> for the run`).
const CREDENTIAL_LABEL_PATTERN =
  /\b(?:pass(?:word)?|passwd|pwd|token|secret|credential|auth(?:orization)?|(?:api|access|private)(?:\s+|[_-])?key)\b/i;
const SENSITIVE_TITLE_LINE_PATTERNS = [
  /^\s*(?:pass(?:word)?|passwd|pwd|api(?:\s+|[_-])?key|access(?:\s+|[_-])?key|credential|private(?:\s+|[_-])?key)\s+\S+/i,
  /^\s*(?:token|secret)\s+\S+\s*$/i,
  /^\s*(?:token|secret|auth(?:orization)?)\s+(?=\S*[0-9_./+=:@-])\S+/i,
  /\b(?:pass(?:word)?|passwd|pwd|token|secret|api(?:\s+|[_-])?key|access(?:\s+|[_-])?key|auth(?:orization)?|credential|private(?:\s+|[_-])?key)\b\s*[:=]\s*\S+/i,
  /\b(database_url|redis_url|sentry_dsn|dsn|connection_?string|mongo(db)?_uri|postgres(_?url)?|mysql(_?url)?)\b\s*[:=]\s*\S+/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]+@/i,
  /\bhttps?:\/\/[A-Za-z0-9._~+%/-]+@[A-Za-z0-9.-]+/i,
  /\b(?:curl|wget|http)\b[^\r\n]*(?:\s-u\s*|\s--user(?:=|\s+))\S+:\S+/i,
  /\B--(?:pass(word)?|token|secret|api[-_]?key)(?:=|\s+)\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i,
  /\b(?:sk|sk-proj|ghp|github_pat|glpat|xox[baprs]|AKIA)[A-Za-z0-9_-]{8,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
] as const;

export type SessionTitleTopicSource = "none" | "auto" | "user";

export interface SessionTitleState {
  readonly topic: string | null;
  readonly topic_source: SessionTitleTopicSource;
  readonly references: readonly string[];
  readonly activity: string | null;
}

export function oneLineTitle(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const line = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) {
    return null;
  }
  return line.replace(/\s+/g, " ");
}

export function truncateTitle(value: string, maxChars = MAX_TITLE_CHARS): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return chars.slice(0, maxChars).join("");
  }
  return `${chars.slice(0, maxChars - 3).join("")}...`;
}

/**
 * A long run of token characters is credential-like only when it is opaque. A
 * separated sequence of words and date parts — a plan document name, a repo
 * path — carries no secret, so it must not veto the line that mentions it.
 */
function isWordSequenceToken(token: string): boolean {
  const segments = token.split(LONG_TOKEN_SEGMENT_SEPARATOR).filter((segment) => segment !== "");
  return segments.length > 1
    && segments.every((segment) => LONG_TOKEN_WORD_SEGMENT_PATTERN.test(segment));
}

function hasOpaqueLongToken(value: string): boolean {
  for (const match of value.matchAll(GENERIC_LONG_TOKEN_PATTERN)) {
    if (!isWordSequenceToken(match[0])) {
      return true;
    }
  }
  return false;
}

function sensitiveUrlComponent(value: string): boolean {
  return SENSITIVE_TITLE_LINE_PATTERNS.some((pattern) => pattern.test(value))
    || hasOpaqueLongToken(value);
}

function hasSensitiveUrlParameterAssignment(value: string): boolean {
  return value.split(/[&;]/).some((part) => {
    const name = part.match(/^\s*([^=:?#]+)\s*[:=]/)?.[1];
    return name !== undefined && SENSITIVE_URL_PARAMETER_NAME_PATTERN.test(name);
  });
}

function isSensitiveWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      return true;
    }
    for (const [name, parameter] of url.searchParams) {
      if (
        SENSITIVE_URL_PARAMETER_NAME_PATTERN.test(name)
        || sensitiveUrlComponent(`${name}=${parameter}`)
      ) {
        return true;
      }
    }
    if (url.hash) {
      let fragment: string;
      try {
        fragment = decodeURIComponent(url.hash.slice(1));
      } catch {
        return true;
      }
      if (hasSensitiveUrlParameterAssignment(fragment) || sensitiveUrlComponent(fragment)) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

function withoutWebUrls(value: string): string {
  return value.replace(WEB_URL_PATTERN, " ").replace(/\s+/g, " ").trim();
}

function withoutOpaqueLongTokens(value: string): string {
  return value
    .replace(GENERIC_LONG_TOKEN_PATTERN, (token) => (isWordSequenceToken(token) ? token : " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * An explicit credential shape or a credential-bearing URL taints its whole
 * line: the words around it name or describe the secret. Only these signals
 * veto a line outright; a generic opaque run is removable instead.
 */
function hasHardCredentialSignal(line: string): boolean {
  if (SENSITIVE_TITLE_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
    return true;
  }
  const withoutUrls = withoutWebUrls(line);
  if (CREDENTIAL_LABEL_PATTERN.test(withoutUrls) && hasOpaqueLongToken(withoutUrls)) {
    return true;
  }
  const urls = line.match(WEB_URL_PATTERN) ?? [];
  return urls.some((url) => isSensitiveWebUrl(url));
}

export function isSensitiveTitleLine(line: string): boolean {
  return hasHardCredentialSignal(line) || hasOpaqueLongToken(withoutWebUrls(line));
}

export function safeTitleLine(value: string | null | undefined): string | null {
  const suffix = oneLineTitle(value);
  if (!suffix || hasHardCredentialSignal(suffix)) {
    return null;
  }
  // Drop ordinary URLs and opaque runs, then re-check: the remaining task words
  // stay usable instead of losing the line to one unrecognized token.
  const salvaged = oneLineTitle(withoutOpaqueLongTokens(withoutWebUrls(suffix)));
  return salvaged && !isSensitiveTitleLine(salvaged) ? salvaged : null;
}

export function promptTitleSuffix(prompt: string): string | null {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstLine = lines[0];
  if (!firstLine) {
    return null;
  }
  const skill = SKILL_INVOCATION_PATTERN.exec(firstLine);
  if (!skill) {
    const suffix = safeTitleLine(firstLine);
    return suffix ? truncateTitle(suffix) : null;
  }
  if (hasHardCredentialSignal(firstLine)) {
    return null;
  }
  const skillName = skill[1];
  if (!skillName) {
    return null;
  }
  const inlineArguments = skill[2]?.trim();
  const detail = inlineArguments
    ? safeTitleLine(inlineArguments)
    : lines.slice(1).map((line) => safeTitleLine(line)).find((line) => line !== null) ?? null;
  const suffix = detail ? `${skillName} ${detail}` : skillName;
  return suffix ? truncateTitle(suffix) : null;
}

export function canonicalTitleBase(value: string | null | undefined): string | null {
  const title = oneLineTitle(value);
  return title ? title.replaceAll(TITLE_SEPARATOR, TITLE_BASE_INTERNAL_SEPARATOR) : null;
}

export function composedTitleBase(value: string | null | undefined): string | null {
  const title = oneLineTitle(value);
  if (!title) {
    return null;
  }
  const separatorIndex = title.indexOf(TITLE_SEPARATOR);
  return separatorIndex > 0 ? title.slice(0, separatorIndex) : title;
}

export function titleActionSegments(value: string | null | undefined): readonly string[] {
  const title = oneLineTitle(value);
  return title
    ? title.split(/\s(?:-|—|–)\s/).map((segment) => segment.trim()).filter((segment) => segment.length > 0)
    : [];
}

export function stripComposedTitleBase(
  baseTitle: string | null | undefined,
  value: string | null | undefined,
): string | null {
  const rawBase = oneLineTitle(baseTitle);
  const base = canonicalTitleBase(baseTitle);
  const title = oneLineTitle(value);
  if (!title || !base) {
    return title;
  }
  const maxBaseChars = Math.max(0, MAX_TITLE_CHARS - TITLE_SEPARATOR.length - MIN_SUFFIX_CHARS);
  const visibleRawBase = rawBase && maxBaseChars > 0 ? truncateTitle(rawBase, maxBaseChars) : null;
  const visibleBase = maxBaseChars > 0 ? truncateTitle(base, maxBaseChars) : null;
  for (const candidate of new Set([rawBase, base, visibleRawBase, visibleBase])) {
    if (!candidate) {
      continue;
    }
    if (title === candidate) {
      return null;
    }
    for (const separator of TITLE_ACTION_SEPARATORS) {
      const prefix = `${candidate}${separator}`;
      if (title.startsWith(prefix)) {
        return oneLineTitle(title.slice(prefix.length));
      }
    }
  }
  return title;
}

export function composeTitle(
  baseTitle: string | null | undefined,
  suffix: string | null | undefined,
): string | null {
  const base = canonicalTitleBase(baseTitle);
  const normalizedSuffix = oneLineTitle(suffix);
  if (!base && !normalizedSuffix) {
    return null;
  }
  if (!base) {
    const canonicalSuffix = canonicalTitleBase(normalizedSuffix);
    return canonicalSuffix ? truncateTitle(canonicalSuffix) : null;
  }
  if (!normalizedSuffix) {
    return truncateTitle(base);
  }
  const maxBaseChars = Math.max(0, MAX_TITLE_CHARS - TITLE_SEPARATOR.length - MIN_SUFFIX_CHARS);
  if (maxBaseChars === 0) {
    return truncateTitle(normalizedSuffix);
  }
  const visibleBase = truncateTitle(base, maxBaseChars);
  const suffixMax = MAX_TITLE_CHARS - visibleBase.length - TITLE_SEPARATOR.length;
  return `${visibleBase}${TITLE_SEPARATOR}${truncateTitle(normalizedSuffix, suffixMax)}`;
}

function titleStateComponent(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized && Array.from(normalized).length <= MAX_TITLE_CHARS ? normalized : null;
}

export function normalizeSessionTitleState(value: unknown): SessionTitleState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const state = value as Partial<Record<keyof SessionTitleState, unknown>>;
  const topic = state.topic === null ? null : titleStateComponent(state.topic);
  const activity = state.activity === null ? null : titleStateComponent(state.activity);
  const topicSource = state.topic_source;
  if (
    (topicSource !== "none" && topicSource !== "auto" && topicSource !== "user")
    || (topicSource === "none" ? topic !== null : topic === null)
    || !Array.isArray(state.references)
    || state.references.length > MAX_TITLE_REFERENCES
  ) {
    return null;
  }
  const references: string[] = [];
  for (const reference of state.references) {
    if (typeof reference !== "string" || !TITLE_REFERENCE_PATTERN.test(reference)) {
      return null;
    }
    if (!references.includes(reference)) {
      references.push(reference);
    }
  }
  return { topic, topic_source: topicSource, references, activity };
}

export function sessionTitleStatesEqual(
  left: SessionTitleState | null | undefined,
  right: SessionTitleState | null | undefined,
): boolean {
  const a = normalizeSessionTitleState(left);
  const b = normalizeSessionTitleState(right);
  return a?.topic === b?.topic
    && a?.topic_source === b?.topic_source
    && a?.activity === b?.activity
    && (a?.references.length ?? 0) === (b?.references.length ?? 0)
    && (a?.references ?? []).every((reference, index) => reference === b?.references[index]);
}

function topicContainsReference(topic: string, reference: string): boolean {
  let index = topic.indexOf(reference);
  while (index !== -1) {
    const before = topic.charAt(index - 1);
    const after = topic.charAt(index + reference.length);
    const qualifiedSuffix = reference.startsWith("#")
      && /([a-z][a-z0-9._-]{1,63}) $/.test(topic.slice(0, index))
      && /[-_.]/.test(topic.slice(0, index).match(/([a-z][a-z0-9._-]{1,63}) $/)?.[1] ?? "");
    if (!/[A-Za-z0-9_.-]/.test(before) && !/[A-Za-z0-9_]/.test(after) && !qualifiedSuffix) {
      return true;
    }
    index = topic.indexOf(reference, index + 1);
  }
  return false;
}

function compactReferences(references: readonly string[], maxChars: number): string {
  const parts = references.map((reference) => {
    const [label, number] = reference.split(" #");
    return label !== undefined && number !== undefined
      ? { label, number: `#${number}`, budget: label.length }
      : { label: "", number: reference, budget: 0 };
  });
  if (parts.length === 0) {
    return "";
  }
  const render = () => parts.map(({ label, number, budget }) => (
    label ? `${truncateTitle(label, budget)} ${number}` : number
  )).join(" ");
  while (Array.from(render()).length > maxChars) {
    const longest = parts.reduce((best, part) => part.budget > best.budget ? part : best);
    if (longest.budget <= 4) {
      break;
    }
    longest.budget -= 1;
  }
  return render();
}

function titleStateAnchor(state: SessionTitleState, maxChars: number): string | null {
  const topic = state.topic;
  let visibleTopic = topic ? truncateTitle(topic, maxChars) : null;
  let references = "";
  if (topic) {
    for (let attempt = 0; attempt <= state.references.length; attempt += 1) {
      const missing = state.references.filter((reference) => (
        !visibleTopic || !topicContainsReference(visibleTopic, reference)
      ));
      references = compactReferences(missing, maxChars);
      const topicMax = references
        ? Math.max(0, maxChars - Array.from(references).length - 1)
        : maxChars;
      const nextVisibleTopic = truncateTitle(topic, topicMax);
      if (nextVisibleTopic === visibleTopic) {
        break;
      }
      visibleTopic = nextVisibleTopic;
    }
  } else {
    references = compactReferences(state.references, maxChars);
  }
  if (!topic && !references) {
    return null;
  }
  if (!references) {
    return topic ? truncateTitle(topic, maxChars) : null;
  }
  if (!topic) {
    return truncateTitle(references, maxChars);
  }
  return visibleTopic ? `${visibleTopic} ${references}` : truncateTitle(references, maxChars);
}

export function renderSessionTitleState(value: SessionTitleState): string | null {
  const state = normalizeSessionTitleState(value);
  if (!state) {
    return null;
  }
  const maxAnchorChars = state.activity
    ? MAX_TITLE_CHARS - TITLE_SEPARATOR.length - MIN_SUFFIX_CHARS
    : MAX_TITLE_CHARS;
  const anchor = titleStateAnchor(state, maxAnchorChars);
  if (!anchor) {
    return state.activity ? truncateTitle(state.activity) : null;
  }
  if (!state.activity) {
    return truncateTitle(anchor);
  }
  const activityMax = MAX_TITLE_CHARS - Array.from(anchor).length - TITLE_SEPARATOR.length;
  return `${anchor}${TITLE_SEPARATOR}${truncateTitle(state.activity, activityMax)}`;
}

export function userSessionTitleState(title: string | null | undefined): SessionTitleState | null {
  const topic = oneLineTitle(title);
  return topic
    ? { topic, topic_source: "user", references: [], activity: null }
    : null;
}

export function emptySessionTitleState(): SessionTitleState {
  return { topic: null, topic_source: "none", references: [], activity: null };
}

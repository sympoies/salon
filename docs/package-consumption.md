# Build and consume compiled packages

Build and test local package archives with the commands below. These commands do not publish
packages, create a release, change repository visibility or establish a downstream published-version
pin. The public SDK release entrypoint is a separately authorized publisher operation.

## Build and test local archives

Select Node 24 from `.node-version` and pnpm 11.9.0 from `packageManager`, then:

```bash
pnpm install --frozen-lockfile
pnpm build:packages
pnpm pack:core
pnpm test:package-consumption
```

`dist-packages/` receives `shared.tgz`, `edge.tgz`, `ui.tgz` and `manifest.json`. The manifest
records the source commit, a dirty-worktree flag, package names, versions, byte lengths and SHA-256
digests. A dirty manifest describes local development output; it is unsuitable as released
provenance. Artifact production does not invoke npm publication or any remote release API.

## What the package checks prove

The package-consumer smoke test installs the three tarballs in a temporary directory outside the
workspace. It clears inherited source-selection and runtime configuration, rejects installed package
paths that escape the consumer, and checks that the payload contains declarations and no TypeScript
source. It typechecks against installed declarations, composes a generic UI from exported modules,
starts the compiled authenticated edge and requests the page, JavaScript, CSS and fonts. The test
supplies its own neutral environment and requires no live upstream.

Its isolated headless Chrome probe mounts the public compiled conversation panel with native
IndexedDB. It waits for both the authoritative submitted row and empty history to load, checks that
one outgoing echo remains, then loads the matching user turn and checks that history takes over.

A fresh document with a later history window must retain the journaled handover. Unexpected reads,
writes and browser errors fail the probe. No internal imports or source aliases replace the
installed implementation.

## Read the native connection configuration

Use `nativeConnection()` from `@agent-console/ui/native-connection` in native shell code. It reads the
current UI configuration synchronously and returns `{ serverUrl, token }` when both values are set,
or `{ unavailable: true }` when either is missing. Reading the snapshot leaves storage untouched.

Use the credential only in the authorization header of a request to the configured server's origin.
Keep it out of URLs, logs, diagnostics and error messages.

## Run the installed owner commands

The installed edge package exposes three owner-local commands:

- `agent-console-test-credential` creates, revokes and audits test credentials.
- `agent-console-machine-preferences` enables or disables a machine preference.
- `agent-console-outbox-lifecycle` performs the guarded one-row repair of a legacy
  outbox lifecycle fence. See [Outbox lifecycle recovery](outbox-lifecycle-recovery.md).

The first two invoke the compiled package files and retain their existing explicit database,
principal and operation arguments. Invalid or empty invocations of those two fail before opening a
store; the package-consumer smoke probes those two commands without supplying a database.

The local override of the shared dependency ensures both edge and UI resolve the same tarball. This
proves the dependency selection for unpublished packages, with no registry fallback. The root
lockfile is for this producer workspace; a downstream distribution owns its own dependency lock and
acquisition policy.

## Import baseline and retained adaptations

The upstream import baseline follows actual merged source commit
`c0d52234c8a5c62180f38b319c30903f4563ee35`, including the preceding refused-reply and
conversation-image repairs and the accepted submitted-reply handover change. At that baseline, the
six submitted-reply implementation/test files were byte-identical to accepted review head
`112e886557533c44e9db50280ea32d37bc4fc2e8`.

The actual merge also includes the separately accepted fresh-document Sign out fixture already
present here; that fixture differs from the submitted-reply review head. The Sign out fixture
adaptation gives each synthetic fresh document its own boot clock, preserving all native and browser
assertions and their original execution bounds.

The source manifest records the 600 selected package paths at that baseline. Its `adaptedFiles`
entries keep upstream and retained hashes separate. The retained source inventory has 601 paths: the
600 baseline paths and the added save adapter.

The generic image-toolbar implementation input is recorded by source commit and patch digest, with
input and final hashes for each of its 10 paths. This input is not presented as an approved upstream
baseline.

SDK 0.1.4 also retains the actionable terminal-draft refusal wording and regression from
[PR29][terminal-draft-repair], merged as `300502a4ae8777d9678aae83d44efbce42e336e2` after review at
`e11a6c1b880ffba9a79c9e6490507b906b681bfe`. These later changes do not redefine the recorded
upstream baseline, reviewed snapshot or implementation input.

The import retains the three helper-module renames that prevent component and model output paths
from colliding on case-insensitive filesystems. The package builder checks actual emitted
JavaScript, declarations and copied assets; the project gate also checks tracked paths.

The [source manifest](core-source-manifest.json) records baseline hashes and final hashes for 13
retained local adaptations across package metadata, owner command entrypoints, and existing
license/comment/EOF adjustments. It records implementation input/final hashes for the image-toolbar
files and preserves the original reviewed snapshot and completed downstream distribution-test
transfer. The three package metadata adaptation hashes reflect the final 0.1.103 versions.
The manifest also retains the upstream hashes and historical/input identities.

No upstream Git history, private composition or environment files are imported.

## Recover shared replies and terminal input

The SDK patch includes the canonical refused-reply and terminal recovery repair. Only definitely
refused replies offer Discard and Retry. Discard sends nothing and records cancellation durably,
including for an earlier session incarnation. Capacity pruning retains that cancellation so an old
admission cannot recreate or send a discarded intent.

Retry requires the current incarnation and item revision. It retains the intent and allocates a
fresh provider request ID.

After rejected or unconfirmed terminal input, a later provider-confirmed submission for the current
pane/provider releases input uncertainty. Historical events, transport acknowledgements and Clear
draft alone do not. Locally tracked slash drafts remain guarded after recovery. The port retains the
canonical shared, edge and mounted UI behavior tests.

A definite terminal-draft refusal now explains that the owner must clear the draft in the terminal
before explicit retry. This wording does not establish a fix for native empty-composer
classification in [nils-cli#2922][native-composer-classification]; application/provider and native
acceptance remain separate.

## Discard a definitely refused local reply

The conversation view offers Discard for one definitely refused reply retained by the legacy local
queue, including a reply from an earlier session incarnation. The durable transaction removes only
the selected local row and its echo; Retry, unconfirmed replies, unrelated state, and shared/server
rows remain intact. Discard does not submit again. This is separate from submitted reply identity
reconciliation.

Real native IndexedDB/client acceptance for the legacy local-row Discard remains pending. No
real-browser/native or automatic cross-window result is claimed by source-package validation.

## Display conversation images and file attachments

The SDK preserves bounded opaque image selectors through history HTTP and SSE. The explicit
`@agent-console/shared/conversation-images` export provides the shared normalization contract.
Descriptors preserve optional sanitized `original_name` display basenames when the runtime supplies
upload metadata ([runtime contract work][runtime-image-names]); missing metadata retains the neutral
image label.

Successful attachment uploads return `data.attachment.original_name` beside the stored `path` and
`bytes`. The composer keeps names and supported raster blobs in its browser-local outbox journal;
provider prompts and server admissions still contain only text.

Non-image uploads render shared file cards in outgoing and history bubbles. Cards show a known
original name or neutral kind, keep long-name extensions visible, and copy the original transport
path. Upload byte counts stay in the browser-local journal for the optional size line; history
without size metadata shows only the kind. Multiple cards stack below message text.

Local preview URLs are released when the echo unmounts, and local metadata is removed on transcript
proof, dismissal or eviction.

Descriptors contain neither paths nor bytes; unsupported URLs are not fetched. Image bytes use the
authenticated history ownership route, injected daemon credentials, bounded raster admission and
private no-store responses. Deleted images remain distinct from unavailable images; abandoned
transfers are cancelled.

History, full Conversation panels, phone panes and desktop tiles use the same lazy thumbnails and
message-scoped viewer. Fit, zoom, pan, image navigation, keyboard focus and native Back dismissal
retain the accepted behavior.

The isolated compiled consumer checks the actual image contract declarations and authenticated exact
byte forwarding; source headless fixtures cover the mounted views. Real provider/native acceptance
remains with its owning milestone.

## Choose a theme

The console resolves a System / Dark / Paper setting (default System, stored per device) to
`data-theme="dark"` or `data-theme="paper"` on the root element and keeps the chosen mode in
`data-theme-mode`. `<meta name="theme-color">` follows the resolved canvas colour.

A consumer overlay can style its own markers with `:root[data-theme="paper"]` or read the same state
with `useTheme()` from `@agent-console/ui/theme`, which also returns `setMode`.

## Set the application name and mark

`mountApp` takes optional `appName` and `appIcon` options. `appIcon` is `{ dark, light }`: URLs of
the header mark for dark surfaces and for light and Paper surfaces. Every place the header mark
renders (dashboard header, login, settings) uses it.

When `appIcon` is omitted the Salon mark is shown, so a host that relied on the former Agent Console
mark must now pass its own `appIcon`.

```ts
mountApp(root, { appName: "Example", appIcon: { dark: "/mark-dark.svg", light: "/mark-light.svg" } });
```

### Retain last-good usage during backoff

A usage producer can set `ProviderUsage.retained` to `true` on an entry whose
quota windows came from the last successful fetch. Keep `updated_at` set to the
time of that fetch. Set `backoff_until` to the expected next refresh time when
known. Both timestamps use Unix epoch seconds.

The Usage page, header strip, and session account details show retained values
as stale, with their age and any refresh estimate. Retained windows expire at
six hours or at their own reset, whichever comes first. Reset eligibility
continues to expire after ten minutes, as do windows without the opt-in.

## Publish and consume the public SDK

Publication is reserved for the authorized publisher after designated review and merge. The
checked-in SDK version is `0.1.103`. The publisher creates a GitHub prerelease with `latest=false`.

### Changes retained in SDK 0.1.103

Every outgoing reply bubble menu offers **Copy text** (#663, closes #661).
Open the menu with a long press, a right-click or the keyboard menu key.
The action copies the reply as sent, with uploaded-file paths shortened to
their file names. Salon briefly confirms a successful copy and shows a notice
if the clipboard is unavailable or denies access.

**Dismiss reply** is available only for replies with an **Unknown outcome**.
Moving your finger during a long press cancels the gesture.

SDK consumers can keep their existing configuration. The container runtime
remains pinned to nils-cli v1.42.6.

### Changes retained in SDK 0.1.102

Once Salon hands a reply to the agent, the reply bubble shows the provider's
delivery status (#660, closes #659). Claude shows **Queued for Claude; read after the current step.**
Codex shows **Sent into the current turn.** Other providers show **Handed to the agent**.

**Dismiss reply** is available only for **Unknown outcome**. Refused replies
still offer **Discard** and **Retry**. The [README](../README.md#track-outgoing-replies-and-attachments)
describes the updated reply statuses.

SDK consumers can keep their existing configuration. The container runtime
remains pinned to nils-cli v1.42.6.

### Changes retained in SDK 0.1.101

The container updates its pinned nils-cli runtime from 1.42.1 to 1.42.6.
Managed Codex control stays ready when Codex uses an API key. This restores
the initial prompt and Conversation replies for API-key Codex sessions in
the container (#653, #656).

SDK consumers can keep their existing configuration. For standalone container
launches, mount `/run/salon` owned by UID 1000 with mode `0700`, as shown in
the [container test procedure](container-development.md#check-codex-api-key-prompt-delivery-offline).
A wholly unreachable provider endpoint can still prevent thread attachment.
[nils-cli #3995][codex-unreachable] records that case.

[codex-unreachable]: https://github.com/sympoies/nils-cli/issues/3995

### Changes retained in SDK 0.1.100

The read-only extension facade `conversation.firstReplyAfter` returns the
first assistant reply after an extension's own delivered input in the exact
session incarnation. The response carries a durable event ID and order, bounded
text, and typed unavailability. Codex is supported. Claude returns
`unavailable` because it lacks a receipt binding (#650, #652).

The container adds a documented command to add or remove Claude's
`apiKeyHelper` while preserving its activity hooks. The edge and UI explain
`structured-prompt-unavailable` for a refused initial prompt or Conversation
reply (#653, #654).

You can upgrade with your existing SDK configuration.

### Changes retained in SDK 0.1.99

Usage providers can mark cached last-good quota windows with `retained: true` and
optionally supply `backoff_until` in Unix seconds. The edge passes these fields
through. The UI shows retained windows as stale with their age for up to six
hours and drops them when they reset. Unmarked windows keep the ten-minute
cutoff (#643, #645).

The container installs `agent-hook` from the pinned nils-cli archive and
configures warn-only Claude activity hooks so Salon can report session state.
The edge stores its SQLite state database in the existing runtime volume,
which enables shared replies in the Conversation view (#647, #649).

You can upgrade with your existing SDK configuration.

### Changes retained in SDK 0.1.98

Conversation tool cards use **OK** and **Error** for results. Collapsed groups
show **1 Error** or **N Errors**, with the same font weight and color as the
single-card error label (#636, #637).

Outgoing reply bubbles show **Uploading**, **Sending**, **Handed to the agent**,
**Refused**, or **Unknown outcome**. A definite refusal shows a short reason and
offers **Retry** for the current session. The labels reflect the existing delivery
flow (#638, #640).

You can upgrade with your existing SDK configuration.

### Changes retained in SDK 0.1.97

Container startup adds Codex trust for the default workspace while preserving
existing trust decisions and other settings. The
[container guide](container-development.md#set-workspace-trust) documents
Claude's one-time setup. The session-start hint points to sign-in or first-run
setup on the selected machine (#627, #628).

The header keeps the provider badge visible at every usage display step on
narrow screens. Intermediate steps show as much usage detail as fits
(#630, #635).

Themed confirmation dialogs cover ending a shell, restoring a saved draft,
and revealing a terminal link. A regression guard checks for new native
confirmation calls (#629, #634).

Checkboxes, select pickers, disclosure markers, and focus rings follow the
active theme. A regression guard checks native form controls for theme coverage.
Escape dismisses an open select picker and leaves the enclosing dialog open
(#631, #633).

You can upgrade with your existing SDK configuration.

### Changes retained in SDK 0.1.96

When the runtime refuses to start a session and returns a typed reason, the UI
shows the runtime's message. If provider sign-in is required, the UI tells you
to sign in on the selected machine. New stays available, and a definite refusal
leaves no stopped placeholder. The unknown-outcome banner still appears when the
result is uncertain, such as after a lost response (#621, #624).

The Compose smoke script accepts an optional project name after the Compose file.
The argument takes precedence over an exported `COMPOSE_PROJECT_NAME`
(#622, #625).

You can upgrade with your existing SDK configuration.

### Changes retained in SDK 0.1.95

The publish workflow runs the Compose smoke check against the exact pushed
image digest on a fresh runner before recording the digest in the release notes
(#615, #617).

The image pins agent-session 1.42.1 and installs `procps`. Default session
creation now reaches provider setup, fixing session creation in the 0.1.94
image (#614, #619).

The image includes Claude Code alongside Codex. The
[container guide](container-development.md#set-up-provider-authentication)
covers API-key and subscription sign-in, logout, and credential removal for
both providers (#616, #618). Add the named `claude-state` volume when upgrading
an existing Compose file. The [pull-only example](../compose.image.yaml)
already declares it.

This release uses the existing SDK configuration.

### Changes retained in SDK 0.1.94

The one-line notice **Show more** and **Show less** control uses the theme's
inline text-control styling. It has a transparent background, themed text, a
visible keyboard focus ring, and a 44 px target on touch devices (#611, #612).
This release uses the existing configuration.

### Changes retained in SDK 0.1.93

The phone header usage strip shows complete account entries without clipping
or overlap. As space narrows, it shows fewer accounts, one full account, and
then compact details or stacked percentages. Countdown text changes keep the
same step at a given width (#608, #609). This release uses the existing
configuration.

### Changes retained in SDK 0.1.92

Meta/Ctrl+Shift+S in an editable field is left to the field on every client,
and Android Back closes the header layout menu instead of leaving the app
(#594, #597, #602). System notices render on one line with the kind, time and first
line, plus an expander; stored text is unchanged (#603, #604).

The edge removes layout keys for unconfigured machines and for closed sessions
beyond board retention before pruning, preventing stale keys from filling the
256-key bound (#600, #605). The optional host-backed layout store only receives
the unconfigured-machine cleanup. This lifts the 0.1.91 capacity limitation for
the internal layout store. No configuration change is required.

### Changes retained in SDK 0.1.91

Idle clients no longer repeatedly write the shared layout order at the 256-entry
bound (#598, #599). Clients preserve keys outside their local view. Stale keys can
accumulate toward that bound until edge cleanup is available (#600). No configuration
change is required.

### Changes retained in SDK 0.1.90

Concurrent session list reads for the same selection and projection share one upstream
observation, reducing spoke reads (#593, #595). Explicit refresh still reads fresh, and
per-reader projection and cancellation behavior remain unchanged. No configuration change
is required.

### Changes retained in SDK 0.1.89

Snapshot and closed board records retain `last_terminal_activity_at` as a string or null
(#590). Records stored before the upgrade serve null until re-ingested. No configuration
change is required.

### Changes retained in SDK 0.1.88

**Breaking config change.** Every `AGENT_CONSOLE_CONSOLE_START_SERVICES` entry
requires a nonempty `capabilities` array containing `message`, `console-start`, or
both. A missing key or unknown value fails config loading at startup (#587).

Before upgrading, add `capabilities` to every entry. Use
`["message", "console-start"]` to retain both grants, or list only the capability
the service needs. See [Service admission](service-console-starts.md#admission).

### Changes retained in SDK 0.1.87

Edge extensions can admit and read authorized session inputs through `ctx.outbox.admit` and
`ctx.outbox.get`. The public types are available from `@agent-console/edge/extensions`.
Caller-supplied input IDs make identical retries idempotent. Records include structured source
metadata and delivery state, and the facade returns typed errors such as an input ID conflict
(#584). See [Extension outbox](package-boundary.md#extension-outbox).

### Changes retained in SDK 0.1.86

The Conversation and Terminal file inputs keep their pending picker results across document
visibility changes. Hidden panes pause live traffic and stay mounted (#580).

### Changes retained in SDK 0.1.85

Speech synthesis providers advertise their available voices and a default voice. Requests can
name a voice, and the edge returns a typed error for an unknown voice. A synthesis provider setting
must be an object, and invalid types fail at startup. Providers without synthesis remain
transcription-only (#574).

On Android, Desktop Auto uses one column at phone widths and two at wider widths.
The Desktop picker stays visible and Auto stays selected (#576).

### Changes retained in SDK 0.1.84

The edge exposes an authenticated speech synthesis route through its configured speech providers.
It bounds input text and output audio and returns typed errors (#565).

Paired devices can list their owner's companion inbox and acknowledge messages idempotently.
The inbox accepts messages through authenticated producer ingress and persists messages and receipts
(#566).

Confirmed companion replies use an idempotency key and support receipt lookup. The edge checks the
target session incarnation before dispatch, and delivered input carries companion provenance
(#568).

The console unsubscribes hidden terminals and skips redundant updates to cut idle traffic on
relayed links. The session list recovers on slow links (#570).

The latest refused reply keeps its retry and discard actions above the composer (#571).

### Changes retained in SDK 0.1.83

The coordination relay admits service sources for peer discovery and delivers admitted service-origin
messages with the original service identity intact. The relay returns typed refusals (#560).
Replies to service origins are out of scope for 0.1.83.

A repository lookup that returns no usable destination shows a visible, accessible notice (#563).

Browser test profile teardown tolerates late writes (#562, test only).

A revoked or signed-out device returns to sign-in with a short reason and clears its credential
(#549). Network failures, HTTP 403 responses and unconfirmed refusals keep the credential.
Browser re-login and pairing wait for cookie cleanup.

The top bar shows number-only status counts with accessible names. The account usage control
shows the five-hour and weekly percentages at narrow widths (#554).

The notice-layout browser fixtures load their font explicitly before measuring (#550, test only).

Grouped tool-call rows use the conversation row layout again (#545): avatar gutters and bubble edges align,
group end times appear in the timestamp column, and expanded timestamps keep their clearance.
Only the first visible row of an agent run shows an avatar, and rounded outlines stay continuous.
This UI change leaves history APIs and message data unchanged.

The owner pairing link carries the canonical 20-character code so native shells can import tapped
and scanned links (#541). The native importer remains strict.

The container startup test waits for the edge to listen before shutdown, allowing its children to
be cleaned up (#539). This test-only change does not alter runtime behavior.

The coordination relay advances an existing owner's grant on a proven clear/restart continuity chain
(#530). The edge shuts down gracefully on SIGTERM and SIGINT and closes SQLite (#532).

Composer uploads appear as removable attachment chips while delivered text remains unchanged (#535).
Consecutive tool calls are grouped into one summary row, and Load older fills visible rows when tools
are hidden (#536).

The coordination relay adds an `excluded` array to its remote-peers response (#523). A policy-visible
running recipient whose incarnation and provider conversation changed is reported with the typed,
content-free `ownership-binding-stale` reason. The existing owner-scoped claim re-bind restores its
eligibility; see [Coordination resume](coordination-resume.md).

Pairing regression coverage retains the client consistency checks and refused-item retry device
binding (#524). This carried change adds tests without changing runtime behavior.

Status-count chips retain their accessible names on Android toggle buttons (#519). Each chip
keeps `aria-pressed`, `aria-label` and `title`, adds visually hidden text equal to its full name,
and keeps its visible count and labels `aria-hidden` in the session list and both header modes.
Visuals, geometry and desktop names stay unchanged.

Device sign-in exchanges a one-time code for an independently revocable credential with a fixed
30-day authorization lifetime (#509). Enrollment, approval and explicit Renew require the main
credential. Metadata lists expiry and last use; selective revocation remains effective across
bearer, cookie, attach-ticket, HTTP, SSE, WebSocket and queued-work paths. Activity never renews
authorization.

Pairing uses the existing state database with added pairing-request, device-credential, rate-counter
and renewal-audit tables, plus an issuing device identifier on durable outbox intentions. Retain the
state database across edge replacement. `AGENT_CONSOLE_PAIRING_TTL_SECONDS` configures the code
lifetime (60–600 seconds, default 300).

TLS-terminating consumers must configure
`AGENT_CONSOLE_PAIRING_TRUSTED_PROXY_PEERS` with exact immediate-proxy IPs and overwrite
`X-Forwarded-Proto` from the actual TLS connection; direct TLS needs no proxy list.

Extension
handlers that await work beyond `readJsonBody` must call `ctx.assertAuthorized()` immediately
before a protected side effect to enforce revocation of the captured credential. See the
[device sign-in contract](device-sign-in.md) for configuration, storage and extension obligations.

Browser and native flows provide owner code comparison, explicit recipient account/server consent,
and device listing, Renew and Revoke (#514). Native claim/exchange uses a separate HTTPS transport
without redirects or a saved bearer. The edge accepts app-shell Origins only for anonymous native
claim/exchange POSTs with no Cookie, Authorization or WebSocket subprotocol header. The
[device sign-in guide](device-sign-in-guide.md) describes the user flow. Packaged native transport
and real redirect-downgrade acceptance remain separate from browser and mocked transport checks.

Native shells import received HTTPS pairing links through the public `importPairingLink(url)` from
`@agent-console/ui/pairing` (#526). Parsing requires an HTTPS root and fragment-only payload; explicit
consent precedes claim and credential installation. Generation and import-identity fences prevent stale
imports from installing credentials.

Optional `mountApp` hooks `scanPairingLink` and `openPairingLinkInApp` add connection-screen scanning and
an explicit browser-to-app handoff before claim. Consumer-supplied `EdgeConfig.androidAppLinks` can serve
the Android association document; it is absent by default, and alias paths return 404. No default package
names or signing identities are supplied. See the
[link-import contract](device-sign-in.md#import-a-pairing-link-from-a-native-shell) for parsing and cancellation rules.

The reply composer and terminal input carry their accessible names on the input element itself,
without separate hidden label nodes. Status-count chips expose one name with the label and count
once in the session list and both header modes; their visible count and label are hidden from
accessibility (#511). Existing desktop names, placeholders, CSS and geometry stay unchanged.
Android native accessibility mapping remains a separate device acceptance check.

Copy, More, layout and Reply icon-only popup or disclosure triggers retain their accessible names as
visually hidden DOM text. Active compact filters retain their placeholder as hidden text when chips
are shown. Existing aria-labels, visuals and geometry stay unchanged (#501). Android native name
mapping remains a separate device acceptance check.

Tool status labels (OK and Error) and the shared `--ok` / `--danger` tokens use the dark theme
palette: green `#addb67` and red `#f78c6c`. AA contrast is pinned for both themes; Paper values stay
unchanged (#497).

The New session dialog keeps a typed absolute working directory and rejects a relative path with an
inline reason. Runtime startup refusals show their reason and explanation to the creating principal,
including when the creation outcome remains unknown (#493).

Release tooling reports failing child commands, their exit status or signal, and a stderr tail. It
resumes verification for an exact complete release and refuses a provider draft without a tag (#491).
These tooling changes do not change package behavior.

Tool rows show the command or file path as their collapsed title and the description as secondary
text instead of raw JSON (#487). Masked rows and owner-only projection remain unchanged.

Sessions carry a marker for a draft the runtime saved, and the composer can show, restore and discard it
(#282, #383). The UI API also exports `discardSavedDraft` for this action.
A refused shared reply always names its refusal reason (#298). Settings shows the server
version and build when the consumer supplies them (#297), and session cards show the session's
current work issue references (#293), which open through the external-link path (#306).

The image viewer suppresses the native context menu (#304), and outgoing image rows render
thumbnails, neutral labels and one timestamp side (#305). Uploads return the sanitized original file
name, pending outgoing replies keep that name and a local image preview, and history rows show an
optional runtime-supplied original name (#307). Non-image attachments render as file cards with a
kind icon, a one-line name that keeps its extension, kind and size, and a copy action (#312).

In multi-user mode a principal receives the authoritative turn state of its own sessions on the
activity stream (#320). An auth-quarantined session names the quarantine, offers Re-verify for bound
Claude sessions, and the terminal keeps a refused context-command draft and blocks Enter until
release (#265).

Conversation images share a bounded in-memory cache, keep loaded thumbnails while scrolled out of
view, and load through a visible-first queue with per-image progress, distinct transient and
unavailable states, and Retry (#319). Caption bubbles under user images align right with the
previews (#324).

A freshly started session that is waiting before its first turn keeps its authoritative waiting
state instead of showing unknown (#326).

An acknowledged runtime command such as a compaction request hands its local echo over to its
classified history row once, also across reloads (#267).

In multi-user mode the usage route keeps host-bound accounts for the root principal (#332).

The image Retry button keeps its position while pressed, so a pointer click retries (#335).

Undelivered replies of a previous session incarnation are cancelled on the server, so every client
drops them (#333).

After an archive and a resume of the same session, a successful archive releases its outbox
lifecycle fence, so replies of the new incarnation are admitted and refused ones keep Discard and
Retry (#339).

Fences left by older edges no longer block a session forever: new fences carry an ownership token
and their operation kind, archive and maintenance fences recover on a confirmed different running
incarnation through an exact-row compare-and-swap, and an operator-invoked one-row repair tool
handles legacy rows (#340).

[Outbox lifecycle recovery](outbox-lifecycle-recovery.md) defines incarnation-bound replacement
recovery and the owner-local repair procedure for verified legacy archive fences.

Session notices of the monitoring, role and session kind families carry their family title instead
of the generic one (#276).

The saved-draft list opens reliably when chosen right after the composer mounts (#325).

A history image refused as outside the session folder shows that reason and the file name from the
message (#167).

Session create forwards the validated capacity-refusal proof (#347).

Resend of a failed turn and the user bubble drop paste wrapper tags, so the resent text matches what
the user sent (#351).

A delivered non-image upload shows its sanitized original name and size when the runtime supplies
managed file parts, including archived History rows; otherwise it keeps the neutral file-kind label
(#307).

A conversation image whose source is a remote URL is never fetched. Its tile says the external
image is not loaded, shows the origin and offers an explicit link to open it (#360).

A completed delete or maintenance-delete refusal releases the session's outbox lifecycle fence, so
a resumed session can be archived or deleted again; uncertain direct deletes stay fenced (#340).

History card previews drop paste wrapper tags (#362).

A refused remote image tile also uses the runtime's typed remote-url refusal reason, so the
external-image state appears without a Markdown association; a valid lower-case http(s) origin is
shown only when supplied, and invalid origins are dropped (#367).

A user-attachment image stored as an image block offers Copy file path from the runtime-supplied
upload path when present; earlier runtimes keep the quoted-text fallback (#271).

`UiExtension` accepts an optional row-presentation hook, applied in the live and History views: a
user row may show a short source label with a recognised leading prefix removed from the displayed
text, and a notice row may fold its body behind a closed summary. Copy and Resend keep the original
text; no hook, an empty or malformed result, or a throwing hook render as before (#374).

Conversation history is read 100 messages at a time, and when tool-call and tool-result records fill
a page the edge reads a small, bounded number of older pages so the window still shows readable
rows; an internal deadline returns the rows already accepted with the current older cursor. The
Working indicator stays at the bottom of a short conversation (#377).

Correlated, status-bearing debug events retain a bounded daemon error code without response text.
When session creation has an unknown outcome, the response carries the claimed session identity so
the UI can focus that session when it appears (#380).

Saved drafts can be discarded through the runtime discard route; the Discard button is hidden when
no saved drafts remain, and runtimes without the route retain read-only access (#383). A resume relay
provider-ownership refusal returns a typed 422 `resume-source-unknown` envelope (#385).

Session create, resume and resume preflight accept the generic `account` field or the matching
provider-specific field, and reject conflicting or wrong-provider fields. The edge forwards `account`
when the target advertises `session_account_field`; otherwise it uses the provider-specific field (#388).

Composer-unobservable refusals retain the runtime’s fixed-word `observation`. For a multi-row
draft (`region-not-single-row`), both outboxes instruct the user to send or clear the draft (#391).

The Saved drafts button, panel and error occupy their own spaced row, and the header saved-draft
marker truncates with an ellipsis (#393).

The edge forwards optional `notice_kind`, `notice_source` and `notice_id` on session creation
and service starts, and passes through `session.launch_notice` (#406).

Refused outbox replies keep the history side inset on phones (#396).

The edge serves remote conversation images using only the source URL from a typed runtime refusal,
with bounded caching, concurrency limits and cross-site protections (#402). Remote images require
a runtime that reports the source URL in that typed refusal.

Visible remote conversation images load through the authenticated edge and open in the image viewer.
Refusals retain the external link and explain why the image could not load (#400).

Retained conversation images are cleared when authentication or connection identity changes, and
visible images reload after authentication succeeds (#412).

The Machines list in Settings can be reordered by dragging or with up and down buttons, and the
Session filter shares that order. The optional `machineOrderDefaults` UI extension field supplies a
default order, and Restore defaults clears the saved order (#417).

The Usage panel shows one row per granted limit reset, reports a program the provider does not offer
as "Not offered", and shows an "as of" age when `limit_resets_checked_at` marks reset data stale. Usage
windows accept an optional `scope`, and a `weekly_scoped` window renders as a per-model weekly meter
(#419).

Image tiles retry transient remote image refusals, and the image observer is attached after a branch
swap (#423).

Dragging a machine in the Machines list targets the nearest slot, including across row gaps (#431).

A session created on a phone or touch viewport opens according to the phone open preference. A machine
without history keeps the terminal and shows no notice (#430).

A Machines drag keeps reordering until release, wherever the pointer moves, and commits reliably. The
drag is tracked on the document, so a release off the handle is not lost (#444).

`@agent-console/ui/reorder-list` exports `ReorderList` and `useReorderDrag`, so a consumer can reuse
the list behind the Machines setting for its own ordered settings (#446). The package stylesheet
for the list loads with the module under the generic `reorder-*` class names, so the consumer copies
no CSS. The old Machines list class names are gone. The list has the same drag and up/down controls
as Machines.

`ReorderList<T>` takes these props:

- `items`: the items in their current order.
- `itemKey`: returns each item's unique string key.
- `itemName`: optional human-readable name for the drag and up/down controls. For example,
  `itemName={role => role.title}` names a role with key `lead` as "Project lead". When omitted, controls use the key
  (#456).
- `renderLabel` and `renderActions`: render the row's label and its trailing actions.
- `onReorder`: receives the items in the new order after a drop or a move button.
- `restore`: optional node rendered after the list, such as a restore-defaults button.

`useReorderDrag({ keys, list, onReorder })` is the pointer-drag hook alone. It takes the current
keys, a ref to the list element whose rows carry `data-reorder-key`, and a callback that receives the
new key order. It returns `shownKeys`, `draggingKey` and `begin(event, key)`, which a handle's
`onPointerDown` calls.

A container image is published for each release tag, and its digest is recorded in the release notes.
`compose.image.yaml` runs that image pull-only (#442).

Start-service admission entries accept an optional `console_role`. Service creation records that role,
so a coordinator root started by a service matches coordinator messaging selectors (#451).

Codex sessions hand a submitted echo over to its history turn using the runtime's accepted request
identity, without a duplicate. Claude keeps its existing matching behavior (#455; follow-up #23).

Test-only changes make remote-image cache timing deterministic and cover reorder gaps and slot
invariants (#453, #454).

The connection notice in the Desktop header stays on one line at header-button height on narrow
screens, without collapsing or pushing the header down (#466).

Test-only coverage protects Codex echo handover follow-ups and the create preference on wide
touch-primary viewports (#465, #459). CI guards image-digest reruns and validates smoke probes (#460).

Assistant tool calls, bounded results and unified diffs appear in live and saved conversations.
Collapsed tool controls expose the details, and separate results join their calls by identity (#461).

The [reply queue design](reply-queue-design.md) proposes an edge-owned editable queue and steering;
it changes no runtime or product behavior (#462).

Every assistant tool row, including the first, aligns with the turn's content column in live and
saved conversations. Each tool timestamp follows its content with the same placement as assistant
text timestamps (#474).

Tool call and result rows show the runtime's unmasked text only to the session owner. Shared viewers
keep masked text and never receive owner-only fields (#481).

A tool row's chevron reliably opens and closes the row at every width (#482).

Settings → Conversation includes a Show tool calls switch, on by default, that hides or restores
tool rows in live and saved conversations (#483).

### Preserve published releases

Existing `v0.1.0` through `v0.1.68` tags and assets stay immutable. The visibility transition does
not republish those releases, change their source or digests, or reuse an existing tag.

A future publication requires separately approved version metadata and an unused tag. This
preparation does not establish version-merge or publication GO. Source preparation does not
authorize publication.

The authorized publisher uploads only `shared.tgz`, `edge.tgz`, `ui.tgz` and `manifest.json`. The
existing manifest is the checksum record; no additional asset format is created.

### Prepare an authorized publication

Use a clean managed checkout at the exact approved full source SHA, with Node 24, pnpm 11.9.0,
installed frozen dependencies, `agent-run`, `forge-cli`, `gh` and `tar`. Retain the exact source's
gate, CI and designated review. Prepare notes outside the checkout naming that full SHA, approved
PR/CI, package versions and compiled SDK scope; application/provider/container acceptance remains
separate.

The entrypoint invokes `node scripts/release-core-sdk.ts` directly using Node 24 type stripping,
with no tooling build step. The title summarizer adapter runs as `.ts` in the checkout and ships as
compiled `.js` through the existing edge package build.

Run the release entrypoint through the repository environment:

```bash
systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0 \
  agent-run exec --cwd "$salon_checkout" -- ./.agents/scripts/release.sh \
  "$approved_source_sha" "$release_notes_file" --dry-run
```

The publisher runs the same command without `--dry-run` only under its existing release
authorization.

The script checks public repository identity and visibility, clean exact source already merged into
main and fixed versions. A new publication requires an unused tag. It runs the existing `pack:core`,
verifies manifest source/cleanliness/versions plus actual archive sizes, hashes and compiled-only payloads, then
repeats the public-scope check before the native publisher.

Main may advance without changing the exact approved release source. Dry-run performs the same local
checks and the native `forge-cli release create --dry-run`; it does not publish.

### Verify publication and acquire packages

After publication the entrypoint checks actual tag resolution, prerelease state, four distinct
uploaded asset IDs and provider sizes/digests, then downloads each asset by ID and compares its
bytes, including the manifest itself. Its final stdout records those actual identities.

If a step fails, its error names the command and arguments, exit status or signal, and the last
4 KiB of captured stderr. For a transient provider error, rerun with the same approved source and
notes. An existing tag must resolve to that exact source. After rebuilding and checking the local
artifacts, the script announces that it is resuming verification and repeats all provider digest
and asset-ID byte checks;
it does not create another release, upload assets or replace anything. Dry-run also verifies an
existing release without publication.

The script also checks provider drafts independently of tag refs. A draft left before its tag exists
refuses before packing or invoking the publisher. The error names the draft and tag; the release
owner must decide how to complete or abandon that draft before rerunning.

A different source, different or missing assets, or an incomplete release state refuses the rerun.
A failed readback does not roll back or replace a release; hand that state to the release owner.

Public acquisition uses the exact versioned release assets without a reader App or acquisition
token. Publishing still uses an authorized credential with release write access; making assets
readable does not authorize a publication.

Consumers select the explicit version and approved full source SHA. Fetch `manifest.json`,
`shared.tgz`, `edge.tgz` and `ui.tgz` from that tag's public release download URLs, using an
unauthenticated HTTP client that follows redirects. Do not use a latest-release URL: these releases
remain prereleases with `latest=false`. Before installing, verify the manifest's `sourceCommit`,
package names and versions, byte sizes and SHA-256 digests against the actual archives.

Pin the verified version, source and digests in the consuming project. Ordinary install, tests and
builds require no acquisition credential.

## Complete downstream delivery

After source review and producer validation, the designated steward must review the export PR.
Release creation and asset upload require their own authorized release flow.

Downstream acquisition must verify actual public asset bytes, source commit and digests before
pinning those exact artifacts. Its ordinary install, tests and container build require no
acquisition credential. Deleting downstream vendored core follows the approved exact-artifact
switch.

The original three packaging/workflow/evidence test files and two native desktop configuration cases
were transferred to their downstream overlay owner in commit
`46bab91a207f5849c1b778ea3c10d2dc03a4a9c4`, retaining all 50 distribution cases. The source manifest
preserves that history; those tests are already absent from the current upstream core snapshot. The
three core title-bar rendering cases stay in this producer.

These package checks do not establish provider integration, container startup, native packaging or
reconnect acceptance. Those belong to their owning application milestones.

[terminal-draft-repair]: https://github.com/sympoies/salon/pull/29
[native-composer-classification]: https://github.com/sympoies/nils-cli/issues/2922
[runtime-image-names]: https://github.com/sympoies/nils-cli/issues/3331

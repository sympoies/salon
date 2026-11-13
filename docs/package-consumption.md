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
transfer. The three package metadata adaptation hashes reflect the final 0.1.67 versions; upstream
hashes and historical/input identities remain unchanged.

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

## Publish and consume the public SDK

Publication is reserved for the authorized publisher after designated review and merge. The
checked-in SDK version is `0.1.67`; its release is a GitHub prerelease with `latest=false`.

### Changes retained in SDK 0.1.67

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

### Preserve published releases

Existing `v0.1.0` through `v0.1.66` tags and assets stay immutable. The visibility transition does
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
main, fixed versions and an unused tag. It runs the existing `pack:core`, verifies manifest
source/cleanliness/versions plus actual archive sizes, hashes and compiled-only payloads, then
repeats the public-scope check before the native publisher.

Main may advance without changing the exact approved release source. Dry-run performs the same local
checks and the native `forge-cli release create --dry-run`; it does not publish.

### Verify publication and acquire packages

After publication the entrypoint checks actual tag resolution, prerelease state, four distinct
uploaded asset IDs and provider sizes/digests, then downloads each asset by ID and compares its
bytes, including the manifest itself. Its final stdout records those actual identities.

A failed readback does not roll back or replace a release; stop and hand the observed state to the
release owner.

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

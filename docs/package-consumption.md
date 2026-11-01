# Compiled package preparation

The preparation commands build local package archives without publishing them,
creating a release, changing repository visibility or establishing a downstream
published-version pin. The public SDK release entrypoint below is a separately
authorized publisher operation.

The upstream import baseline follows actual merged source commit
`c0d52234c8a5c62180f38b319c30903f4563ee35`, including the preceding refused-reply
and conversation-image repairs and the accepted submitted-reply handover change.
At that baseline, the six submitted-reply implementation/test files were
byte-identical to accepted review head
`112e886557533c44e9db50280ea32d37bc4fc2e8`. The actual merge also includes the separately accepted fresh-document Sign out fixture already present
here; that fixture differs from the submitted-reply review head. The source
manifest records the 600 selected package paths at that baseline. Its
`adaptedFiles` entries keep upstream and retained hashes separate. The generic
image-toolbar implementation input is recorded by source commit and patch digest,
with input and final hashes for each of its 10 paths. This input is not presented
as an approved upstream baseline. The retained source inventory has 601 paths:
the 600 baseline paths and the added save adapter. SDK 0.1.4 also retains the
actionable terminal-draft refusal wording and regression from [PR29](https://github.com/sympoies/salon/pull/29),
merged as `300502a4ae8777d9678aae83d44efbce42e336e2` after review at
`e11a6c1b880ffba9a79c9e6490507b906b681bfe`. These later changes do not redefine
the recorded upstream baseline, reviewed snapshot or implementation input.

The import retains the three helper-module renames that prevent component and
model output paths from colliding on case-insensitive filesystems. The package
builder checks actual emitted JavaScript, declarations and copied assets; the
project gate also checks tracked paths.

The [source manifest](core-source-manifest.json) records baseline hashes and
final hashes for 13 retained local adaptations across package metadata, owner
command entrypoints, and existing license/comment/EOF adjustments. It records
implementation input/final hashes for the image-toolbar files and preserves
the original reviewed snapshot and completed downstream distribution-test
transfer. The three package metadata adaptation hashes reflect the final
0.1.28 versions; upstream hashes and historical/input identities remain unchanged.
No upstream Git history, private composition or environment files
are imported. The Sign out fixture adaptation
gives each synthetic fresh document its own boot clock, preserving all native
and browser assertions and their original execution bounds.

Select Node 24 from `.node-version` and pnpm 11.9.0 from `packageManager`, then:

```bash
pnpm install --frozen-lockfile
pnpm build:packages
pnpm pack:core
pnpm test:package-consumption
```

`dist-packages/` receives `shared.tgz`, `edge.tgz`, `ui.tgz` and `manifest.json`.
The manifest records the source commit, a dirty-worktree flag, package names,
versions, byte lengths and SHA-256 digests. A dirty manifest describes local
development output; it is unsuitable as released provenance. Artifact production
does not invoke npm publication or any remote release API.

The smoke installs the three tarballs in a temporary directory outside the
workspace. It clears inherited source-selection and runtime configuration,
rejects installed package paths that escape the consumer, and checks that the
payload contains declarations and no TypeScript source. It typechecks against
installed declarations, composes a generic UI from exported modules, starts the
compiled authenticated edge and requests the page, JavaScript, CSS and fonts.
The smoke supplies its own neutral environment and requires no live upstream.
Its isolated headless Chrome probe mounts the public compiled conversation panel
with native IndexedDB. It waits for both the authoritative submitted row and
empty history to load, checks that one outgoing echo remains, then loads the
matching user turn and checks that history takes over. A fresh document with a
later history window must retain the journaled handover. Unexpected reads,
writes and browser errors fail the probe. No internal imports or source aliases
replace the installed implementation.

The installed edge package exposes two owner-local commands:
`agent-console-test-credential` for creating, revoking and auditing test
credentials, and `agent-console-machine-preferences` for enabling or disabling
a machine preference. Both invoke the compiled package files and retain their
existing explicit database, principal and operation arguments. Invalid or
empty invocations fail before opening a store; the package-consumer smoke
probes both commands without supplying a database.

The local override of the shared dependency ensures both edge and UI resolve the
same tarball. It is a proof for unpublished packages, with no registry fallback.
The root lockfile is for this producer workspace; a downstream distribution owns
its own dependency lock and acquisition policy.

## Shared reply and terminal recovery

The SDK patch includes the canonical refused-reply and terminal recovery repair.
Only definitely refused replies offer Discard and Retry. Discard sends nothing
and records cancellation durably, including for an earlier session incarnation.
Capacity pruning retains that cancellation so an old admission cannot recreate
or send a discarded intent. Retry requires the current incarnation and item
revision, retains the intent and allocates a fresh provider request ID.

After rejected or unconfirmed terminal input, a later provider-confirmed
submission for the current pane/provider releases input uncertainty. Historical
events, transport acknowledgements and Clear draft alone do not. Locally tracked
slash drafts remain guarded after recovery. The port retains the canonical
shared, edge and mounted UI behavior tests. A definite terminal-draft refusal
now explains that the owner must clear the draft in the terminal before explicit
retry. This wording does not establish a fix for native empty-composer
classification in [nils-cli#2922](https://github.com/sympoies/nils-cli/issues/2922);
application/provider and native acceptance remain separate.

## Targeted discard of definitely refused local replies

The conversation view offers Discard for one definitely refused reply retained
by the legacy local queue, including a reply from an earlier session
incarnation. The durable transaction removes only the selected local row and
its echo; Retry, unconfirmed replies, unrelated state, and shared/server rows
remain intact. Discard does not submit again. This is separate from submitted
reply identity reconciliation.

Real native IndexedDB/client acceptance for the legacy local-row Discard
remains pending. No real-browser/native or automatic cross-window result is
claimed by source-package validation.

## Conversation images

The SDK preserves bounded opaque image selectors through history HTTP and SSE.
The explicit `@agent-console/shared/conversation-images` export provides the
shared normalization contract. Descriptors contain neither paths nor bytes;
unsupported URLs are not fetched. Image bytes use the authenticated history
ownership route, injected daemon credentials, bounded raster admission and
private no-store responses. Deleted images remain distinct from unavailable
images; abandoned transfers are cancelled.

History, full Conversation panels, phone panes and desktop tiles use the same
lazy thumbnails and message-scoped viewer. Fit, zoom, pan, image navigation,
keyboard focus and native Back dismissal retain the accepted behavior. The
isolated compiled consumer checks the actual image contract declarations and
authenticated exact byte forwarding; source headless fixtures cover the mounted
views. Real provider/native acceptance remains with its owning milestone.

## Theme

The console resolves a System / Dark / Paper setting (default System, stored per
device) to `data-theme="dark"` or `data-theme="paper"` on the root element and
keeps the chosen mode in `data-theme-mode`. `<meta name="theme-color">` follows
the resolved canvas colour. A consumer overlay can style its own markers with
`:root[data-theme="paper"]` or read the same state with `useTheme()` from
`@agent-console/ui/theme`, which also returns `setMode`.

## Application name and mark

`mountApp` takes optional `appName` and `appIcon` options. `appIcon` is
`{ dark, light }`: URLs of the header mark for dark surfaces and for light and
Paper surfaces. Every place the header mark renders (dashboard header, login,
settings) uses it. When `appIcon` is omitted the Salon mark is shown, so a host
that relied on the former Agent Console mark must now pass its own `appIcon`.

```ts
mountApp(root, { appName: "Example", appIcon: { dark: "/mark-dark.svg", light: "/mark-light.svg" } });
```

## Public SDK release

Publication is reserved for the authorized publisher after designated review and
merge. The checked-in SDK version is `0.1.28`; its release is a GitHub
prerelease with `latest=false`. The speech response `label` is shown verbatim in
the voice dialog and the voice tag (#216). Voice stays beside Send, and transcripts
are sent as a Markdown blockquote (#221). The deprecated `ScopeRecord`,
`scopeRecordKey` and `scopeParents` aliases are removed; import `LineageRecord`,
`lineageRecordKey` and `lineageParents` instead (#211). Existing
`v0.1.0` through `v0.1.27` tags and assets stay immutable. The visibility transition does not
republish those releases, change their source or digests, or reuse an existing
tag. A future publication requires separately approved version metadata and an
unused tag. This preparation does not establish version-merge or
publication GO. Source preparation does not authorize publication. The
authorized publisher uploads only
`shared.tgz`, `edge.tgz`, `ui.tgz` and `manifest.json`. The existing manifest is
the checksum record; no additional asset format is created.

Use a clean managed checkout at the exact approved full source SHA, with Node 24,
pnpm 11.9.0, installed frozen dependencies, `agent-run`, `forge-cli`, `gh` and
`tar`. Retain the exact source's gate, CI and designated review. Prepare notes
outside the checkout naming that full SHA, approved PR/CI, package versions and
compiled SDK scope; application/provider/container acceptance remains separate.
The entrypoint invokes `node scripts/release-core-sdk.ts` directly using Node 24
type stripping, with no tooling build step. The title summarizer adapter runs as
`.ts` in the checkout and ships as compiled `.js` through the existing edge
package build. Run the release entrypoint through the repository environment:

```bash
systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0 \
  agent-run exec --cwd "$salon_checkout" -- ./.agents/scripts/release.sh \
  "$approved_source_sha" "$release_notes_file" --dry-run
```

The publisher runs the same command without `--dry-run` only under its existing
release authorization. The script checks public repository identity and visibility, clean exact
source already merged into main, fixed versions and an unused tag. It runs the
existing `pack:core`, verifies manifest source/cleanliness/versions plus actual
archive sizes, hashes and compiled-only payloads, then repeats the public-scope
check before the native publisher. Main may advance without changing the exact
approved release source. Dry-run performs the same local checks and the native
`forge-cli release create --dry-run`; it does not publish.

After publication the entrypoint checks actual tag resolution, prerelease state,
four distinct uploaded asset IDs and provider sizes/digests, then downloads each
asset by ID and compares its bytes, including the manifest itself. Its final
stdout records those actual identities. A failed readback does not roll back or
replace a release; stop and hand the observed state to the release owner. Public acquisition uses the exact versioned release assets without a reader App
or acquisition token. Publishing still uses an authorized credential with release
write access; making assets readable does not authorize a publication.

Consumers select the explicit version and approved full source SHA. Fetch
`manifest.json`, `shared.tgz`, `edge.tgz` and `ui.tgz` from that tag's public
release download URLs, using an unauthenticated HTTP client that follows
redirects. Do not use a latest-release URL: these releases remain prereleases
with `latest=false`. Before installing, verify the manifest's `sourceCommit`,
package names and versions, byte sizes and SHA-256 digests against the actual
archives. Pin the verified version, source and digests in the consuming project.
Ordinary install, tests and builds require no acquisition credential.

## Remaining delivery work

After source review and producer validation, the designated steward must review
the export PR. Release creation and asset upload require their own authorized
release flow. Downstream acquisition must verify actual public asset bytes,
source commit and digests before pinning those exact artifacts. Its ordinary
install, tests and container build require no acquisition credential.
Deleting downstream vendored core follows the approved exact-artifact switch.
The original three packaging/workflow/evidence test files and two native desktop
configuration cases were transferred to their downstream overlay owner in
commit `46bab91a207f5849c1b778ea3c10d2dc03a4a9c4`, retaining all 50 distribution
cases. The source manifest preserves that history; those tests are already
absent from the current upstream core snapshot. The three core title-bar
rendering cases stay in this producer.

These package checks do not establish provider integration, container startup,
native packaging or reconnect acceptance. Those belong to their owning
application milestones.

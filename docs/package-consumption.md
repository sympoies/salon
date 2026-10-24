# Compiled package preparation

The preparation commands build local private packages without publishing them,
creating a release, changing repository visibility or establishing a downstream
published-version pin. The private SDK release entrypoint below is a separately
authorized publisher operation.

The current import follows merged source commit
`c1df368099b9ecffec7ae655732395aa0c1db6db`, whose full tree is identical to
reviewed head `f3c2478ba6e05b6f4e4a9c305335353d70c283de`. It includes the three
helper-module renames that prevent component and
model output paths from colliding on case-insensitive filesystems. The package
builder checks actual emitted JavaScript, declarations and copied assets; the
project gate also checks tracked paths.

The [source manifest](core-source-manifest.json) records current source hashes,
12 local license/comment/EOF/fixture adaptations and two full font license
notices. Its initial-import history preserves the original reviewed snapshot
and completed downstream distribution-test transfer. No upstream Git history, private
composition or environment files are imported. The Sign out fixture adaptation
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
shared, edge and mounted UI behavior tests; application/provider and native
acceptance remain separate.

## Private SDK release

Publication is reserved for the authorized publisher after designated review and
merge. The current SDK patch release is fixed at `v0.1.1`, a private GitHub prerelease
with `latest=false`; root and package versions are `0.1.1`. The existing `v0.1.0` tag and assets stay immutable. It uploads only
`shared.tgz`, `edge.tgz`, `ui.tgz` and `manifest.json`. The existing manifest is
the checksum record; no additional asset format is created.

Use a clean managed checkout at the exact approved full source SHA, with Node 24,
pnpm 11.9.0, installed frozen dependencies, `agent-run`, `forge-cli`, `gh` and
`tar`. Retain the exact source's gate, CI and designated review. Prepare notes
outside the checkout naming that full SHA, approved PR/CI, package versions and
compiled SDK scope; application/provider/container acceptance remains separate.
Run the entrypoint through the repository environment:

```bash
systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0 \
  agent-run exec --cwd "$salon_checkout" -- ./.agents/scripts/release.sh \
  "$approved_source_sha" "$release_notes_file" --dry-run
```

The publisher runs the same command without `--dry-run` only under its existing
release authorization. The script checks private repository scope, clean exact
source already merged into main, fixed versions and an unused tag. It runs the
existing `pack:core`, verifies manifest source/cleanliness/versions plus actual
archive sizes, hashes and compiled-only payloads, then repeats the private-scope
check before the native publisher. Main may advance without changing the exact
approved release source. Dry-run performs the same local checks and the native
`forge-cli release create --dry-run`; it does not publish.

After publication the entrypoint checks actual tag resolution, prerelease state,
four distinct uploaded asset IDs and provider sizes/digests, then downloads each
asset by ID and compares its bytes, including the manifest itself. Its final
stdout records those actual identities. A failed readback does not roll back or
replace a release; stop and hand the observed state to the release owner. Route
the verified identities through the lead/coordinator for the separate reader-App
byte/scope probe before downstream acquisition and exact pins.

## Remaining delivery work

After source review and producer validation, the designated steward must review
the export PR. Release creation and asset upload require their own authorized
release flow. Downstream acquisition must verify actual private asset bytes,
source commit and digests before pinning those exact artifacts. Its ordinary
install, tests and container build must run without the acquisition credential.
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

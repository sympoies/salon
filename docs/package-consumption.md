# Compiled package preparation

This prepares local private package consumption. It does not publish packages,
create a release, change a repository's visibility or establish a downstream
published-version pin.

The current import follows merged source commit
`540ca97a492a008d63dc4410eaa4502ce7536117`, whose full tree is identical to
reviewed head `2abcd0716923f87ed59867f7be2db73cc43be260`. It includes the three
helper-module renames that prevent component and
model output paths from colliding on case-insensitive filesystems. The package
builder checks actual emitted JavaScript, declarations and copied assets; the
project gate also checks tracked paths.

The [source manifest](core-source-manifest.json) records current source hashes,
11 local license/comment/EOF adaptations and two full font license notices. Its
initial-import history preserves the original reviewed snapshot and completed
downstream distribution-test transfer. No upstream Git history, private
composition or environment files are imported.

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

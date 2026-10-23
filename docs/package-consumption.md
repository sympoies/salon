# Compiled package preparation

This prepares local private package consumption. It does not publish packages,
create a release, change a repository's visibility or establish a downstream
published-version pin.

The initial import is bound to reviewed snapshot
`89a213ee4096d80ccb702618cbc935a584329218`, identical to merge
`2d00a8df5d89803f65934438113784529ec76169`. The
[source manifest](core-source-manifest.json) records each allowlisted source
hash, excluded distribution tests and the small local license/comment changes.
No upstream Git history, private composition or environment files are imported.

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
Before that deletion, relocate every excluded distribution test into its
downstream owner: the three packaging/workflow/evidence test files and two
native desktop configuration cases listed in the source manifest. Their valid
coverage remains with the distribution; the three core title-bar rendering
cases stay in this producer.

These package checks do not establish provider integration, container startup,
native packaging or reconnect acceptance. Those belong to their owning
application milestones.

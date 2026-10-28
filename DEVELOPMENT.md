# Development

Salon has three reusable core libraries and local package validation. The
complete application, container and provider milestone remains pending. The
first application milestone covers one provider before the full two-provider
MVP described in [README.md](README.md).

## Prerequisites

Use Git, Bash, Python 3.11 or newer, ShellCheck and the `devlog` CLI from
[nils-cli](https://github.com/sympoies/nils-cli). Select Node 24 from
`.node-version` and pnpm 11.9.0 from `packageManager`. The UI regression suite
uses isolated headless Chrome fixtures; install `google-chrome` or set the
existing `CHROME_BIN` override. Browser fixture temporary files use `/tmp`.

Install with `pnpm install --frozen-lockfile`. `pnpm build:packages` compiles
the three libraries; `pnpm pack:core` creates local tarballs with provenance
and digests. [Package consumption](docs/package-consumption.md) describes the
outside-workspace consumer and the separately authorized private SDK release
entrypoint. Application/container acceptance remains a separate milestone.
[Coordination resume](docs/coordination-resume.md) defines the authenticated
edge relay contract and its separate deployment acceptance.

## Before editing

Read [AGENTS.md](AGENTS.md) and inspect the files relevant to the requested
change. Keep user-facing status and the intended user flow in README; keep
contributor commands and delivery rules here. Add durable supporting detail
under `docs/` when a root entrypoint would otherwise become too long.

Use English, generic roles and neutral examples throughout repository files,
commit messages and pull requests. Keep secrets and private environment details
out of repository history. Supply operator-specific values through local
configuration. Do not add speculative frameworks, unused configuration or
placeholder tests.

## Validation

Run the same gate used by the pre-PR dispatcher:

```bash
bash scripts/validate-project-dev.sh
```

On Linux, run validation within the standard memory-limited scope:

```bash
systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0 bash .agents/scripts/pre-pr.sh
```

With Node 24 and pnpm on PATH, the gate checks Markdown links, its validation
contract, shell lint, devlog structure and Git whitespace across both the
committed change and working tree. It runs frozen install, core compilation,
typechecking (including `pnpm typecheck:scripts` for native Node tooling),
package tests, boundary/privacy checks and isolated packed-package consumption. The browser checks are headless fixtures; native/device and real
provider acceptance remain separate.
It removes any stale success marker before checking and writes
`.cache/agent-validation/project-dev.ok` only after every check passes.
[VALIDATION.toml](VALIDATION.toml) declares the finish-line command and marker;
[the pre-PR dispatcher](.agents/scripts/pre-pr.sh) invokes that command.

[CI](.github/workflows/ci.yml) invokes the same dispatcher for main-branch
pushes and pull requests from this repository. Results appear in job logs and
the workflow summary.

For documentation and build scaffolding without a practical failing behavior
test, explain the test-first waiver in the PR's `Test changes` section and list
the substitute checks actually run. Add behavior tests when executable product
behavior exists; do not create no-op or implementation-mirroring tests.

## Delivery

Use a focused branch and a reviewed pull request with a semantic commit message.
Include `Test changes`, exact validation commands and remaining limitations in
the PR description. A package gate pass does not establish application or provider
acceptance. Release publication, deployment and repository visibility changes
require a separate maintainer decision.

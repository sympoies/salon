# Development

Salon currently has a documentation and validation scaffold. Application code,
provider integration, packaging and container startup will arrive in later
changes. The first developer milestone covers one provider before the full
two-provider MVP described in [README.md](README.md).

## Prerequisites

Use Git, Bash, Python 3.11 or newer, ShellCheck and the `devlog` CLI from
[nils-cli](https://github.com/sympoies/nils-cli). No application dependency
installation or build is available at this stage.

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

The gate checks Markdown file links, the validation contract, shell syntax and
ShellCheck findings, development log structure, and Git whitespace errors.
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
the PR description. A scaffold pass does not establish application or provider
acceptance. Release publication, deployment and repository visibility changes
require a separate maintainer decision.

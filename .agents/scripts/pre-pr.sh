#!/usr/bin/env bash
set -euo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
  printf 'Bash 4 or newer is required. Install a modern Bash and put it first on PATH, then run bash .agents/scripts/pre-pr.sh.\n' >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"
# Run the configured command under this shell's `set -euo pipefail` rather
# than `exec`-ing it: a compound command (&&, ||, ;, |) then runs every stage
# and any failure aborts the gate. `exec` would bind only the first simple
# command and silently drop the rest, turning a partial run into a green gate.
# Includes the native TypeScript tooling check: pnpm run typecheck:scripts.
bash scripts/validate-project-dev.sh "$@"

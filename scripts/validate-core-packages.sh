#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ "$(node -p 'process.versions.node.split(".")[0]')" != "24" ]]; then
  printf 'Core validation requires Node 24; select .node-version before running.\n' >&2
  exit 1
fi
if [[ "$(pnpm --version)" != "11.9.0" ]]; then
  printf 'Core validation requires pnpm 11.9.0 from packageManager.\n' >&2
  exit 1
fi
command -v "${CHROME_BIN:-google-chrome}" >/dev/null || {
  printf 'Core UI fixture tests require headless Chrome (CHROME_BIN).\n' >&2
  exit 1
}
export TMPDIR=/tmp

pnpm install --frozen-lockfile
pnpm run build:packages
pnpm run typecheck
pnpm -r --workspace-concurrency=1 run test
pnpm run check:core
node --test scripts/package-consumption.test.mjs

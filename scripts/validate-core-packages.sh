#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

scope="${1:-full}"
suite=""
if [[ "$scope" == --suite ]]; then suite="${2:?Expected suite}"; fi
if [[ -n "$suite" ]]; then
  case "$suite" in core|edge|ui-unit|ui-browser) ;; *) exit 2 ;; esac
else
  case "$scope" in edge|ui|full) ;; *) exit 2 ;; esac
fi

if [[ "$(node -p 'process.versions.node.split(".")[0]')" != "24" ]]; then
  printf 'Core validation requires Node 24; select .node-version before running.\n' >&2
  exit 1
fi
if [[ "$(pnpm --version)" != "11.9.0" ]]; then
  printf 'Core validation requires pnpm 11.9.0 from packageManager.\n' >&2
  exit 1
fi
if [[ "$suite" == ui-browser || ( -z "$suite" && "$scope" != edge ) ]]; then
command -v "${CHROME_BIN:-google-chrome}" >/dev/null || {
  printf 'Core UI fixture tests require headless Chrome (CHROME_BIN).\n' >&2
  exit 1
}
fi
export TMPDIR=/tmp

pnpm install --frozen-lockfile
pnpm run build:packages
if [[ -n "$suite" ]]; then
  case "$suite" in
    core)
      pnpm run typecheck
      pnpm run typecheck:scripts
      pnpm --filter @agent-console/shared run test
      pnpm run check:core
      node --test scripts/package-consumption.test.ts
      node --test docker/start.test.mjs
      node --check apps/workspace/src/server.mjs
      pnpm --filter @salon/workspace run build
      ;;
    edge) pnpm --filter @agent-console/edge run test ;;
    ui-unit) bash scripts/test-ui.sh unit ;;
    ui-browser) bash scripts/test-ui.sh browser ;;
  esac
  exit 0
fi
pnpm run typecheck
pnpm run typecheck:scripts
pnpm --filter @agent-console/shared run test
if [[ "$scope" != ui ]]; then pnpm --filter @agent-console/edge run test; fi
if [[ "$scope" != edge ]]; then pnpm --filter @agent-console/ui run test; fi
pnpm run check:core
node --test scripts/package-consumption.test.ts

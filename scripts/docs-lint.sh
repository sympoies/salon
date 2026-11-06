#!/usr/bin/env bash
# The explicit list excludes historical logs, PR assets, licenses and generated files.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
kit="$repo_root/node_modules/.salon-docs-lint/1a72ec42076f78bd79976c176911ac0fb2f3bbc1"
if [[ ! -f "$kit/.installed" ]]; then
  printf 'Run bash scripts/install-docs-lint.sh before linting documentation.\n' >&2
  exit 2
fi
mapfile -t files < scripts/validation/docs-lint-files.txt
"$kit/tools/docs-readability/bin/docs-lint" "${files[@]}"

#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
marker=".cache/agent-validation/project-dev.ok"
rm -f "$marker"

scope=full
suite=""
case "${1:-}" in
  "") ;;
  --suite) suite="${2:?Expected suite}"; shift 2 ;;
  --scope) scope="${2:?Expected scope}"; shift 2 ;;
  --base) scope="$(python3 scripts/validation/ci_scope.py --base "${2:?Expected base ref}")"; shift 2 ;;
  *) printf 'Usage: %s [--base <ref> | --scope docs|edge|ui|full]\n' "$0" >&2; exit 2 ;;
esac
[[ $# == 0 ]] || exit 2
if [[ -n "$suite" ]]; then
  case "$suite" in
    cheap) scope=docs ;;
    core|edge|ui-unit|ui-browser) exec bash scripts/validate-core-packages.sh --suite "$suite" ;;
    *) exit 2 ;;
  esac
fi
case "$scope" in docs|edge|ui|full) ;; *) exit 2 ;; esac
printf 'Validation scope: %s\n' "$scope"

for tool in git python3 shellcheck devlog; do
  command -v "$tool" >/dev/null || {
    printf 'Required validation tool missing: %s\n' "$tool" >&2
    exit 1
  }
done

python3 scripts/validation/check-scaffold.py
python3 -m unittest discover -s scripts/validation -p '*_test.py'
while IFS= read -r -d '' script; do
  bash -n "$script"
  shellcheck "$script"
done < <(find scripts .agents/scripts -type f -name '*.sh' -print0)
devlog check
python3 scripts/validation/check-whitespace.py
if [[ "$scope" == docs ]]; then
  printf 'Documentation checks passed; full validation marker not written.\n'
  exit 0
fi
bash scripts/validate-core-packages.sh "$scope"
node --test docker/start.test.ts
pnpm --filter @salon/workspace run build

if [[ "$scope" != full ]]; then
  printf 'Scoped package validation passed; full validation marker not written.\n'
  exit 0
fi
mkdir -p "$(dirname "$marker")"
printf 'project-dev validation passed\n' > "$marker"
printf 'Project core package validation passed.\n'

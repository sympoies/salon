#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
marker=".cache/agent-validation/project-dev.ok"
rm -f "$marker"

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
bash scripts/validate-core-packages.sh

mkdir -p "$(dirname "$marker")"
printf 'project-dev validation passed\n' > "$marker"
printf 'Project core package validation passed.\n'

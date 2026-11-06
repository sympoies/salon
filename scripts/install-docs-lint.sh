#!/usr/bin/env bash
# Install the shared entrypoint and its upstream lockfile once per reviewed pin.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pin=1a72ec42076f78bd79976c176911ac0fb2f3bbc1
kit="$repo_root/node_modules/.salon-docs-lint/$pin"
[[ ! -f "$kit/.installed" ]] || exit 0
mkdir -p "$kit"
git init -q "$kit"
git -C "$kit" fetch -q --depth=1 https://github.com/sympoies/agent-runtime-kit.git "$pin"
git -C "$kit" archive FETCH_HEAD tools/docs-readability | tar -x -C "$kit"
npm ci --ignore-scripts --no-audit --no-fund --prefix "$kit/tools/docs-readability"
touch "$kit/.installed"

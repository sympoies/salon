#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/packages/ui"
kind="${1:?Expected unit or browser}"
case "$kind" in unit|browser) ;; *) exit 2 ;; esac
shard_args=()
if [[ -n "${UI_TEST_SHARD:-}" ]]; then
  if [[ ! "$UI_TEST_SHARD" =~ ^[1-9][0-9]*/[1-9][0-9]*$ ]] ||
     ! python3 -c 'import sys; i, n = map(int, sys.argv[1].split("/")); sys.exit(i > n)' "$UI_TEST_SHARD"; then
    printf 'Invalid UI_TEST_SHARD: expected i/n with 1 <= i <= n.\n' >&2
    exit 2
  fi
  shard_args+=("--test-shard=$UI_TEST_SHARD")
fi
export NODE_OPTIONS="${NODE_OPTIONS:-} --conditions=source"
# Keep the assertion safety guard ahead of either test partition.
node --test test/domAssertSafety.test.ts
files=()
for file in test/*.test.ts; do
  browser=false
  case "$file" in
    *.browser.test.ts|test/headerCountAvailability.test.ts|test/terminalContextCommands.test.ts) browser=true ;;
  esac
  if [[ "$kind" == browser && "$browser" == true ]] || [[ "$kind" == unit && "$browser" == false ]]; then
    files+=("$file")
  fi
done
[[ ${#files[@]} -gt 0 ]] || { printf 'Empty UI test partition: %s\n' "$kind" >&2; exit 1; }
node --test --test-reporter=tap --test-concurrency=3 "${shard_args[@]}" "${files[@]}"

#!/usr/bin/env bash
# Post-start smoke check for a Salon container started with a compose file.
# Needs only docker and curl; no provider credentials.
# Usage: smoke-compose.sh [compose-file]   (default: compose.image.yaml)
# Exit: 0 all checks passed, 1 a check failed, 2 usage or missing tool.
set -uo pipefail

compose_file="${1:-compose.image.yaml}"
expected_port="127.0.0.1:3000"
failures=0

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s: %s\n' "$1" "$2"; failures=$((failures + 1)); }

for tool in docker curl; do
  command -v "$tool" >/dev/null || { printf 'Missing required tool: %s\n' "$tool" >&2; exit 2; }
done
[[ -f "$compose_file" ]] || { printf 'Compose file not found: %s\n' "$compose_file" >&2; exit 2; }

container="$(docker compose -f "$compose_file" ps --quiet workspace 2>/dev/null)"
if [[ -z "$container" ]]; then
  fail "container running" "no workspace container; run 'docker compose -f $compose_file up -d' first"
  exit 1
fi
pass "container running"

health="$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null)"
if [[ "$health" == healthy ]]; then
  pass "container healthy"
else
  fail "container healthy" "status is '${health:-unknown}'"
fi

if curl --fail --silent --show-error --max-time 5 "http://${expected_port}/healthz" >/dev/null; then
  pass "healthz answers"
else
  fail "healthz answers" "no success from http://${expected_port}/healthz"
fi

published="$(docker port "$container" 3000/tcp 2>/dev/null)"
if [[ "$published" == "$expected_port" ]]; then
  pass "published port is loopback ($expected_port)"
else
  fail "published port is loopback" "expected only $expected_port, got '${published//$'\n'/ }'"
fi

# Real and effective uid of every process, read inside the container; `docker top`
# would show host-mapped names.
uids="$(docker exec "$container" sh -c 'grep -h "^Uid:" /proc/[0-9]*/status' 2>/dev/null |
  awk '{print $2; print $3}')"
if [[ -n "$uids" ]] && ! grep -qx 0 <<<"$uids"; then
  pass "process is non-root"
else
  fail "process is non-root" "uids: ${uids//$'\n'/ }"
fi

((failures == 0))

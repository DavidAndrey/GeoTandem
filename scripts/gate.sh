#!/usr/bin/env bash
# The gate every work package finishes with: static checks and tests, then the
# container as it ships — first start on an empty volume (F-2.12), Playwright
# against it, a restart on the same volume (F-2.17, no second sample load), and
# Playwright once more on the data the first pass left behind.
set -euo pipefail
cd "$(dirname "$0")/.."

image=geotandem:gate
name="geotandem-gate-$$"
volume="$name-data"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_healthy() {
  local status
  for _ in $(seq 1 60); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$name")
    case "$status" in
      healthy) return 0 ;;
      unhealthy) break ;;
    esac
    sleep 1
  done
  echo "container is $status" >&2
  docker logs "$name" >&2
  return 1
}

step "lint"
make lint

step "test"
make test

step "image"
docker build -t "$image" .

step "first start on an empty volume"
docker run -d --name "$name" -p 127.0.0.1::8000 -v "$volume:/data" "$image" >/dev/null
wait_healthy
port=$(docker port "$name" 8000/tcp | head -n1 | sed 's/.*://')
docker logs "$name" 2>&1 | grep -q "sample dataset" \
  || { echo "sample dataset was not loaded on first start" >&2; exit 1; }

step "playwright against http://127.0.0.1:$port"
(cd e2e && E2E_BASE_URL="http://127.0.0.1:$port" npx playwright test --reporter=line)

step "restart on the same volume"
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker restart "$name" >/dev/null
wait_healthy
if docker logs --since "$since" "$name" 2>&1 | grep -q "sample dataset"; then
  echo "sample dataset was loaded again after restart" >&2
  exit 1
fi

step "playwright again, on the data of the first pass"
port=$(docker port "$name" 8000/tcp | head -n1 | sed 's/.*://')  # new port after restart
(cd e2e && E2E_BASE_URL="http://127.0.0.1:$port" npx playwright test --reporter=line)

step "gate passed"

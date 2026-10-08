#!/usr/bin/env bash
# The gate every work package finishes with: static checks and tests, then the
# container as it ships — first start on an empty volume (F-2.12), Playwright
# against it, a restart on the same volume (F-2.17, no second sample load), and
# Playwright once more on the data the first pass left behind.
#
# The container sits on an internal Docker network: no route out, no name
# lookup. Every Playwright pass is thereby the offline proof (F-9.1, E2.1).
# With GATE_LLM_MODEL set, an Ollama container joins that network and the
# E2.1 acceptance connects that model and needs its connection test green:
#
#   GATE_LLM_MODEL=qwen3:8b make gate
#
#   GATE_OLLAMA_MODELS  Ollama's model store (manifests/, blobs/), mounted
#                       read-only; default /usr/share/ollama/.ollama/models,
#                       where the Linux installer keeps it. Also a volume name.
#   GATE_OLLAMA_IMAGE   default ollama/ollama
#   GATE_REQUIRE_LLM=1  fail instead of skipping when GATE_LLM_MODEL is unset
set -euo pipefail
cd "$(dirname "$0")/.."

image=geotandem:gate
name="geotandem-gate-$$"
volume="$name-data"
network="$name-net"
ollama="$name-ollama"
llm_model=${GATE_LLM_MODEL:-}

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

cleanup() {
  docker rm -f "$name" "$ollama" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
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

# No port is published on an internal network: the host reaches the container
# by its address on that network's bridge.
address() {
  docker inspect -f "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$name"
}

start_ollama() {
  local models=${GATE_OLLAMA_MODELS:-/usr/share/ollama/.ollama/models}
  local gpus=()
  if docker info --format '{{json .Runtimes}}' | grep -q nvidia; then gpus=(--gpus all); fi
  # OLLAMA_NOPRUNE: the store is read-only and not the gate's to tidy.
  docker run -d --name "$ollama" --network "$network" --network-alias ollama "${gpus[@]}" \
    -v "$models:/root/.ollama/models:ro" -e OLLAMA_NOPRUNE=1 \
    -e OLLAMA_CONTEXT_LENGTH=8192 "${GATE_OLLAMA_IMAGE:-ollama/ollama}" >/dev/null
  local listed
  for _ in $(seq 1 30); do
    if listed=$(docker exec "$ollama" ollama list 2>/dev/null); then
      if awk 'NR > 1 {print $1}' <<<"$listed" | grep -qxF "$llm_model"; then
        return 0
      fi
      echo "$llm_model is not in $models; pull it there first" >&2
      return 1
    fi
    sleep 1
  done
  echo "ollama did not start" >&2
  docker logs "$ollama" >&2
  return 1
}

if [ -z "$llm_model" ] && [ "${GATE_REQUIRE_LLM:-}" = 1 ]; then
  echo "GATE_REQUIRE_LLM=1 but GATE_LLM_MODEL is unset" >&2
  exit 1
fi

step "lint"
make lint

step "test"
make test

step "known vulnerabilities in dependencies"
make audit

step "image"
docker build --pull -t "$image" .

step "first start on an empty volume, on a network without a route out"
docker network create --internal "$network" >/dev/null
llm_env=()
if [ -n "$llm_model" ]; then
  start_ollama
  llm_env=(E2E_LLM_URL=http://ollama:11434/v1 E2E_LLM_MODEL="$llm_model")
fi
docker run -d --name "$name" --network "$network" -v "$volume:/data" \
  -e GEOTANDEM_LLM_LOCAL_HOSTS=ollama "$image" >/dev/null
wait_healthy
base="http://$(address):8000"
# Logs into a variable first: with pipefail, `docker logs | grep -q` fails when
# grep stops at the first match and docker logs dies writing the rest.
logs=$(docker logs "$name" 2>&1)
grep -q "sample dataset" <<<"$logs" \
  || { echo "sample dataset was not loaded on first start" >&2; exit 1; }

# As an operator would: the setup token from the first start's log (security review #1).
token=$(grep -o 'Setup token: [A-Za-z0-9_-]*' <<<"$logs" | head -n1 | cut -d' ' -f3)
[ -n "$token" ] || { echo "no setup token in the log of the first start" >&2; exit 1; }

step "playwright against $base, offline${llm_model:+, with $llm_model}"
(cd e2e && env "${llm_env[@]}" E2E_SETUP_TOKEN="$token" E2E_BASE_URL="$base" \
  npx playwright test --reporter=line)

step "restart on the same volume"
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker restart "$name" >/dev/null
wait_healthy
logs=$(docker logs --since "$since" "$name" 2>&1)
if grep -q "sample dataset" <<<"$logs"; then
  echo "sample dataset was loaded again after restart" >&2
  exit 1
fi
if grep -q "Setup token" <<<"$logs"; then
  echo "a set-up instance still offers a setup token" >&2
  exit 1
fi

step "playwright again, on the data of the first pass"
base="http://$(address):8000"  # the address may change with the restart
# Marked, so tests that save in the first pass insist on finding it (E1.7).
(cd e2e && E2E_AFTER_RESTART=1 E2E_BASE_URL="$base" npx playwright test --reporter=line)

if [ -z "$llm_model" ]; then
  step "gate passed — SKIPPED: E2.1 with a local model (set GATE_LLM_MODEL)"
else
  step "gate passed"
fi

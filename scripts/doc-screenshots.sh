#!/usr/bin/env bash
# Screenshots of the query editor for docs/filters.md, chapter 2: builds the
# frontend from the working tree, starts a throwaway instance with the sample
# dataset and no basemap, photographs every example and stores the pictures,
# scaled to 3/4 and reduced to 256 colours, in docs/img/filter-beispiele/.
# Fails when a hit count in the interface differs from the document.
set -euo pipefail
cd "$(dirname "$0")/.."

port=${DOC_SCREENSHOTS_PORT:-8765}
out=docs/img/filter-beispiele
work=$(mktemp -d)
server=

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

cleanup() {
  [ -n "$server" ] && kill "$server" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

step "frontend"
(cd frontend && npm run build >/dev/null)

step "instance on port $port"
mkdir -p "$work/data" "$work/shots"
export GEOTANDEM_SETUP_TOKEN="screenshots-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
GEOTANDEM_DATA_DIR="$work/data" GEOTANDEM_LOAD_SAMPLE_DATA=true GEOTANDEM_BASEMAP=none \
  GEOTANDEM_FRONTEND_DIR="$PWD/frontend/dist" \
  uv run geotandem serve --port "$port" >"$work/server.log" 2>&1 &
server=$!
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$port/" >/dev/null && break
  kill -0 "$server" 2>/dev/null || { cat "$work/server.log"; exit 1; }
  sleep 1
done

step "screenshots"
(cd e2e && node screenshots/filter-examples.mjs "http://127.0.0.1:$port" "$work/shots")

step "$out"
mkdir -p "$out"
uv run --with pillow python - "$work/shots" "$out" <<'EOF'
import sys
from pathlib import Path

from PIL import Image

source, target = map(Path, sys.argv[1:])
for shot in sorted(source.glob("beispiel-*.png")):
    image = Image.open(shot).convert("RGB")
    image = image.resize((image.width * 3 // 4, image.height * 3 // 4), Image.LANCZOS)
    reduced = image.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    reduced.save(target / shot.name, optimize=True)
    print(f"{target / shot.name}  {(target / shot.name).stat().st_size // 1024} KB")
EOF

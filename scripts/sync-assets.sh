#!/usr/bin/env bash
#
# sync-assets.sh
# -------------------------------------------------------------------
# Copies the SHARED, already public assets (maps and fonts) from the
# reference site repo into this project, so the GM Console carries its
# own self-contained copy and works offline.
#
# Single source of truth: the reference repo. Self-contained output:
# this repo. Run this before a local session and before deploying.
#
# It NEVER copies GM-only assets (hidden map variants, enemy tokens,
# spoilers). Those live only in this repo and must never go to the
# public reference repo. This script only ever reads from the
# reference repo and writes into this one.
# -------------------------------------------------------------------
set -euo pipefail

# Where the public reference site repo lives, relative to this repo
# root (or set an absolute path). Override with: REF_DIR=/path ./scripts/sync-assets.sh
REF_DIR="${REF_DIR:-../ShadowOverAldermere}"

# Resolve paths relative to this script, so it works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REF_DIR="$(cd "$PROJECT_ROOT" && cd "$REF_DIR" 2>/dev/null && pwd || true)"

if [ -z "$REF_DIR" ] || [ ! -d "$REF_DIR" ]; then
  echo "ERROR: reference repo not found. Set REF_DIR to the ShadowOverAldermere clone." >&2
  echo "  example: REF_DIR=/path/to/ShadowOverAldermere ./scripts/sync-assets.sh" >&2
  exit 1
fi

echo "Reference repo: $REF_DIR"
echo "This project:   $PROJECT_ROOT"

# The shared map files this project uses as the REVEALED side of its
# sample scenes. Add filenames here as you wire more shared maps.
MAPS=(
  city-gate.jpg
  inn-first-floor.jpg
  market.jpg
  town-center.jpg
)

# The shared web fonts (cozy-gothic typography, work offline).
FONTS=(
  cinzel.woff2
  atkinson-400.woff2
  atkinson-700.woff2
  atkinson-italic.woff2
)

copy_set () {
  local label="$1" src_dir="$2" dst_dir="$3"; shift 3
  local names=("$@")
  mkdir -p "$dst_dir"
  echo
  echo "$label  ($src_dir -> $dst_dir)"
  for name in "${names[@]}"; do
    if [ -f "$src_dir/$name" ]; then
      cp -f "$src_dir/$name" "$dst_dir/$name"
      echo "  copied  $name"
    else
      echo "  MISSING $name (not found in reference repo)" >&2
    fi
  done
}

copy_set "Maps"  "$REF_DIR/maps"  "$PROJECT_ROOT/assets/maps"  "${MAPS[@]}"
copy_set "Fonts" "$REF_DIR/fonts" "$PROJECT_ROOT/assets/fonts" "${FONTS[@]}"

echo
echo "Done. Hidden map variants are GM-only and are not synced; add them by hand."

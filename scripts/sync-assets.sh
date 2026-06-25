#!/usr/bin/env bash
#
# sync-assets.sh
# -------------------------------------------------------------------
# Copies the SHARED, already public assets (maps, fonts, and optional sample
# character cutouts) from the reference site repo into this project, so the GM
# Console carries its own self-contained copy and works offline. It then scans
# the asset folders and regenerates data/manifest.js (the scene builder's pick
# lists).
#
# Single source of truth: the reference repo. Self-contained output:
# this repo. Run this before a local session and before deploying.
#
# It NEVER copies GM-only assets (hidden map variants, custom spoiler
# art). Those live only in this repo and must never go to the public
# reference repo. The optional SEED_SAMPLES / SEED_TOKENS steps copy
# only already-public sample art. This script only ever reads from the
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

# Public hero cutouts (transparent PNGs) seeded as SAMPLE characters when
# SEED_SAMPLES=1. They already exist on the public reference site, so copying
# them here is not a spoiler. Drop your own character PNGs into
# assets/characters at any time; the manifest scan picks them up.
HEROES=(
  lysander.png
  telstar.png
  thraka.png
  khaleesi.png
  sai.png
  samsara.png
  truf.png
)

# Public round token art (JPGs) seeded as SAMPLE tokens when SEED_TOKENS=1.
# Hero files keep their name (assets/tokens/heroes/<id>.jpg); the sample enemy
# is renamed to match cast.js (assets/tokens/enemies/brigands.jpg). Tokens are
# NOT scanned -- cast.js is the source of truth; drop your own art at its paths.
HERO_TOKENS=(
  lysander.jpg
  telstar.jpg
  thraka.jpg
  khaleesi.jpg
  sai.jpg
  samsara.jpg
  truf.jpg
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

# Optional: seed sample character cutouts so the scene builder has transparent
# characters to pick on a fresh checkout. Off by default so a routine asset
# refresh does not recopy them. Enable with:
#   SEED_SAMPLES=1 ./scripts/sync-assets.sh
if [ "${SEED_SAMPLES:-0}" = "1" ]; then
  copy_set "Characters (samples)" "$REF_DIR/art" "$PROJECT_ROOT/assets/characters" "${HEROES[@]}"
fi

# Optional: seed sample round token art (heroes + the sample brigands enemy) so
# the map board shows portraits on a fresh checkout. Off by default. Enable with:
#   SEED_TOKENS=1 ./scripts/sync-assets.sh
if [ "${SEED_TOKENS:-0}" = "1" ]; then
  copy_set "Hero tokens" "$REF_DIR/hero" "$PROJECT_ROOT/assets/tokens/heroes" "${HERO_TOKENS[@]}"
  # The sample enemy art is enemy-brigands.jpg in the reference repo, but cast.js
  # points at tokens/enemies/brigands.jpg -- copy it under the expected name.
  mkdir -p "$PROJECT_ROOT/assets/tokens/enemies"
  echo
  echo "Enemy tokens  ($REF_DIR/hero -> $PROJECT_ROOT/assets/tokens/enemies)"
  if [ -f "$REF_DIR/hero/enemy-brigands.jpg" ]; then
    cp -f "$REF_DIR/hero/enemy-brigands.jpg" "$PROJECT_ROOT/assets/tokens/enemies/brigands.jpg"
    echo "  copied  enemy-brigands.jpg -> brigands.jpg"
  else
    echo "  MISSING enemy-brigands.jpg (not found in reference repo)" >&2
  fi
fi

# Always regenerate the asset manifest the scene builder reads, scanning
# whatever is now in assets/maps, assets/backgrounds, and assets/characters.
echo
if command -v python3 >/dev/null 2>&1; then
  echo "Manifest  (scanning assets -> data/manifest.js)"
  python3 "$SCRIPT_DIR/scan_assets.py"
else
  echo "WARNING: python3 not found; data/manifest.js was not regenerated." >&2
fi

echo
echo "Done. Hidden map and background variants are GM-only and are not synced; add them by hand."

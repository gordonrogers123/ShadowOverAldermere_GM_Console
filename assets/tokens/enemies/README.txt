Enemy token art (round portraits) goes here.

Each file is named after an enemy id in data/cast.js, e.g. brigands.jpg. cast.js
is the source of truth; these images are NOT scanned by scan_assets.py. Until a
file is present the token shows initials over a colored ring.

Seed the public sample art with:  SEED_TOKENS=1 ./scripts/sync-assets.sh

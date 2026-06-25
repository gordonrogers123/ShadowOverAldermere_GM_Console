Hero token art (round portraits) goes here.

Each file is named after a hero id in data/cast.js, e.g. lysander.jpg. cast.js
is the source of truth for which tokens exist and their ring colors; these
images are NOT scanned by scan_assets.py. Until a file is present the token
shows the hero's initials over a colored ring, so the board works without art.

Seed the public sample art with:  SEED_TOKENS=1 ./scripts/sync-assets.sh

Drop background images here (JPG or PNG).

These are the backdrops the scene builder offers: a flat location or
cinematic art, used as the background layer of a scene. After you add or
remove files, click "Rescan assets" in the GM window (or run
scripts/sync-assets.sh) to refresh the builder's pick lists.

Naming:
- A file named something_hidden.jpg (or _hidden.png) is treated as a
  GM-only reveal variant and is NOT listed as a background on its own.
  Pair it with the matching base background in the builder.

This folder is tracked in git (via this note) so it travels with the repo.
Commit the images you want to keep, and commit the regenerated
data/manifest.js alongside them.

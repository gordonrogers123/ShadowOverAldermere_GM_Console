Drop transparent character PNGs here.

These are the character cutouts the scene builder offers for the left and
right of a scene. For best results use a PNG with a transparent background
(an alpha channel), cropped to the figure. After you add or remove files,
click "Rescan assets" in the GM window (or run scripts/sync-assets.sh) to
refresh the builder's pick lists.

Sample cutouts: run SEED_SAMPLES=1 ./scripts/sync-assets.sh to copy the
seven public hero PNGs from the reference site into this folder as
ready-to-use samples.

This folder is tracked in git (via this note) so it travels with the repo.
Commit the images you want to keep, and commit the regenerated
data/manifest.js alongside them.

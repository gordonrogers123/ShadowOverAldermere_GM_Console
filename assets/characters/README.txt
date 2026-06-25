Character cutouts, split by category.

The scene builder offers these as the LEFT and RIGHT character of a scene,
grouped by category in the pick lists:

  characters/heroes/   the player characters
  characters/npcs/     non-player characters (quest givers, townsfolk)
  characters/enemies/  villains and monsters shown in cinematic shots

Drop a transparent PNG (alpha channel, cropped to the figure) into the folder
that matches the character's category. After adding or removing files, click
"Rescan assets" in the GM window (or run scripts/sync-assets.sh) to refresh the
builder's pick lists.

Files dropped directly in this folder (not in a subfolder) still work and are
treated as heroes, but prefer the subfolders so the pickers stay organized.

Sample cutouts: run  SEED_SAMPLES=1 ./scripts/sync-assets.sh  to copy the seven
public hero PNGs from the reference site into characters/heroes/.

These folders are tracked in git (via these notes) so they travel with the repo.
Commit the images you want to keep, and commit the regenerated data/manifest.js
alongside them.

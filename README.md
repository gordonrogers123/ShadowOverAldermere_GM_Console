# Aldermere GM Console

A local, two-window web app for running an in-person Dungeons and Dragons
session. The GM drives a private control surface on the laptop; the Player
window goes on a TV (an extended display over HDMI) and shows the scene.

The spine of the app is the **scene**, now a composition:

- a **background** (a tactical map or cinematic art) with one or more named
  reveal variants (for example a room covered, then uncovered),
- an optional **left** and **right** character (a transparent PNG) shown over
  the background with transitions,
- round **tokens** for heroes and enemies, placed and moved on a map in a
  dedicated map mode, with a per-scene roster of who can be placed,
- and, reserved for a later phase, audio.

You build scenes from the art you drop into the repo, save them to a recall
list, and during play direct the stage live: show or hide the whole scene
(it fades up from or down to black), switch the background variant, and bring
each character in (from its side, or by fading) or out.

This project is separate from the public reference site
(`ShadowOverAldermere`). It holds GM-only content (spoilers, hidden art) and
**must never be deployed to a public URL**. It runs locally, with no internet,
and (later) on a private Cloudflare Pages site gated by Cloudflare Access.

## Run it

You need a local static server so both windows share an origin (the windows
talk over the BroadcastChannel API, which needs a real origin, not a `file://`
path). Use the included helper server, which also powers the **Rescan assets**
button:

```
python3 scripts/serve.py
```

It serves on port 8000 by default (`python3 scripts/serve.py 8123` to change
it). Then open two windows in Chrome or Edge:

- GM control: `http://localhost:8000/?view=gm`
- Player screen: `http://localhost:8000/?view=player`

Opening `http://localhost:8000/` with no `?view=` shows a small chooser with a
link to each. A plain `python3 -m http.server 8000` also works, but the Rescan
button needs `serve.py`; without it, run the sync script instead (see below).

### During a session

1. Open both windows. Drag the Player window onto the TV and fullscreen it.
2. In the GM window, click a scene. The Player fades up from black into the
   scene: the background, plus any characters entering from their sides.
3. Direct the stage live from the GM window:
   - **Hide scene** drops a black curtain over everything; **Show scene** lifts
     it. Good for cutting to black between beats.
   - **Background** variant buttons switch the backdrop (for example **Hidden**
     to **Revealed**, or a covered room to an uncovered one), cross-fading.
   - **Left** and **right** **Enter** / **Exit** bring each character on or off.
     A character set to "Enter from side" slides in from its edge; one set to
     "Fade in" fades in place.
   - A per-side character picker lets you swap who is on that side on the fly.
     **Reset** returns to the scene's own character.
4. Refreshing either window restores the current scene and stage.

## Build a scene

Click **New scene** in the GM window to open the builder, or select a scene and
click **Edit in builder** to base a new one on it.

- **Name** the scene.
- **Background variants**: pick a background for each variant and label it. The
  first variant is what players see first, so keep spoilers in a later one.
  **Add variant** for more reveal states; **Remove** to drop one.
- **Left** and **right character**: pick a cutout (or None) and an entrance
  (Enter from side, or Fade in).
- **Roster**: check the heroes and enemies that can be placed on this map. This
  only marks who is eligible; you place and move them live in map mode.
- The preview composites your choices exactly as the TV will show them.
- **Save scene** stores it in this browser (it survives refreshes) and adds it
  to the scene list, marked "saved". **Export** prints a paste-ready scene
  object to copy into `data/scenes.js` when you want to commit or share it.

Saved scenes live in the browser's localStorage, so they are per machine until
you export them into `data/scenes.js`. A saved scene whose id matches a shipped
scene overrides it, so you can tweak a built version of a shipped scene.

## Tokens and map mode

A map scene can carry **tokens**: round markers for the heroes and enemies in
play. Give the scene a **Roster** in the builder (which heroes and enemies are
eligible), then click **Map mode** on the scene's live controls to run it.

Map mode opens an enlarged board with the roster tray beside it:

- **Add** a hero or enemy from the tray to drop it on the board. Heroes are
  unique; enemies are auto-numbered (Brigand 1, Brigand 2, ...), so add as many
  of a kind as you need.
- **Drag** a token to move it. Its position is stored as a fraction of the map
  image, so it lands on the same spot on the TV no matter the window size.
- **Reveal** / **Hide** sets what the Player TV shows per token. Heroes are
  placed visible; enemies are placed hidden, so you can stage an ambush and
  reveal them on cue. A hidden token still shows as a dim ghost on your board.
- **×** takes a token off the board.

Tokens render as a colored ring (green for heroes, red for enemies) around a
round portrait. Until you vendor token art (below) a token shows the character's
initials over the ring, so the board is fully usable right away. The whole-scene
**Hide scene** curtain covers tokens too.

## Drop in backgrounds and characters

The builder offers whatever art is in the asset folders:

- backgrounds: `assets/backgrounds/` (cinematic art) and `assets/maps/` (maps),
- characters: `assets/characters/` (transparent PNG cutouts).

Drop your files into those folders, then make them appear as pickable options
one of two ways:

- Click **Rescan assets** in the GM window (needs `serve.py` running), or
- Run `./scripts/sync-assets.sh`.

Either way regenerates `data/manifest.js` (the builder's pick lists). Commit
that file alongside the images you added.

For sample cutouts to try the feature immediately, seed the seven public hero
PNGs from the reference site:

```
SEED_SAMPLES=1 ./scripts/sync-assets.sh
```

Note: those samples are full character illustrations, so they fill their
rectangle rather than standing as cutouts. Drop your own transparent PNGs (a
figure on a transparent background) into `assets/characters/` for the intended
"character on the stage" look.

### Token art

Token images are listed in `data/cast.js` (heroes and enemies, each with a
name, a ring color, and an image path under `assets/tokens/`). Unlike
backgrounds and characters, token art is **not** scanned: drop a file at the
path a cast entry names (for example `assets/tokens/enemies/brigands.jpg`) and
it shows on that token automatically. Until then the token falls back to the
character's initials, so the board works before any art exists. Add a hero or
enemy to the roster picker by adding an entry to `data/cast.js`.

## Add or hand-edit a scene

Scenes are data, not code. Edit `data/scenes.js`, copy a block, give it a new
unique `id`, and save. It appears in the GM list on the next reload.

```js
{
  id: "old-mill",
  name: "The Old Mill",
  maps: {                                  // the background, with reveal variants
    hidden:   "assets/maps/old-mill_hidden.jpg",   // shown first (spoiler safe)
    revealed: "assets/maps/old-mill.jpg"           // a later variant
  },
  defaultMapState: "hidden",
  characters: {                            // optional, each side independent
    left:  { id: "wren", src: "assets/characters/wren.png", enter: "slide" },
    right: { id: "wick", src: "assets/characters/wick.png", enter: "fade" }
  },
  defaults: { visible: true, leftShown: true, rightShown: true },  // opening posture
  tokens:   { heroes: ["lysander"], enemies: ["brigands"] },  // map roster, or null
  music:    null,   // reserved (Phase 4)
  ambience: [],     // reserved (Phase 4)
  audio:    null,   // reserved (Phase 4)
  gmNotes:  "Only you see this."
}
```

### The spoiler rule

- **Hidden variants are GM-only.** Author them and keep them **only in this
  repo**, never in the public reference repo. Name a hidden background file with
  a `_hidden` suffix; the scan keeps `*_hidden` files out of the standalone pick
  lists, so they are only ever used as a named variant of a scene.
- If a variant file named by a scene is not present yet, the Player shows a
  neutral "not yet revealed" plate with the scene name instead of a broken
  image, and the reveal still cross-fades. A missing character cutout simply
  does not appear (no broken image). So you can wire a scene before its art
  exists.
- The seeded sample characters come from the public reference art, so seeding
  them is not a spoiler.

## Refresh shared assets

The shared, already public assets (maps, fonts, and the optional sample
characters) have one canonical home: the reference site repo. This project
keeps its own committed copy so it is self-contained and works offline.

```
./scripts/sync-assets.sh
```

By default it looks for the reference repo at `../ShadowOverAldermere`; override
with `REF_DIR=/path/to/ShadowOverAldermere ./scripts/sync-assets.sh`. It only
ever reads from the reference repo and writes into this one, never the reverse,
and never touches hidden art. It finishes by regenerating `data/manifest.js`.

## How it is put together

- Plain HTML, CSS, and JavaScript (ES modules). No framework, no bundler, no
  build step.
- One app, two views, chosen by the `?view=` URL parameter.
- The GM window is the source of truth. It saves state to `localStorage` and
  broadcasts every change. The Player window is a pure renderer that restores
  from `localStorage` on load and then follows the GM window.
- `js/sync.js` is the only file that knows how the two windows talk
  (BroadcastChannel today). A separate-device setup later would touch only it.
- `js/stageView.js` is the shared compositor: the same code renders the Player
  TV and the GM builder preview, so the preview matches the TV exactly.

```
index.html            single entry; reads ?view=gm or ?view=player
css/                  app.css (shared + stage timings), gm.css, player.css
js/                   main.js (router), sync.js, state.js,
                      stageView.js (compositor), transitions.js,
                      scenesAll.js + userScenes.js (scene resolution),
                      gm.js (control surface + builder), player.js (TV)
data/                 scenes.js (content), manifest.js (generated pick lists),
                      cast.js (token markers + NPC portraits)
assets/maps/          maps (shared, committed); hidden maps (GM only)
assets/backgrounds/   your cinematic backgrounds (drop files in)
assets/characters/    your transparent character PNGs (drop files in)
assets/tokens/        round token art: heroes/ and enemies/ (named in cast.js)
assets/fonts/         Cinzel and Atkinson Hyperlegible (offline)
scripts/              serve.py (local server + rescan), scan_assets.py,
                      sync-assets.sh
```

## Phase status

Done: the two-window shell (Phase 1); the scene compositor (Phase 2) — layered
background plus left and right characters, named background variants, the
show/hide curtain and character transitions, the in-window scene builder with
save and export, and the drop-files plus rescan asset pipeline; and tokens
(Phase 3) — round hero and enemy markers placed, numbered, dragged, and revealed
on a map in a dedicated map mode, with a per-scene roster.

Reserved for later: audio with music, ambience, and volumes (Phase 4). The scene
data model already carries the `audio` fields so it needs no reshape. The
service worker for offline caching and the Cloudflare Pages plus Access
deployment are also later steps.

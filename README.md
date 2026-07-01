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

Saved scenes are stored two ways: in the browser's localStorage (instant) and,
when the local server is running, on disk in `data/userScenes.json`. The disk
copy is what lets a setup survive clearing browser data or moving to another
machine — both windows load it at startup. A saved scene whose id matches a
shipped scene overrides it, so you can tweak a built version of a shipped scene.
Export still prints a paste-ready object for `data/scenes.js` when you want to
commit a scene into the code itself.

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
- **Save layout** records where every token sits (and which are hidden) onto the
  scene, so opening it later places them exactly as you left them. **Reset to
  saved layout** snaps the board back to that arrangement after live moves. This
  is how you prep an encounter the day before and still rearrange in the moment.

Tokens render as a colored ring (green for heroes, red for enemies) around a
round portrait. Until you vendor token art (below) a token shows the character's
initials over the ring, so the board is fully usable right away. The whole-scene
**Hide scene** curtain covers tokens too.

## Combat: attacks, saves, and heals

In map mode, whoever is up in the initiative tracker shows a **stat card** with
their combat actions, taken from their character sheet. Each action resolves on
the board against a **target** you pick (a red arrow links attacker and target on
both screens); with a grid laid down, the card also flags range at the measured
distance (in reach / in range / long — disadvantage / out).

Actions come in three shapes, each with its own buttons after **Target**:

- **Attack rolls** — **Hit** rolls d20 + the bonus versus the target's AC (with
  crit and miss), then **Dmg** rolls the damage and subtracts it. Longsword, Fire
  Bolt, Guiding Bolt, Scimitar, and the like. Magic Missile rolls all **three
  darts**.
- **Saving throws** — **Save**. When the target has a stat block the save is
  rolled for you (its d20 + the relevant ability modifier versus the spell's DC);
  a target with no stats (an NPC) gives you a **✓ Saved / ✗ Failed** button
  instead. The outcome applies automatically: **negate** (Sacred Flame — full
  damage on a fail, none on a save), **half on a save** (Breath Weapon, Hellish
  Rebuke), and/or a **condition on a failed save** (Entangle / Web → restrained).
- **Heals** — **Heal** adds HP back, clamped to the maximum. Second Wind heals the
  caster with no target; Cure Wounds and Healing Word heal a targeted ally.

A resolved roll prints a one-line readout on the card — the d20-versus-DC math and
exactly what it applied.

### What the card includes — and what it doesn't

The card is the **combat-resolution subset** of each sheet: weapon and cantrip
attacks, damaging and condition saving throws, area spells, healing, and a few
damage riders (Sneak Attack, Reckless Attack) as manual rows. Every number is
reconciled from the character sheets in the reference site repo, matched to real
5e structure.

Area spells whose shape you place on the board — the Breath Weapon **cone**, Turn
Undead **radius**, and the placed **zones** (Entangle, Web, Spike Growth) — carry
their area data on the card today and resolve against a **single target**; placing
the template so it auto-collects everyone inside is the very next step (see
`docs/ROADMAP.md`).

Deliberately **not** on the card — these stay on the printed sheet and are run
narratively by the GM, since they don't reduce to a target-and-roll:

- **Utility & movement** — Mage Hand, Minor Illusion, Misty Step, Wild Shape,
  Cunning Action, Step of the Wind, rituals (Speak with Animals), Action Surge.
- **Buffs** — Bless, Guidance.
- **Passives & reactions** — Rage, Danger Sense, Relentless, Portent, Deflect
  Missiles, Shield.
- **Control with no template / attack** — Sleep, Hold Person, Charm Person.
- **One-off riders not auto-applied** — Guiding Bolt's granted advantage, Thorn
  Whip's forced pull, the Flurry/Open Hand follow-ups.

The full kit always lives on the printed character sheet; the card exists to make
the parts that *do* reduce to dice fast to run at the table.

## Audio

A scene can carry sound: a looping **music** bed, any number of **ambience**
loops (rain, crowd, wind), and one-shot **SFX** (door slam, sword clash). Pick
them in the builder's **Audio** field from whatever is in `assets/audio/`
(`music/`, `ambience/`, `sfx/`), then run it from the **Audio** panel on the
scene's live controls:

- **Play / Stop**, **volume**, and **pan** per track, with a **master** volume
  over everything. Music and ambience beds **loop automatically**; SFX fire once.
- **SFX** buttons fire a cue once.
- **Output** picks which window actually makes sound: **TV** (the Player, on the
  room speakers over HDMI) and/or **Laptop** (the GM, e.g. to monitor on
  headphones). The TV is on by default.
- **Save audio to scene** captures the current tuning (volumes, pans) back onto
  the scene so it recalls next session — the audio half of prepping the day
  before.

The first click in the Player window enables its sound (browsers block audio
until a gesture); a small hint says so, then disappears. No audio ships with the
repo: drop your own files into `assets/audio/**` and **Rescan**.

## Drop in backgrounds and characters

The builder offers whatever art is in the asset folders:

- backgrounds: `assets/backgrounds/` (cinematic art) and `assets/maps/` (maps),
- characters: `assets/characters/{heroes,npcs,enemies}` (transparent PNG cutouts,
  grouped by category in the left/right pickers).

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
figure on a transparent background) into `assets/characters/heroes` (or `npcs` /
`enemies`) for the intended
"character on the stage" look.

### Token art

Token images are listed in `data/cast.js` (heroes and enemies, each with a
name, a ring color, and an image path under `assets/tokens/`). Unlike
backgrounds and characters, token art is **not** scanned: drop a file at the
path a cast entry names (for example `assets/tokens/enemies/brigands.jpg`) and
it shows on that token automatically. Until then the token falls back to the
character's initials, so the board works before any art exists. Add a hero or
enemy to the roster picker by adding an entry to `data/cast.js`.

Seed the public sample token art (the seven heroes plus a sample brigands enemy)
from the reference site with:

```
SEED_TOKENS=1 ./scripts/sync-assets.sh
```

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
    left:  { id: "wren", src: "assets/characters/npcs/wren.png", enter: "slide" },
    right: { id: "wick", src: "assets/characters/npcs/wick.png", enter: "fade" }
  },
  defaults: { visible: true, leftShown: true, rightShown: true },  // opening posture
  tokens:   { heroes: ["lysander"], enemies: ["brigands"] },  // map roster, or null
  music:    null,   // legacy, unused
  ambience: [],     // legacy, unused
  audio:    {       // music bed + ambience loops + one-shot SFX, or null
    music: { src: "assets/audio/music/old-mill.ogg", volume: 0.6, loop: true, pan: 0 },
    ambience: [{ src: "assets/audio/ambience/river.ogg", volume: 0.4, loop: true, pan: 0 }],
    sfx: [{ id: "wheel-creak", src: "assets/audio/sfx/wheel-creak.ogg", volume: 0.8, pan: 0 }]
  },
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
                      audioEngine.js + audioFx.js (sound),
                      scenesAll.js + userScenes.js + fileScenes.js (scenes),
                      gm.js (control surface + builder), player.js (TV)
data/                 scenes.js (content), manifest.js (generated pick lists),
                      cast.js (token markers + NPC portraits),
                      userScenes.json (your saved scenes, written by the server)
assets/maps/          maps (shared, committed); hidden maps (GM only)
assets/backgrounds/   your cinematic backgrounds (drop files in)
assets/characters/    cutouts in heroes/, npcs/, enemies/ (drop files in)
assets/tokens/        round token art: heroes/ and enemies/ (named in cast.js)
assets/audio/         music/, ambience/, sfx/ (drop files in)
assets/fonts/         Cinzel and Atkinson Hyperlegible (offline)
scripts/              serve.py (local server + rescan), scan_assets.py,
                      sync-assets.sh
```

## Phase status

Done: the two-window shell (Phase 1); the scene compositor (Phase 2) — layered
background, characters, named variants, the curtain, and the in-window builder;
tokens (Phase 3) — round hero/enemy markers placed, numbered, dragged, and
revealed on a map in a dedicated map mode, with a per-scene roster; and audio
(Phase 4) — a state-driven Web Audio engine in both windows with per-track
play/stop/loop/volume/pan, one-shot SFX, and selectable TV / laptop output. Phase 4 also made
setups durable: saved scenes persist to disk (`data/userScenes.json`) and recall
their full configuration, including token placement.

Reserved for later: the service worker for offline caching and the Cloudflare
Pages plus Access deployment.

## Where it's headed

Future feature ideas — atmosphere effects (weather/particles, cinematic image
effects, cutscene video), deeper map mode (fog of war, a shared zoom/pan camera),
room hardware (spatial "place a sound in the room" audio, DMX lighting), and the
eventual per-player companion view — live in [`docs/ROADMAP.md`](docs/ROADMAP.md),
along with the reasoning for what's cheap vs. expensive given the architecture.

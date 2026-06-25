# Aldermere GM Console

A local, two-window web app for running an in-person Dungeons and Dragons
session. The GM drives a private control surface on the laptop; the Player
window goes on a TV (an extended display over HDMI) and shows the maps. The
spine of the app is the **scene**: a bundle of a map (a hidden version and an
optional revealed version), and later music, ambience, tokens, and GM notes.

This project is separate from the public reference site
(`ShadowOverAldermere`). It holds GM-only content (spoilers, hidden maps) and
**must never be deployed to a public URL**. It runs locally, with no internet,
and (later) on a private Cloudflare Pages site gated by Cloudflare Access.

This repository is **Phase 1**: the two-window shell. See "What is in Phase 1"
below for the exact scope.

## Run it

You need a local static server so both windows share an origin (the windows
talk to each other over the BroadcastChannel API, which needs a real origin,
not a `file://` path).

From the repository root:

```
python3 -m http.server 8000
```

(or `npx serve -l 8000`, whichever you have). Then open two browser windows in
Chrome or Edge:

- GM control: `http://localhost:8000/?view=gm`
- Player screen: `http://localhost:8000/?view=player`

Opening `http://localhost:8000/` with no `?view=` shows a small chooser with a
link to each.

### During a session

1. Open both windows. Drag the Player window onto the TV and fullscreen it
   (F11, or the browser's fullscreen).
2. In the GM window, click a scene. The Player window shows that scene's map.
3. Click **Reveal map** to cross-fade from the hidden version to the revealed
   version, and **Hide map** to go back.
4. Refreshing either window restores the current scene and map state.

The GM window plays no audio yet and the Player window shows no controls or
notes. Audio arrives in Phase 4.

## Add a scene

Scenes are data, not code. Edit `data/scenes.js`, copy an existing block, give
it a new unique `id`, set its name and map files, and save. It appears in the
GM scene list on the next reload. No code change is needed.

```js
{
  id: "old-mill",
  name: "The Old Mill",
  maps: {
    hidden:   "assets/maps/old-mill_hidden.jpg",   // what players see first
    revealed: "assets/maps/old-mill.jpg"           // optional, shown on reveal
  },
  defaultMapState: "hidden",   // "hidden" or "revealed"
  music: null,                 // optional, used in Phase 4
  ambience: [],                // optional, used in Phase 4
  gmNotes: "Only you see this."
}
```

### Map files, and the spoiler rule

Put map images under `assets/maps/`. Maps are stylized art of varying
proportions; the Player view letterboxes them (preserves aspect, adds bars as
needed), so any size works.

- **Revealed maps** in the sample scenes are the four shared maps from the
  reference site (`city-gate`, `inn-first-floor`, `market`, `town-center`).
  Refresh them with the sync script below.
- **Hidden maps are GM-only.** Author them and keep them **only in this repo**.
  Never copy a hidden map into the public reference repo. The sample scenes
  expect them at `assets/maps/<id>_hidden.jpg`; drop your files there.

If a map file named by a scene is not present yet, the Player view shows a
neutral "not yet revealed" plate with the scene name instead of a broken
image, and the reveal toggle still cross-fades. So you can wire a scene before
its art exists.

## Refresh shared assets

The shared, already public assets (the four maps and the fonts) have one
canonical home: the reference site repo. This project keeps its own committed
copy so it is self-contained and works offline. To refresh that copy:

```
./scripts/sync-assets.sh
```

By default it looks for the reference repo at `../ShadowOverAldermere`. Point
it elsewhere with an environment variable:

```
REF_DIR=/path/to/ShadowOverAldermere ./scripts/sync-assets.sh
```

The script only ever reads from the reference repo and writes into this one. It
never touches hidden maps.

## How it is put together

- Plain HTML, CSS, and JavaScript (ES modules). No framework, no bundler, no
  build step.
- One app, two views, chosen by the `?view=` URL parameter.
- `js/sync.js` is the only file that knows how the two windows talk
  (BroadcastChannel today). Swapping in websockets for a separate-device setup
  later would touch only that file.
- The GM window is the source of truth. It saves state to `localStorage` and
  broadcasts every change. The Player window is a pure renderer that restores
  from `localStorage` on load and then follows the GM window.

```
index.html            single entry; reads ?view=gm or ?view=player
css/                  app.css (shared), gm.css, player.css
js/                   main.js (router), sync.js, state.js, gm.js, player.js
data/                 scenes.js (content), cast.js (stub for later phases)
assets/maps/          revealed maps (shared, committed); hidden maps (GM only)
assets/fonts/         Cinzel and Atkinson Hyperlegible (offline)
scripts/sync-assets.sh
```

## What is in Phase 1

In: the two views, the scene list from the data file, the map on the Player
window, the hidden/revealed cross-fade toggle, window-to-window sync, and state
that survives a refresh.

Not yet (later phases): NPC portraits and title/blackout cards (Phase 2);
tokens (Phase 3); audio with music, ambience, and volumes (Phase 4). The
service worker for offline caching and the Cloudflare Pages plus Access
deployment are also a later step; for now this runs locally as described above.

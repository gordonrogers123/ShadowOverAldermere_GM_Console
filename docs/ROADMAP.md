# Roadmap & Vision

A living reference for where the Aldermere GM Console could go. This is **not a
commitment** — it captures ideas, their feasibility, and (most importantly) *why*
some are cheap and some are expensive, so we can pick well later. The core system
is the focus for now; this is the parking lot.

---

## What it is today

A local, two-window web app for running an **in-person** D&D session. The GM
drives a private control surface on a laptop; the Player window goes on a TV (an
extended display over HDMI) and shows the scene. Already shipped:

- **Shared layered compositor** (`stageView.js`) — background cross-fade →
  characters → curtain → tokens → idle title, rendered identically to the GM
  preview and the Player TV.
- **Cue + keyframe system** — cues are state snapshots plus timeline *lanes*
  (each with start/ramp). Opening cues fire on scene select. Per-cue preview.
- **Characters** — per-side roster (multiple per side, one shown at a time),
  per-character transition + placement, exit-then-enter swaps, cue-driven reveals.
- **Map mode** — tokens on a map image, initiative tracker, enemy stat sheets,
  saved layouts, per-enemy art/ring fallback.
- **Audio engine** (Web Audio) — music beds / ambience / SFX, per-bed fades with
  dip-to-silence looping, cross-cue crossfades, a sidebar mixer, TV/Laptop outputs.
- **Helper server** (`scripts/serve.py`) — serves the static app, persists scenes
  to disk, runs asset scans.

---

## The architecture "grain"

Four properties decide what's cheap vs. expensive. **Read this before scoping any
feature below.**

1. **Layered compositor.** Adding a *new visual layer* is idiomatic and isolated.
2. **State-driven + cue/keyframe model.** The GM mutates state → broadcasts →
   both windows reconcile. **Most cinematic features reduce to: a new layer + a
   new cue lane + a state field + a normalizer.** That's the reuse jackpot — the
   first feature in a category pays the plumbing; the rest are cheap.
3. **GM-authoritative, single-writer.** The GM is the only writer; the Player is
   read-only output. Anything that adds *other* writers cuts against the grain.
4. **BroadcastChannel = same browser, same machine** (the TV is an extended
   display). The **Python helper server** is the bridge to anything *hardware* or
   *networked* (DMX, player phones, big assets).

Rule of thumb: rides layers + cues → cheap. Needs the helper server → a step up.
Needs multi-client networking → a different product.

---

## Tier 1 — Atmosphere (best ROI; rides the cue model)

These mostly share one new `fx` / `weather` cue lane, so the first carries the
plumbing and the rest are nearly free.

- **Particle / weather effects** — rain, snow, fog, embers, ash, dust motes. A
  `<canvas>` FX layer + a `weather` cue lane (`fade rain in over 4s`). Keep
  particle counts modest for a weak TV box. *Highest atmosphere-per-effort.*
- **Image effects** — slow zoom (Ken Burns), shake/rumble, vignette, blur,
  desaturate / sepia / hue-grade. Almost all pure CSS (`transform`, `filter`) on
  the stage, driven by an `fx` cue lane with ramps. The *zoom + shake + vignette*
  trio alone elevates everything. **Chromatic aberration** is the costly outlier
  (needs an SVG `feOffset` filter or a WebGL pass) — worth it for glitch/psychic
  moments, but not free.
- **Cutscene video** — a `<video>` layer, cue-triggered. Nuance: the Player TV
  plays it *with* audio while the GM preview shows it *muted* (no double sound),
  and music beds duck under it.
- **Video map backgrounds** — a `<video>` as the map image (flowing water,
  flickering torches). Token coordinate math already uses fractions of the
  displayed image, so it works over video unchanged.
- **Handout / portrait reveals, name plates, on-screen timers/clocks** (the
  ritual, the bomb), **"show the dice roll to the room."** Tiny layer+cue adds,
  high table value.

## Tier 2 — Map & combat depth

- **Fog of war / progressive reveal** — the GM uncovers the dungeon as players
  explore. Likely the highest-value *map* feature for in-person play.
- **Token HP bars + condition/status icons** (poisoned, prone, concentrating).
- **AoE templates + a ruler/measurement** (drop a 20-ft cone, measure movement).
- **Large maps with a shared camera** — a transform layer (translate+scale map +
  tokens together), pan/zoom input on the GM, `state.stage.camera = {x,y,zoom}`
  broadcast so the TV follows, and a `camera` cue lane (pan room A→B over a ramp).
  Tokens live in map-space, so they transform correctly. *The one genuinely new
  subsystem in this tier.*
- **A second Player output** (a map TV + a cinematic TV) — the compositor is
  already shared.

## Tier 3 — Room hardware (needs the helper server / hardware)

### Spatial room audio — "place a sound where the speakers are"

**Goal:** speakers around the room, players in the middle, and a sound that seems
to come from a specific direction (a growl from the NE corner, footsteps from
behind).

**Target setup (confirmed):** a **multichannel audio interface + multiple powered
speakers** around the room are in hand — so this is **not** gated on hardware;
it's a software build (the spatial panner + a one-time room/speaker config that
matches the real speaker count/positions and per-output level trims + a per-sound
placement UI). The interface is the single multichannel output device Web Audio
targets.

**Key insight:** for a *group*, do **not** use headphone HRTF/binaural (works for
one listener with headphones only). Use **object-based amplitude panning to
physical speakers** — the sound is louder in the speaker(s) nearest the intended
direction. The "sweet spot" of amplitude panning is the centre of the array,
which is exactly where the table is.

**Technique (fits our per-track graph):**
- Give each sound a **position** (angle, or x/y on a small "room map").
- Compute **per-speaker gains** with pairwise constant-power panning (VBAP in 2D):
  find the two speakers bracketing the target angle and pan between them.
- Route: mono source → one `GainNode` per speaker → `ChannelMergerNode(N)` →
  a multichannel `destination`. Replaces/augments the current `StereoPanner` stage.
- Because position is just a value, a sound can **travel** around the table over a
  cue ramp — slots into the cue/keyframe model as a `position` lane.
- One-time **room/speaker config** (positions + per-speaker level trim) and a
  per-sound **placement** UI (drag a dot, or pick a compass point).

**The limiter is the OUTPUT DEVICE, not the Web Audio API.** Hardware ladder:
1. **Multichannel audio interface** (6–8 outs → powered speakers/amp) — the
   "do it right" path; the browser sees one multichannel output device.
   **← this is the setup in hand, so the spatial-audio work is unblocked.**
2. **HDMI → AV receiver in multichannel PCM** — cheap if a receiver already
   exists; mind the routing (the same HDMI also drives the TV).
3. ~~Multiple stereo USB dongles~~ — a browser context drives **one** output
   device, so this doesn't work.
4. Networked per-speaker players (Pi/ESP) — exotic; sync is hard. Skip unless
   desperate.

Degrades cleanly to stereo when only 2 channels exist. **Effort: medium-high**
(spatial panner + room config + placement UI + position cue lane), but real and
satisfying. **This is the recommended "surround" — not a 5.1 mix (see Deferred).**

### DMX lighting — "the whole room reacts"

Tie room lights to the scene (dim+red for combat, warm for the tavern, blackout
for a reveal). Browsers can't drive USB-DMX reliably, but the **Python server
can**. Ladder: **Art-Net over UDP** (software-only, no driver — test against a
free DMX visualizer first) → real fixtures via **OLA** or a USB dongle. A GM cue
POSTs a lighting state to the server; the server fades fixtures. The cue model's
"fade over ramp" maps *exactly* to DMX crossfades. Work: a fixture/patch
abstraction (channels → semantic warm/cold/color/intensity) + a lighting cue
editor. High immersion, niche (needs a rig), architecture already has the bridge.

## Tier 4 — The product fork: player companion clients

**Direction (eventual, not near-term):** per-player, read-mostly access to *their
own* character — stats, info, inventory, HP, conditions, the initiative order, the
current scene mood. **Not** GM-level control of the board; a "second screen," not
a VTT.

**Target device (confirmed):** **Android tablets** on the local network. That
keeps the client simple — Chrome on the tablet loads a **companion page served by
the helper server** and connects over the LAN (WebSocket/SSE); no native app, no
app store. A tablet's larger screen also suits a fuller layout (a full sheet + an
inventory grid) than a phone would, and the device set is small and known.

This is lighter than a VTT, but it's the one feature that breaks the grain:
- **Networking:** the tablets aren't in the GM's browser, so the **Python server
  becomes a live relay** (WebSocket/SSE) over the LAN and serves the companion
  page. The pure-offline property softens to "needs a LAN" (already true for the
  room-audio / DMX hardware tier).
- **Data model:** characters/inventory (GM-owned, or player-owned with light
  self-edits like HP).
- **Identity + authority:** a per-player join (code/URL); players edit only their
  own sheet; the GM can see/override. Far less conflict than shared token control.

Treat this as a deliberate fork: *GM cinematic engine* (Tiers 1–3) vs. a
*table companion* layer on top. This app is a prototype; this is where it's headed.

---

## Deferred / not recommended

- **Discrete 5.1 / 7.1 "surround mix."** Pre-authored channel mixing depends on a
  multichannel device exposed to the browser and authored content. The
  **object-panning spatial audio above gives the actual goal** ("make it come from
  over there") with one mono source and a position — do that instead.

---

## Suggested sequencing

1. **Atmosphere tier** — weather + the zoom/shake/filter `fx` lane + cutscene
   video. Biggest immersion-per-hour; all ride the cue model; the first one builds
   the shared lane.
2. **Map & combat depth** — fog of war + token HP/conditions, then the
   camera/large-map system.
3. **Room hardware** — spatial room audio (the interface + speakers are already in
   hand, so it's unblocked whenever you want it) and/or DMX lighting (the "whole
   room reacts" moment).
4. **Companion clients** — the deliberate fork, once the cinematic engine is solid.

## Reuse notes

- New cinematic aspects (`weather`, `fx`, `camera`, `position`) all want to be
  **cue lanes** with start/ramp, mirroring the existing audio/character/background
  lanes — author once, reuse everywhere.
- The **helper server** (`serve.py`) is the bridge for every hardware/networked
  feature (DMX transport, multichannel/room config persistence, the future
  WebSocket relay for companion clients).
- New visual features are **layers** in `stageView.js`, kept in sync by the same
  state-broadcast-reconcile loop the GM preview and Player TV already share.

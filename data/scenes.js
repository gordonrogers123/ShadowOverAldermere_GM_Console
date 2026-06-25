// ============================================================
//  scenes.js  --  the content of the GM Console
// ------------------------------------------------------------
//  A "scene" is a composition shown on the Player TV:
//    a BACKGROUND (a tactical map or cinematic art) with one or
//    more named reveal variants, plus an optional LEFT and RIGHT
//    character (transparent PNG) shown over it with transitions,
//    plus (later) tokens and audio.
//
//  TO ADD A SCENE BY HAND: copy a block below, give it a new unique
//  `id`, set its name, background, and characters, and save. It shows
//  up in the GM scene list on the next reload. No code change. You can
//  also build and save scenes from the GM window itself; those live in
//  the browser and can be exported back into this file to share.
//
//  Scene shape:
//    {
//      id:   "unique-id",
//      name: "Display Name",
//
//      // BACKGROUND. Named, ordered reveal variants. Two variants read
//      // as the familiar Hidden / Revealed toggle; three or more show a
//      // variant picker. The first / default variant is the one players
//      // see first, so keep spoilers in a later variant. A scene needs at
//      // least one variant. The key is just a label; any name works.
//      maps: { hidden: "assets/maps/<id>_hidden.jpg",
//              revealed: "assets/maps/<file>.jpg" },
//      defaultMapState: "hidden",     // which variant key shows on select
//
//      // CHARACTERS. Optional, independent left and right. Each points at a
//      // transparent PNG in assets/characters/{heroes,npcs,enemies} and a
//      // default entrance: "slide" (in from its own side) or "fade".
//      characters: {
//        left:  { id: "lysander", src: "assets/characters/heroes/lysander.png", enter: "slide" },
//        right: { id: "thraka",   src: "assets/characters/heroes/thraka.png",   enter: "fade" }
//      },
//
//      // Optional opening posture when the scene is selected. If absent,
//      // the curtain is up and each side shows only if it has a character.
//      defaults: { visible: true, leftShown: true, rightShown: true },
//
//      // Token roster for map mode: which cast ids (data/cast.js) may be
//      // placed on this map. null or omitted means none. The GM places and
//      // moves them live during play.
//      tokens:   { heroes:[id...], enemies:[id...] },   // or null
//      music:    null,   // legacy, unused (audio now lives in `audio`)
//      ambience: [],     // legacy, unused
//      // Audio (Phase 4): a music bed + ambience loops + one-shot SFX, each
//      // with volume, pan, loop, and an effects map (reverb/low-high-pass/
//      // delay/distortion/pitch). null = silent. Picked in the builder; tuned
//      // live in the audio panel and captured with "Save audio to scene".
//      audio:    null,   // or { music:{src,volume,pan,loop,effects},
//                        //      ambience:[{src,...}], sfx:[{id,src,volume,pan,effects}] }
//      gmNotes:  "GM only text."   // shown in the GM window only
//    }
//
//  Hidden background variants are GM-only. They live only in THIS repo,
//  never in the public reference repo. The shared maps below come from the
//  shared assets (run scripts/sync-assets.sh to refresh). Drop your own
//  hidden art at the paths named; until you do, the Player shows a neutral
//  "not yet revealed" plate and the reveal still cross-fades. Character PNGs
//  are dropped into assets/characters/{heroes,npcs,enemies} (SEED_SAMPLES seeds
//  hero samples).
// ============================================================

export const SCENES = [
  {
    id: "city-gate",
    name: "The City Gate",
    maps: {
      hidden: "assets/maps/city-gate_hidden.jpg",
      revealed: "assets/maps/city-gate.jpg"
    },
    defaultMapState: "hidden",
    tokens: null,
    music: null,
    ambience: [],
    audio: null,
    gmNotes: "The gate watch waves the party through without a second look. If anyone lingers, the captain mentions the road south has been quiet, too quiet, since the mill went dark."
  },
  {
    id: "inn-first-floor",
    name: "The Inn, Ground Floor",
    maps: {
      hidden: "assets/maps/inn-first-floor_hidden.jpg",
      revealed: "assets/maps/inn-first-floor.jpg"
    },
    defaultMapState: "hidden",
    tokens: null,
    music: null,
    ambience: [],
    audio: null,
    gmNotes: "Warm, low, and crowded. Hob clams up if pressed about the cellar. Vela may brush past the party on her way out; she lifts a coin purse if no one is watching."
  },
  {
    id: "market",
    name: "The Market Square",
    maps: {
      hidden: "assets/maps/market_hidden.jpg",
      revealed: "assets/maps/market.jpg"
    },
    defaultMapState: "hidden",
    tokens: null,
    music: null,
    ambience: [],
    audio: null,
    gmNotes: "Half the stalls are shuttered. Granny Edna sells charms against the shadow at twice the fair price, and she is not entirely wrong to."
  },
  {
    id: "town-center",
    name: "Aldermere Town Center",
    maps: {
      hidden: "assets/maps/town-center_hidden.jpg",
      revealed: "assets/maps/town-center.jpg"
    },
    defaultMapState: "hidden",
    tokens: null,
    music: null,
    ambience: [],
    // Demo audio (Phase 6D): synthesized placeholders so the audio panel can be
    // exercised here out of the box. Drop your own files into assets/audio/**,
    // Rescan, and re-pick them in the builder to replace these.
    audio: {
      music: { src: "assets/audio/music/theme-calm.wav", volume: 0.6, pan: 0, loop: true, effects: {} },
      ambience: [{ src: "assets/audio/ambience/wind.wav", volume: 0.35, pan: 0, loop: true, effects: {} }],
      sfx: [
        { id: "chime", src: "assets/audio/sfx/chime.wav", volume: 0.7, pan: 0, effects: {} },
        { id: "door-thud", src: "assets/audio/sfx/door-thud.wav", volume: 0.8, pan: 0, effects: {} }
      ]
    },
    gmNotes: "The old well at the center is the heart of the trouble. Reveal the map only once the party has reason to look closely; the carvings on the rim match the ones in Wick's journal."
  },

  // A cinematic dialogue scene: one background, two characters who enter
  // from their sides. A sample of the Phase 2 compositor. It uses the
  // seeded sample character cutouts (run SEED_SAMPLES=1 ./scripts/sync-assets.sh).
  {
    id: "gate-parley",
    name: "A Word at the Gate",
    maps: {
      revealed: "assets/maps/city-gate.jpg"
    },
    defaultMapState: "revealed",
    characters: {
      left:  { id: "lysander", src: "assets/characters/heroes/lysander.png", enter: "slide" },
      right: { id: "thraka",   src: "assets/characters/heroes/thraka.png",   enter: "slide" }
    },
    defaults: { visible: true, leftShown: true, rightShown: true },
    tokens: null,
    music: null,
    ambience: [],
    audio: null,
    gmNotes: "A staged parley at the gate. Bring Lysander in from the left first, then let Thraka arrive from the right as the threat lands. Hide the scene to cut to black."
  }
];

// ============================================================
//  scenes.js  --  the content of the GM Console
// ------------------------------------------------------------
//  A "scene" bundles everything that defines a moment in play:
//  a map (a hidden version and an optional revealed version),
//  and, in later phases, music, ambience loops, and GM notes.
//
//  TO ADD A SCENE: copy one of the blocks below, give it a new
//  unique `id`, set its name and map files, and save. It shows
//  up in the GM scene list on the next reload. No code change.
//
//  Scene shape:
//    {
//      id:    "unique-id",            // used internally and for filenames
//      name:  "Display Name",         // shown in the GM scene list
//      maps: {
//        hidden:   "assets/maps/<id>_hidden.jpg",   // what players see first
//        revealed: "assets/maps/<file>.jpg"         // optional, shown on reveal
//      },
//      defaultMapState: "hidden",     // "hidden" or "revealed"
//      music:    null,                // optional, used in Phase 4
//      ambience: [],                  // optional, used in Phase 4
//      gmNotes:  "GM only text."      // shown in the GM window only
//    }
//
//  Hidden maps are GM-only. They live only in THIS repo, never in
//  the public reference repo. The four revealed maps below come from
//  the shared assets (run scripts/sync-assets.sh to refresh them).
//  Drop your own hidden art at the paths named below; until you do,
//  the Player view shows a neutral "not yet revealed" plate for the
//  hidden state, and the reveal toggle still cross-fades.
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
    music: null,
    ambience: [],
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
    music: null,
    ambience: [],
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
    music: null,
    ambience: [],
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
    music: null,
    ambience: [],
    gmNotes: "The old well at the center is the heart of the trouble. Reveal the map only once the party has reason to look closely; the carvings on the rim match the ones in Wick's journal."
  }
];

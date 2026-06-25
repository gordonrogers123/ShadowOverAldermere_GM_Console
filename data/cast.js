// ============================================================
//  cast.js  --  token markers and NPC portraits
// ------------------------------------------------------------
//  The single source of truth for who can be placed on a map. As of
//  Phase 3, js/stageView.js reads `heroes` and `enemies` to draw round
//  tokens (a scene's `tokens` roster lists which ids are eligible; the GM
//  places them live). `npcs` portraits are still for a later phase.
//
//  Token art is vendored BY HAND into assets/tokens/** -- it is NOT scanned
//  by scripts/scan_assets.py. Until a file exists, a token renders as a
//  colored ring with the character's initials, so the board works now and
//  the portrait simply appears once a file is dropped at the path below.
//
//  Shapes:
//    heroes:  [{ id, name, tokenImage, ringColor }]            // round token
//    enemies: [{ id, name, tokenImage, ringColor, singular? }] // round token
//    npcs:    [{ id, name, portrait }]                          // fullscreen
//
//  `singular` (enemies, optional) is the label stem used when copies are
//  auto-numbered on the board, e.g. "Brigand 1" from name "Brigands". If
//  absent the code strips a trailing "s", then falls back to the full name.
//
//  Ring colors reuse the campaign palette:
//    support green #2f6b43, control blue #2a4d7a, offense red #8a2e2e.
// ============================================================

export const CAST = {
  heroes: [
    { id: "lysander", name: "Lysander", tokenImage: "assets/tokens/heroes/lysander.jpg", ringColor: "#2f6b43" },
    { id: "telstar",  name: "Telstar",  tokenImage: "assets/tokens/heroes/telstar.jpg",  ringColor: "#2f6b43" },
    { id: "thraka",   name: "Thraka",   tokenImage: "assets/tokens/heroes/thraka.jpg",   ringColor: "#2f6b43" },
    { id: "khaleesi", name: "Khaleesi", tokenImage: "assets/tokens/heroes/khaleesi.jpg", ringColor: "#2f6b43" },
    { id: "sai",      name: "Sai",      tokenImage: "assets/tokens/heroes/sai.jpg",      ringColor: "#2f6b43" },
    { id: "samsara",  name: "Samsara",  tokenImage: "assets/tokens/heroes/samsara.jpg",  ringColor: "#2f6b43" },
    { id: "truf",     name: "Truf",     tokenImage: "assets/tokens/heroes/truf.jpg",     ringColor: "#2f6b43" }
  ],

  enemies: [
    { id: "brigands", name: "Brigands", tokenImage: "assets/tokens/enemies/brigands.jpg", ringColor: "#8a2e2e", singular: "Brigand" }
  ],

  npcs: [
    { id: "cassian",    name: "Cassian",      portrait: "assets/portraits/cassian.jpg" },
    { id: "dorran",     name: "Dorran",       portrait: "assets/portraits/dorran.jpg" },
    { id: "grannyedna", name: "Granny Edna",  portrait: "assets/portraits/grannyedna.jpg" },
    { id: "marshfamily",name: "The Marshes",  portrait: "assets/portraits/marshfamily.jpg" },
    { id: "pip",        name: "Pip",          portrait: "assets/portraits/pip.jpg" },
    { id: "wick",       name: "Wick",         portrait: "assets/portraits/wick.jpg" },
    { id: "wren",       name: "Wren",         portrait: "assets/portraits/wren.jpg" }
  ]
};

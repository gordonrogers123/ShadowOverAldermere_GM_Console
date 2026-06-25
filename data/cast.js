// ============================================================
//  cast.js  --  markers and portraits
// ------------------------------------------------------------
//  STUB FOR LATER PHASES. Nothing in Phase 1 reads this file.
//  It is here so the data layout is settled and so you can see
//  the shape now. The token and portrait images it points at are
//  vendored in Phase 3 (tokens) and Phase 2 (NPC portraits); the
//  paths below are where those files will go.
//
//  Shapes:
//    heroes:  [{ id, name, tokenImage, ringColor }]  // small round portrait
//    enemies: [{ id, name, tokenImage, ringColor }]  // small marker
//    npcs:    [{ id, name, portrait }]               // fullscreen image
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
    { id: "brigands", name: "Brigands", tokenImage: "assets/tokens/enemies/brigands.jpg", ringColor: "#8a2e2e" }
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

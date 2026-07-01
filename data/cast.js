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
//  `stats` (heroes + enemies, optional) is the stat block shown in map mode for
//  whichever combatant is up in the initiative tracker. Shape:
//    stats: { name, subtitle?, ac, hp, speed, abilities:{str,dex,con,int,wis,cha},
//             attacks:[{ name, toHit, range?, damage }] }   // ability scores are modifiers
//  toHit may be a "+N" bonus or a save/keyword ("DEX save 13", "auto"); the card
//  only appends "to hit" to a numeric bonus. A combatant without `stats` shows a
//  compact card (name + HP + conditions) instead.
//
//  `face` (optional, e.g. "50% 18%") is the CSS object-position focus point for
//  the token art -- it centers the board token AND the stat-card profile picture
//  on the character's face. A token editor will set this per character later.
//
//  Ring colors reuse the campaign palette:
//    support green #2f6b43, control blue #2a4d7a, offense red #8a2e2e.
// ============================================================

export const CAST = {
  heroes: [
    { id: "lysander", name: "Lysander", tokenImage: "assets/tokens/heroes/lysander.jpg", ringColor: "#2f6b43", face: "50% 18%",
      stats: { name: "Lysander", subtitle: "Halfling Cleric", ac: 17, hp: 24, speed: "25 ft",
        abilities: { str: -1, dex: 1, con: 2, int: 0, wis: 3, cha: 1 },
        attacks: [
          { name: "Sacred Flame", toHit: "DEX save 13", damage: "1d8 radiant" },
          { name: "Guiding Bolt", toHit: "+5", damage: "4d6 radiant" },
          { name: "Mace", toHit: "+1", damage: "1d6 bludgeoning" }
        ] } },
    { id: "telstar", name: "Telstar", tokenImage: "assets/tokens/heroes/telstar.jpg", ringColor: "#2f6b43", face: "50% 18%",
      stats: { name: "Telstar", subtitle: "Kenku Druid", ac: 14, hp: 21, speed: "30 ft",
        abilities: { str: -1, dex: 2, con: 1, int: 1, wis: 3, cha: 0 },
        attacks: [
          { name: "Shillelagh", toHit: "+5", damage: "1d8+3 bludgeoning" },
          { name: "Thorn Whip", toHit: "+5", damage: "1d6 piercing" },
          { name: "Entangle", toHit: "STR save 13", damage: "restrained" }
        ] } },
    { id: "thraka", name: "Thraka", tokenImage: "assets/tokens/heroes/thraka.jpg", ringColor: "#2f6b43", face: "50% 18%",
      stats: { name: "Thraka", subtitle: "Orc Barbarian", ac: 14, hp: 35, speed: "30 ft",
        abilities: { str: 3, dex: 1, con: 3, int: -1, wis: 1, cha: 0 },
        attacks: [
          { name: "Greataxe", toHit: "+5", damage: "1d12+3 slashing (1d12+5 raging)" },
          { name: "Handaxe", toHit: "+5", range: "thrown 20/60 ft", damage: "1d6+3 slashing" },
          { name: "Reckless Attack", toHit: "advantage", damage: "all-out swing" }
        ] } },
    { id: "khaleesi", name: "Khaleesi", tokenImage: "assets/tokens/heroes/khaleesi.jpg", ringColor: "#2f6b43", face: "50% 15%",
      stats: { name: "Khaleesi", subtitle: "Dragonborn Fighter", ac: 18, hp: 28, speed: "30 ft",
        abilities: { str: 3, dex: 1, con: 2, int: -1, wis: 1, cha: 0 },
        attacks: [
          { name: "Longsword", toHit: "+5", damage: "1d8+5 slashing" },
          { name: "Breath Weapon", toHit: "DEX save 12", damage: "2d6 fire (1/rest)" },
          { name: "Javelin", toHit: "+5", range: "thrown 30/120 ft", damage: "1d6+3 piercing" }
        ] } },
    { id: "sai", name: "Sai", tokenImage: "assets/tokens/heroes/sai.jpg", ringColor: "#2f6b43", face: "50% 18%",
      stats: { name: "Sai", subtitle: "Loxodon Monk", ac: 15, hp: 21, speed: "40 ft",
        abilities: { str: 1, dex: 3, con: 1, int: 0, wis: 2, cha: -1 },
        attacks: [
          { name: "Bo staff", toHit: "+5", damage: "1d8+3 bludgeoning" },
          { name: "Unarmed strike", toHit: "+5", damage: "1d4+3 bludgeoning" },
          { name: "Darts", toHit: "+5", range: "thrown 20/60 ft", damage: "1d4+3 piercing" }
        ] } },
    { id: "samsara", name: "Samsara", tokenImage: "assets/tokens/heroes/samsara.jpg", ringColor: "#2f6b43", face: "50% 18%",
      stats: { name: "Samsara", subtitle: "Gnome Wizard", ac: 12, hp: 17, speed: "25 ft",
        abilities: { str: -1, dex: 2, con: 1, int: 3, wis: 1, cha: 0 },
        attacks: [
          { name: "Fire Bolt", toHit: "+5", damage: "1d10 fire" },
          { name: "Magic Missile", toHit: "auto", damage: "3 x 1d4+1 force" },
          { name: "Dagger", toHit: "+4", damage: "1d4+2 piercing" }
        ] } },
    { id: "truf", name: "Truf", tokenImage: "assets/tokens/heroes/truf.jpg", ringColor: "#2f6b43", face: "50% 18%",
      stats: { name: "Truf", subtitle: "Tiefling Rogue", ac: 15, hp: 21, speed: "30 ft",
        abilities: { str: -1, dex: 3, con: 1, int: 2, wis: 0, cha: 2 },
        attacks: [
          { name: "Dagger", toHit: "+5", range: "thrown 20/60 ft", damage: "1d4+3 piercing" },
          { name: "Sneak Attack", toHit: "once/turn", damage: "+2d6" },
          { name: "Hellish Rebuke", toHit: "DEX save 12", damage: "2d10 fire (reaction)" }
        ] } }
  ],

  enemies: [
    { id: "brigands", name: "Brigands", tokenImage: "assets/tokens/enemies/brigands.jpg", ringColor: "#8a2e2e", singular: "Brigand", face: "50% 22%",
      stats: {
        name: "Roadside Raider", ac: 12, hp: 11, speed: "30 ft",
        abilities: { str: 0, dex: 1, con: 1, int: 0, wis: 0, cha: 0 },
        attacks: [
          { name: "Scimitar", toHit: "+3", range: "reach 5 ft", damage: "1d6+1 slashing" },
          { name: "Light crossbow", toHit: "+3", range: "range 80/320 ft", damage: "1d8+1 piercing" }
        ]
      } },
    { id: "palehusks", name: "Pale Husk", tokenImage: "assets/tokens/enemies/palehusk.jpg", ringColor: "#8a2e2e", singular: "Pale Husk", face: "50% 22%",
      stats: {
        name: "Pale Husk", ac: 11, hp: 26, speed: "20 ft",
        abilities: { str: 1, dex: -1, con: 2, int: -4, wis: -2, cha: -3 },
        attacks: [
          { name: "Slam", toHit: "+3", range: "reach 5 ft", damage: "1d6+1 bludgeoning" },
          { name: "Draining Bite", toHit: "+3", range: "reach 5 ft", damage: "1d4+1 piercing plus 1d4 necrotic" }
        ]
      } }
  ],

  // NPCs double as scene cutouts (portrait) and placeable allied tokens on the map.
  // ringColor is the pale-blue "ally" ring; token art/face come later via the token
  // builder, so until then a placed NPC shows initials on the blue ring.
  npcs: [
    { id: "cassian",    name: "Cassian",      portrait: "assets/portraits/cassian.jpg",    ringColor: "#6f9bd1" },
    { id: "dorran",     name: "Dorran",       portrait: "assets/portraits/dorran.jpg",      ringColor: "#6f9bd1" },
    { id: "grannyedna", name: "Granny Edna",  portrait: "assets/portraits/grannyedna.jpg",  ringColor: "#6f9bd1" },
    { id: "marshfamily",name: "The Marshes",  portrait: "assets/portraits/marshfamily.jpg", ringColor: "#6f9bd1" },
    { id: "pip",        name: "Pip",          portrait: "assets/portraits/pip.jpg",         ringColor: "#6f9bd1" },
    { id: "wick",       name: "Wick",         portrait: "assets/portraits/wick.jpg",        ringColor: "#6f9bd1" },
    { id: "wren",       name: "Wren",         portrait: "assets/portraits/wren.jpg",        ringColor: "#6f9bd1" }
  ]
};

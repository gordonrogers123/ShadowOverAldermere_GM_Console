// The standard 5e conditions, offered as presets in the map-mode roster's
// condition picker. A token's `conditions` array holds plain strings, so a
// custom entry just pushes any label the GM types -- no enum to extend.
export const CONDITIONS = [
  'Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened', 'Grappled',
  'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified', 'Poisoned', 'Prone',
  'Restrained', 'Stunned', 'Unconscious'
];

// Short rules text for each condition (5e SRD, condensed), shown at the bottom of
// the active combatant's stat block so the GM never has to look one up. Custom
// (typed) conditions simply have no entry and show as a bare label.
export const CONDITION_INFO = {
  Blinded: "Can't see; auto-fails checks needing sight. Attack rolls against it have advantage; its attack rolls have disadvantage.",
  // Auto-managed by the app when a hero/NPC drops to 0 HP (cleared on healing above 0).
  'Death Saves': "At 0 HP and dying: each turn roll a d20 — 10+ is a success, three successes stabilize, three failures mean death. A nat 20 regains 1 HP; damage while dying = one failure (a crit = two).",
  Charmed: "Can't attack the charmer or target them with harmful abilities. The charmer has advantage on social checks with it.",
  Deafened: "Can't hear; auto-fails checks needing hearing.",
  Exhaustion: "Cumulative levels: 1 disadvantage on checks; 2 speed halved; 3 disadvantage on attacks & saves; 4 HP max halved; 5 speed 0; 6 death.",
  Frightened: "Disadvantage on checks and attacks while the source of fear is in line of sight; can't willingly move closer to it.",
  Grappled: "Speed becomes 0, and it can't benefit from any bonus to speed. Ends if the grappler is incapacitated or moved away.",
  Incapacitated: "Can't take actions or reactions.",
  Invisible: "Can't be seen without special sense; counts as heavily obscured. Attacks against it have disadvantage; its attacks have advantage.",
  Paralyzed: "Incapacitated; can't move or speak. Auto-fails Str & Dex saves. Attacks against it have advantage; any hit within 5 ft is a crit.",
  Petrified: "Turned to stone: incapacitated, unaware, weight x10. Attacks have advantage; auto-fails Str & Dex saves; resists all damage; immune to poison & disease.",
  Poisoned: "Disadvantage on attack rolls and ability checks.",
  Prone: "Can only crawl unless it stands (costs half its speed). Disadvantage on attacks. Melee attacks against it have advantage; ranged have disadvantage.",
  Restrained: "Speed becomes 0. Attacks against it have advantage; its attacks have disadvantage. Disadvantage on Dex saves.",
  Stunned: "Incapacitated; can't move, speaks falteringly. Auto-fails Str & Dex saves. Attacks against it have advantage.",
  Unconscious: "Incapacitated; can't move or speak, unaware. Drops what it holds and falls prone. Auto-fails Str & Dex saves. Attacks have advantage; hits within 5 ft are crits."
};

// ============================================================
//  scenesAll.js  --  the effective scene list
// ------------------------------------------------------------
//  Both windows resolve scenes through here: the code-defined
//  SCENES (data/scenes.js) merged with the scenes you built and
//  saved (userScenes.js). The Player needs this too, because the GM
//  only sends a sceneId over sync and the Player looks the scene up
//  locally; since both windows share the same origin and localStorage,
//  a saved scene is immediately resolvable in both.
//
//  Precedence: a saved scene whose id matches a code scene OVERRIDES
//  it (so you can tweak a built version of a shipped scene). Saved
//  scenes with new ids are appended after the code scenes.
// ============================================================

import { SCENES } from '../data/scenes.js';
import { loadUserScenes } from './userScenes.js';

export function allScenes() {
  const user = loadUserScenes();
  const codeIds = new Set(SCENES.map((s) => s.id));
  const merged = SCENES.map((s) => user.find((u) => u.id === s.id) || s);
  const extras = user.filter((u) => !codeIds.has(u.id));
  return [...merged, ...extras];
}

export function sceneById(id) {
  if (id == null) return null;
  return allScenes().find((s) => s.id === id) || null;
}

// True when the scene came from the saved (user) store, for list badges
// and delete affordances in the GM window.
export function isUserScene(id) {
  return loadUserScenes().some((s) => s.id === id);
}

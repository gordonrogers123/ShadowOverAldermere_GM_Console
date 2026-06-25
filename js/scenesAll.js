// ============================================================
//  scenesAll.js  --  the effective scene list
// ------------------------------------------------------------
//  Both windows resolve scenes through here: the code-defined SCENES
//  (data/scenes.js) merged with the scenes you built and saved. Saved
//  scenes live in two tiers: localStorage (instant, per browser;
//  userScenes.js) and on disk (data/userScenes.json; fileScenes.js),
//  the latter loaded once at startup. The Player needs this too, because
//  the GM only sends a sceneId over sync and the Player looks the scene up
//  locally.
//
//  Precedence: disk > localStorage > code (a saved scene whose id matches
//  a shipped scene overrides it, so you can tweak a built version; the disk
//  copy is the most durable, so it wins). Saved scenes with new ids are
//  appended after the code scenes.
// ============================================================

import { SCENES } from '../data/scenes.js';
import { loadUserScenes } from './userScenes.js';
import { fileScenes } from './fileScenes.js';

export function allScenes() {
  const local = loadUserScenes();
  const file = fileScenes();
  // Apply tiers in increasing priority into an id-keyed map.
  const byId = new Map();
  for (const s of SCENES) byId.set(s.id, s);
  for (const s of local) byId.set(s.id, s);
  for (const s of file) byId.set(s.id, s);
  // Stable order: code scenes first (in file order), then saved-only ids.
  const codeIds = new Set(SCENES.map((s) => s.id));
  const ordered = SCENES.map((s) => byId.get(s.id));
  const seen = new Set(codeIds);
  for (const s of [...local, ...file]) {
    if (!seen.has(s.id)) { seen.add(s.id); ordered.push(byId.get(s.id)); }
  }
  return ordered;
}

export function sceneById(id) {
  if (id == null) return null;
  return allScenes().find((s) => s.id === id) || null;
}

// True when the scene came from a saved store -- localStorage OR disk --
// for list badges and delete affordances in the GM window.
export function isUserScene(id) {
  return loadUserScenes().some((s) => s.id === id) || fileScenes().some((s) => s.id === id);
}

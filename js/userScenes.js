// ============================================================
//  userScenes.js  --  scenes you build and save in the GM window
// ------------------------------------------------------------
//  The scene builder writes finished scenes here so they persist
//  across refreshes without a backend. They live in localStorage
//  (this machine's browser), separate from the session state and
//  separate from the code-defined SCENES in data/scenes.js. Use the
//  builder's Export to copy a scene into data/scenes.js when you want
//  to commit or share it.
//
//  A saved scene uses the exact same shape as a data/scenes.js entry.
// ============================================================

export const USER_SCENES_KEY = 'aldermere.gm.userScenes.v1';

export function loadUserScenes() {
  try {
    const raw = localStorage.getItem(USER_SCENES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.warn('could not load saved scenes', err);
    return [];
  }
}

export function saveUserScenes(list) {
  try {
    localStorage.setItem(USER_SCENES_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('could not save scenes', err);
  }
}

// Upsert by id: a re-saved scene replaces the previous version.
export function addUserScene(scene) {
  const list = loadUserScenes().filter((s) => s.id !== scene.id);
  list.push(scene);
  saveUserScenes(list);
  return list;
}

export function removeUserScene(id) {
  const list = loadUserScenes().filter((s) => s.id !== id);
  saveUserScenes(list);
  return list;
}

// ============================================================
//  fileScenes.js  --  saved scenes that live on disk
// ------------------------------------------------------------
//  Scenes you build are saved two ways: in localStorage (instant,
//  per browser; see userScenes.js) AND on disk in data/userScenes.json
//  via the local server's POST /save-scenes. The disk copy is what makes
//  a day-before setup survive clearing browser data or moving machines.
//
//  This module owns the disk tier:
//    - loadFileScenes()  fetches data/userScenes.json once at startup and
//                        caches it, so allScenes() can read it synchronously.
//    - fileScenes()      returns the cached array.
//    - saveSceneToFile() / removeSceneFromFile()  upsert the cache and POST
//                        the whole list back, best-effort.
//
//  Everything degrades to "localStorage still works": a missing server
//  (the static deploy, or running plain http.server) makes the fetch and
//  the POST no-ops, never an error. The on-disk format is a bare JSON array
//  of scene objects, byte-identical to what userScenes.js stores.
// ============================================================

const FILE_URL = 'data/userScenes.json';
const SAVE_URL = '/save-scenes';

let cache = [];   // populated once by loadFileScenes(), before either view mounts

// Read the disk tier at startup. Swallows every failure (404 on the static
// deploy, offline, malformed file) into an empty list, so it can never block
// or break mount.
export async function loadFileScenes() {
  try {
    const res = await fetch(FILE_URL, { cache: 'no-store' });
    if (!res.ok) { cache = []; return cache; }
    const arr = await res.json();
    cache = Array.isArray(arr) ? arr : [];
  } catch (err) {
    cache = [];
  }
  return cache;
}

// The cached disk scenes, for the synchronous allScenes() merge.
export function fileScenes() {
  return cache;
}

// Upsert a scene into the disk tier and POST the whole list. The cache is
// updated first so an immediate allScenes() reflects the change even if the
// network write is slow or fails. Returns true only if the server saved it.
export async function saveSceneToFile(scene) {
  if (!scene || typeof scene.id !== 'string') return false;
  cache = cache.filter((s) => s.id !== scene.id);
  cache.push(scene);
  return postList();
}

export async function removeSceneFromFile(id) {
  cache = cache.filter((s) => s.id !== id);
  return postList();
}

async function postList() {
  try {
    const res = await fetch(SAVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cache)
    });
    return res.ok;
  } catch (err) {
    return false;   // localStorage already has it; the disk copy is best-effort
  }
}

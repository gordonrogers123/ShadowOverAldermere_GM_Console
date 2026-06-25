// ============================================================
//  state.js  --  the session state and where it is saved
// ------------------------------------------------------------
//  One small object describes the whole session. The GM window is
//  the single source of truth and the only writer. Both windows
//  read it from localStorage on load so a refresh recovers the
//  session, online or offline.
//
//  Phase 1 state:
//    {
//      version:  1,
//      sceneId:  "city-gate" | null,   // currently selected scene
//      mapState: "hidden" | "revealed" // which map variant shows
//    }
//
//  Later phases add fields here (tokens, audio volumes, the active
//  card or NPC portrait). Bump STATE_VERSION when the shape changes
//  in a way old saved state cannot satisfy.
// ============================================================

export const STORAGE_KEY = 'aldermere.gm.state.v1';
export const STATE_VERSION = 1;

export function defaultState() {
  return {
    version: STATE_VERSION,
    sceneId: null,
    mapState: 'hidden'
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STATE_VERSION) return defaultState();
    // Merge over defaults so a missing field never crashes a reader.
    return { ...defaultState(), ...parsed };
  } catch (err) {
    console.warn('could not load saved state, starting fresh', err);
    return defaultState();
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('could not save state', err);
  }
}

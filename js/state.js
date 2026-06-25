// ============================================================
//  state.js  --  the session state and where it is saved
// ------------------------------------------------------------
//  One object describes the whole session. The GM window is the
//  single source of truth and the only writer. Both windows read
//  it from localStorage on load so a refresh recovers the session,
//  online or offline.
//
//  Phase 2 state:
//    {
//      version: 2,
//      sceneId: "city-gate" | null,   // currently selected scene
//      mapState: "hidden",            // active BACKGROUND VARIANT key:
//                                     //   any key in scene.maps, not just
//                                     //   hidden/revealed
//      stage: {                       // the live cinematic stage
//        visible: true,               // black curtain up (true) or down (false)
//        left:  { shown, srcOverride },   // is the left character on stage?
//        right: { shown, srcOverride }    // is the right character on stage?
//      }
//    }
//
//  srcOverride is an optional live character swap; null means "use the
//  scene's own characters.<side>.src". A character's entrance transition
//  is read from the scene, not stored here (it never varies per session).
//  Token and audio fields live on the SCENE (data/scenes.js), reserved
//  for Phase 3 and Phase 4.
//
//  Bump STATE_VERSION when the shape changes in a way old saved state
//  cannot satisfy; migrate() upgrades older state in place where it can,
//  rather than discarding it.
// ============================================================

export const STORAGE_KEY = 'aldermere.gm.state.v1';
export const STATE_VERSION = 2;

// Fill any missing piece of the nested stage block from defaults, so a
// reader never trips over an absent sub-key. (The old shallow merge could
// not do this: it replaced the whole stage object wholesale.)
function normalizeStage(s) {
  s = s || {};
  const side = (x) => ({
    shown: !!(x && x.shown),
    srcOverride: (x && x.srcOverride) || null
  });
  return {
    visible: s.visible !== false,   // default true
    left: side(s.left),
    right: side(s.right)
  };
}

export function defaultState() {
  return {
    version: STATE_VERSION,
    sceneId: null,
    mapState: 'hidden',
    stage: normalizeStage(null)
  };
}

// Upgrade older or partial saved state to the current shape instead of
// throwing it away, so an upgrade keeps the GM's current scene and reveal.
function migrate(parsed) {
  if (!parsed || typeof parsed !== 'object') return defaultState();
  if (parsed.version === 1 || parsed.version === 2) {
    return {
      version: STATE_VERSION,
      sceneId: parsed.sceneId != null ? parsed.sceneId : null,
      mapState: parsed.mapState || 'hidden',
      stage: normalizeStage(parsed.stage)
    };
  }
  // Unknown or corrupt: start fresh (safe default).
  return defaultState();
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return migrate(JSON.parse(raw));
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

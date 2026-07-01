// ============================================================
//  state.js  --  the session state and where it is saved
// ------------------------------------------------------------
//  One object describes the whole session. The GM window is the
//  single source of truth and the only writer. Both windows read
//  it from localStorage on load so a refresh recovers the session,
//  online or offline.
//
//  Phase 4 state:
//    {
//      version: 4,
//      sceneId: "city-gate" | null,   // currently selected scene
//      mapState: "hidden",            // active BACKGROUND VARIANT key:
//                                     //   any key in scene.maps, not just
//                                     //   hidden/revealed
//      stage: {                       // the live cinematic stage
//        visible: true,               // black curtain up (true) or down (false)
//        left:  { shown, srcOverride },   // is the left character on stage?
//        right: { shown, srcOverride },   // is the right character on stage?
//        tokens: [                    // live tokens placed on the map (Phase 3)
//          { instId,                  //   unique id per placed token
//            castId,                  //   id into CAST.heroes / CAST.enemies
//            kind,                    //   "hero" | "enemy"
//            label,                   //   badge text, e.g. "Lysander", "Brigand 2"
//            x, y,                    //   center, fractions [0,1] of the MAP IMAGE
//            visible }                //   shown on the Player TV (the GM can hide)
//        ]
//      },
//      audio: {                       // live audio, driven by the GM, mirrored
//        master: 0.8,                 //   master volume [0,1]
//        outputs: { player, gm },     //   which windows actually SOUND (selectable)
//        tracks: {                    //   keyed 'mus:<i>' | 'amb:<i>' (legacy 'music')
//          "<key>": { playing, volume, pan, loop } },
//        sfxTrigger: { "<sfxId>": n } //   bump the counter to fire a one-shot
//      }
//    }
//
//  srcOverride is an optional live character swap; null means "use the
//  scene's own characters.<side>.src". A character's entrance transition
//  is read from the scene, not stored here (it never varies per session).
//  A token's x/y are fractions of the DISPLAYED map image (object-fit:
//  contain), so the same numbers land on the same map pixel on the GM
//  board and the Player TV regardless of window size. Which cast members
//  are ELIGIBLE on a scene is the SCENE's `tokens` roster (data/scenes.js);
//  the array here is what is actually PLACED and live. state.audio is the LIVE
//  audio (which tracks play, at what volume/pan); a scene's `audio`
//  config (data/scenes.js) is the template it is seeded from on select.
//
//  Bump STATE_VERSION when the shape changes in a way old saved state
//  cannot satisfy; migrate() upgrades older state in place where it can,
//  rather than discarding it.
// ============================================================

export const STORAGE_KEY = 'aldermere.gm.state.v1';
export const STATE_VERSION = 4;

function clamp01(n) {
  n = +n;
  if (!isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// Validate one live token instance STRUCTURALLY -- never against the scene
// roster. normalizeStage has no scene context, and a transient mismatch (a
// scene not yet resolved on cold load, or a roster edited after placement)
// must not silently delete the GM's board. Drop only entries that are
// genuinely unusable (no castId); fix up the rest. instId is normally set by
// the writer (gm.js); a fallback is minted only for legacy/malformed entries.
// Per-token combat tracking (map mode): current/max HP and a list of condition
// labels. Optional + additive -- absent on older saves and ignored by the Player
// (GM-only), so no STATE_VERSION bump, same as `visible`.
function normHp(h) {
  const num = (v) => (v == null || v === '' || !isFinite(+v)) ? null : Math.max(0, Math.round(+v));
  const max = num(h && h.max);
  let current = num(h && h.current);
  if (max != null && current != null && current > max) current = max;
  return { current, max };
}
function normalizeToken(t, i) {
  if (!t || typeof t !== 'object') return null;
  const castId = typeof t.castId === 'string' ? t.castId.trim() : '';
  if (!castId) return null;
  const kind = t.kind === 'hero' ? 'hero' : (t.kind === 'npc' ? 'npc' : 'enemy');
  const instId = (typeof t.instId === 'string' && t.instId) ? t.instId : ('t' + i + '_' + castId);
  let label = castId;
  if (t.label != null && String(t.label).trim()) label = String(t.label);
  const conditions = Array.isArray(t.conditions) ? t.conditions.filter((c) => typeof c === 'string' && c.trim()).map((c) => String(c).trim()) : [];
  return { instId, castId, kind, label, x: clamp01(t.x), y: clamp01(t.y), visible: t.visible !== false, hp: normHp(t.hp), conditions };
}

// Fill any missing piece of the nested stage block from defaults, so a
// reader never trips over an absent sub-key. (The old shallow merge could
// not do this: it replaced the whole stage object wholesale.) tokens is
// backfilled to [] for pre-Phase-3 saved state.
//
// stage.mapMode is a TRANSIENT broadcast flag (gm.js sets it true while the GM
// is in map mode, telling the Player to reveal tokens). It is deliberately not
// persisted or normalized here, so a reload clears it and the Player hides
// tokens until the GM re-enters map mode.
function normalizeStage(s) {
  s = s || {};
  const side = (x) => ({
    shown: !!(x && x.shown),
    srcOverride: (x && x.srcOverride) || null
  });
  const tokens = (Array.isArray(s.tokens) ? s.tokens : [])
    .map((t, i) => normalizeToken(t, i))
    .filter(Boolean);
  return {
    visible: s.visible !== false,   // default true
    // Backdrop hidden = the background layer goes black but characters still
    // composite ("characters on black"). Separate from `visible` (the global
    // curtain). Optional/default false, so old saves + the Player need no migration.
    bgHidden: !!s.bgHidden,
    left: side(s.left),
    right: side(s.right),
    tokens,
    // The token whose turn it is (initiative). Broadcast so both the GM board
    // and the Player TV ring it gold; null when no encounter is running.
    activeTokenId: s.activeTokenId != null ? String(s.activeTokenId) : null,
    // GM-toggled on-map overlays (map mode): hero/NPC HP bars + condition icons on
    // the tokens themselves, shown on the GM board AND the Player TV. Enemy HP is
    // never rendered (enforced in stageView). Optional/additive -> no VERSION bump.
    hpOnMap: !!s.hpOnMap,
    conditionsOnMap: !!s.conditionsOnMap
  };
}

function clampPan(n) {
  n = +n;
  if (!isFinite(n)) return 0;
  return n < -1 ? -1 : n > 1 ? 1 : n;
}

// One live audio track's settings, validated structurally (mirrors
// normalizeToken): volume defaults 0.8, pan 0, loop true.
function normalizeTrack(t) {
  t = t || {};
  const sec = (v) => { const n = +v; return isFinite(n) && n > 0 ? Math.min(60, n) : 0; };
  return {
    playing: !!t.playing,
    volume: clamp01(t.volume == null ? 0.8 : t.volume),
    pan: clampPan(t.pan),
    loop: t.loop !== false,
    muted: !!t.muted,         // mixer mute: silent but still "playing"
    fadeIn: sec(t.fadeIn),    // seconds: ramp gain 0->vol when the bed starts
    fadeOut: sec(t.fadeOut)   // seconds: ramp vol->0 on stop / before a non-loop bed ends
  };
}

// Live audio: master volume, which windows output (selectable), per-track live
// settings, and monotonic one-shot SFX trigger counters. Like normalizeStage,
// it never throws and drops nothing structurally, so a transient mismatch can
// never wipe the GM's audio. outputs default to player-on, gm-off.
function normalizeAudio(a) {
  a = a || {};
  const o = (a.outputs && typeof a.outputs === 'object') ? a.outputs : {};
  const tracks = {};
  if (a.tracks && typeof a.tracks === 'object') {
    for (const [key, t] of Object.entries(a.tracks)) {
      if (key) tracks[key] = normalizeTrack(t);
    }
  }
  const sfxTrigger = {};
  if (a.sfxTrigger && typeof a.sfxTrigger === 'object') {
    for (const [id, n] of Object.entries(a.sfxTrigger)) {
      const v = Math.floor(+n);
      sfxTrigger[id] = (isFinite(v) && v > 0) ? v : 0;
    }
  }
  return {
    master: clamp01(a.master == null ? 0.8 : a.master),
    masterMuted: !!a.masterMuted,   // mixer Master mute / Fade -> whole mix silent
    outputs: { player: o.player !== false, gm: !!o.gm },
    tracks,
    sfxTrigger
  };
}

export function defaultState() {
  return {
    version: STATE_VERSION,
    sceneId: null,
    mapState: 'hidden',
    stage: normalizeStage(null),
    audio: normalizeAudio(null),
    initiative: null
  };
}

// Upgrade older or partial saved state to the current shape instead of
// throwing it away, so an upgrade keeps the GM's current scene and reveal.
function migrate(parsed) {
  if (!parsed || typeof parsed !== 'object') return defaultState();
  if (parsed.version === 1 || parsed.version === 2 || parsed.version === 3 || parsed.version === 4) {
    return {
      version: STATE_VERSION,
      sceneId: parsed.sceneId != null ? parsed.sceneId : null,
      mapState: parsed.mapState || 'hidden',
      stage: normalizeStage(parsed.stage),
      audio: normalizeAudio(parsed.audio),
      // Initiative is GM-only combat state; carried opaquely so a reload mid-fight
      // keeps the order + current turn. The Player ignores it.
      initiative: (parsed.initiative && typeof parsed.initiative === 'object') ? parsed.initiative : null
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

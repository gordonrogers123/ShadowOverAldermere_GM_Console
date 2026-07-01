// ============================================================
//  tokenOverrides.js  --  per-character token tweaks that live on disk
// ------------------------------------------------------------
//  The token builder (GM tool) lets you crop a character's face into the
//  round token, recolor the ring, and tune the on-map overlays (name size,
//  condition word size + position, HP-bar position). Those tweaks are NOT
//  session state -- they belong to the character, so they are stored per
//  castId on disk in data/tokenOverrides.json (server-written, same pattern
//  as data/userScenes.json) and MERGED OVER the built-in CAST at load.
//
//  Merging in place means every consumer that already reads CAST
//  (stageView tokens, the stat card, the roster) picks the tweaks up with
//  no plumbing. Everything degrades to "the built-in CAST": a missing
//  server (static deploy) makes the fetch and the POST no-ops, never errors.
//
//  Override entry (all fields optional, additive):
//    { face,        // CSS object-position, e.g. "50% 22%" -- the face crop
//      ringColor,   // token ring color, e.g. "#6f9bd1"
//      tokenImage,  // round token art path (lets an NPC borrow its portrait)
//      display: {   // GLOBAL on-map overlay tuning (the _global entry), read by stageView
//        nameSize, nameSpacing,       //   name badge scale + letter-spacing
//        condSize, condSpacing,       //   condition word scale + letter-spacing
//        condPosY,                    //   condition vertical position (0 below .. 100 above)
//        condCurve,                   //   condition word-wrap depth (0 flat .. 100 deep)
//        condColor, condOutline,      //   condition text fill + outline (#rrggbb)
//        hpPos } }                    //   HP-bar height (0 bottom .. 100 top)
// ============================================================

import { CAST } from '../data/cast.js';

const FILE_URL = 'data/tokenOverrides.json';
const SAVE_URL = '/save-token-overrides';

let cache = {};   // { [castId]: override } -- populated once at startup
let pristine = null;   // snapshot of the built-in CAST fields, taken before any merge
let addedIds = new Set();   // ids the builder appended to CAST this session (for idempotent re-apply)

const KINDS = ['heroes', 'enemies', 'npcs'];
const ADDED_KEY = '_added';    // reserved: { [id]: character } for GM-created tokens
const HIDDEN_KEY = '_hidden';  // reserved: { [castId]: true } to hide built-ins/added from pickers

// Snapshot the overridable fields of every CAST entry ONCE, before the first
// merge. applyToCast() rebuilds from this snapshot each time, so it is idempotent
// AND a removed override truly restores the built-in default (we mutate CAST in
// place, so without a pristine copy there would be nothing to restore to).
function snapshot() {
  if (pristine) return;
  pristine = {};
  for (const kind of KINDS) {
    for (const c of (CAST[kind] || [])) {
      pristine[c.id] = {
        face: c.face, ringColor: c.ringColor, tokenImage: c.tokenImage,
        display: c.display ? { ...c.display } : undefined
      };
    }
  }
}

function clampNum(v, lo, hi, dflt) {
  const n = +v;
  if (!isFinite(n)) return dflt;
  return n < lo ? lo : n > hi ? hi : n;
}

// The on-map display settings are GLOBAL (one set for every token), stored under
// a reserved key -- not per character. Keep only the known, well-typed fields so
// a hand-edited or stale file can never inject junk.
function cleanDisplay(d) {
  if (!d || typeof d !== 'object') return null;
  const out = {};
  if (d.nameSize != null) out.nameSize = clampNum(d.nameSize, 0.6, 1.6, 1);
  if (d.nameSpacing != null) out.nameSpacing = clampNum(d.nameSpacing, 0, 100, 0);   // name letter-spacing (0 .. 0.4em)
  if (d.condSize != null) out.condSize = clampNum(d.condSize, 0.6, 1.8, 1);
  if (d.condSpacing != null) out.condSpacing = clampNum(d.condSpacing, 0, 100, 8);   // condition letter-spacing (spreads the curved word)
  if (d.condPosY != null) out.condPosY = clampNum(d.condPosY, 0, 100, 100);   // condition vertical position (0 below .. 100 above)
  if (d.condCurve != null) out.condCurve = clampNum(d.condCurve, 0, 100, 55);   // how tightly the word wraps (0 flat .. 100 deep)
  if (/^#[0-9a-fA-F]{6}$/.test(d.condColor || '')) out.condColor = d.condColor;       // condition text fill
  if (/^#[0-9a-fA-F]{6}$/.test(d.condOutline || '')) out.condOutline = d.condOutline; // condition text outline
  if (d.hpPos != null) out.hpPos = clampNum(d.hpPos, 0, 100, 0);                 // HP-bar height: 0 bottom .. 100 top
  return Object.keys(out).length ? out : null;
}

// The SVG path the condition word curves along. `curve` is the wrap depth (0 =
// nearly flat, 100 = a deep arc). `positionY` is the manual vertical placement
// (100 = above the token, 0 = below it, ~50 = across the middle): the word center
// sits at that height and the arc stays concave TOWARD the token center (over the
// top when high, under the bottom when low). Shared by stageView + the preview.
export function condArcPath(curve, positionY) {
  const t = clampNum(curve == null ? 55 : curve, 0, 100, 55) / 100;
  const p = clampNum(positionY == null ? 100 : positionY, 0, 100, 100) / 100;
  const half = 60;
  const peakY = 150 - p * 180;                            // word center: p=1 -> -30 (wraps the top), p=0 -> 150 (clearly below the token)
  const s = 4 + t * 60;                                   // sagitta (bulge): 4 flat .. 64 deep
  const R = (half * half + s * s) / (2 * s);
  if (peakY <= 50) {                                      // upper half: concave down (over the top)
    const yE = peakY + s;
    return `M ${50 - half},${yE.toFixed(1)} A ${R.toFixed(1)},${R.toFixed(1)} 0 0 1 ${50 + half},${yE.toFixed(1)}`;
  }
  const yE = peakY - s;                                   // lower half: concave up (under the bottom)
  return `M ${50 - half},${yE.toFixed(1)} A ${R.toFixed(1)},${R.toFixed(1)} 0 0 0 ${50 + half},${yE.toFixed(1)}`;
}
// A per-character override is now ONLY the token identity: face crop, ring color,
// token art. (Display settings moved to the global entry above.)
function cleanOverride(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  if (typeof o.face === 'string' && o.face.trim()) out.face = o.face.trim();
  if (typeof o.ringColor === 'string' && o.ringColor.trim()) out.ringColor = o.ringColor.trim();
  if (typeof o.tokenImage === 'string' && o.tokenImage.trim()) out.tokenImage = o.tokenImage.trim();
  return Object.keys(out).length ? out : null;
}

// A GM-created character (token builder "Add token"): identity + art, no stats.
const KIND_ARR = { hero: 'heroes', npc: 'npcs', enemy: 'enemies' };
function cleanChar(c) {
  if (!c || typeof c !== 'object') return null;
  const id = typeof c.id === 'string' ? c.id.trim() : '';
  const name = typeof c.name === 'string' ? c.name.trim() : '';
  if (!id || !name) return null;
  const kind = c.kind === 'npc' ? 'npc' : c.kind === 'enemy' ? 'enemy' : 'hero';
  const out = { id, name, kind, added: true };
  if (typeof c.tokenImage === 'string' && c.tokenImage.trim()) out.tokenImage = c.tokenImage.trim();
  if (typeof c.ringColor === 'string' && c.ringColor.trim()) out.ringColor = c.ringColor.trim();
  if (typeof c.face === 'string' && c.face.trim()) out.face = c.face.trim();
  if (kind === 'enemy') out.singular = (typeof c.singular === 'string' && c.singular.trim()) ? c.singular.trim() : name.replace(/s$/, '');
  return out;
}

// Rebuild every CAST entry from its pristine snapshot, then overlay the override
// (if any). Doing a full rebuild -- rather than layering onto whatever CAST holds
// now -- keeps it idempotent and lets a removed override restore the built-in
// default. A partial override leaves the un-set fields at the built-in value.
function applyToCast() {
  snapshot();
  // 1) Drop any previously-appended tokens so this stays idempotent.
  for (const kind of KINDS) {
    if (CAST[kind]) for (let i = CAST[kind].length - 1; i >= 0; i--) if (addedIds.has(CAST[kind][i].id)) CAST[kind].splice(i, 1);
  }
  addedIds = new Set();
  // 2) Rebuild built-in identity from the pristine snapshot + any per-id override.
  for (const kind of KINDS) {
    for (const c of (CAST[kind] || [])) {
      const base = pristine[c.id] || {};
      const o = cleanOverride(cache[c.id]) || {};
      c.face = o.face != null ? o.face : base.face;
      c.ringColor = o.ringColor || base.ringColor;
      c.tokenImage = o.tokenImage || base.tokenImage;
    }
  }
  // 3) Append GM-created tokens (identity from _added, overlaid with any edits).
  const added = (cache[ADDED_KEY] && typeof cache[ADDED_KEY] === 'object') ? cache[ADDED_KEY] : {};
  for (const raw of Object.values(added)) {
    const c = cleanChar(raw);
    if (!c) continue;
    const arr = KIND_ARR[c.kind];
    if (!CAST[arr]) CAST[arr] = [];
    if (CAST[arr].some((x) => x.id === c.id)) continue;
    const o = cleanOverride(cache[c.id]) || {};   // later crop/ring/image edits via "Save token"
    CAST[arr].push({ ...c, ...o });
    addedIds.add(c.id);
  }
  // 4) Mark hidden entries so the pickers can filter them (built-in + added).
  const hidden = (cache[HIDDEN_KEY] && typeof cache[HIDDEN_KEY] === 'object') ? cache[HIDDEN_KEY] : {};
  for (const kind of KINDS) for (const c of (CAST[kind] || [])) c.hidden = hidden[c.id] === true;
}

// The GLOBAL on-map display settings (name/condition size, condition position +
// angle, HP-bar position), applied to every token. Stored under a reserved key
// that applyToCast ignores (no character has this id). Read by stageView.
const GLOBAL_KEY = '_global';
export function globalDisplay() {
  return cleanDisplay(cache[GLOBAL_KEY]) || {};
}
export async function saveGlobalDisplay(patch) {
  const merged = { ...(cache[GLOBAL_KEY] || {}), ...(patch || {}) };
  const clean = cleanDisplay(merged);
  if (clean) cache[GLOBAL_KEY] = clean; else delete cache[GLOBAL_KEY];
  return post();
}
// Apply the global settings live in THIS window (the Player, off a broadcast).
export function applyGlobalDisplay(display) {
  const clean = cleanDisplay(display);
  if (clean) cache[GLOBAL_KEY] = clean; else delete cache[GLOBAL_KEY];
}

// ---- Roster editing: add / remove / hide tokens (all persist + re-merge CAST) ----
export function isAdded(id) { return addedIds.has(id); }
export function isHidden(id) { return !!(cache[HIDDEN_KEY] && cache[HIDDEN_KEY][id]); }
// The roster payload the GM broadcasts so the Player rebuilds the same CAST live.
export function rosterPayload() {
  return { added: cache[ADDED_KEY] || {}, hidden: cache[HIDDEN_KEY] || {} };
}
export function applyRosterLive(payload) {
  cache[ADDED_KEY] = (payload && payload.added && typeof payload.added === 'object') ? payload.added : {};
  cache[HIDDEN_KEY] = (payload && payload.hidden && typeof payload.hidden === 'object') ? payload.hidden : {};
  applyToCast();
}
export async function addCharacter(char) {
  const c = cleanChar(char);
  if (!c) return false;
  if (!cache[ADDED_KEY]) cache[ADDED_KEY] = {};
  cache[ADDED_KEY][c.id] = c;
  applyToCast();
  return post();
}
export async function removeAddedCharacter(id) {
  if (cache[ADDED_KEY]) delete cache[ADDED_KEY][id];
  if (cache[id]) delete cache[id];                 // drop any per-id override too
  if (cache[HIDDEN_KEY]) delete cache[HIDDEN_KEY][id];
  applyToCast();
  return post();
}
export async function setHidden(id, hide) {
  if (!cache[HIDDEN_KEY]) cache[HIDDEN_KEY] = {};
  if (hide) cache[HIDDEN_KEY][id] = true; else delete cache[HIDDEN_KEY][id];
  applyToCast();
  return post();
}

// Read the disk tier once at startup and merge it over CAST. Swallows every
// failure (404 on the static deploy, offline, malformed file) so it can never
// block or break mount.
export async function loadTokenOverrides() {
  try {
    const res = await fetch(FILE_URL, { cache: 'no-store' });
    const obj = res.ok ? await res.json() : null;
    cache = (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (err) {
    cache = {};
  }
  applyToCast();
  return cache;
}

// The current override for a castId (raw, may be null) -- the builder reads this
// to seed its controls.
export function overrideFor(castId) {
  return (castId && cache[castId]) ? cleanOverride(cache[castId]) : null;
}

// Upsert one character's override, re-merge over CAST so the change is live this
// session, and POST the whole map. `patch` is merged over any existing override;
// pass a field as null/'' to drop it back to the CAST default on next load.
export async function saveTokenOverride(castId, patch) {
  if (!castId || !patch || typeof patch !== 'object') return false;
  const merged = { ...(cache[castId] || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') delete merged[k];
    else if (k === 'display') merged.display = { ...(merged.display || {}), ...v };
    else merged[k] = v;
  }
  const clean = cleanOverride(merged);
  if (clean) cache[castId] = clean; else delete cache[castId];
  applyToCast();
  return post();
}

// Drop a character's override entirely, restoring the built-in token, and persist.
export async function resetTokenOverride(castId) {
  if (castId && cache[castId]) delete cache[castId];
  applyToCast();
  return post();
}

// Apply a single override to THIS window's CAST live, without a disk round-trip.
// The GM broadcasts a token change so the Player TV re-crops immediately (both
// windows otherwise only merge overrides at load). Pass a null override to clear.
export function applyLiveOverride(castId, override) {
  if (!castId) return;
  const clean = cleanOverride(override);
  if (clean) cache[castId] = clean; else delete cache[castId];
  applyToCast();
}

async function post() {
  try {
    const res = await fetch(SAVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cache)
    });
    return res.ok;
  } catch (err) {
    return false;   // best-effort; the in-memory merge already took effect
  }
}

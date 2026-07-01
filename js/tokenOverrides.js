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
//      display: {   // on-map overlay tuning, read by stageView
//        nameSize,  //   name badge scale (multiplier, ~0.6..1.6)
//        condSize,  //   condition word scale (multiplier, ~0.6..1.8)
//        condPos,   //   "above" | "below" the token
//        hpPos } }  //   "below" | "above" the token
// ============================================================

import { CAST } from '../data/cast.js';

const FILE_URL = 'data/tokenOverrides.json';
const SAVE_URL = '/save-token-overrides';

let cache = {};   // { [castId]: override } -- populated once at startup
let pristine = null;   // snapshot of the built-in CAST fields, taken before any merge

const KINDS = ['heroes', 'enemies', 'npcs'];

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

// Keep only the known, well-typed fields, so a hand-edited or stale file can
// never inject junk onto a CAST entry.
function cleanDisplay(d) {
  if (!d || typeof d !== 'object') return null;
  const out = {};
  if (d.nameSize != null) out.nameSize = clampNum(d.nameSize, 0.6, 1.6, 1);
  if (d.condSize != null) out.condSize = clampNum(d.condSize, 0.6, 1.8, 1);
  if (d.condPos === 'above' || d.condPos === 'below') out.condPos = d.condPos;
  if (d.hpPos === 'above' || d.hpPos === 'below') out.hpPos = d.hpPos;
  return Object.keys(out).length ? out : null;
}
function cleanOverride(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  if (typeof o.face === 'string' && o.face.trim()) out.face = o.face.trim();
  if (typeof o.ringColor === 'string' && o.ringColor.trim()) out.ringColor = o.ringColor.trim();
  if (typeof o.tokenImage === 'string' && o.tokenImage.trim()) out.tokenImage = o.tokenImage.trim();
  const disp = cleanDisplay(o.display);
  if (disp) out.display = disp;
  return Object.keys(out).length ? out : null;
}

// Rebuild every CAST entry from its pristine snapshot, then overlay the override
// (if any). Doing a full rebuild -- rather than layering onto whatever CAST holds
// now -- keeps it idempotent and lets a removed override restore the built-in
// default. A partial override leaves the un-set fields at the built-in value.
function applyToCast() {
  snapshot();
  for (const kind of KINDS) {
    for (const c of (CAST[kind] || [])) {
      const base = pristine[c.id] || {};
      const o = cleanOverride(cache[c.id]) || {};
      c.face = o.face != null ? o.face : base.face;
      c.ringColor = o.ringColor || base.ringColor;
      c.tokenImage = o.tokenImage || base.tokenImage;
      const disp = { ...(base.display || {}), ...(o.display || {}) };
      c.display = Object.keys(disp).length ? disp : undefined;
    }
  }
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

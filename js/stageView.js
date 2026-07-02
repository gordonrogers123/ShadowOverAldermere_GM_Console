// ============================================================
//  stageView.js  --  the layered scene compositor (shared)
// ------------------------------------------------------------
//  The same DOM and logic render the Player TV and the GM builder
//  preview, so the preview matches the TV exactly. A stage layers,
//  back to front:
//    two background cross-fade layers  (a map or cinematic art, with
//                                        named reveal variants)
//    left character  (transparent PNG, enters from the left or fades)
//    right character (transparent PNG, enters from the right or fades)
//    a black curtain (whole-scene show/hide, fades up from / to black)
//    an idle title   (before any scene is chosen)
//
//  render(state, scene, opts) is told the current state and the
//  resolved scene; it diffs against what is already on stage and
//  plays only the transitions that changed, so characters animate in
//  and out rather than popping. Pass { instant: true } to apply a
//  posture with no animation (used on a cold page load so a restored
//  scene appears already in place).
// ============================================================

import { DEFAULT_ENTER } from './transitions.js';
import { CAST } from '../data/cast.js';
import { globalDisplay, condArcPath } from './tokenOverrides.js';

// Resolve a token's castId to its cast entry (ring color, portrait, name).
// ids are unique across heroes and enemies, so a flat map is enough; the
// token's `kind` only drives styling and numbering, not lookup.
// Live lookup across ALL cast kinds (heroes, NPCs, enemies) -- scanned each call
// rather than snapshotted, so tokens added in the token builder mid-session (and
// NPC token art) resolve without a reload.
const CAST_BY_ID = (id) => {
  for (const arr of [CAST.heroes, CAST.npcs, CAST.enemies]) {
    const c = (arr || []).find((x) => x.id === id);
    if (c) return c;
  }
  return null;
};

// A token's diameter as a fraction of the shorter side of the displayed map.
const TOKEN_FRAC = 0.07;

// A scene side's character roster: one OR many cutouts eligible to occupy a side
// (only one shown at a time). Accepts the legacy single object or an array
// (mirrors how audio `music` accepts single-or-array) and always returns an
// array of entries that actually carry a src.
function charRoster(cfg) {
  if (!cfg) return [];
  if (Array.isArray(cfg)) return cfg.filter((c) => c && c.src);
  return cfg.src ? [cfg] : [];
}

function clampUnit(n) {
  n = +n;
  if (!isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// object-fit: contain geometry -- the rect the map image actually occupies
// inside a (possibly differently shaped) stage, so tokens pin to the image
// itself, not the letterbox bars. Used for placement and, inverted, for drag.
function computeContainRect(stageW, stageH, imgAspect) {
  let w, h;
  if (stageW / stageH > imgAspect) { h = stageH; w = h * imgAspect; }
  else { w = stageW; h = w / imgAspect; }
  return { left: (stageW - w) / 2, top: (stageH - h) / 2, w, h };
}

// A map background can be a still <img> OR a looping <video>; both expose an
// intrinsic size and a readiness, just under different property names. These
// helpers let all the contain-rect math (tokens, grid, targeting, drag) treat
// the two the same, so coordinates land identically over image and video maps.
function mediaW(el) { return el ? (el.naturalWidth || el.videoWidth || 0) : 0; }
function mediaH(el) { return el ? (el.naturalHeight || el.videoHeight || 0) : 0; }
function mediaAspect(el) { const h = mediaH(el); return h ? mediaW(el) / h : 1; }
// A map src is a looping video when its extension is one we scan under
// maps/animated (kept in step with scan_assets.py VIDEO_EXTS).
function isVideoSrc(src) { return /\.(mp4|webm)(\?.*)?$/i.test(String(src || '')); }

// Short badge text for the no-art fallback: "Brigand 2" -> "B2",
// "Granny Edna" -> "GE", "Lysander" -> "L".
function initials(label) {
  const s = String(label || '').trim();
  const numbered = s.match(/^(\S)\S*\s+(\d+)$/);
  if (numbered) return numbered[1].toUpperCase() + numbered[2];
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (s[0] || '?').toUpperCase();
}

export function createStageView(root) {
  root.innerHTML = `
    <div class="stage">
      <div class="map-layer" data-layer="0"></div>
      <div class="map-layer" data-layer="1"></div>
      <img class="char-layer char-left" alt="" data-side="left">
      <img class="char-layer char-right" alt="" data-side="right">
      <svg class="grid-overlay" aria-hidden="true"></svg>
      <svg class="aoe-fx" aria-hidden="true"></svg>
      <svg class="target-fx" aria-hidden="true"><line class="target-line" x1="0" y1="0" x2="0" y2="0"></line><polygon class="target-arrowhead" points=""></polygon><text class="target-dist" text-anchor="middle" dominant-baseline="middle"></text></svg>
      <div class="token-layer"></div>
      <div class="zone-chips"></div>
      <div class="curtain"></div>
      <div class="idle"><div class="idle-title">The Shadow Over Aldermere</div></div>
    </div>
  `;

  const stage = root.querySelector('.stage');
  const layers = Array.from(root.querySelectorAll('.map-layer'));
  const chars = {
    left: root.querySelector('.char-left'),
    right: root.querySelector('.char-right')
  };
  const curtain = root.querySelector('.curtain');
  const idle = root.querySelector('.idle');
  const tokenLayer = root.querySelector('.token-layer');
  const targetFx = root.querySelector('.target-fx');
  const aoeFx = root.querySelector('.aoe-fx');
  const chipsLayer = root.querySelector('.zone-chips');
  const gridOverlay = root.querySelector('.grid-overlay');
  let lastState = null;      // last painted state, so a resize can re-lay-out the arrow + grid

  let activeIndex = 0;       // which background layer is currently visible
  let currentBgKey = null;   // what background is on screen, to skip redundant work
  let tokensShown = false;   // last token-visibility decision, so a ResizeObserver
                             // re-layout keeps tokens hidden when not in map mode
  const applied = {          // last applied posture, for diffing
    left: { shown: false, src: null },
    right: { shown: false, src: null }
  };
  // Exit-then-enter bookkeeping: a swap removes is-shown (the outgoing cutout
  // leaves) and waits for the exit to finish before the incoming one enters.
  // A bumped token invalidates any pending enter when a newer render interrupts.
  const swapState = { left: { token: 0, timer: null }, right: { token: 0, timer: null } };

  // ---- Background: the Phase 1 descriptor + two-layer cross-fade, now over
  //      any number of named variants (scene.maps[state.mapState]). ----
  function bgDescriptor(state, scene) {
    if (!scene) return { kind: 'idle' };
    // Backdrop hidden -> a blank (black) backdrop; characters still composite on
    // top (characters-on-black). Distinct from the global curtain (state.visible).
    if (state.stage && state.stage.bgHidden) return { kind: 'blank' };
    const maps = scene.maps || null;
    const path = maps ? maps[state.mapState] : null;
    if (path) return { kind: 'image', src: path, label: scene.name, video: isVideoSrc(path) };
    // The title plate's top line is per-scene (scene.titleHeader), defaulting to
    // "Aldermere" so existing scenes are unchanged. e.g. "Act I · Scene II".
    const header = (scene.titleHeader != null && String(scene.titleHeader).trim()) || 'Aldermere';
    return { kind: 'unrevealed', label: scene.name, header };
  }

  function bgKey(d) {
    // Include the header so editing the title-screen header re-renders the plate.
    return d.kind === 'image' ? 'image:' + d.src : d.kind + ':' + (d.label || '') + ':' + (d.header || '');
  }

  function buildUnrevealed(label, header) {
    const panel = document.createElement('div');
    panel.className = 'unrevealed';
    const mark = document.createElement('div');
    mark.className = 'unrevealed-mark';
    mark.textContent = header || 'Aldermere';
    const name = document.createElement('div');
    name.className = 'unrevealed-name';
    name.textContent = label || '';
    panel.append(mark, name);
    return panel;
  }

  function updateBackground(state, scene) {
    const d = bgDescriptor(state, scene);
    const key = bgKey(d);

    if (d.kind === 'idle') {
      idle.classList.add('show');
      layers.forEach((l) => { l.style.opacity = '0'; });
      currentBgKey = key;
      return;
    }
    idle.classList.remove('show');
    if (key === currentBgKey) return;
    currentBgKey = key;

    const incoming = layers[1 - activeIndex];
    const reveal = () => {
      incoming.style.opacity = '1';
      const outgoing = layers[activeIndex];
      outgoing.style.opacity = '0';
      // A video map in the layer we're hiding keeps decoding otherwise; pause it
      // (it's discarded when that layer is next reused as `incoming`).
      const ov = outgoing.querySelector('video.map-img');
      if (ov) { try { ov.pause(); } catch (_) {} }
      activeIndex = 1 - activeIndex;
    };

    if (d.kind === 'blank') {
      // Backdrop hidden: fade BOTH layers out so the dark stage shows through, with
      // the characters still composited over it (characters-on-black).
      layers.forEach((l) => { l.style.opacity = '0'; });
      return;
    }

    if (d.kind === 'unrevealed') {
      incoming.innerHTML = '';
      incoming.appendChild(buildUnrevealed(d.label, d.header));
      reveal();
      return;
    }

    let settled = false;
    // Re-pin tokens/grid once the map's intrinsic size is known (it was 0 while
    // loading, so the first render could not lay them out yet).
    const settle = () => { if (!settled) { settled = true; reveal(); layoutTokens(); } };
    const failToPlate = () => {
      // A variant file not present yet: fall back to the neutral plate.
      incoming.innerHTML = '';
      incoming.appendChild(buildUnrevealed(d.label, d.header));
      settle();
    };
    incoming.innerHTML = '';
    if (d.video) {
      // Animated (looping video) map: muted + playsinline so it autoplays with no
      // user gesture. Its intrinsic size lands at loadedmetadata; contain math then
      // pins tokens over the displayed rect exactly as for an image.
      const vid = document.createElement('video');
      vid.className = 'map-img';
      vid.loop = true; vid.muted = true; vid.autoplay = true; vid.playsInline = true;
      vid.setAttribute('muted', ''); vid.setAttribute('playsinline', '');
      vid.onloadedmetadata = settle;
      vid.onloadeddata = settle;
      vid.onerror = failToPlate;
      incoming.appendChild(vid);
      vid.src = d.src;
      if (vid.readyState >= 1 && vid.videoWidth > 0) settle();
      const p = vid.play && vid.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      const img = document.createElement('img');
      img.className = 'map-img';
      img.alt = '';
      img.onload = settle;
      img.onerror = failToPlate;
      incoming.appendChild(img);
      img.src = d.src;
      if (img.complete && img.naturalWidth > 0) settle();
    }
  }

  // ---- Characters: resolve the live src/visibility/transition per side, then
  //      diff against what is on stage and play only what changed. ----
  function resolveSide(side, state, scene) {
    // A side is a ROSTER of cutouts (one shown at a time). The live srcOverride
    // names who is active; resolve THAT character's transition/placement from
    // the roster. With no override the first roster entry is the side default
    // (so a legacy single-character scene reads exactly as before). An override
    // that names someone off-roster still shows -- with default placement.
    const roster = charRoster(scene && scene.characters ? scene.characters[side] : null);
    const live = (state.stage && state.stage[side]) || { shown: false, srcOverride: null };
    const override = live.srcOverride || null;
    const cfg = override ? (roster.find((c) => c.src === override) || null) : (roster[0] || null);
    const src = override || (cfg && cfg.src) || null;
    // Characters never composite over a title screen (an empty-src variant) --
    // the Aldermere plate is meant to stand alone, so a character armed/shown
    // from a prior backdrop does not bleed onto it. They enter once the GM
    // reveals a real map/background.
    const onTitle = bgDescriptor(state, scene).kind === 'unrevealed';
    // In map mode the tokens take over the stage -- characters give way, so a
    // scene NPC does not bleed over the battle map on the TV or the GM board.
    const inMapMode = !!(state.stage && state.stage.mapMode);
    const shown = !inMapMode && !onTitle && !!live.shown && !!src;
    const enter = (cfg && cfg.enter) || DEFAULT_ENTER;
    // Per-character display tuning: size multiplier, horizontal flip, and a
    // stage-relative x/y nudge (percent) -- useful for transparent cutouts
    // (e.g. NPCs) that need to grow, mirror, or lift up to the visible backdrop
    // bottom when a non-16:9 image letterboxes. All clamped to sane ranges.
    const rawScale = cfg && +cfg.scale;
    const scale = rawScale ? Math.min(4, Math.max(0.3, rawScale)) : 1;
    const flip = !!(cfg && cfg.flip);
    const clampN = (v, lo, hi) => { v = +v; return !isFinite(v) ? 0 : v < lo ? lo : v > hi ? hi : v; };
    const x = clampN(cfg && cfg.x, -20, 60);
    const y = clampN(cfg && cfg.y, -20, 40);
    // A re-entrance nonce: a keyframed cue bumps it to replay the entrance even
    // when the side is already on stage (rides the broadcast; undefined normally).
    const enterSeq = live.enterSeq;
    return { src, shown, enter, scale, flip, x, y, enterSeq };
  }

  // Apply a side's size / flip / position / enter-mode. They ride as CSS custom
  // properties so they compose with the entrance transforms (slide/fade) instead
  // of fighting them; x/y are stage-relative offsets (no drift). Held back during
  // a swap's exit so the outgoing cutout keeps its OWN placement until it leaves.
  function setPlacement(img, r) {
    img.style.setProperty('--char-scale', r.scale != null ? r.scale : 1);
    img.style.setProperty('--char-flip', r.flip ? -1 : 1);
    img.style.setProperty('--char-x', (r.x || 0) + '%');
    img.style.setProperty('--char-y', (r.y || 0) + '%');
    // A fade-in character sits in place (no slide); a slide character starts
    // off its own edge. Setting the class before is-shown fixes the baseline.
    img.classList.toggle('enter-fade', r.enter === 'fade');
  }

  function setSrc(side, src) {
    const img = chars[side];
    img.onerror = () => {
      // Missing cutout: never show a broken image; just stay offstage.
      img.classList.remove('is-shown');
      img.removeAttribute('src');
      applied[side] = { shown: false, src: null };
      cancelSwap(side);
    };
    img.src = src;
  }

  // Invalidate any pending exit-then-enter on a side (a newer render supersedes
  // it) and drop its fallback timer.
  function cancelSwap(side) {
    const s = swapState[side];
    s.token += 1;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  }

  // Run cb once the outgoing cutout has finished leaving -- on the exit
  // transition's end, or a timeout a hair past the slide duration if no
  // transition fires (reduced motion / display quirks). Stale tokens are ignored.
  function afterExit(side, cb) {
    const img = chars[side];
    const s = swapState[side];
    const token = s.token;
    let done = false;
    const finish = () => {
      if (done || token !== s.token) return;
      done = true;
      img.removeEventListener('transitionend', onEnd);
      if (s.timer) { clearTimeout(s.timer); s.timer = null; }
      cb();
    };
    const onEnd = (e) => {
      if (e.target === img && (e.propertyName === 'transform' || e.propertyName === 'opacity')) finish();
    };
    img.addEventListener('transitionend', onEnd);
    s.timer = setTimeout(finish, 640);   // a hair past --char-slide (520ms)
  }

  function applySide(side, r, instant) {
    const img = chars[side];
    const prev = applied[side];

    if (r.shown) {
      const srcChanged = r.src !== prev.src;
      const seqChanged = r.enterSeq != null && r.enterSeq !== prev.enterSeq;

      // A swap (exit-then-enter) is mid-flight on this side: a redundant
      // re-render (same target) must NOT touch is-shown or it aborts the exit;
      // a genuinely new target -- or an instant snap -- interrupts and replaces it.
      if (prev.swapping) {
        if (!instant && !srcChanged && !seqChanged) return;
        cancelSwap(side);
      }

      // Swap: the active character changed while the side was already lit, so the
      // outgoing cutout must LEAVE before the incoming one enters. Replay: a
      // keyframed cue re-fires the same character's entrance in place. (Both are
      // skipped on an instant snap, which just shows the final posture.)
      const swap = !instant && prev.shown && srcChanged;
      const replay = !instant && prev.shown && seqChanged && !srcChanged;

      // Everything except a swap places immediately; a swap holds the new
      // placement back until the outgoing cutout has left (applied in `enter`).
      if (!swap) setPlacement(img, r);

      if (instant) {
        if (srcChanged) setSrc(side, r.src);
        img.classList.add('is-shown');
      } else if (swap) {
        img.classList.remove('is-shown');         // exit the outgoing character
        const enter = () => {
          setPlacement(img, r);                   // incoming character's own placement
          setSrc(side, r.src);
          const t = img.style.transition;
          img.style.transition = 'none';
          img.classList.remove('is-shown');
          void img.offsetWidth;                   // settle at the offstage baseline
          img.style.transition = t;
          const go = () => requestAnimationFrame(() => {
            img.classList.add('is-shown');
            if (applied[side]) applied[side].swapping = false;
          });
          if (img.decode) img.decode().then(go).catch(go); else go();
        };
        afterExit(side, enter);
      } else if (replay) {
        const t = img.style.transition;
        img.style.transition = 'none';
        img.classList.remove('is-shown');
        void img.offsetWidth;
        img.style.transition = t;
        requestAnimationFrame(() => img.classList.add('is-shown'));
      } else if (!prev.shown) {
        // First reveal: SETTLE the entrance baseline with NO transition before
        // showing -- a fade char's in-place blur, a slide char's offstage edge --
        // then animate. setPlacement (above) toggles enter-fade, which CHANGES the
        // transform; with the transition live that change itself animates, so a
        // fade character slid in from the side wherever the cutout last rested (and
        // only behaved on the 2nd reveal, once it already rested in place). The
        // swap/replay branches already settle this way; the first reveal did not.
        if (srcChanged) setSrc(side, r.src);
        const go = () => {
          const t = img.style.transition;
          img.style.transition = 'none';
          img.classList.remove('is-shown');
          void img.offsetWidth;                   // commit the baseline, no animation
          img.style.transition = t;
          requestAnimationFrame(() => img.classList.add('is-shown'));
        };
        if (img.decode) img.decode().then(go).catch(go); else go();
      } else {
        img.classList.add('is-shown');            // already shown, same cutout
      }

      applied[side] = { shown: true, src: r.src, enterSeq: r.enterSeq, swapping: swap };
    } else {
      cancelSwap(side);
      img.classList.remove('is-shown');   // exit: CSS slides or fades it back out
      applied[side] = { shown: false, src: prev.src };
    }
  }

  function updateCurtain(state) {
    const visible = !(state.stage && state.stage.visible === false);
    curtain.classList.toggle('is-down', !visible);
  }

  // ---- Tokens: round hero/enemy markers pinned to the map image. The Player
  //      renders them read-only (the layer is pointer-events:none); the GM
  //      board adds .board-interactive to re-enable dragging. ----
  function activeMapImg() {
    const layer = layers[activeIndex];
    const el = layer ? layer.querySelector('.map-img') : null;   // <img> or <video>
    return (el && mediaW(el) > 0) ? el : null;
  }

  // Draw the map grid (PR 6A) as evenly spaced SVG lines over the displayed map
  // rect, in the SAME contain-space as the tokens, so it lands identically on the
  // GM board and the Player TV. Cells are square in displayed px (cellSize is a
  // fraction of the map WIDTH); the X/Y offsets are fractions of a CELL, so ±0.5
  // spans exactly one cell of alignment at any density. Hidden unless the current
  // map's grid exists + is enabled, a map is up, and tokens show (map mode). Lines
  // are clipped to the map rect so none spill onto the letterbox bars.
  // The live grid for the CURRENT map variant. Grids are keyed by map-variant key
  // (state.mapState), so the overlay follows the active map on both screens without
  // any re-seed plumbing -- state.mapState already rides the broadcast.
  function currentGrid() {
    const st = lastState && lastState.stage;
    const grids = st && st.grids;
    return (grids && lastState.mapState != null) ? grids[lastState.mapState] : null;
  }
  function layoutGrid() {
    if (!gridOverlay) return;
    const grid = currentGrid();
    const img = activeMapImg();
    if (!grid || !grid.enabled || !img || !tokensShown) { gridOverlay.style.display = 'none'; return; }
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) { gridOverlay.style.display = 'none'; return; }
    const cr = computeContainRect(r.width, r.height, mediaAspect(img));
    const cell = (Number(grid.cellSize) || 0.08) * cr.w;   // square cell edge, in px
    if (!(cell >= 3)) { gridOverlay.style.display = 'none'; return; }   // too fine to draw
    const phase = (v) => (((v * cell) % cell) + cell) % cell;   // offset is a fraction of a CELL
    const x0 = cr.left, y0 = cr.top, x1 = cr.left + cr.w, y1 = cr.top + cr.h;
    let d = '';
    for (let x = x0 + phase(Number(grid.offsetX) || 0); x <= x1 + 0.5; x += cell) d += 'M' + x.toFixed(1) + ' ' + y0.toFixed(1) + 'V' + y1.toFixed(1);
    for (let y = y0 + phase(Number(grid.offsetY) || 0); y <= y1 + 0.5; y += cell) d += 'M' + x0.toFixed(1) + ' ' + y.toFixed(1) + 'H' + x1.toFixed(1);
    gridOverlay.style.display = '';
    gridOverlay.setAttribute('width', r.width);
    gridOverlay.setAttribute('height', r.height);
    gridOverlay.setAttribute('viewBox', '0 0 ' + r.width + ' ' + r.height);
    gridOverlay.innerHTML = '<path d="' + d + '"></path>';
    gridOverlay.style.setProperty('--grid-color', grid.color || 'rgba(255,255,255,0.4)');
    gridOverlay.style.setProperty('--grid-width', (Number(grid.lineWidth) || 1).toFixed(2) + 'px');
    gridOverlay.style.opacity = (grid.opacity != null && isFinite(+grid.opacity)) ? String(grid.opacity) : '1';
  }

  // Snap a map fraction to the nearest grid CELL CENTER (PR 6A), matching the
  // lines layoutGrid draws. Reads the live broadcast grid; returns the input
  // unchanged when there's no enabled grid (or no map). The CALLER still decides
  // WHEN to snap (e.g. skip when the Alt key is held, for free placement).
  function snapFractionToCell(frac) {
    const grid = currentGrid();
    const img = activeMapImg();
    if (!grid || !grid.enabled || !frac || !img) return frac;
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return frac;
    const cr = computeContainRect(r.width, r.height, mediaAspect(img));
    const cell = (Number(grid.cellSize) || 0.08) * cr.w;
    if (!(cell > 0)) return frac;
    const phase = (v) => (((v * cell) % cell) + cell) % cell;   // offset is a fraction of a CELL
    const px = phase(Number(grid.offsetX) || 0), py = phase(Number(grid.offsetY) || 0);
    // Cell centers sit at phase + (k + 0.5)*cell in map-relative px.
    const nearest = (p, ph) => { const k = Math.round((p - ph - cell / 2) / cell); return ph + (k + 0.5) * cell; };
    return {
      x: clampUnit(nearest(frac.x * cr.w, px) / cr.w),
      y: clampUnit(nearest(frac.y * cr.h, py) / cr.h)
    };
  }

  // Chebyshev (5-5-5) grid distance between two map fractions, in cells + feet,
  // using the current variant's grid. Cells are square in px, so the row delta is
  // scaled by the map aspect. Returns null when there's no enabled grid / map (the
  // caller then skips the range check -- graceful degrade). PR 6B.
  function gridDistance(a, b) {
    const grid = currentGrid();
    const img = activeMapImg();
    if (!grid || !grid.enabled || !a || !b || !img) return null;
    const cs = Number(grid.cellSize) || (1 / 16);
    const aspect = mediaAspect(img);
    const dCol = (a.x - b.x) / cs;
    const dRow = (a.y - b.y) / (cs * aspect);
    const cells = Math.round(Math.max(Math.abs(dCol), Math.abs(dRow)));
    return { cells, feet: cells * (Number(grid.feetPerCell) || 5) };
  }

  // Token diameter in displayed px: ONE GRID CELL when a grid is enabled (so a token
  // occupies its square, like minis on a battle mat), else the classic fraction of the
  // map. Tiny-cell guard so an ultra-fine grid can't shrink tokens into unreadability.
  function tokenSizePx(cr) {
    const grid = currentGrid();
    if (grid && grid.enabled) {
      const cell = (Number(grid.cellSize) || 0) * cr.w;
      if (cell >= 12) return cell;
    }
    return TOKEN_FRAC * Math.min(cr.w, cr.h);
  }
  // Position and size every token element from its stored x/y fraction and the
  // current displayed-image rect. Cheap; called on render, on resize, and
  // after a map image loads. No active map image -> hide the whole layer.
  function layoutTokens() {
    layoutGrid();   // self-manages its own visibility; shares the resize/render triggers
    const img = activeMapImg();
    if (!img || !tokensShown) { tokenLayer.style.display = 'none'; targetFx.style.display = 'none'; if (aoeFx) aoeFx.style.display = 'none'; if (chipsLayer) chipsLayer.innerHTML = ''; return; }
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    tokenLayer.style.display = '';
    const cr = computeContainRect(r.width, r.height, mediaAspect(img));
    const size = tokenSizePx(cr);
    tokenLayer.querySelectorAll('.token').forEach((el) => {
      const x = parseFloat(el.dataset.x) || 0;
      const y = parseFloat(el.dataset.y) || 0;
      el.style.left = (cr.left + x * cr.w) + 'px';
      el.style.top = (cr.top + y * cr.h) + 'px';
      el.style.width = size + 'px';
      el.style.height = size + 'px';
      el.style.fontSize = size + 'px';   // children scale in em
    });
    updateTargetArrow(lastState);
    drawAoe();                           // instant AoE template, re-pinned on every layout/resize
  }
  // Draw the targeting arrow (attacker -> target) as an SVG line + arrowhead over
  // the board, in the SAME contain-space as the tokens, so it lands identically on
  // the GM board and the Player TV. Hidden when there's no link or no visible map.
  function updateTargetArrow(state) {
    if (!targetFx) return;
    const link = state && state.stage && state.stage.targetLink;
    const list = (state && state.stage && state.stage.tokens) || [];
    const from = link && list.find((t) => t.instId === link.from);
    const to = link && list.find((t) => t.instId === link.to);
    const img = activeMapImg();
    if (!link || !from || !to || !img || !tokensShown || from.visible === false || to.visible === false) { targetFx.style.display = 'none'; return; }
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) { targetFx.style.display = 'none'; return; }
    const cr = computeContainRect(r.width, r.height, mediaAspect(img));
    const size = tokenSizePx(cr);   // arrow endpoints hug the (possibly grid-sized) token edge
    const ax = cr.left + from.x * cr.w, ay = cr.top + from.y * cr.h;
    const bx = cr.left + to.x * cr.w, by = cr.top + to.y * cr.h;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, rad = size * 0.55;
    const sx = ax + ux * rad, sy = ay + uy * rad;   // start at the attacker's edge
    const ex = bx - ux * rad, ey = by - uy * rad;   // tip at the target's edge
    targetFx.style.display = '';
    targetFx.setAttribute('width', r.width); targetFx.setAttribute('height', r.height);
    targetFx.setAttribute('viewBox', '0 0 ' + r.width + ' ' + r.height);
    const line = targetFx.querySelector('.target-line');
    const head = targetFx.querySelector('.target-arrowhead');
    line.setAttribute('x1', sx); line.setAttribute('y1', sy); line.setAttribute('x2', ex); line.setAttribute('y2', ey);
    line.setAttribute('stroke-width', Math.max(3, size * 0.09));
    const ah = Math.max(9, size * 0.34), px = -uy, py = ux;
    const b1x = ex - ux * ah + px * ah * 0.55, b1y = ey - uy * ah + py * ah * 0.55;
    const b2x = ex - ux * ah - px * ah * 0.55, b2y = ey - uy * ah - py * ah * 0.55;
    head.setAttribute('points', ex + ',' + ey + ' ' + b1x + ',' + b1y + ' ' + b2x + ',' + b2y);
    // PR 6B: a grid distance label beside the arrow midpoint, and a range tint
    // (green in-range / amber disadvantage / red out) from the link's status. The
    // label is computed live here; the status is set by the GM (best across the
    // attacker's attacks). Both ride the broadcast, so the Player TV shows them too.
    const dist = gridDistance({ x: from.x, y: from.y }, { x: to.x, y: to.y });
    const distEl = targetFx.querySelector('.target-dist');
    if (distEl) {
      if (dist) {
        distEl.setAttribute('x', (sx + ex) / 2 + px * size * 0.55);
        distEl.setAttribute('y', (sy + ey) / 2 + py * size * 0.55);
        distEl.setAttribute('font-size', Math.max(11, size * 0.4).toFixed(1));
        distEl.textContent = dist.feet + ' ft';
        distEl.style.display = '';
      } else { distEl.style.display = 'none'; }
    }
    const st = link.status;
    targetFx.dataset.range = (st === 'in' || st === 'disadv' || st === 'out') ? st : '';
  }

  // ---- Instant AoE template (PR 6D): a cone / radius the GM aims on the board, drawn in the
  //      shared .aoe-fx layer so it lands identically on the GM board + Player TV. All geometry
  //      is in DISPLAYED PIXELS (cells are square there) off the same contain rect the tokens
  //      use. Size is FEET -> cells via the current grid (falls back to a 16-cell / 5-ft default
  //      when no grid, so it still draws). Half-angle 26.565° makes a 5e cone as wide as long. ----
  const AOE_HALF_ANGLE = 26.565;
  // Shared displayed-px geometry for templates + zones: the contain rect plus the
  // px-per-foot scale from the current grid (16-cell / 5-ft default when no grid).
  function stageGeom() {
    const img = activeMapImg();
    if (!img || !tokensShown) return null;
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const cr = computeContainRect(r.width, r.height, mediaAspect(img));
    const grid = currentGrid();
    const cellFrac = (grid && grid.enabled ? Number(grid.cellSize) : (1 / 16)) || (1 / 16);
    const feetPerCell = (grid && grid.enabled ? Number(grid.feetPerCell) : 5) || 5;
    return { r, cr, pxPerFoot: (cellFrac * cr.w) / feetPerCell };
  }
  // A shape (template OR zone) in px: origin + extent. Cone/circle extent = sizeFeet
  // (length/radius); square extent = HALF the sizeFeet side (a 20-ft square spans 20 ft).
  function shapeGeom(g, t) {
    return {
      ox: g.cr.left + t.originX * g.cr.w,
      oy: g.cr.top + t.originY * g.cr.h,
      extentPx: (t.shape === 'square' ? Number(t.sizeFeet) / 2 : Number(t.sizeFeet)) * g.pxPerFoot
    };
  }
  function shapeContainsPx(t, s, px, py) {
    const dx = px - s.ox, dy = py - s.oy;
    if (t.shape === 'square') return Math.abs(dx) <= s.extentPx && Math.abs(dy) <= s.extentPx;
    const dist = Math.hypot(dx, dy);
    if (dist > s.extentPx) return false;
    if (t.shape !== 'cone') return true;                       // circle: anything inside the radius
    if (dist < 1e-6) return true;                              // the cone's own origin cell
    const ang = Math.atan2(dy, dx) * 180 / Math.PI;
    const diff = Math.abs(((ang - t.angleDeg + 540) % 360) - 180);
    return diff <= AOE_HALF_ANGLE;
  }
  function shapePath(t, s) {
    const e = s.extentPx;
    if (t.shape === 'cone') {
      const dir = (t.angleDeg || 0) * Math.PI / 180, ha = AOE_HALF_ANGLE * Math.PI / 180;
      const a1 = dir - ha, a2 = dir + ha;
      const p1x = s.ox + Math.cos(a1) * e, p1y = s.oy + Math.sin(a1) * e;
      const p2x = s.ox + Math.cos(a2) * e, p2y = s.oy + Math.sin(a2) * e;
      return 'M' + s.ox.toFixed(1) + ' ' + s.oy.toFixed(1) + ' L' + p1x.toFixed(1) + ' ' + p1y.toFixed(1) +
             ' A' + e.toFixed(1) + ' ' + e.toFixed(1) + ' 0 0 1 ' + p2x.toFixed(1) + ' ' + p2y.toFixed(1) + ' Z';
    }
    if (t.shape === 'square') {
      return 'M' + (s.ox - e).toFixed(1) + ' ' + (s.oy - e).toFixed(1) +
             ' h' + (e * 2).toFixed(1) + ' v' + (e * 2).toFixed(1) + ' h' + (-e * 2).toFixed(1) + ' Z';
    }
    const R = e.toFixed(1);                                    // circle drawn as two half-arcs
    return 'M' + (s.ox - e).toFixed(1) + ' ' + s.oy.toFixed(1) +
           ' a' + R + ' ' + R + ' 0 1 0 ' + (e * 2).toFixed(1) + ' 0' +
           ' a' + R + ' ' + R + ' 0 1 0 ' + (-e * 2).toFixed(1) + ' 0 Z';
  }
  // Draw the instant template (dashed preview / solid once committed) AND every persistent
  // zone (PR 6E) into the one .aoe-fx layer, then chip + highlight bookkeeping.
  function drawAoe() {
    if (!aoeFx) return;
    const g = stageGeom();
    const t = lastState && lastState.stage && lastState.stage.aoeTemplate;
    const zones = (lastState && lastState.stage && lastState.stage.zones) || [];
    // Movement range (turn engine): a Chebyshev square around the active token. The GM
    // board draws it for ANY mover; the Player TV only for heroes (the table sees their
    // own options, not the monsters'). Half-side = feet + half a cell so the outline
    // lands on cell borders and covers every reachable cell.
    const list = (lastState && lastState.stage && lastState.stage.tokens) || [];
    const mrRaw = lastState && lastState.stage && lastState.stage.moveRange;
    const mover = mrRaw && list.find((tok) => tok.instId === mrRaw.instId);
    const mr = (mrRaw && mover && mover.visible !== false &&
                (stage.classList.contains('board-interactive') || mover.kind === 'hero')) ? mrRaw : null;
    if (!g || (!t && !zones.length && !mr)) {
      aoeFx.style.display = 'none';
      aoeFx.innerHTML = '';
      if (chipsLayer) chipsLayer.innerHTML = '';
      tokenLayer.querySelectorAll('.is-aoe-hit').forEach((el) => el.classList.remove('is-aoe-hit'));
      return;
    }
    aoeFx.style.display = '';
    aoeFx.setAttribute('width', g.r.width); aoeFx.setAttribute('height', g.r.height);
    aoeFx.setAttribute('viewBox', '0 0 ' + g.r.width + ' ' + g.r.height);
    let html = '';
    if (mr) {
      const grid = currentGrid();
      const fpc = (grid && grid.enabled ? Number(grid.feetPerCell) : 5) || 5;
      const sq = { shape: 'square', originX: mr.originX, originY: mr.originY, sizeFeet: mr.feet * 2 + fpc };
      html += '<path class="aoe-shape move-range" d="' + shapePath(sq, shapeGeom(g, sq)) + '"></path>';
    }
    for (const z of zones) html += '<path class="aoe-shape is-zone" style="--aoe-color:' + z.color + '" d="' + shapePath(z, shapeGeom(g, z)) + '"></path>';
    if (t) {
      stage.style.setProperty('--aoe-color', t.color || '#e5533a');   // caught tokens inherit the template colour
      html += '<path class="aoe-shape' + (t.committed ? '' : ' is-preview') + '" style="--aoe-color:' + (t.color || '#e5533a') + '" d="' + shapePath(t, shapeGeom(g, t)) + '"></path>';
    }
    aoeFx.innerHTML = html;
    const ts = t ? shapeGeom(g, t) : null;
    tokenLayer.querySelectorAll('.token').forEach((el) => {
      const px = g.cr.left + (parseFloat(el.dataset.x) || 0) * g.cr.w;
      const py = g.cr.top + (parseFloat(el.dataset.y) || 0) * g.cr.h;
      el.classList.toggle('is-aoe-hit', !!t && el.dataset.instId !== t.casterId && shapeContainsPx(t, ts, px, py));
    });
    drawZoneChips(g, zones);
  }
  // One chip per zone, pinned above its top edge: spell name + round counter + (GM board
  // only, via CSS) a −tick and a ✕clear button. gm.js handles the clicks by delegation.
  function drawZoneChips(g, zones) {
    if (!chipsLayer) return;
    const seen = new Set();
    for (const z of zones) {
      seen.add(z.id);
      let chip = chipsLayer.querySelector('.zone-chip[data-zone-id="' + z.id + '"]');
      if (!chip) {
        chip = document.createElement('div');
        chip.className = 'zone-chip'; chip.dataset.zoneId = z.id;
        const nm = document.createElement('span'); nm.className = 'zone-chip-name';
        const rd = document.createElement('span'); rd.className = 'zone-chip-rounds';
        const tick = document.createElement('button'); tick.type = 'button'; tick.className = 'zone-tick'; tick.textContent = '−'; tick.title = 'Tick a round off (0 ends the zone)';
        const clr = document.createElement('button'); clr.type = 'button'; clr.className = 'zone-clear'; clr.textContent = '✕'; clr.title = 'End the zone';
        chip.append(nm, rd, tick, clr);
        chipsLayer.appendChild(chip);
      }
      chip.querySelector('.zone-chip-name').textContent = z.name;
      chip.querySelector('.zone-chip-rounds').textContent = z.rounds > 0 ? String(z.rounds) : '';
      chip.style.setProperty('--zone-color', z.color);
      const s = shapeGeom(g, z);
      chip.style.left = s.ox + 'px';
      chip.style.top = (s.oy - s.extentPx) + 'px';
    }
    chipsLayer.querySelectorAll('.zone-chip').forEach((el) => { if (!seen.has(el.dataset.zoneId)) el.remove(); });
  }
  // Who's inside the current template (instIds) -- for gm.js resolve-all. Skips the caster
  // (no self-blast) and hidden tokens.
  function aoeHits() {
    const g = stageGeom();
    const t = lastState && lastState.stage && lastState.stage.aoeTemplate;
    if (!g || !t) return [];
    const s = shapeGeom(g, t);
    const list = (lastState && lastState.stage && lastState.stage.tokens) || [];
    return list.filter((tok) => tok.visible !== false && tok.instId !== t.casterId &&
      shapeContainsPx(t, s, g.cr.left + tok.x * g.cr.w, g.cr.top + tok.y * g.cr.h)).map((tok) => tok.instId);
  }
  // Who's inside a placed ZONE (entry saves) -- same rules as aoeHits.
  function zoneHits(zoneId) {
    const g = stageGeom();
    const zones = (lastState && lastState.stage && lastState.stage.zones) || [];
    const z = zones.find((x) => x.id === zoneId);
    if (!g || !z) return [];
    const s = shapeGeom(g, z);
    const list = (lastState && lastState.stage && lastState.stage.tokens) || [];
    return list.filter((tok) => tok.visible !== false && tok.instId !== z.casterId &&
      shapeContainsPx(z, s, g.cr.left + tok.x * g.cr.w, g.cr.top + tok.y * g.cr.h)).map((tok) => tok.instId);
  }
  // Zones containing a map fraction -- the Spike-Growth on-move check (drag start/end).
  function zonesAtFraction(frac) {
    const g = stageGeom();
    if (!g || !frac) return [];
    const zones = (lastState && lastState.stage && lastState.stage.zones) || [];
    const px = g.cr.left + frac.x * g.cr.w, py = g.cr.top + frac.y * g.cr.h;
    return zones.filter((z) => shapeContainsPx(z, shapeGeom(g, z), px, py));
  }
  // Pointer angle (deg) from a map-fraction origin to a client point, in DISPLAYED px space so
  // the cone aims where the GM's cursor visually is, undistorted by the map's aspect ratio.
  function aoePointerAngle(origin, clientX, clientY) {
    const img = activeMapImg(); if (!img) return 0;
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return 0;
    const cr = computeContainRect(r.width, r.height, mediaAspect(img));
    const ox = cr.left + origin.x * cr.w, oy = cr.top + origin.y * cr.h;
    return Math.atan2((clientY - r.top) - oy, (clientX - r.left) - ox) * 180 / Math.PI;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // HP fill colour by ratio: green stays through healthy (>=60%), fades to orange
  // when hurt (~30%), then to red when critical (0%).
  function hpColor(ratio) {
    const r = Math.max(0, Math.min(1, ratio));
    const green = [91, 189, 106], orange = [235, 160, 40], red = [224, 82, 79];
    const mix = (a, b, t) => 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(', ') + ')';
    if (r >= 0.6) return mix(orange, green, 1);                 // healthy: green
    if (r >= 0.3) return mix(orange, green, (r - 0.3) / 0.3);   // 60% green -> 30% orange
    return mix(red, orange, r / 0.3);                           // 30% orange -> 0% red
  }
  // Condition overlay: an SVG whose textPath curves the condition word(s) around
  // the top arc of the token ring. One unique arc id per token instance.
  function buildCondOverlay(instId) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'token-cond');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.style.display = 'none';
    const defs = document.createElementNS(SVG_NS, 'defs');
    const arc = document.createElementNS(SVG_NS, 'path');
    const id = 'tcarc-' + instId;
    arc.setAttribute('id', id);
    arc.setAttribute('d', 'M -10,40 A 60,60 0 0 1 110,40');   // top arc well ABOVE the ring/glow, left -> right (upright)
    arc.setAttribute('fill', 'none');
    defs.append(arc);
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'token-cond-text');
    const tp = document.createElementNS(SVG_NS, 'textPath');
    tp.setAttribute('startOffset', '50%');
    tp.setAttribute('text-anchor', 'middle');
    tp.setAttribute('href', '#' + id);
    tp.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#' + id);
    text.append(tp);
    svg.append(defs, text);
    return svg;
  }

  // Apply the per-character token-builder tweaks (face crop, ring color, and the
  // on-map display settings) to a token element. Called on build AND on every
  // update, so a change saved in the token builder shows on the next render
  // without recreating the token -- on the GM board and the Player TV alike.
  function applyTokenStyling(el, inst) {
    const cast = CAST_BY_ID(inst.castId) ||
      { ringColor: inst.kind === 'enemy' ? '#8a2e2e' : inst.kind === 'npc' ? '#6f9bd1' : '#2f6b43' };
    el.style.borderColor = cast.ringColor || '#888';
    const fb = el.querySelector('.token-fallback');
    if (fb) fb.style.background = cast.ringColor || '#555';
    const img = el.querySelector('.token-portrait');
    if (img) {
      // The face crop centers the round token on the character's face (same
      // object-position the stat card uses); default to centered.
      img.style.objectPosition = cast.face || '50% 50%';
      // Zoom the token art (token-builder faceZoom, 1..3), pivoting on the face so it
      // stays put as it magnifies. The .token-crop wrapper clips the overflow to the ring.
      const z = (cast.faceZoom != null && isFinite(+cast.faceZoom)) ? +cast.faceZoom : 1;
      img.style.transformOrigin = cast.face || '50% 50%';
      img.style.transform = z !== 1 ? 'scale(' + z + ')' : '';
      // Token art can be assigned/changed by the builder (e.g. an NPC borrowing
      // its portrait); swap the src only when it actually differs.
      if (cast.tokenImage && img.getAttribute('src') !== cast.tokenImage) img.src = cast.tokenImage;
    }
    // On-map display settings are GLOBAL (one set for every token): name/condition
    // size, condition side + word-wrap depth, HP-bar height.
    const d = globalDisplay();
    el.style.setProperty('--token-name-scale', d.nameSize || 1);
    el.style.setProperty('--token-name-spacing', ((Number(d.nameSpacing) || 0) / 100 * 0.4).toFixed(3) + 'em');
    el.style.setProperty('--token-cond-scale', d.condSize || 1);
    el.style.setProperty('--token-cond-spacing', ((d.condSpacing == null ? 8 : Number(d.condSpacing)) / 100 * 10).toFixed(2) + 'px');   // SVG user units (needs a unit)
    el.style.setProperty('--token-cond-color', d.condColor || '#ffffff');
    el.style.setProperty('--token-cond-outline', d.condOutline || 'rgba(0,0,0,0.85)');
    const condPosY = d.condPosY == null ? 100 : Number(d.condPosY);
    el.classList.toggle('cond-below', condPosY < 50);   // low condition -> name flips above it
    // HP-bar vertical position: hpPos 0 (bottom) .. 100 (top) -> a top offset in %.
    el.style.setProperty('--token-hp-y', (84 - (Number(d.hpPos) || 0) * 0.82).toFixed(1) + '%');
    const cond = el.querySelector('.token-cond');
    if (cond) {
      const arc = cond.querySelector('path');
      if (arc) arc.setAttribute('d', condArcPath(d.condCurve, condPosY));
    }
  }

  function buildTokenEl(inst) {
    const cast = CAST_BY_ID(inst.castId) || { name: inst.label };
    const el = document.createElement('div');
    el.className = 'token token-' + inst.kind;
    el.dataset.instId = inst.instId;

    const fallback = document.createElement('div');
    fallback.className = 'token-fallback';
    fallback.textContent = initials(inst.label);

    // The portrait sits over the initials; if the art is not vendored yet it
    // errors and the initials stay. A broken-image icon never shows.
    const img = document.createElement('img');
    img.className = 'token-portrait';
    img.alt = '';
    img.style.display = 'none';
    img.onload = () => { img.style.display = ''; fallback.style.display = 'none'; };
    img.onerror = () => { img.style.display = 'none'; fallback.style.display = ''; };

    const label = document.createElement('div');
    label.className = 'token-label';
    label.textContent = inst.label;

    // GM-toggled on-map overlays: an HP bar (heroes/NPCs only) and condition
    // badges. Kept hidden here; populated + shown per state in updateTokens.
    const hpbar = document.createElement('div'); hpbar.className = 'token-hpbar'; hpbar.style.display = 'none';
    hpbar.append(document.createElement('i'));
    const cond = buildCondOverlay(inst.instId);

    // The portrait + initials live in a round clip so a zoomed image (faceZoom) stays
    // inside the ring; the condition arc stays a direct child of the token (which is
    // overflow:visible) so its text can ride above the ring.
    const crop = document.createElement('div'); crop.className = 'token-crop';
    crop.append(fallback, img);
    el.append(crop, label, hpbar, cond);
    applyTokenStyling(el, inst);   // ring, face crop, name/cond scale, hp/cond position
    if (cast.tokenImage && img.complete && img.naturalWidth > 0) { img.style.display = ''; fallback.style.display = 'none'; }
    return el;
  }

  // On-map combat overlays, driven by state.stage.hpOnMap / conditionsOnMap. Runs
  // on the GM board AND the Player TV (shared compositor). Enemy HP is never shown.
  function updateTokenOverlays(el, inst, state) {
    // Damage flash: when a token's current HP drops, blink it (on both screens; the
    // HP-bar width also animates via its CSS transition). Kind-agnostic so enemies
    // flash when hit too, without revealing their HP. First sighting never blinks.
    const curHp = (inst.hp && inst.hp.current != null) ? inst.hp.current : null;
    if (el._hpPrev != null && curHp != null && curHp < el._hpPrev) {
      el.classList.remove('is-hit'); void el.offsetWidth;   // restart the animation if mid-flash
      el.classList.add('is-hit');
      clearTimeout(el._hitTimer);
      el._hitTimer = setTimeout(() => el.classList.remove('is-hit'), 650);
    }
    el._hpPrev = curHp;

    const hpOn = !!(state.stage && state.stage.hpOnMap);
    const condOn = !!(state.stage && state.stage.conditionsOnMap);
    const hpbar = el.querySelector('.token-hpbar');
    if (hpbar) {
      const hp = inst.hp || {};
      const canHp = inst.kind === 'hero' || inst.kind === 'npc';   // enemy HP stays hidden
      const showHp = hpOn && canHp && hp.max != null;
      hpbar.style.display = showHp ? '' : 'none';
      if (showHp) {
        const cur = hp.current != null ? hp.current : hp.max;
        const ratio = hp.max ? cur / hp.max : 0;
        const fill = hpbar.firstChild;
        fill.style.width = Math.max(0, Math.min(100, Math.round(ratio * 100))) + '%';
        fill.style.background = hpColor(ratio);
      }
    }
    const cond = el.querySelector('.token-cond');
    if (cond) {
      const list = (condOn && Array.isArray(inst.conditions)) ? inst.conditions.slice(0, 3) : [];
      cond.style.display = list.length ? '' : 'none';
      const tp = cond.querySelector('textPath');
      if (tp) {
        const txt = list.join(' · ');
        if (tp.textContent !== txt) tp.textContent = txt;
        // Fit long conditions to the arc so SVG doesn't drop the end characters: a word
        // whose advance exceeds the arc PATH length rides off it and loses the ends
        // ("unconscious" -> "nconsciou"), worse the larger the text. Scale the font by
        // CHARACTER COUNT (deterministic -- getComputedTextLength is unreliable mid-render)
        // so anything past what the arc comfortably holds (~MAX_CHARS) shrinks to fit.
        // Drives --token-cond-fit in CSS.
        const MAX_CHARS = 8;
        el.style.setProperty('--token-cond-fit', (txt.length > MAX_CHARS ? MAX_CHARS / txt.length : 1).toFixed(3));
      }
    }
  }

  function updateTokenEl(el, inst) {
    const lab = el.querySelector('.token-label');
    if (lab && lab.textContent !== inst.label) {
      lab.textContent = inst.label;
      const fb = el.querySelector('.token-fallback');
      if (fb) fb.textContent = initials(inst.label);
    }
    applyTokenStyling(el, inst);   // pick up token-builder tweaks saved this session
  }

  // Diff the live token list against what is on stage: create new, drop gone,
  // update the label/position/hidden of survivors. Mirrors the character diff.
  function updateTokens(state, scene) {
    lastState = state;
    const list = (state.stage && Array.isArray(state.stage.tokens)) ? state.stage.tokens : [];
    const haveMap = bgDescriptor(state, scene).kind === 'image';

    const existing = new Map();
    tokenLayer.querySelectorAll('.token').forEach((el) => existing.set(el.dataset.instId, el));

    // The token whose turn it is (initiative) wears a golden ring -- on the GM
    // board AND the Player TV, since activeTokenId rides the broadcast.
    const activeId = state.stage && state.stage.activeTokenId;
    const link = state.stage && state.stage.targetLink;
    const seen = new Set();
    for (const inst of list) {
      seen.add(inst.instId);
      let el = existing.get(inst.instId);
      if (!el) { el = buildTokenEl(inst); tokenLayer.appendChild(el); }
      else { updateTokenEl(el, inst); }
      el.dataset.x = inst.x;
      el.dataset.y = inst.y;
      el.classList.toggle('is-hidden', inst.visible === false);
      el.classList.toggle('is-active', !!activeId && inst.instId === activeId);
      // 0 HP (both screens, derived -- no extra state): a hero/NPC is DOWN (death saves),
      // an enemy is DEFEATED (translucent + red X).
      const downHp = !!(inst.hp && inst.hp.max != null && inst.hp.current === 0);
      el.classList.toggle('is-down', downHp && inst.kind !== 'enemy');
      el.classList.toggle('is-defeated', downHp && inst.kind === 'enemy');
      el.classList.toggle('is-targeted', !!(link && inst.instId === link.to));
      updateTokenOverlays(el, inst, state);
    }
    existing.forEach((el, id) => { if (!seen.has(id)) el.remove(); });

    // Tokens are a map-mode concern. The interactive GM board always shows them
    // (placement happens there); every mirror -- the Player TV and the GM
    // preview -- shows them only while the GM is in map mode, so leaving map
    // mode clears the table on the TV.
    const inMapMode = !!(state.stage && state.stage.mapMode);
    tokensShown = stage.classList.contains('board-interactive') || inMapMode;
    // Leaving map mode (or showing a non-map scene) must clear the grid too, not just the
    // tokens -- otherwise a grid drawn in map mode lingers over the next scene. layoutTokens
    // (which calls layoutGrid) is skipped on this early return, so hide the overlay here.
    if (!haveMap || !tokensShown) { tokenLayer.style.display = 'none'; targetFx.style.display = 'none'; gridOverlay.style.display = 'none'; if (aoeFx) aoeFx.style.display = 'none'; if (chipsLayer) chipsLayer.innerHTML = ''; return; }
    layoutTokens();
  }

  // Client point -> clamped map fraction, using the SAME contain math as
  // placement so a GM drag lands on the same map pixel on the Player TV.
  function pointToFraction(clientX, clientY) {
    const img = activeMapImg();
    if (!img) return null;
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const cr = computeContainRect(r.width, r.height, mediaAspect(img));
    return {
      x: clampUnit((clientX - r.left - cr.left) / cr.w),
      y: clampUnit((clientY - r.top - cr.top) / cr.h)
    };
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => layoutTokens()).observe(stage);
  }

  // Per-cue keyframe ramps: a sequenced cue sets state.stage.fx = { curtain,
  // crossfade, char } (ms) so each beat's transition runs at the cue's authored
  // speed. We push them as inline CSS custom properties on the stage (the same
  // vars app.css defines), and clear them when absent so normal play uses the
  // defaults. The char ramp drives both the fade and the slide.
  function applyFx(state) {
    const fx = (state && state.stage && state.stage.fx) || null;
    const setVar = (prop, key) => {
      const v = fx && fx[key];
      if (v != null && isFinite(+v)) stage.style.setProperty(prop, Math.max(0, +v) + 'ms');
      else stage.style.removeProperty(prop);
    };
    setVar('--curtain-fade', 'curtain');
    setVar('--crossfade', 'crossfade');
    setVar('--char-fade', 'char');
    setVar('--char-slide', 'char');
  }

  function render(state, scene, opts = {}) {
    const instant = !!opts.instant;
    applyFx(state);

    // The background runs its own fade when its image loads; it is not part of
    // the instant wrap. Characters and the curtain are.
    updateBackground(state, scene);

    const apply = () => {
      applySide('left', resolveSide('left', state, scene), instant);
      applySide('right', resolveSide('right', state, scene), instant);
      updateCurtain(state);
      updateTokens(state, scene);
    };

    if (instant) {
      stage.classList.add('no-anim');
      apply();
      void stage.offsetWidth;   // commit the no-transition state before re-enabling
      stage.classList.remove('no-anim');
    } else {
      apply();
    }
  }

  return { render, el: stage, tokenLayer, layoutTokens, pointToFraction, snapFractionToCell, gridDistance, aoeHits, aoePointerAngle, zoneHits, zonesAtFraction };
}

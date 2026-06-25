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

// Resolve a token's castId to its cast entry (ring color, portrait, name).
// ids are unique across heroes and enemies, so a flat map is enough; the
// token's `kind` only drives styling and numbering, not lookup.
const CAST_BY_ID = (() => {
  const m = {};
  for (const h of (CAST.heroes || [])) m[h.id] = h;
  for (const e of (CAST.enemies || [])) m[e.id] = e;
  return m;
})();

// A token's diameter as a fraction of the shorter side of the displayed map.
const TOKEN_FRAC = 0.07;

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
      <div class="token-layer"></div>
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

  let activeIndex = 0;       // which background layer is currently visible
  let currentBgKey = null;   // what background is on screen, to skip redundant work
  let tokensShown = false;   // last token-visibility decision, so a ResizeObserver
                             // re-layout keeps tokens hidden when not in map mode
  const applied = {          // last applied posture, for diffing
    left: { shown: false, src: null },
    right: { shown: false, src: null }
  };

  // ---- Background: the Phase 1 descriptor + two-layer cross-fade, now over
  //      any number of named variants (scene.maps[state.mapState]). ----
  function bgDescriptor(state, scene) {
    if (!scene) return { kind: 'idle' };
    const maps = scene.maps || null;
    const path = maps ? maps[state.mapState] : null;
    if (path) return { kind: 'image', src: path, label: scene.name };
    return { kind: 'unrevealed', label: scene.name };
  }

  function bgKey(d) {
    return d.kind === 'image' ? 'image:' + d.src : d.kind + ':' + (d.label || '');
  }

  function buildUnrevealed(label) {
    const panel = document.createElement('div');
    panel.className = 'unrevealed';
    const mark = document.createElement('div');
    mark.className = 'unrevealed-mark';
    mark.textContent = 'Aldermere';
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
      layers[activeIndex].style.opacity = '0';
      activeIndex = 1 - activeIndex;
    };

    if (d.kind === 'unrevealed') {
      incoming.innerHTML = '';
      incoming.appendChild(buildUnrevealed(d.label));
      reveal();
      return;
    }

    const img = document.createElement('img');
    img.className = 'map-img';
    img.alt = '';
    let settled = false;
    // Re-pin tokens once the map's intrinsic size is known (naturalWidth was
    // 0 while loading, so the first render could not lay them out yet).
    const settle = () => { if (!settled) { settled = true; reveal(); layoutTokens(); } };
    img.onload = settle;
    img.onerror = () => {
      // A variant file not present yet: fall back to the neutral plate.
      incoming.innerHTML = '';
      incoming.appendChild(buildUnrevealed(d.label));
      settle();
    };
    incoming.innerHTML = '';
    incoming.appendChild(img);
    img.src = d.src;
    if (img.complete && img.naturalWidth > 0) settle();
  }

  // ---- Characters: resolve the live src/visibility/transition per side, then
  //      diff against what is on stage and play only what changed. ----
  function resolveSide(side, state, scene) {
    const cfg = scene && scene.characters ? scene.characters[side] : null;
    const live = (state.stage && state.stage[side]) || { shown: false, srcOverride: null };
    const src = live.srcOverride || (cfg && cfg.src) || null;
    // Characters never composite over a title screen (an empty-src variant) --
    // the Aldermere plate is meant to stand alone, so a character armed/shown
    // from a prior backdrop does not bleed onto it. They enter once the GM
    // reveals a real map/background.
    const onTitle = bgDescriptor(state, scene).kind === 'unrevealed';
    const shown = !onTitle && !!live.shown && !!src;
    const enter = (cfg && cfg.enter) || DEFAULT_ENTER;
    return { src, shown, enter };
  }

  function applySide(side, r, instant) {
    const img = chars[side];
    const prev = applied[side];

    // A fade-in character sits in place (no slide); a slide character starts
    // off its own edge. Setting the class before is-shown fixes the baseline.
    img.classList.toggle('enter-fade', r.enter === 'fade');

    if (r.shown) {
      const srcChanged = r.src !== prev.src;
      if (srcChanged) {
        img.onerror = () => {
          // Missing cutout: never show a broken image; just stay offstage.
          img.classList.remove('is-shown');
          img.removeAttribute('src');
          applied[side] = { shown: false, src: null };
        };
        img.src = r.src;
      }
      if (instant) {
        img.classList.add('is-shown');
      } else if (!prev.shown || srcChanged) {
        // Animate the entrance from the offstage baseline once decoded.
        const go = () => requestAnimationFrame(() => img.classList.add('is-shown'));
        if (img.decode) img.decode().then(go).catch(go); else go();
      }
      applied[side] = { shown: true, src: r.src };
    } else {
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
    const img = layer ? layer.querySelector('.map-img') : null;
    return (img && img.naturalWidth > 0) ? img : null;
  }

  // Position and size every token element from its stored x/y fraction and the
  // current displayed-image rect. Cheap; called on render, on resize, and
  // after a map image loads. No active map image -> hide the whole layer.
  function layoutTokens() {
    const img = activeMapImg();
    if (!img || !tokensShown) { tokenLayer.style.display = 'none'; return; }
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    tokenLayer.style.display = '';
    const cr = computeContainRect(r.width, r.height, img.naturalWidth / img.naturalHeight);
    const size = TOKEN_FRAC * Math.min(cr.w, cr.h);
    tokenLayer.querySelectorAll('.token').forEach((el) => {
      const x = parseFloat(el.dataset.x) || 0;
      const y = parseFloat(el.dataset.y) || 0;
      el.style.left = (cr.left + x * cr.w) + 'px';
      el.style.top = (cr.top + y * cr.h) + 'px';
      el.style.width = size + 'px';
      el.style.height = size + 'px';
      el.style.fontSize = size + 'px';   // children scale in em
    });
  }

  function buildTokenEl(inst) {
    const cast = CAST_BY_ID[inst.castId] ||
      { name: inst.label, ringColor: inst.kind === 'enemy' ? '#8a2e2e' : '#2f6b43' };
    const el = document.createElement('div');
    el.className = 'token token-' + inst.kind;
    el.dataset.instId = inst.instId;
    el.style.borderColor = cast.ringColor || '#888';

    const fallback = document.createElement('div');
    fallback.className = 'token-fallback';
    fallback.style.background = cast.ringColor || '#555';
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

    el.append(fallback, img, label);
    if (cast.tokenImage) {
      img.src = cast.tokenImage;
      if (img.complete && img.naturalWidth > 0) { img.style.display = ''; fallback.style.display = 'none'; }
    }
    return el;
  }

  function updateTokenEl(el, inst) {
    const lab = el.querySelector('.token-label');
    if (lab && lab.textContent !== inst.label) {
      lab.textContent = inst.label;
      const fb = el.querySelector('.token-fallback');
      if (fb) fb.textContent = initials(inst.label);
    }
  }

  // Diff the live token list against what is on stage: create new, drop gone,
  // update the label/position/hidden of survivors. Mirrors the character diff.
  function updateTokens(state, scene) {
    const list = (state.stage && Array.isArray(state.stage.tokens)) ? state.stage.tokens : [];
    const haveMap = bgDescriptor(state, scene).kind === 'image';

    const existing = new Map();
    tokenLayer.querySelectorAll('.token').forEach((el) => existing.set(el.dataset.instId, el));

    const seen = new Set();
    for (const inst of list) {
      seen.add(inst.instId);
      let el = existing.get(inst.instId);
      if (!el) { el = buildTokenEl(inst); tokenLayer.appendChild(el); }
      else { updateTokenEl(el, inst); }
      el.dataset.x = inst.x;
      el.dataset.y = inst.y;
      el.classList.toggle('is-hidden', inst.visible === false);
    }
    existing.forEach((el, id) => { if (!seen.has(id)) el.remove(); });

    // Tokens are a map-mode concern. The interactive GM board always shows them
    // (placement happens there); every mirror -- the Player TV and the GM
    // preview -- shows them only while the GM is in map mode, so leaving map
    // mode clears the table on the TV.
    const inMapMode = !!(state.stage && state.stage.mapMode);
    tokensShown = stage.classList.contains('board-interactive') || inMapMode;
    if (!haveMap || !tokensShown) { tokenLayer.style.display = 'none'; return; }
    layoutTokens();
  }

  // Client point -> clamped map fraction, using the SAME contain math as
  // placement so a GM drag lands on the same map pixel on the Player TV.
  function pointToFraction(clientX, clientY) {
    const img = activeMapImg();
    if (!img) return null;
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const cr = computeContainRect(r.width, r.height, img.naturalWidth / img.naturalHeight);
    return {
      x: clampUnit((clientX - r.left - cr.left) / cr.w),
      y: clampUnit((clientY - r.top - cr.top) / cr.h)
    };
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => layoutTokens()).observe(stage);
  }

  function render(state, scene, opts = {}) {
    const instant = !!opts.instant;

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

  return { render, el: stage, tokenLayer, layoutTokens, pointToFraction };
}

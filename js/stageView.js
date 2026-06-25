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

export function createStageView(root) {
  root.innerHTML = `
    <div class="stage">
      <div class="map-layer" data-layer="0"></div>
      <div class="map-layer" data-layer="1"></div>
      <img class="char-layer char-left" alt="" data-side="left">
      <img class="char-layer char-right" alt="" data-side="right">
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

  let activeIndex = 0;       // which background layer is currently visible
  let currentBgKey = null;   // what background is on screen, to skip redundant work
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
    const settle = () => { if (!settled) { settled = true; reveal(); } };
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
    const shown = !!live.shown && !!src;
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

  function render(state, scene, opts = {}) {
    const instant = !!opts.instant;

    // The background runs its own fade when its image loads; it is not part of
    // the instant wrap. Characters and the curtain are.
    updateBackground(state, scene);

    const apply = () => {
      applySide('left', resolveSide('left', state, scene), instant);
      applySide('right', resolveSide('right', state, scene), instant);
      updateCurtain(state);
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

  return { render, el: stage };
}

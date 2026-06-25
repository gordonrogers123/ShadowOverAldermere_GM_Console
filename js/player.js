// ============================================================
//  player.js  --  the TV output (pure renderer)
// ------------------------------------------------------------
//  No controls, no GM notes, nothing that spoils. It only shows
//  the map for the current scene and state. It reacts to messages
//  from the GM window and, on load, restores the last known state
//  from localStorage so a refresh recovers the session even before
//  the GM window has said anything.
//
//  The map cross-fades on every change (scene switch or the
//  hidden/revealed toggle) using two stacked layers.
// ============================================================

import { SCENES } from '../data/scenes.js';
import { loadState } from './state.js';
import { createSync } from './sync.js';

const CURSOR_HIDE_MS = 3000;

export function mountPlayer(root) {
  root.innerHTML = `
    <div class="stage">
      <div class="map-layer" data-layer="0"></div>
      <div class="map-layer" data-layer="1"></div>
      <div class="idle">
        <div class="idle-title">The Shadow Over Aldermere</div>
      </div>
    </div>
  `;

  const layers = Array.from(root.querySelectorAll('.map-layer'));
  const idle = root.querySelector('.idle');
  let activeIndex = 0;      // which layer is currently visible
  let currentKey = null;    // what we last rendered, to skip redundant work

  function sceneById(id) {
    return SCENES.find((s) => s.id === id) || null;
  }

  // Turn the state into "what should the screen show".
  function descriptorFor(state) {
    const scene = sceneById(state.sceneId);
    if (!scene) return { kind: 'idle' };
    const path = scene.maps ? scene.maps[state.mapState] : null;
    if (path) return { kind: 'image', src: path, label: scene.name };
    return { kind: 'unrevealed', label: scene.name };
  }

  function keyOf(d) {
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

  function render(state) {
    const d = descriptorFor(state);
    const key = keyOf(d);
    if (key === currentKey) return;
    currentKey = key;

    if (d.kind === 'idle') {
      idle.classList.add('show');
      layers.forEach((l) => { l.style.opacity = '0'; });
      return;
    }
    idle.classList.remove('show');

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
    } else {
      const img = document.createElement('img');
      img.className = 'map-img';
      img.alt = '';
      let settled = false;
      const settle = () => { if (!settled) { settled = true; reveal(); } };
      img.onload = settle;
      img.onerror = () => {
        // The file is not present yet (for example a hidden variant you
        // have not added). Fall back to the neutral plate, no broken image.
        incoming.innerHTML = '';
        incoming.appendChild(buildUnrevealed(d.label));
        settle();
      };
      incoming.innerHTML = '';
      incoming.appendChild(img);
      img.src = d.src;
      // Cached images may already be ready before the load event attaches.
      if (img.complete && img.naturalWidth > 0) settle();
    }

    preloadAround(state);
  }

  // Preload the other variant and the next scene's map, so switches do
  // not flicker.
  function preloadAround(state) {
    const scene = sceneById(state.sceneId);
    if (!scene || !scene.maps) return;
    const other = state.mapState === 'hidden' ? scene.maps.revealed : scene.maps.hidden;
    if (other) { const a = new Image(); a.src = other; }
    const next = SCENES[SCENES.indexOf(scene) + 1];
    if (next && next.maps && next.maps.revealed) { const b = new Image(); b.src = next.maps.revealed; }
  }

  // 1) Restore immediately from the last saved state (offline friendly).
  render(loadState());

  // 2) React to live updates from the GM window.
  const sync = createSync((msg) => {
    if (msg && msg.type === 'state' && msg.state) render(msg.state);
  });

  // 3) Ask an already-open GM window for the current state.
  sync.post({ type: 'hello' });

  // Hide the cursor after a short idle; bring it back on movement.
  let cursorTimer = null;
  function pokeCursor() {
    document.body.classList.remove('cursor-hidden');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => document.body.classList.add('cursor-hidden'), CURSOR_HIDE_MS);
  }
  window.addEventListener('mousemove', pokeCursor, { passive: true });
  pokeCursor();
}

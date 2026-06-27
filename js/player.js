// ============================================================
//  player.js  --  the TV output (pure renderer)
// ------------------------------------------------------------
//  No controls, no GM notes, nothing that spoils. It mounts the
//  shared stage compositor (stageView.js) and feeds it state. It
//  reacts to messages from the GM window and, on load, restores the
//  last known state from localStorage so a refresh recovers the
//  session even before the GM window has said anything.
//
//  The first paint after a load is applied with no animation, so a
//  restored scene appears already in place instead of sliding in.
// ============================================================

import { sceneById } from './scenesAll.js';
import { loadState } from './state.js';
import { createSync } from './sync.js';
import { createStageView } from './stageView.js';
import { createAudioEngine } from './audioEngine.js';

const CURSOR_HIDE_MS = 3000;

export function mountPlayer(root) {
  const view = createStageView(root);
  let firstPaint = true;

  // Audio: the Player is on the TV, so it is the room's output by default. The
  // engine follows state; a one-time click anywhere unlocks it (browsers block
  // audio until a user gesture). A small hint says so, then dismisses itself.
  const engine = createAudioEngine({ role: 'player', gestureTarget: document.body });
  window.__audio = engine;   // debug / test hook
  const gate = document.createElement('div');
  gate.className = 'sound-gate';
  gate.textContent = '\u{1F50A} Click to enable sound';
  document.body.appendChild(gate);
  const dismissGate = () => { engine.unlock(); gate.classList.add('gone'); window.removeEventListener('click', dismissGate); };
  window.addEventListener('click', dismissGate);

  function paint(state) {
    const scene = sceneById(state.sceneId);
    view.render(state, scene, { instant: firstPaint });
    firstPaint = false;
    preloadAround(state, scene);
    engine.sync(state, scene);
  }

  // Preload the other background variants and both character cutouts so a
  // variant switch or a character entrance does not flash.
  function preloadAround(state, scene) {
    if (!scene) return;
    if (scene.maps) {
      for (const key of Object.keys(scene.maps)) {
        if (key !== state.mapState && scene.maps[key]) {
          const img = new Image();
          img.src = scene.maps[key];
        }
      }
    }
    if (scene.characters) {
      for (const side of ['left', 'right']) {
        // A side is a roster (single object or array); preload every cutout that
        // a cue could bring on so a swap never flashes.
        const cfg = scene.characters[side];
        const roster = Array.isArray(cfg) ? cfg : (cfg ? [cfg] : []);
        for (const c of roster) { if (c && c.src) { const img = new Image(); img.src = c.src; } }
      }
    }
  }

  // 1) Restore immediately from the last saved state (offline friendly).
  paint(loadState());

  // 2) React to live updates from the GM window.
  const sync = createSync((msg) => {
    if (msg && msg.type === 'state' && msg.state) paint(msg.state);
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

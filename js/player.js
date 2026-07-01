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
import { dieSvg } from './diceRoller.js';
import { applyLiveOverride } from './tokenOverrides.js';

const CURSOR_HIDE_MS = 3000;
const ROOM_DICE_MS = 7000;   // how long a pushed roll lingers on the TV

export function mountPlayer(root) {
  const view = createStageView(root);
  let firstPaint = true;

  // "Show the dice to the room": when the GM arms "To room", each roll arrives as
  // state.stage.roomDice = { flat:[{d,r}], total, notation, n }. We draw the same
  // die shapes the GM tray uses, with the rolled number on each and a big total,
  // then auto-dismiss. n is a bump counter so a repeat roll re-triggers the show.
  const roomDice = document.createElement('div');
  roomDice.className = 'room-dice';
  roomDice.hidden = true;
  document.body.appendChild(roomDice);
  let roomDiceN = -1;
  let roomDiceTimer = null;
  function renderRoomDice(rd) {
    if (!rd || !Array.isArray(rd.flat) || !rd.flat.length) {
      roomDice.hidden = true;
      roomDice.classList.remove('is-in');
      roomDiceN = rd ? rd.n : -1;
      clearTimeout(roomDiceTimer);
      return;
    }
    if (rd.n === roomDiceN) return;   // already processed this roll (shown, adopted, or dismissed)
    roomDiceN = rd.n;
    const dice = rd.flat.map((x) => {
      const cls = (x.d === 20 && x.r === 20) ? ' is-crit' : (x.d === 20 && x.r === 1) ? ' is-fumble' : '';
      return `<span class="room-die${cls}">${dieSvg(x.d)}<span class="room-die-num">${x.r}</span></span>`;
    }).join('');
    roomDice.innerHTML =
      `<div class="room-dice-row">${dice}</div>` +
      `<div class="room-dice-sum"><span class="room-dice-eq">Total</span><span class="room-dice-total">${rd.total}</span></div>`;
    roomDice.hidden = false;
    roomDice.classList.remove('is-in');
    void roomDice.offsetWidth;   // restart the entrance animation on a repeat roll
    roomDice.classList.add('is-in');
    clearTimeout(roomDiceTimer);
    roomDiceTimer = setTimeout(() => { roomDice.hidden = true; roomDice.classList.remove('is-in'); }, ROOM_DICE_MS);
  }

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
    const first = firstPaint;
    view.render(state, scene, { instant: first });
    firstPaint = false;
    preloadAround(state, scene);
    engine.sync(state, scene);
    const rd = state.stage && state.stage.roomDice;
    // On the very first paint we adopt any restored roll silently (no stale pop-up
    // on a page reload); after that a bumped n shows a fresh roll.
    if (first) roomDiceN = rd ? rd.n : -1;
    else renderRoomDice(rd);
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
  let lastPainted = loadState();
  paint(lastPainted);

  // 2) React to live updates from the GM window.
  const sync = createSync((msg) => {
    if (!msg) return;
    if (msg.type === 'state' && msg.state) { lastPainted = msg.state; paint(msg.state); }
    // The token builder changed a character's crop/ring/display: merge it into
    // this window's CAST and repaint the last state so the TV re-crops live.
    else if (msg.type === 'tokens') { applyLiveOverride(msg.castId, msg.override); if (lastPainted) paint(lastPainted); }
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

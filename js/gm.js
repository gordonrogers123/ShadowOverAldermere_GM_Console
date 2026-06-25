// ============================================================
//  gm.js  --  the laptop control surface
// ------------------------------------------------------------
//  The GM window is the source of truth. It renders the scene list,
//  lets the GM build new scenes from the dropped-in art, save them,
//  recall them, and direct the stage live (show or hide the scene,
//  switch the background variant, bring each character in or out).
//  Every change saves to localStorage and broadcasts to the Player.
//
//  GM-only content (notes, scene internals) lives here and is never
//  shown on the Player window.
// ============================================================

import { allScenes, sceneById, isUserScene } from './scenesAll.js';
import { addUserScene, removeUserScene } from './userScenes.js';
import { saveSceneToFile, removeSceneFromFile } from './fileScenes.js';
import { loadState, saveState } from './state.js';
import { createSync } from './sync.js';
import { createStageView } from './stageView.js';
import { ENTER_TRANSITIONS, DEFAULT_ENTER } from './transitions.js';
import { BACKGROUNDS, CHARACTERS, MUSIC, AMBIENCE, SFX } from '../data/manifest.js';
import { CAST } from '../data/cast.js';
import { createAudioEngine } from './audioEngine.js';

export function mountGm(root) {
  let state = loadState();
  let draft = null;                 // the in-progress scene while building
  let mapMode = false;              // map mode replaces the live panel for token play
  let tokenSeq = 0;                 // monotonic source of unique token instIds
  let backgrounds = BACKGROUNDS.slice();   // mutable so Rescan can replace them
  let characters = CHARACTERS.slice();
  let audioMusic = MUSIC.slice();          // audio pick lists, also Rescan-replaceable
  let audioAmbience = AMBIENCE.slice();
  let audioSfx = SFX.slice();
  let builtAudioSceneId = null;            // which scene's audio panel is currently built

  // Sentinel a builder variant uses for "the Aldermere title screen": a
  // background with no image. It saves as an empty src, which the compositor
  // renders as the title plate (Aldermere + the scene name) before the reveal.
  const TITLE_SRC = '__title__';

  // The GM preview animates character entrances/exits like the TV, so the chosen
  // transition is actually visible while directing. Only the very first paint is
  // instant (a restored scene appears already in place, matching the Player).
  let previewFirstPaint = true;

  root.innerHTML = `
    <header class="gm-header">
      <div class="gm-title-wrap">
        <h1 class="gm-title">Aldermere GM Console</h1>
        <span class="gm-mode-chip" role="status" aria-live="polite" hidden></span>
      </div>
      <div class="gm-header-actions">
        <a class="gm-button btn--primary gm-open" href="?view=player" target="aldermere-player" rel="noopener">Open Player window</a>
        <button class="gm-button btn--quiet rescan" type="button">Rescan assets</button>
      </div>
    </header>

    <div class="gm-main">
      <aside class="gm-scenes">
        <div class="gm-scenes-head">
          <h2 class="gm-h2">Scenes</h2>
          <button class="gm-button new-scene" type="button">New scene</button>
        </div>
        <ul class="scene-list"></ul>
        <p class="rescan-status" role="status" aria-live="polite" hidden></p>

        <!-- Live controls live in the rail so they stay put (and visible) whether
             you are directing the scene or in map mode: nothing jumps. The nav
             row (Black out + Map<->Exit + Edit) is shown in BOTH modes at one
             fixed spot, so the three quick actions sit together and never move. -->
        <div class="gm-controls" hidden>
          <div class="control-row controls-nav">
            <button class="gm-button btn--toggle vis-toggle" type="button">Black out</button>
            <button class="gm-button btn--quiet map-mode-toggle" type="button" hidden>Map mode</button>
            <button class="gm-button btn--quiet edit-scene" type="button">Edit</button>
          </div>
          <div class="control-row variant-row">
            <span class="control-label">Background</span>
            <div class="variant-buttons"></div>
          </div>
          <div class="controls-live">
            <div class="control-row char-row" data-side="left">
              <span class="control-label">Left</span>
              <button class="gm-button char-toggle" data-side="left" type="button">Enter</button>
              <select class="char-swap" data-side="left" aria-label="Left character"></select>
              <button class="gm-button char-reset" data-side="left" type="button">Reset</button>
            </div>
            <div class="control-row char-row" data-side="right">
              <span class="control-label">Right</span>
              <button class="gm-button char-toggle" data-side="right" type="button">Enter</button>
              <select class="char-swap" data-side="right" aria-label="Right character"></select>
              <button class="gm-button char-reset" data-side="right" type="button">Reset</button>
            </div>
          </div>
          <div class="controls-map" hidden>
            <div class="control-row">
              <button class="gm-button btn--save mm-save-layout" type="button">Save layout</button>
              <button class="gm-button btn--quiet mm-reset-layout" type="button" hidden>Reset to saved layout</button>
            </div>
          </div>
        </div>
      </aside>

      <section class="gm-stage">
        <p class="gm-empty">Pick a scene to begin, or build a new one.</p>

        <figure class="gm-preview" hidden>
          <div class="preview-frame"></div>
          <figcaption class="preview-cap">
            <span class="preview-name"></span>
            <span class="badge"></span>
          </figcaption>
        </figure>

        <!-- (Live controls moved into the rail; see .gm-controls in .gm-scenes above.) -->

        <div class="gm-notes" hidden>
          <h3 class="gm-h3">GM notes</h3>
          <p class="notes-body"></p>
        </div>

        <div class="gm-audio" hidden>
          <h3 class="gm-h3">Audio</h3>
          <div class="audio-body"></div>
        </div>

        <div class="gm-builder" hidden>
          <h3 class="gm-h3 builder-title">Build a scene</h3>

          <div class="builder-grid">
            <div class="builder-col">
              <label class="field">
                <span>Name</span>
                <input class="b-name" type="text" placeholder="A Word at the Gate">
              </label>

              <div class="field">
                <span>Background variants <small>(first is shown first; pick "Title screen" for an Aldermere card that reveals to a map)</small></span>
                <div class="variant-list"></div>
                <button class="gm-button btn--quiet add-variant" type="button">Add variant</button>
              </div>

              <div class="field char-field">
                <span>Left character</span>
                <select class="b-left-src"></select>
                <select class="b-left-enter"></select>
                <div class="char-adjust">
                  <label class="char-size">Size <input type="range" class="b-left-scale" min="0.5" max="4" step="0.1"></label>
                  <label class="char-size" title="Horizontal position">↔ <input type="range" class="b-left-x" min="-10" max="45" step="1"></label>
                  <label class="char-size" title="Vertical position — raise to align with the backdrop bottom">↕ <input type="range" class="b-left-y" min="-10" max="30" step="1"></label>
                  <button class="gm-button btn--toggle b-left-flip" type="button" title="Flip the character to face the other way">Flip</button>
                </div>
              </div>
              <div class="field char-field">
                <span>Right character</span>
                <select class="b-right-src"></select>
                <select class="b-right-enter"></select>
                <div class="char-adjust">
                  <label class="char-size">Size <input type="range" class="b-right-scale" min="0.5" max="4" step="0.1"></label>
                  <label class="char-size" title="Horizontal position">↔ <input type="range" class="b-right-x" min="-10" max="45" step="1"></label>
                  <label class="char-size" title="Vertical position — raise to align with the backdrop bottom">↕ <input type="range" class="b-right-y" min="-10" max="30" step="1"></label>
                  <button class="gm-button btn--toggle b-right-flip" type="button" title="Flip the character to face the other way">Flip</button>
                </div>
              </div>
            </div>

            <div class="builder-col">
              <div class="field">
                <span>Roster <small>(who can be placed on the map)</small></span>
                <div class="roster-pick">
                  <div class="roster-group">
                    <div class="roster-group-head">
                      <span class="roster-group-label">Heroes</span>
                      <button class="roster-all" data-group="heroes" type="button">Select all</button>
                    </div>
                    <div class="roster-heroes"></div>
                  </div>
                  <div class="roster-group">
                    <div class="roster-group-head">
                      <span class="roster-group-label">Enemies</span>
                      <button class="roster-all" data-group="enemies" type="button">Select all</button>
                    </div>
                    <div class="roster-enemies"></div>
                  </div>
                </div>
              </div>

              <div class="field">
                <span>Audio <small>(music bed, ambience loops, one-shot SFX)</small></span>
                <div class="audio-pick">
                  <label class="audio-pick-row"><span class="audio-pick-label">Music</span><select class="b-music"></select></label>
                  <div class="audio-pick-group"><span class="audio-pick-label">Ambience</span><div class="b-ambience"></div></div>
                  <div class="audio-pick-group"><span class="audio-pick-label">SFX</span><div class="b-sfx"></div></div>
                </div>
              </div>

              <label class="field">
                <span>GM notes</span>
                <textarea class="b-notes" rows="2"></textarea>
              </label>
            </div>
          </div>

          <div class="builder-actions">
            <button class="gm-button btn--save b-save" type="button">Save scene</button>
            <button class="gm-button btn--quiet b-export" type="button">Export</button>
            <button class="gm-button btn--quiet b-cancel" type="button">Cancel</button>
          </div>
          <p class="b-export-hint" hidden>Copy this into the SCENES array in data/scenes.js to commit or share it.</p>
          <textarea class="b-export-out" hidden readonly rows="8"></textarea>
          <button class="gm-button btn--quiet b-copy" type="button" hidden>Copy to clipboard</button>
        </div>

        <div class="gm-mapmode" hidden>
          <div class="mapmode-head">
            <h3 class="gm-h3 mapmode-title"></h3>
          </div>
          <p class="mapmode-intro">Place and move tokens on the map; they show on the TV <strong>only while you are in map mode</strong>. The rail keeps <strong>Background</strong> (reveal the map), <strong>Save layout</strong>, and <strong>Exit map mode</strong> right where they were &mdash; nothing jumps.</p>
          <div class="mapmode-board"></div>
          <div class="mapmode-roster"></div>
        </div>
      </section>
    </div>
  `;

  const els = {
    sceneList:    root.querySelector('.scene-list'),
    rescanBtn:    root.querySelector('.rescan'),
    rescanStatus: root.querySelector('.rescan-status'),
    newScene:     root.querySelector('.new-scene'),
    empty:        root.querySelector('.gm-empty'),
    preview:      root.querySelector('.gm-preview'),
    previewFrame: root.querySelector('.preview-frame'),
    previewName:  root.querySelector('.preview-name'),
    badge:        root.querySelector('.badge'),
    controls:     root.querySelector('.gm-controls'),
    visToggle:    root.querySelector('.vis-toggle'),
    editScene:    root.querySelector('.edit-scene'),
    variantRow:   root.querySelector('.variant-row'),
    variantButtons: root.querySelector('.variant-buttons'),
    notes:        root.querySelector('.gm-notes'),
    notesBody:    root.querySelector('.notes-body'),
    builder:      root.querySelector('.gm-builder'),
    bName:        root.querySelector('.b-name'),
    variantList:  root.querySelector('.variant-list'),
    addVariant:   root.querySelector('.add-variant'),
    bLeftSrc:     root.querySelector('.b-left-src'),
    bLeftEnter:   root.querySelector('.b-left-enter'),
    bLeftScale:   root.querySelector('.b-left-scale'),
    bLeftX:       root.querySelector('.b-left-x'),
    bLeftY:       root.querySelector('.b-left-y'),
    bLeftFlip:    root.querySelector('.b-left-flip'),
    bRightSrc:    root.querySelector('.b-right-src'),
    bRightEnter:  root.querySelector('.b-right-enter'),
    bRightScale:  root.querySelector('.b-right-scale'),
    bRightX:      root.querySelector('.b-right-x'),
    bRightY:      root.querySelector('.b-right-y'),
    bRightFlip:   root.querySelector('.b-right-flip'),
    bNotes:       root.querySelector('.b-notes'),
    bSave:        root.querySelector('.b-save'),
    bExport:      root.querySelector('.b-export'),
    bCancel:      root.querySelector('.b-cancel'),
    bExportHint:  root.querySelector('.b-export-hint'),
    bExportOut:   root.querySelector('.b-export-out'),
    bCopy:        root.querySelector('.b-copy'),
    modeChip:     root.querySelector('.gm-mode-chip'),
    mapModeToggle: root.querySelector('.map-mode-toggle'),
    controlsLive: root.querySelector('.controls-live'),
    controlsMap:  root.querySelector('.controls-map'),
    mapmode:      root.querySelector('.gm-mapmode'),
    mapboard:     root.querySelector('.mapmode-board'),
    mapmodeTitle: root.querySelector('.mapmode-title'),
    mmSaveLayout: root.querySelector('.mm-save-layout'),
    mmResetLayout: root.querySelector('.mm-reset-layout'),
    mapRoster:    root.querySelector('.mapmode-roster'),
    rosterHeroes: root.querySelector('.roster-heroes'),
    rosterEnemies: root.querySelector('.roster-enemies'),
    rosterAllHeroes:  root.querySelector('.roster-all[data-group="heroes"]'),
    rosterAllEnemies: root.querySelector('.roster-all[data-group="enemies"]'),
    audio:        root.querySelector('.gm-audio'),
    audioBody:    root.querySelector('.audio-body'),
    bMusic:       root.querySelector('.b-music'),
    bAmbience:    root.querySelector('.b-ambience'),
    bSfx:         root.querySelector('.b-sfx'),
    charToggle: {
      left:  root.querySelector('.char-toggle[data-side="left"]'),
      right: root.querySelector('.char-toggle[data-side="right"]')
    },
    charSwap: {
      left:  root.querySelector('.char-swap[data-side="left"]'),
      right: root.querySelector('.char-swap[data-side="right"]')
    },
    charReset: {
      left:  root.querySelector('.char-reset[data-side="left"]'),
      right: root.querySelector('.char-reset[data-side="right"]')
    },
    charRow: {
      left:  root.querySelector('.char-row[data-side="left"]'),
      right: root.querySelector('.char-row[data-side="right"]')
    }
  };

  const previewView = createStageView(els.previewFrame);
  const boardView = createStageView(els.mapboard);
  boardView.el.classList.add('board-interactive');   // tokens are draggable here
  boardView.el.addEventListener('pointerdown', onBoardPointerDown);
  boardView.el.addEventListener('pointermove', onBoardPointerMove);
  boardView.el.addEventListener('pointerup', onBoardPointerUp);
  boardView.el.addEventListener('pointercancel', onBoardPointerUp);

  // The GM can monitor audio locally (role 'gm', off by default); the first
  // click anywhere unlocks its AudioContext (browser autoplay rule).
  const audioEngine = createAudioEngine({ role: 'gm', gestureTarget: root });
  window.__audio = audioEngine;   // debug / test hook

  // ---- Sync: broadcast state; reply to a Player hello with current state. ----
  const sync = createSync((msg) => {
    if (msg && msg.type === 'hello') broadcast();
  });
  function broadcast() { sync.post({ type: 'state', state }); }
  function commit() { saveState(state); broadcast(); renderUI(); }

  // ---- Small helpers ----
  function humanize(s) {
    const words = String(s || '').replace(/[_-]+/g, ' ').trim().split(/\s+/);
    return words.length && words[0]
      ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
      : String(s || '');
  }
  function slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'scene';
  }
  function charIdOf(src) {
    const found = characters.find((c) => c.src === src);
    if (found) return found.id;
    const file = String(src || '').split('/').pop() || '';
    return file.replace(/\.[^.]+$/, '');
  }

  // ============================================================
  //  Live play controls
  // ============================================================
  // Expand a scene's saved token layout into fresh live tokens. Positions are
  // identity-free in the scene; mint instIds in the 'tk<N>' shape so seedTokenSeq
  // keeps the counter ahead of them and a later add never collides.
  function expandSavedLayout(scene) {
    const layout = (scene && Array.isArray(scene.savedLayout)) ? scene.savedLayout : [];
    return layout
      .filter((L) => L && typeof L.castId === 'string' && L.castId)
      .map((L) => ({
        instId: 'tk' + (++tokenSeq),
        castId: L.castId,
        kind: L.kind === 'hero' ? 'hero' : 'enemy',
        label: (L.label != null && String(L.label).trim()) ? String(L.label) : L.castId,
        x: clamp01(L.x),
        y: clamp01(L.y),
        visible: L.visible !== false
      }));
  }
  function selectScene(id) {
    const scene = sceneById(id);
    if (!scene) return;
    // A global black-out persists across scene changes, so the GM can cut to
    // black, switch scenes, then reveal when ready.
    const wasBlackedOut = !!(state.stage && state.stage.visible === false);
    draft = null;
    state.sceneId = id;
    const keys = scene.maps ? Object.keys(scene.maps) : [];
    const def = scene.defaultMapState;
    // Use defaultMapState when it names a real variant KEY -- a title-screen
    // variant has an empty src, so test for the key, not a truthy value.
    const hasDef = def && scene.maps && Object.prototype.hasOwnProperty.call(scene.maps, def);
    state.mapState = hasDef ? def : (keys[0] || 'hidden');
    const d = scene.defaults || {};
    const hasLeft = !!(scene.characters && scene.characters.left);
    const hasRight = !!(scene.characters && scene.characters.right);
    state.stage = {
      visible: wasBlackedOut ? false : (d.visible !== false),  // a global black-out carries across scene changes
      left:  { shown: d.leftShown  != null ? !!d.leftShown  : hasLeft,  srcOverride: null },
      right: { shown: d.rightShown != null ? !!d.rightShown : hasRight, srcOverride: null },
      tokens: expandSavedLayout(scene),  // auto-place a saved layout, else empty
      mapMode: false                     // selecting a scene starts on the cinematic controls
    };
    state.audio = seedAudioFromScene(scene, state.audio);
    builtAudioSceneId = null;           // force the audio panel to rebuild on select
    mapMode = false;                   // start on the cinematic controls
    commit();
  }

  function toggleVisible() {
    state.stage.visible = state.stage.visible === false;
    commit();
  }
  function setVariant(key) { state.mapState = key; commit(); }
  function toggleSide(side) {
    state.stage[side].shown = !state.stage[side].shown;
    commit();
  }
  function swapSide(side, src) {
    // Selecting a character only ARMS it -- the Enter button triggers the
    // entrance. Picking from the dropdown never makes someone pop onto the
    // stage (and never shows them over a title screen); visibility is left
    // exactly as it was, so a live swap of an already-shown character is still
    // instant while a hidden side stays hidden until you press Enter.
    state.stage[side].srcOverride = src || null;
    commit();
  }
  function resetSide(side) { state.stage[side].srcOverride = null; commit(); }

  els.visToggle.addEventListener('click', toggleVisible);
  els.editScene.addEventListener('click', () => openBuilder(sceneById(state.sceneId)));
  els.mapModeToggle.addEventListener('click', () => { if (mapMode) exitMapMode(); else enterMapMode(); });
  els.mmSaveLayout.addEventListener('click', saveLayout);
  els.mmResetLayout.addEventListener('click', resetLayout);
  for (const side of ['left', 'right']) {
    els.charToggle[side].addEventListener('click', () => toggleSide(side));
    els.charReset[side].addEventListener('click', () => resetSide(side));
    els.charSwap[side].addEventListener('change', () => swapSide(side, els.charSwap[side].value));
  }

  // Build the background-variant buttons into a container; shared by the live
  // controls and the map-mode panel. Returns the variant count.
  function buildVariantButtons(container, scene) {
    container.innerHTML = '';
    const keys = scene.maps ? Object.keys(scene.maps) : [];
    for (const key of keys) {
      const btn = document.createElement('button');
      btn.className = 'gm-button btn--toggle variant-button';  // segmented toggle; .active lights it
      btn.type = 'button';
      btn.textContent = (scene.maps && scene.maps[key] === '') ? 'Title screen' : humanize(key);
      btn.classList.toggle('active', key === state.mapState);
      btn.addEventListener('click', () => setVariant(key));
      container.appendChild(btn);
    }
    return keys.length;
  }
  function renderVariantButtons(scene) {
    els.variantRow.hidden = buildVariantButtons(els.variantButtons, scene) <= 1;
  }

  // Category label + order for the grouped left/right character pickers.
  const CHAR_GROUPS = [['hero', 'Heroes'], ['npc', 'NPCs'], ['enemy', 'Enemies']];
  function fillCharSelect(sel, value, withDefaultLabel) {
    sel.innerHTML = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = withDefaultLabel ? 'Scene default' : 'None';
    sel.appendChild(first);
    // Group the cutouts under <optgroup> by category; anything with an unknown
    // or missing category falls into a trailing "Other" group so it is never lost.
    const grouped = new Set();
    const addGroup = (label, items) => {
      if (!items.length) return;
      const g = document.createElement('optgroup');
      g.label = label;
      for (const c of items) {
        const o = document.createElement('option');
        o.value = c.src;
        o.textContent = c.name;
        g.appendChild(o);
        grouped.add(c);
      }
      sel.appendChild(g);
    };
    for (const [cat, label] of CHAR_GROUPS) addGroup(label, characters.filter((c) => c.category === cat));
    addGroup('Other', characters.filter((c) => !grouped.has(c)));
    sel.value = value || '';
  }

  function renderLive(scene) {
    previewView.render(state, scene, { instant: previewFirstPaint }); previewFirstPaint = false;
    els.previewName.textContent = scene.name;

    const keys = scene.maps ? Object.keys(scene.maps) : [];
    els.badge.textContent = (scene.maps && scene.maps[state.mapState] === '') ? 'Title screen' : humanize(state.mapState);
    els.badge.classList.toggle('badge-revealed', keys.length > 1 && state.mapState !== keys[0]);

    for (const side of ['left', 'right']) {
      const hasChar = !!(scene.characters && scene.characters[side]) || !!state.stage[side].srcOverride;
      els.charToggle[side].textContent = state.stage[side].shown ? 'Exit' : 'Enter';
      els.charToggle[side].disabled = !hasChar;
      els.charReset[side].disabled = !state.stage[side].srcOverride;
      els.charRow[side].classList.toggle('row-disabled', !hasChar);
      fillCharSelect(els.charSwap[side], state.stage[side].srcOverride || '', true);
    }

    els.notesBody.textContent = scene.gmNotes || '';
  }

  // ============================================================
  //  Audio: a state-driven control panel. The GM monitors locally; the Player
  //  is the room output. Controls mutate state.audio then commitAudio() (save +
  //  broadcast + engine.sync) -- NOT renderUI(), so sliders are never rebuilt
  //  mid-drag. The panel is (re)built once per scene from buildAudioPanel().
  // ============================================================
  function ensureAudio() {
    if (!state.audio) state.audio = { master: 0.8, outputs: { player: true, gm: false }, tracks: {}, sfxTrigger: {} };
    if (!state.audio.outputs) state.audio.outputs = { player: true, gm: false };
    if (!state.audio.tracks) state.audio.tracks = {};
    if (!state.audio.sfxTrigger) state.audio.sfxTrigger = {};
  }
  function commitAudio() {
    saveState(state);
    broadcast();
    audioEngine.sync(state, sceneById(state.sceneId));
  }
  function trackFromCfg(cfg) {
    return {
      playing: false,
      volume: cfg.volume == null ? 0.8 : cfg.volume,
      pan: cfg.pan || 0,
      loop: cfg.loop !== false
    };
  }
  // Seed live tracks from a scene's audio config, preserving the GM's session
  // master/outputs. Music/ambience start NOT playing (cued deliberately).
  function seedAudioFromScene(scene, prev) {
    prev = prev || {};
    const a = (scene && scene.audio) || {};
    const tracks = {};
    if (a.music && a.music.src) tracks.music = trackFromCfg(a.music);
    (a.ambience || []).forEach((amb, i) => { if (amb && amb.src) tracks['amb:' + i] = trackFromCfg(amb); });
    const sfxTrigger = {};
    (a.sfx || []).forEach((s) => { if (s && s.id) sfxTrigger[s.id] = 0; });
    return {
      master: prev.master == null ? 0.8 : prev.master,
      outputs: prev.outputs || { player: true, gm: false },
      tracks,
      sfxTrigger
    };
  }
  // Capture live tuning (volume/pan) back into the scene's audio config
  // so it recalls next session. Persists to both tiers, like Save layout.
  function saveAudioToScene() {
    const scene = sceneById(state.sceneId);
    if (!scene || !scene.audio) return;
    const a = JSON.parse(JSON.stringify(scene.audio));
    const tr = (state.audio && state.audio.tracks) || {};
    const tune = (t) => ({ volume: t.volume, pan: t.pan, loop: t.loop !== false });
    if (a.music && tr.music) Object.assign(a.music, tune(tr.music));
    (a.ambience || []).forEach((amb, i) => { const t = tr['amb:' + i]; if (t) Object.assign(amb, tune(t)); });
    const updated = { ...scene, audio: a };
    addUserScene(updated);
    saveSceneToFile(updated);
    rebuildSceneList();
    setStatus('Saved audio for "' + scene.name + '".');
  }

  // ---- small DOM helpers for the audio panel ----
  function aRow(cls) { const d = document.createElement('div'); d.className = cls || 'audio-row'; return d; }
  function aLabel(text) { const s = document.createElement('span'); s.className = 'control-label'; s.textContent = text; return s; }
  function aSub(text) { const s = document.createElement('span'); s.className = 'audio-sub-label'; s.textContent = text; return s; }
  function aRange(cls, min, max, val) {
    const r = document.createElement('input');
    r.type = 'range'; r.className = cls; r.min = min; r.max = max; r.step = (max - min) / 100;
    r.value = (val == null ? min : val);
    return r;
  }
  // A short unit label paired with its slider (label on the left), kept compact
  // so the row leaves visual space rather than stretching edge to edge.
  function aKnob(labelText, rangeEl) {
    const w = document.createElement('div'); w.className = 'audio-knob';
    w.append(aSub(labelText), rangeEl);
    return w;
  }

  function buildAudioPanel(scene) {
    ensureAudio();
    const a = scene.audio || {};
    els.audioBody.innerHTML = '';

    const top = aRow();
    const master = aRange('audio-master', 0, 1, state.audio.master);
    master.addEventListener('input', () => { ensureAudio(); state.audio.master = +master.value; commitAudio(); });
    top.append(aLabel('Master'), master);
    const outWrap = document.createElement('div'); outWrap.className = 'audio-outputs';
    for (const [key, text] of [['player', 'TV'], ['gm', 'Laptop']]) {
      const b = document.createElement('button');
      b.className = 'gm-button btn--toggle audio-output'; b.type = 'button'; b.dataset.out = key; b.textContent = text;
      const isOn = () => !!(state.audio.outputs && state.audio.outputs[key]);
      b.classList.toggle('active', isOn());
      b.addEventListener('click', () => { ensureAudio(); state.audio.outputs[key] = !isOn(); b.classList.toggle('active', isOn()); commitAudio(); });
      outWrap.append(b);
    }
    top.append(aSub('Output'), outWrap);
    els.audioBody.append(top);

    if (a.music && a.music.src) els.audioBody.append(buildTrackBlock('music', 'Music', a.music));
    (a.ambience || []).forEach((amb, i) => {
      if (amb && amb.src) els.audioBody.append(buildTrackBlock('amb:' + i, 'Ambience ' + (i + 1), amb));
    });

    if ((a.sfx || []).length) {
      const row = aRow('audio-row audio-sfx-row');
      row.append(aLabel('SFX'));
      for (const s of a.sfx) {
        const b = document.createElement('button');
        b.className = 'gm-button audio-sfx'; b.type = 'button'; b.dataset.sfx = s.id; b.textContent = humanize(s.id);
        b.addEventListener('click', () => { ensureAudio(); state.audio.sfxTrigger[s.id] = (state.audio.sfxTrigger[s.id] || 0) + 1; commitAudio(); });
        row.append(b);
      }
      els.audioBody.append(row);
    }

    const saveRow = aRow();
    const saveBtn = document.createElement('button');
    saveBtn.className = 'gm-button btn--save audio-save'; saveBtn.type = 'button'; saveBtn.textContent = 'Save audio to scene';
    saveBtn.addEventListener('click', saveAudioToScene);
    saveRow.append(saveBtn);
    els.audioBody.append(saveRow);
  }

  // Empty-state shown in the Audio panel when a scene carries no audio yet, so
  // the feature is discoverable instead of the whole panel simply being absent.
  function buildAudioEmpty(scene) {
    els.audioBody.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'audio-empty';
    p.textContent = 'No music, ambience, or SFX set for this scene yet. ';
    const cta = document.createElement('button');
    cta.className = 'gm-button btn--quiet audio-empty-cta';
    cta.type = 'button';
    cta.textContent = 'Add audio in the builder';
    cta.addEventListener('click', () => openBuilder(scene));
    p.append(cta);
    els.audioBody.append(p);
  }

  function buildTrackBlock(key, label, cfg) {
    ensureAudio();
    if (!state.audio.tracks[key]) state.audio.tracks[key] = trackFromCfg(cfg);
    const t = state.audio.tracks[key];
    const block = document.createElement('div'); block.className = 'audio-track'; block.dataset.key = key;

    const head = aRow();
    head.append(aLabel(label));
    const play = document.createElement('button');
    play.className = 'gm-button audio-play'; play.type = 'button';
    play.textContent = t.playing ? 'Stop' : 'Play';
    play.classList.toggle('is-playing', !!t.playing);
    play.addEventListener('click', () => {
      ensureAudio(); const tt = state.audio.tracks[key]; tt.playing = !tt.playing;
      play.textContent = tt.playing ? 'Stop' : 'Play'; play.classList.toggle('is-playing', !!tt.playing); commitAudio();
    });
    head.append(play);
    const vol = aRange('audio-vol', 0, 1, t.volume);
    vol.addEventListener('input', () => { ensureAudio(); state.audio.tracks[key].volume = +vol.value; commitAudio(); });
    const pan = aRange('audio-pan', -1, 1, t.pan);
    pan.addEventListener('input', () => { ensureAudio(); state.audio.tracks[key].pan = +pan.value; commitAudio(); });
    head.append(aKnob('Vol', vol), aKnob('Pan', pan));
    block.append(head);
    return block;
  }

  // ---- Builder audio picker (which tracks the scene carries) ----
  function buildAudioChecks(container, list, isOn, toggle) {
    container.innerHTML = '';
    if (!list.length) { const p = document.createElement('span'); p.className = 'audio-pick-empty'; p.textContent = '(none found -- add files under assets/audio, then Rescan)'; container.append(p); return; }
    for (const item of list) {
      const lab = document.createElement('label'); lab.className = 'roster-item';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = isOn(item);
      cb.addEventListener('change', () => toggle(item, cb.checked));
      const nm = document.createElement('span'); nm.textContent = item.name;
      lab.append(cb, nm); container.append(lab);
    }
  }
  function renderAudioPick() {
    els.bMusic.innerHTML = '';
    const none = document.createElement('option'); none.value = ''; none.textContent = 'None'; els.bMusic.append(none);
    for (const m of audioMusic) { const o = document.createElement('option'); o.value = m.src; o.textContent = m.name; els.bMusic.append(o); }
    els.bMusic.value = (draft.audio.music && draft.audio.music.src) || '';
    buildAudioChecks(els.bAmbience, audioAmbience,
      (item) => draft.audio.ambience.some((x) => x.src === item.src),
      (item, on) => {
        if (on) { if (!draft.audio.ambience.some((x) => x.src === item.src)) draft.audio.ambience.push({ src: item.src, volume: 0.8, pan: 0, loop: true }); }
        else draft.audio.ambience = draft.audio.ambience.filter((x) => x.src !== item.src);
      });
    buildAudioChecks(els.bSfx, audioSfx,
      (item) => draft.audio.sfx.some((x) => x.id === item.id),
      (item, on) => {
        if (on) { if (!draft.audio.sfx.some((x) => x.id === item.id)) draft.audio.sfx.push({ id: item.id, src: item.src, volume: 0.8, pan: 0 }); }
        else draft.audio.sfx = draft.audio.sfx.filter((x) => x.id !== item.id);
      });
  }
  // Build a scene.audio object from the draft, or null when nothing is chosen.
  function buildSceneAudio(da) {
    da = da || {};
    const music = (da.music && da.music.src) ? da.music : null;
    const ambience = (da.ambience || []).filter((x) => x && x.src);
    const sfx = (da.sfx || []).filter((x) => x && x.id && x.src);
    if (!music && !ambience.length && !sfx.length) return null;
    return { music, ambience, sfx };
  }

  // ============================================================
  //  Map mode: place and move tokens on the map
  // ============================================================
  function clamp01(n) { n = +n; if (!isFinite(n)) return 0; return n < 0 ? 0 : n > 1 ? 1 : n; }
  function sceneHasMap(scene) { return !!(scene && scene.maps && Object.keys(scene.maps).length); }
  function castEntry(castId, kind) {
    const list = kind === 'hero' ? CAST.heroes : CAST.enemies;
    return (list || []).find((c) => c.id === castId) || null;
  }
  // "Brigands" -> "Brigand": prefer an explicit singular, else strip a
  // trailing s, else use the name as-is.
  function enemySingular(cast) {
    if (cast && cast.singular) return cast.singular;
    const name = (cast && cast.name) || (cast && cast.id) || 'Enemy';
    return name.replace(/s$/i, '') || name;
  }
  // Lowest unused copy number for this enemy, so removing a middle one and
  // re-adding fills the gap rather than ever leaving a hole in the count.
  function nextEnemyNumber(tokens, castId) {
    const used = new Set();
    for (const t of tokens) {
      if (t.kind === 'enemy' && t.castId === castId) {
        const m = /(\d+)\s*$/.exec(t.label || '');
        if (m) used.add(+m[1]);
      }
    }
    let n = 1;
    while (used.has(n)) n += 1;
    return n;
  }
  function ensureTokens() {
    if (!state.stage) state.stage = { visible: true, left: { shown: false, srcOverride: null }, right: { shown: false, srcOverride: null }, tokens: [], mapMode: false };
    if (!Array.isArray(state.stage.tokens)) state.stage.tokens = [];
  }
  // Seed the instId counter above any id already in saved state so re-adds
  // after a reload never collide.
  function seedTokenSeq() {
    let max = 0;
    for (const t of (state.stage && state.stage.tokens) || []) {
      const m = /^tk(\d+)$/.exec(t.instId || '');
      if (m) max = Math.max(max, +m[1]);
    }
    tokenSeq = max;
  }

  function addToken(castId, kind) {
    const cast = castEntry(castId, kind);
    if (!cast) return;
    ensureTokens();
    const tokens = state.stage.tokens;
    let label, visible;
    if (kind === 'hero') {
      if (tokens.some((t) => t.kind === 'hero' && t.castId === castId)) return;  // heroes are unique
      label = cast.name;
      visible = true;                              // heroes are placed in the open
    } else {
      label = enemySingular(cast) + ' ' + nextEnemyNumber(tokens, castId);
      visible = false;                             // enemies are staged hidden, revealed on cue
    }
    // Scatter around the center so stacked drops do not perfectly overlap.
    const k = tokens.length;
    const x = clamp01(0.5 + ((k % 5) - 2) * 0.045);
    const y = clamp01(0.5 + ((Math.floor(k / 5) % 5) - 2) * 0.045);
    tokens.push({ instId: 'tk' + (++tokenSeq), castId, kind, label, x, y, visible });
    commit();
  }
  function removeToken(instId) {
    ensureTokens();
    state.stage.tokens = state.stage.tokens.filter((t) => t.instId !== instId);
    commit();
  }
  function toggleTokenVisible(instId) {
    ensureTokens();
    const t = state.stage.tokens.find((x) => x.instId === instId);
    if (t) { t.visible = t.visible === false; commit(); }
  }

  function enterMapMode() {
    if (!sceneHasMap(sceneById(state.sceneId))) return;
    mapMode = true;
    ensureTokens();
    state.stage.mapMode = true;   // tell the Player to reveal the tokens
    commit();                     // save + broadcast the flag + re-render
  }
  function exitMapMode() {
    mapMode = false;
    if (state.stage) state.stage.mapMode = false;   // Player hides the tokens again
    commit();
  }

  // Capture the current board into the scene's savedLayout, so selecting the
  // scene later auto-places these tokens. Persists to BOTH tiers: localStorage
  // (instant) and disk (best-effort, survives clearing browser data).
  function saveLayout() {
    const scene = sceneById(state.sceneId);
    if (!scene) return;
    ensureTokens();
    const layout = state.stage.tokens.map((t) => ({
      castId: t.castId, kind: t.kind, label: t.label, x: t.x, y: t.y, visible: t.visible !== false
    }));
    const updated = { ...scene, savedLayout: layout };
    addUserScene(updated);            // localStorage upsert by id
    saveSceneToFile(updated);         // disk write-through (best-effort, async)
    rebuildSceneList();               // it is a saved scene now -> gets the "saved" badge
    renderMapMode(sceneById(state.sceneId));   // refresh; the Reset button now shows
    const n = layout.length;
    setStatus('Saved layout for "' + scene.name + '" (' + n + ' token' + (n === 1 ? '' : 's') + ').');
  }
  // Discard live edits and re-place the scene's saved layout.
  function resetLayout() {
    const scene = sceneById(state.sceneId);
    if (!scene) return;
    state.stage.tokens = expandSavedLayout(scene);
    commit();
  }

  // Map-mode roster: ONE compact place per entity (no more roster + on-board
  // duplication). Two category columns. A hero shows Add until placed, then its
  // Hide/Reveal + remove inline. An enemy type shows Add (a numbered copy) with
  // its placed copies listed and controlled beneath it. Add-all fills a column.
  function rosterSwatch(color) {
    const s = document.createElement('span'); s.className = 'roster-swatch';
    s.style.background = color || '#888'; return s;
  }
  function rosterVisBtn(t) {
    const b = document.createElement('button');
    b.className = 'gm-button mmr-vis' + (t.visible === false ? ' is-hidden' : '');
    b.type = 'button';
    b.textContent = t.visible === false ? 'Reveal' : 'Hide';
    b.addEventListener('click', () => toggleTokenVisible(t.instId));
    return b;
  }
  function rosterDelBtn(t) {
    const b = document.createElement('button');
    b.className = 'mmr-del'; b.type = 'button'; b.textContent = '×';
    b.title = 'Remove from board'; b.setAttribute('aria-label', 'Remove ' + t.label + ' from board');
    b.addEventListener('click', () => removeToken(t.instId));
    return b;
  }
  function rosterAddBtn(id, kind) {
    const b = document.createElement('button');
    b.className = 'gm-button mmr-add'; b.type = 'button'; b.textContent = 'Add';
    b.addEventListener('click', () => addToken(id, kind));
    return b;
  }
  function rosterRow(extraClass) {
    const r = document.createElement('div'); r.className = 'mmr-row' + (extraClass ? ' ' + extraClass : '');
    return r;
  }
  function rosterName(text, hidden) {
    const n = document.createElement('span'); n.className = 'mmr-name'; n.textContent = text;
    if (hidden) n.classList.add('is-hidden-name');
    return n;
  }
  function rosterColumn(label, addAll) {
    const col = document.createElement('div'); col.className = 'mmr-cat';
    const head = document.createElement('div'); head.className = 'mmr-head';
    const lab = document.createElement('span'); lab.className = 'mmr-label'; lab.textContent = label;
    const all = document.createElement('button');
    all.className = 'gm-button btn--quiet mmr-addall'; all.type = 'button'; all.textContent = 'Add all';
    all.addEventListener('click', addAll);
    head.append(lab, all);
    const list = document.createElement('div'); list.className = 'mmr-list';
    col.append(head, list);
    return { col, list };
  }

  function renderRoster(scene) {
    const roster = scene.tokens || {};
    const heroes = Array.isArray(roster.heroes) ? roster.heroes : [];
    const enemies = Array.isArray(roster.enemies) ? roster.enemies : [];
    const placed = (state.stage && state.stage.tokens) || [];
    els.mapRoster.innerHTML = '';

    if (!heroes.length && !enemies.length) {
      const p = document.createElement('p');
      p.className = 'mmr-empty';
      p.textContent = 'No roster set. Edit the scene to choose heroes and enemies.';
      els.mapRoster.append(p);
      return;
    }

    if (heroes.length) {
      // Add all skips heroes already placed (addToken is a no-op for those).
      const { col, list } = rosterColumn('Heroes', () => { for (const id of heroes) addToken(id, 'hero'); });
      for (const id of heroes) {
        const c = castEntry(id, 'hero'); if (!c) continue;
        const inst = placed.find((t) => t.kind === 'hero' && t.castId === id);
        const row = rosterRow(inst ? 'is-placed' : null);
        row.append(rosterSwatch(c.ringColor), rosterName(c.name, inst && inst.visible === false));
        if (inst) row.append(rosterVisBtn(inst), rosterDelBtn(inst));
        else row.append(rosterAddBtn(id, 'hero'));
        list.append(row);
      }
      els.mapRoster.append(col);
    }

    if (enemies.length) {
      // Add all drops one copy of each enemy type.
      const { col, list } = rosterColumn('Enemies', () => { for (const id of enemies) addToken(id, 'enemy'); });
      for (const id of enemies) {
        const c = castEntry(id, 'enemy'); if (!c) continue;
        const typeRow = rosterRow('mmr-type');
        typeRow.append(rosterSwatch(c.ringColor), rosterName(c.name), rosterAddBtn(id, 'enemy'));
        list.append(typeRow);
        for (const t of placed.filter((p) => p.kind === 'enemy' && p.castId === id)) {
          const row = rosterRow('mmr-copy');
          row.append(rosterSwatch(c.ringColor), rosterName(t.label, t.visible === false), rosterVisBtn(t), rosterDelBtn(t));
          list.append(row);
        }
      }
      els.mapRoster.append(col);
    }
  }

  function renderMapMode(scene) {
    els.mapmodeTitle.textContent = scene.name;
    els.mmResetLayout.hidden = !(scene && Array.isArray(scene.savedLayout) && scene.savedLayout.length);
    boardView.render(state, scene, { instant: true });
    boardView.layoutTokens();          // the board was just unhidden; re-pin now
    renderRoster(scene);
  }

  // ---- Drag a token on the board. The element follows the pointer locally
  //      every move; the broadcast to the Player is throttled to one per
  //      frame, and the authoritative save happens once on release. ----
  let drag = null;
  let dragRAF = 0;
  let dragPending = false;
  function flushDragBroadcast() { dragPending = false; dragRAF = 0; broadcast(); }
  function scheduleDragBroadcast() {
    if (dragPending) return;
    dragPending = true;
    dragRAF = requestAnimationFrame(flushDragBroadcast);
  }
  function onBoardPointerDown(e) {
    const tokenEl = e.target.closest && e.target.closest('.token');
    if (!tokenEl || !boardView.el.contains(tokenEl)) return;
    const instId = tokenEl.dataset.instId;
    const tokens = (state.stage && state.stage.tokens) || [];
    if (!tokens.some((t) => t.instId === instId)) return;
    drag = { instId, el: tokenEl };
    tokenEl.classList.add('dragging');
    if (tokenEl.setPointerCapture) { try { tokenEl.setPointerCapture(e.pointerId); } catch (_) {} }
    e.preventDefault();
  }
  function onBoardPointerMove(e) {
    if (!drag) return;
    const frac = boardView.pointToFraction(e.clientX, e.clientY);
    if (!frac) return;
    const t = (state.stage.tokens || []).find((x) => x.instId === drag.instId);
    if (!t) return;
    t.x = frac.x; t.y = frac.y;
    drag.el.dataset.x = frac.x;
    drag.el.dataset.y = frac.y;
    boardView.layoutTokens();          // reposition locally (smooth on the GM board)
    scheduleDragBroadcast();           // mirror to the Player, throttled to a frame
  }
  function onBoardPointerUp(e) {
    if (!drag) return;
    const el = drag.el;
    el.classList.remove('dragging');
    if (el.releasePointerCapture && e.pointerId != null) { try { el.releasePointerCapture(e.pointerId); } catch (_) {} }
    drag = null;
    if (dragRAF) cancelAnimationFrame(dragRAF);
    dragPending = false;
    commit();                          // final save + broadcast + refreshed lists
  }

  // ============================================================
  //  Scene builder
  // ============================================================
  function blankDraft() {
    return {
      editingId: null,
      name: '',
      gmNotes: '',
      // New scenes open on the Aldermere title screen, then reveal to a map.
      variants: [
        { key: 'hidden', src: TITLE_SRC },
        { key: 'revealed', src: (backgrounds[0] && backgrounds[0].src) || '' }
      ],
      left:  { src: '', enter: DEFAULT_ENTER, scale: 1, flip: false, x: 0, y: 0 },
      right: { src: '', enter: DEFAULT_ENTER, scale: 1, flip: false, x: 0, y: 0 },
      roster: { heroes: [], enemies: [] },
      savedLayout: [],
      audio: { music: null, ambience: [], sfx: [] }
    };
  }
  function sceneToDraft(scene) {
    // An empty map src is a title-screen variant; surface it as such in the picker.
    const variants = Object.entries(scene.maps || {}).map(([key, src]) => ({ key, src: src === '' ? TITLE_SRC : src }));
    if (!variants.length) variants.push({ key: 'revealed', src: '' });
    const sideOf = (s) => (s
      ? { src: s.src || '', enter: s.enter || DEFAULT_ENTER, scale: +s.scale > 0 ? +s.scale : 1, flip: !!s.flip, x: +s.x || 0, y: +s.y || 0 }
      : { src: '', enter: DEFAULT_ENTER, scale: 1, flip: false, x: 0, y: 0 });
    const t = scene.tokens || {};
    return {
      editingId: scene.id,
      name: scene.name || '',
      gmNotes: scene.gmNotes || '',
      variants,
      left:  sideOf(scene.characters && scene.characters.left),
      right: sideOf(scene.characters && scene.characters.right),
      roster: {
        heroes: Array.isArray(t.heroes) ? t.heroes.slice() : [],
        enemies: Array.isArray(t.enemies) ? t.enemies.slice() : []
      },
      // Carried opaquely through the builder; positions are edited in map mode.
      savedLayout: Array.isArray(scene.savedLayout) ? scene.savedLayout.slice() : [],
      audio: scene.audio
        ? { music: scene.audio.music || null,
            ambience: Array.isArray(scene.audio.ambience) ? JSON.parse(JSON.stringify(scene.audio.ambience)) : [],
            sfx: Array.isArray(scene.audio.sfx) ? JSON.parse(JSON.stringify(scene.audio.sfx)) : [] }
        : { music: null, ambience: [], sfx: [] }
    };
  }

  function draftToScene(d) {
    const maps = {};
    d.variants.forEach((v, i) => {
      if (!v.src) return;                              // unset variant -- skip
      let base = slug(v.key) || ('variant-' + (i + 1));
      let key = base; let n = 2;
      while (Object.prototype.hasOwnProperty.call(maps, key)) { key = base + '-' + n; n += 1; }
      maps[key] = v.src === TITLE_SRC ? '' : v.src;     // title screen saves as an empty src
    });
    const keys = Object.keys(maps);
    const id = d.editingId || slug(d.name);
    const roster = d.roster || { heroes: [], enemies: [] };
    const hasRoster = (roster.heroes && roster.heroes.length) || (roster.enemies && roster.enemies.length);
    const scene = {
      id,
      name: (d.name || '').trim() || humanize(id),
      maps,
      defaultMapState: keys[0] || 'revealed',
      tokens: hasRoster
        ? { heroes: (roster.heroes || []).slice(), enemies: (roster.enemies || []).slice() }
        : null,
      music: null,
      ambience: [],
      audio: buildSceneAudio(d.audio),
      gmNotes: (d.gmNotes || '').trim()
    };
    if (Array.isArray(d.savedLayout) && d.savedLayout.length) {
      scene.savedLayout = d.savedLayout.map((L) => ({
        castId: L.castId, kind: L.kind, label: L.label, x: L.x, y: L.y, visible: L.visible !== false
      }));
    }
    const chars = {};
    // Per-character display tuning (size + horizontal flip) rides on the scene's
    // character config; only stored when it differs from the default to keep
    // scenes clean. Useful for transparent cutouts (e.g. NPCs) that need scaling
    // or need to face the other way.
    const sideCfg = (d) => {
      const c = { id: charIdOf(d.src), src: d.src, enter: d.enter };
      if (+d.scale > 0 && +d.scale !== 1) c.scale = +d.scale;
      if (d.flip) c.flip = true;
      if (+d.x) c.x = +d.x;
      if (+d.y) c.y = +d.y;
      return c;
    };
    if (d.left.src)  chars.left  = sideCfg(d.left);
    if (d.right.src) chars.right = sideCfg(d.right);
    if (chars.left || chars.right) scene.characters = chars;
    scene.defaults = { visible: true, leftShown: !!chars.left, rightShown: !!chars.right };
    return scene;
  }

  function openBuilder(scene) {
    draft = scene ? sceneToDraft(scene) : blankDraft();
    renderBuilderInputs();
    renderUI();
  }
  function closeBuilder() { draft = null; renderUI(); }

  function renderVariantRows() {
    els.variantList.innerHTML = '';
    draft.variants.forEach((v, i) => {
      const row = document.createElement('div');
      row.className = 'variant-edit';

      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'v-key';
      keyInput.value = v.key;
      keyInput.placeholder = 'label';
      keyInput.addEventListener('input', () => { v.key = keyInput.value; renderBuilderPreview(); });

      const sel = document.createElement('select');
      sel.className = 'v-src';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '(choose background)';
      sel.appendChild(none);
      const title = document.createElement('option');
      title.value = TITLE_SRC;
      title.textContent = 'Title screen (Aldermere)';
      sel.appendChild(title);
      // Group the backdrops so the GM can tell a top-down MAP from a cinematic
      // BACKGROUND at a glance; the kind comes from the asset folder (assets/maps
      // vs assets/backgrounds), tagged by the scanner.
      const used = new Set();
      for (const [k, label] of [['map', 'Maps'], ['background', 'Backgrounds']]) {
        const items = backgrounds.filter((b) => b.kind === k);
        if (!items.length) continue;
        const og = document.createElement('optgroup');
        og.label = label;
        for (const b of items) {
          const o = document.createElement('option');
          o.value = b.src; o.textContent = b.name;
          og.appendChild(o); used.add(b.src);
        }
        sel.appendChild(og);
      }
      // Any untagged backdrops (loose files) keep working under a neutral group.
      const rest = backgrounds.filter((b) => !used.has(b.src));
      if (rest.length) {
        const og = document.createElement('optgroup');
        og.label = 'Other';
        for (const b of rest) {
          const o = document.createElement('option');
          o.value = b.src; o.textContent = b.name;
          og.appendChild(o);
        }
        sel.appendChild(og);
      }
      sel.value = v.src;
      sel.addEventListener('change', () => { v.src = sel.value; renderBuilderPreview(); });

      const tag = document.createElement('span');
      tag.className = 'v-tag';
      tag.textContent = i === 0 ? 'shown first' : '';

      const rm = document.createElement('button');
      rm.className = 'v-remove';
      rm.type = 'button';
      rm.textContent = 'Remove';
      rm.disabled = draft.variants.length <= 1;
      rm.addEventListener('click', () => {
        draft.variants.splice(i, 1);
        renderVariantRows();
        renderBuilderPreview();
      });

      row.append(keyInput, sel, tag, rm);
      els.variantList.appendChild(row);
    });
  }

  function renderBuilderInputs() {
    els.builderTitle = els.builder.querySelector('.builder-title');
    els.builderTitle.textContent = draft.editingId ? 'Edit scene' : 'Build a scene';
    els.bName.value = draft.name;
    els.bNotes.value = draft.gmNotes;
    renderVariantRows();
    fillCharSelect(els.bLeftSrc, draft.left.src, false);
    fillCharSelect(els.bRightSrc, draft.right.src, false);
    fillEnterSelect(els.bLeftEnter, draft.left.enter);
    fillEnterSelect(els.bRightEnter, draft.right.enter);
    els.bLeftScale.value = draft.left.scale || 1;
    els.bRightScale.value = draft.right.scale || 1;
    els.bLeftX.value = draft.left.x || 0;
    els.bLeftY.value = draft.left.y || 0;
    els.bRightX.value = draft.right.x || 0;
    els.bRightY.value = draft.right.y || 0;
    els.bLeftFlip.classList.toggle('is-on', !!draft.left.flip);
    els.bRightFlip.classList.toggle('is-on', !!draft.right.flip);
    renderRosterPick();
    renderAudioPick();
    els.bExportOut.hidden = true;
    els.bExportHint.hidden = true;
    els.bCopy.hidden = true;
  }

  // Roster checkboxes from CAST; toggling one edits draft.roster in place.
  // No preview refresh -- the roster does not change the composited image.
  function renderRosterPick() {
    const build = (container, allBtn, list, selected) => {
      container.innerHTML = '';
      for (const c of list) {
        const lab = document.createElement('label');
        lab.className = 'roster-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.includes(c.id);
        cb.addEventListener('change', () => {
          const i = selected.indexOf(c.id);
          if (cb.checked && i < 0) selected.push(c.id);
          else if (!cb.checked && i >= 0) selected.splice(i, 1);
          syncAllBtn();
        });
        const sw = document.createElement('span');
        sw.className = 'roster-swatch';
        sw.style.background = c.ringColor || '#888';
        const nm = document.createElement('span');
        nm.textContent = c.name;
        lab.append(cb, sw, nm);
        container.appendChild(lab);
      }
      // "Select all" toggles the whole group at once (heroes are the common
      // case); it flips to "Clear" once every member is selected.
      const allOn = () => list.length > 0 && list.every((c) => selected.includes(c.id));
      function syncAllBtn() {
        allBtn.disabled = list.length === 0;
        allBtn.textContent = allOn() ? 'Clear' : 'Select all';
      }
      allBtn.onclick = () => {
        if (allOn()) selected.length = 0;
        else for (const c of list) if (!selected.includes(c.id)) selected.push(c.id);
        renderRosterPick();   // rebuild both groups to reflect the new state
      };
      syncAllBtn();
    };
    build(els.rosterHeroes, els.rosterAllHeroes, CAST.heroes || [], draft.roster.heroes);
    build(els.rosterEnemies, els.rosterAllEnemies, CAST.enemies || [], draft.roster.enemies);
  }

  function fillEnterSelect(sel, value) {
    sel.innerHTML = '';
    for (const t of ENTER_TRANSITIONS) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.label;
      sel.appendChild(o);
    }
    sel.value = value || DEFAULT_ENTER;
  }

  function renderBuilderPreview() {
    if (!draft) return;
    const scene = draftToScene(draft);
    const firstKey = Object.keys(scene.maps)[0] || 'revealed';
    const pstate = {
      sceneId: scene.id,
      mapState: firstKey,
      stage: {
        visible: true,
        left:  { shown: !!(scene.characters && scene.characters.left),  srcOverride: null },
        right: { shown: !!(scene.characters && scene.characters.right), srcOverride: null }
      }
    };
    previewView.render(pstate, scene, { instant: previewFirstPaint }); previewFirstPaint = false;
    els.previewName.textContent = scene.name || 'New scene';
    els.badge.textContent = (scene.maps && scene.maps[firstKey] === '') ? 'Title screen' : humanize(firstKey);
    els.badge.classList.remove('badge-revealed');
  }

  // Builder input wiring (elements persist; only their options change).
  els.bName.addEventListener('input', () => { draft.name = els.bName.value; renderBuilderPreview(); });
  els.bNotes.addEventListener('input', () => { draft.gmNotes = els.bNotes.value; });
  els.addVariant.addEventListener('click', () => {
    draft.variants.push({ key: 'variant-' + (draft.variants.length + 1), src: (backgrounds[0] && backgrounds[0].src) || '' });
    renderVariantRows();
    renderBuilderPreview();
  });
  els.bLeftSrc.addEventListener('change', () => { draft.left.src = els.bLeftSrc.value; renderBuilderPreview(); });
  els.bLeftEnter.addEventListener('change', () => { draft.left.enter = els.bLeftEnter.value; renderBuilderPreview(); });
  els.bRightSrc.addEventListener('change', () => { draft.right.src = els.bRightSrc.value; renderBuilderPreview(); });
  els.bRightEnter.addEventListener('change', () => { draft.right.enter = els.bRightEnter.value; renderBuilderPreview(); });
  els.bLeftScale.addEventListener('input', () => { draft.left.scale = +els.bLeftScale.value; renderBuilderPreview(); });
  els.bRightScale.addEventListener('input', () => { draft.right.scale = +els.bRightScale.value; renderBuilderPreview(); });
  els.bLeftX.addEventListener('input', () => { draft.left.x = +els.bLeftX.value; renderBuilderPreview(); });
  els.bLeftY.addEventListener('input', () => { draft.left.y = +els.bLeftY.value; renderBuilderPreview(); });
  els.bRightX.addEventListener('input', () => { draft.right.x = +els.bRightX.value; renderBuilderPreview(); });
  els.bRightY.addEventListener('input', () => { draft.right.y = +els.bRightY.value; renderBuilderPreview(); });
  els.bLeftFlip.addEventListener('click', () => { draft.left.flip = !draft.left.flip; els.bLeftFlip.classList.toggle('is-on', draft.left.flip); renderBuilderPreview(); });
  els.bRightFlip.addEventListener('click', () => { draft.right.flip = !draft.right.flip; els.bRightFlip.classList.toggle('is-on', draft.right.flip); renderBuilderPreview(); });
  els.bMusic.addEventListener('change', () => {
    const src = els.bMusic.value;
    draft.audio.music = src
      ? ((draft.audio.music && draft.audio.music.src === src) ? draft.audio.music : { src, volume: 0.8, pan: 0, loop: true })
      : null;
  });
  els.bCancel.addEventListener('click', closeBuilder);
  els.newScene.addEventListener('click', () => openBuilder(null));

  els.bSave.addEventListener('click', () => {
    if (!draft) return;
    if (!draft.name.trim()) { setStatus('Name the scene before saving.'); els.bName.focus(); return; }
    const scene = draftToScene(draft);
    addUserScene(scene);
    saveSceneToFile(scene);           // mirror the save to disk (best-effort)
    draft = null;
    rebuildSceneList();
    selectScene(scene.id);
    setStatus('Saved "' + scene.name + '".');
  });

  els.bExport.addEventListener('click', () => {
    if (!draft) return;
    const scene = draftToScene(draft);
    els.bExportOut.value = JSON.stringify(scene, null, 2);
    els.bExportOut.hidden = false;
    els.bExportHint.hidden = false;
    els.bCopy.hidden = false;
    els.bExportOut.focus();
    els.bExportOut.select();
  });

  // Copy the export to the clipboard; fall back to selecting the textarea so the
  // GM can still Ctrl/Cmd-C if the Clipboard API is unavailable (no HTTPS / denied).
  els.bCopy.addEventListener('click', () => {
    const text = els.bExportOut.value;
    const fallback = () => { els.bExportOut.focus(); els.bExportOut.select(); setStatus('Selected the scene JSON — press Ctrl/Cmd-C to copy.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => setStatus('Copied the scene JSON to the clipboard.'), fallback);
    } else {
      fallback();
    }
  });

  // ============================================================
  //  Scene list + Rescan
  // ============================================================
  // Session "pins": scene ids the GM has starred to the top of the list, so the
  // scenes in play this session stay one glance away. Persisted in localStorage
  // (survives a reload), kept separate from the scenes themselves.
  const PINS_KEY = 'aldermere.gm.pinnedScenes.v1';
  function loadPins() {
    try { const a = JSON.parse(localStorage.getItem(PINS_KEY)); return new Set(Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []); }
    catch (e) { return new Set(); }
  }
  function savePins() { try { localStorage.setItem(PINS_KEY, JSON.stringify([...pinned])); } catch (e) {} }
  let pinned = loadPins();
  function togglePin(id) {
    if (pinned.has(id)) pinned.delete(id); else pinned.add(id);
    savePins();
    rebuildSceneList();
  }

  function rebuildSceneList() {
    els.sceneList.innerHTML = '';
    // Pinned scenes float to the top; order is otherwise preserved within each
    // group (a stable partition), so unpinning drops a scene back into place.
    const all = allScenes();
    const ordered = [...all.filter((s) => pinned.has(s.id)), ...all.filter((s) => !pinned.has(s.id))];
    for (const scene of ordered) {
      const li = document.createElement('li');
      const isPinned = pinned.has(scene.id);
      if (isPinned) li.classList.add('is-pinned');

      const pin = document.createElement('button');
      pin.className = 'scene-pin' + (isPinned ? ' is-pinned' : '');
      pin.type = 'button';
      pin.textContent = isPinned ? '★' : '☆';   // filled vs hollow star
      pin.title = isPinned ? 'Unpin from the top' : 'Pin to the top for this session';
      pin.setAttribute('aria-label', pin.title);
      pin.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
      pin.addEventListener('click', (e) => { e.stopPropagation(); togglePin(scene.id); });
      li.appendChild(pin);

      const btn = document.createElement('button');
      btn.className = 'scene-button';
      btn.type = 'button';
      btn.dataset.id = scene.id;
      btn.textContent = scene.name;
      btn.addEventListener('click', () => selectScene(scene.id));
      li.appendChild(btn);
      if (isUserScene(scene.id)) {
        const tag = document.createElement('span');
        tag.className = 'scene-tag';
        tag.textContent = 'saved';
        btn.appendChild(tag);
        const del = document.createElement('button');
        del.className = 'scene-del';
        del.type = 'button';
        del.textContent = '×';
        del.title = 'Delete this saved scene';
        del.setAttribute('aria-label', 'Delete this saved scene');
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          // Deleting a saved scene is destructive and irreversible -- confirm first.
          if (!window.confirm('Delete the saved scene "' + scene.name + '"? This cannot be undone.')) return;
          deleteScene(scene.id);
        });
        li.appendChild(del);
      }
      els.sceneList.appendChild(li);
    }
    highlightActive();
  }
  function highlightActive() {
    els.sceneList.querySelectorAll('.scene-button').forEach((b) => {
      b.classList.toggle('active', b.dataset.id === state.sceneId);
    });
  }
  function deleteScene(id) {
    removeUserScene(id);
    removeSceneFromFile(id);          // clear the disk tier too
    if (state.sceneId === id) {
      state.sceneId = null;
      state.stage = { visible: true, left: { shown: false, srcOverride: null }, right: { shown: false, srcOverride: null }, tokens: [], mapMode: false };
      mapMode = false;
      saveState(state);
      broadcast();
    }
    if (draft && draft.editingId === id) draft = null;
    rebuildSceneList();
    renderUI();
  }

  function setStatus(msg) {
    els.rescanStatus.hidden = false;
    els.rescanStatus.textContent = msg;
  }

  async function rescan() {
    setStatus('Rescanning the asset folders...');
    try {
      const res = await fetch('/rescan', { method: 'POST' });
      if (!res.ok) throw new Error('server responded ' + res.status);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'scan failed');
      backgrounds = Array.isArray(data.backgrounds) ? data.backgrounds : [];
      characters = Array.isArray(data.characters) ? data.characters : [];
      if (Array.isArray(data.music)) audioMusic = data.music;
      if (Array.isArray(data.ambience)) audioAmbience = data.ambience;
      if (Array.isArray(data.sfx)) audioSfx = data.sfx;
      if (draft) renderBuilderInputs();
      const scene = sceneById(state.sceneId);
      if (scene && !draft) renderLive(scene);
      setStatus('Rescanned: ' + backgrounds.length + ' backgrounds, ' + characters.length + ' characters, '
        + audioMusic.length + ' music, ' + audioAmbience.length + ' ambience, ' + audioSfx.length + ' sfx.');
    } catch (err) {
      setStatus('Rescan needs the local server (run: python3 scripts/serve.py). Or run scripts/sync-assets.sh and reload. (' + err.message + ')');
    }
  }
  els.rescanBtn.addEventListener('click', rescan);

  // ============================================================
  //  Top-level render
  // ============================================================
  function renderUI() {
    highlightActive();
    const scene = sceneById(state.sceneId);
    const building = !!draft;
    const inMap = mapMode && !!scene && !building;

    els.empty.hidden = building || !!scene || inMap;
    els.preview.hidden = inMap || !(building || scene);
    // Controls live in the rail and stay in ONE place across live <-> map mode.
    els.controls.hidden = building || !scene;     // shown in live AND map
    els.controlsLive.hidden = inMap;              // character + edit rows: live only
    els.controlsMap.hidden = !inMap;              // save/reset layout: map only
    els.notes.hidden = inMap || building || !scene;
    els.builder.hidden = !building;
    els.mapmode.hidden = !inMap;

    // Persistent rail nav -- Black out + Background + Map<->Exit at one fixed spot,
    // so a quick transition never hunts for a button that moved.
    if (scene && !building) {
      els.visToggle.textContent = state.stage.visible === false ? 'Show scene' : 'Black out';
      els.visToggle.classList.toggle('is-on', state.stage.visible === false);  // lit while blacked out
      els.mapModeToggle.hidden = !sceneHasMap(scene);
      els.mapModeToggle.textContent = inMap ? 'Exit map mode' : 'Map mode';
      els.mapModeToggle.classList.toggle('is-on', inMap);
      renderVariantButtons(scene);
    }

    // Surface audio for every selected scene: the full panel when the scene
    // carries audio, otherwise a discoverable empty-state pointing at the builder.
    const showAudio = !inMap && !building && !!scene;
    els.audio.hidden = !showAudio;
    if (showAudio) {
      const audioKey = (scene.audio ? 'full:' : 'empty:') + scene.id;
      if (builtAudioSceneId !== audioKey) {
        if (scene.audio) buildAudioPanel(scene); else buildAudioEmpty(scene);
        builtAudioSceneId = audioKey;
      }
    }

    if (inMap) renderMapMode(scene);
    else if (building) renderBuilderPreview();
    else if (scene) renderLive(scene);

    // A mode chip in the header names the surface that is live right now.
    const mode = building ? 'Editing' : inMap ? 'Map' : scene ? 'Live' : '';
    els.modeChip.hidden = !mode;
    els.modeChip.textContent = mode;
    els.modeChip.className = 'gm-mode-chip' + (mode ? ' is-' + mode.toLowerCase() : '');
    // Keep the GM's local audio monitor in step with the latest state.
    audioEngine.sync(state, scene);
  }

  // First paint, and a broadcast so a Player window already waiting updates.
  seedTokenSeq();
  rebuildSceneList();
  renderUI();
  broadcast();
}

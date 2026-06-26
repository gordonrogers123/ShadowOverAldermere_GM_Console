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
import { mountDiceRoller } from './diceRoller.js';

export function mountGm(root) {
  let state = loadState();
  let draft = null;                 // the in-progress scene while building
  let mapMode = false;              // map mode replaces the live panel for token play
  let activeCueId = null;           // the cue last applied -- lights its rail button
  let cueTimers = [];               // pending setTimeouts for a sequenced cue's beats
  let testTimers = [];              // pending setTimeouts for a builder "Test in preview" run
  const cueOpen = new Set();        // ids of cue cards expanded in the builder
  let previewLarge = false;         // GM preview size toggle (small default, large for map work)
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

        <!-- The performance surface: the controls the GM needs at their fingertips
             while running a scene, in a fixed order below the preview -- cue bar,
             quick actions (background + characters), then a compact audio mixer.
             Quick + Mixer are the live manual surface; map mode swaps in its own
             controls. Nothing jumps between live and map. -->
        <div class="gm-controls" hidden>
          <!-- Cue bar: the numerous one-press transitions, a row below the preview. -->
          <div class="control-row cue-row" hidden>
            <div class="cue-buttons"></div>
          </div>

          <!-- Quick actions (live): background hot-swap + black out, and Left/Right
               character hot-swap + hide -- the common live tweaks, always one tap. -->
          <div class="gm-quick" hidden>
            <div class="quick-row quick-bg-row">
              <span class="control-label">Background</span>
              <div class="quick-bg-buttons"></div>
              <button class="gm-button btn--toggle vis-toggle" type="button" title="Black out the screen (hide everything)">Black out</button>
            </div>
            <div class="quick-row quick-char-row" data-side="left">
              <span class="control-label">Left</span>
              <select class="quick-swap" data-side="left" aria-label="Left character (hot-swap)"></select>
              <button class="gm-button btn--toggle quick-hide" data-side="left" type="button">Hide</button>
            </div>
            <div class="quick-row quick-char-row" data-side="right">
              <span class="control-label">Right</span>
              <select class="quick-swap" data-side="right" aria-label="Right character (hot-swap)"></select>
              <button class="gm-button btn--toggle quick-hide" data-side="right" type="button">Hide</button>
            </div>
          </div>

          <!-- Audio mixer (live): compact vertical faders (Master/Music/Ambience)
               with a mute each, a one-press Fade in/out, and the SFX buttons.
               Built by renderMixer(); the full per-bed panel sits collapsed below. -->
          <div class="gm-mixer" hidden>
            <div class="mixer-faders"></div>
            <div class="mixer-extra"></div>
          </div>

          <div class="control-row controls-nav">
            <button class="gm-button btn--quiet map-mode-toggle" type="button" hidden>Map mode</button>
            <button class="gm-button btn--quiet edit-scene" type="button">Edit</button>
          </div>

          <!-- Map-mode controls: reveal the map variant + Save/Reset layout. Shown
               only in map mode; the quick + mixer modules take over in live. -->
          <details class="all-controls" hidden>
            <summary class="all-controls-summary">Map controls</summary>
            <div class="all-controls-body">
              <div class="control-row variant-row">
                <span class="control-label">Background</span>
                <div class="variant-buttons"></div>
              </div>
              <div class="controls-map" hidden>
                <div class="control-row">
                  <button class="gm-button btn--save mm-save-layout" type="button">Save layout</button>
                  <button class="gm-button btn--quiet mm-reset-layout" type="button" hidden>Reset to saved layout</button>
                </div>
              </div>
            </div>
          </details>
        </div>
      </aside>

      <section class="gm-stage">
        <p class="gm-empty">Pick a scene to begin, or build a new one.</p>

        <figure class="gm-preview" hidden>
          <div class="preview-frame"></div>
          <figcaption class="preview-cap">
            <span class="preview-name"></span>
            <span class="badge"></span>
            <button class="gm-button btn--quiet preview-size" type="button" title="Toggle preview size (larger for map building)">⤢ Larger</button>
          </figcaption>
        </figure>

        <!-- (Live controls moved into the rail; see .gm-controls in .gm-scenes above.) -->

        <div class="gm-notes" hidden>
          <h3 class="gm-h3">GM notes</h3>
          <p class="notes-body"></p>
        </div>

        <!-- The full per-bed audio panel (outputs, per-track Vol/Pan/Play, Save).
             Collapsed by default now that the compact mixer carries the live
             controls -- this is the setup/detail view, one click away. -->
        <details class="gm-audio" hidden>
          <summary class="gm-audio-summary">Audio &mdash; full panel <small>(per-bed Vol/Pan, outputs, save)</small></summary>
          <div class="audio-body"></div>
        </details>

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
              <details class="field builder-collapse">
                <summary>Roster <small>(map tokens &mdash; who can be placed on the map)</small></summary>
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
              </details>

              <details class="field builder-collapse">
                <summary>Audio <small>(music beds, ambience loops, one-shot SFX)</small></summary>
                <div class="audio-pick">
                  <div class="audio-pick-group"><span class="audio-pick-label">Music <small>(one or more beds; cues choose which plays)</small></span><div class="b-music"></div></div>
                  <div class="audio-pick-group"><span class="audio-pick-label">Ambience</span><div class="b-ambience"></div></div>
                  <div class="audio-pick-group"><span class="audio-pick-label">SFX</span><div class="b-sfx"></div></div>
                </div>
              </details>

              <div class="field">
                <span>Cues <small>(one-press stage transitions &mdash; build each one: pick a background, characters, audio, then keyframe what should be timed)</small></span>
                <div class="cue-list"></div>
                <p class="cue-empty-hint" hidden>No cues yet. Press <strong>+ New cue</strong> to build one.</p>
                <button class="gm-button btn--quiet cue-new" type="button">+ New cue</button>
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
    stage:        root.querySelector('.gm-stage'),
    preview:      root.querySelector('.gm-preview'),
    previewFrame: root.querySelector('.preview-frame'),
    previewSize:  root.querySelector('.preview-size'),
    previewName:  root.querySelector('.preview-name'),
    badge:        root.querySelector('.badge'),
    controls:     root.querySelector('.gm-controls'),
    cueRow:       root.querySelector('.cue-row'),
    cueButtons:   root.querySelector('.cue-buttons'),
    quick:        root.querySelector('.gm-quick'),
    quickBgButtons: root.querySelector('.quick-bg-buttons'),
    mixer:        root.querySelector('.gm-mixer'),
    mixerFaders:  root.querySelector('.mixer-faders'),
    mixerExtra:   root.querySelector('.mixer-extra'),
    allControls:  root.querySelector('.all-controls'),
    allControlsBody: root.querySelector('.all-controls-body'),
    visToggle:    root.querySelector('.vis-toggle'),
    editScene:    root.querySelector('.edit-scene'),
    variantRow:   root.querySelector('.variant-row'),
    variantButtons: root.querySelector('.variant-buttons'),
    notes:        root.querySelector('.gm-notes'),
    notesTitle:   root.querySelector('.gm-notes .gm-h3'),
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
    cueList:      root.querySelector('.cue-list'),
    cueEmptyHint: root.querySelector('.cue-empty-hint'),
    cueNew:       root.querySelector('.cue-new'),
    quickSwap: {
      left:  root.querySelector('.quick-swap[data-side="left"]'),
      right: root.querySelector('.quick-swap[data-side="right"]')
    },
    quickHide: {
      left:  root.querySelector('.quick-hide[data-side="left"]'),
      right: root.querySelector('.quick-hide[data-side="right"]')
    }
  };

  const previewView = createStageView(els.previewFrame);

  // Layout: the performance surface puts the control surface and the preview
  // SIDE BY SIDE (compact mode) so the whole thing fits on one screen. Within the
  // controls, the audio mixer + quick-action modules pair side by side at the
  // top, the cue bar is a row beneath them, and the nav (Edit) + extended map
  // controls sit below. GM notes move to the bottom of the left rail. The markup
  // keeps each as one readable block; we relocate the nodes here, so toggling
  // their .hidden / contents in renderUI works the same wherever they sit.
  // Compact live: the preview sits in the CENTRE, the control panel (quick-action
  // + mixer modules, stacked) on the RIGHT at the SAME height as the preview, and
  // the cue bar as a full-width row directly UNDER the preview, then the Edit/Map
  // nav. The controls keep their single .gm-controls wrapper (so one .hidden
  // toggle still shows/hides them as a group); CSS display:contents drops its
  // pieces -- cue bar / side panel / nav -- straight into the surface grid.
  // Larger stacks a full-width preview ABOVE the controls (the classic order:
  // preview, cue, quick, mixer, nav). GM notes move to the rail.
  const perfSide = document.createElement('div');
  perfSide.className = 'perf-side';
  els.mixer.before(perfSide);
  perfSide.append(els.quick, els.mixer);   // quick (visual) over the mixer (audio)
  const surface = document.createElement('div');
  surface.className = 'gm-surface';
  els.preview.before(surface);
  surface.append(els.preview, els.controls);   // preview centre; controls flow via display:contents
  root.querySelector('.gm-scenes').appendChild(els.notes);  // notes fill the rail bottom

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
  function expandLayout(layout) {
    return (Array.isArray(layout) ? layout : [])
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
  function expandSavedLayout(scene) { return expandLayout(scene && scene.savedLayout); }
  function selectScene(id) {
    const scene = sceneById(id);
    if (!scene) return;
    cancelCueTimeline(); cancelTestTimeline();   // a scene change cancels any in-flight cue/test sequence
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
    activeCueId = null;
    // If the scene defines an opening cue, fire it as part of the same select so
    // the title card + title music come up in one atomic transition (no extra
    // click). A persisting black-out carries through it, like the base stage.
    const opening = (scene.cues || []).find((c) => c.opening);
    if (opening) applyCueState(opening, scene, { wasBlackedOut });
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
  // Quick hot-swap: picking someone from the dropdown brings them on INSTANTLY
  // (overriding the scene default). Choosing "Scene default" clears the override
  // and shows the scene's own character there -- or hides the side if it has none.
  function quickSwap(side, src) {
    const scene = sceneById(state.sceneId);
    state.stage[side].srcOverride = src || null;
    state.stage[side].shown = !!src || !!(scene && scene.characters && scene.characters[side]);
    commit();
  }

  els.visToggle.addEventListener('click', toggleVisible);
  els.cueNew.addEventListener('click', () => addCue());
  els.editScene.addEventListener('click', () => openBuilder(sceneById(state.sceneId)));
  els.previewSize.addEventListener('click', () => {
    previewLarge = !previewLarge;
    // The class drives the whole surface: compact lays the preview beside the
    // controls; large stacks a full-width preview above them.
    els.stage.classList.toggle('is-large', previewLarge);
    els.previewSize.textContent = previewLarge ? '⤡ Smaller' : '⤢ Larger';
  });
  els.mapModeToggle.addEventListener('click', () => { if (mapMode) exitMapMode(); else enterMapMode(); });
  els.mmSaveLayout.addEventListener('click', saveLayout);
  els.mmResetLayout.addEventListener('click', resetLayout);
  for (const side of ['left', 'right']) {
    els.quickHide[side].addEventListener('click', () => toggleSide(side));
    els.quickSwap[side].addEventListener('change', () => quickSwap(side, els.quickSwap[side].value));
  }

  // Build the background-variant buttons into a container; shared by the live
  // controls and the map-mode panel. Returns the variant count.
  // A variant can be flagged to show only in scene (cinematic) mode, only in
  // map mode, or both. Absent variantModes -> shown in both (so existing scenes
  // are unchanged). The rail offers only the variants that apply to the mode
  // you are in, so map backdrops stay out of the cinematic picker and vice versa.
  function variantInMode(scene, key, inMap) {
    const vm = scene && scene.variantModes && scene.variantModes[key];
    if (!vm) return true;
    return inMap ? vm.map !== false : vm.scene !== false;
  }
  function buildVariantButtons(container, scene) {
    container.innerHTML = '';
    const keys = (scene.maps ? Object.keys(scene.maps) : []).filter((k) => variantInMode(scene, k, mapMode));
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
    // Show the picker whenever at least one variant applies to the current mode
    // (a mode often has a single backdrop -- e.g. the one map in map mode -- that
    // the GM still needs to activate/reveal), and hide it only when none do.
    els.variantRow.hidden = buildVariantButtons(els.variantButtons, scene) < 1;
  }

  // ============================================================
  //  Cues: one-press stage presets
  // ------------------------------------------------------------
  //  A cue is a saved snapshot of the whole stage -- which background variant is
  //  up, scene-vs-map mode, the curtain, who is on left/right, and which audio
  //  plays. Pressing it sets the full target state and commits once, so the
  //  shared compositor + audio engine transition every aspect together (the same
  //  machinery selectScene already uses). Cues are scene template data (like
  //  savedLayout), carried opaquely through persistence -- no state.js change.
  // ============================================================
  // Every aspect on by default; a cue narrows this so a quick character swap does
  // not disturb the background or music.
  function defaultAffects() {
    return { background: true, mapMode: true, curtain: true, characters: true, tokens: true, audio: true };
  }
  function cueAffects(cue) { return { ...defaultAffects(), ...(cue && cue.affects) }; }
  function uniqueCueId(cues, base) {
    base = base || 'cue';
    let id = base, n = 2;
    while ((cues || []).some((c) => c.id === id)) { id = base + '-' + n; n += 1; }
    return id;
  }
  // Apply only the aspects a cue affects to the live state. No commit -- the
  // caller commits once so every change animates in a single pass. opts.wasBlackedOut
  // keeps a global black-out down through a curtain-affecting cue (used by the
  // opening cue on scene select; a manual press passes false so a reveal cue lifts).
  // opts.skip is a Set of aspect keys ('background'/'curtain'/'characters'/'audio'/
  // 'sfx') the caller will animate on a keyframe instead -- they are left untouched
  // here so the t=0 pass does not pop them early or apply them twice.
  function applyCueState(cue, scene, opts) {
    opts = opts || {};
    const skip = opts.skip || new Set();
    const snap = (cue && cue.snapshot) || {};
    const aff = cueAffects(cue);
    ensureAudio();
    if (!state.stage) {
      state.stage = { visible: true, left: { shown: false, srcOverride: null }, right: { shown: false, srcOverride: null }, tokens: [], mapMode: false };
    }
    // Background -- only switch to a variant the scene still has (fail safe).
    if (aff.background && !skip.has('background') && snap.mapState != null &&
        scene && scene.maps && Object.prototype.hasOwnProperty.call(scene.maps, snap.mapState)) {
      state.mapState = snap.mapState;
    }
    // Map mode -- set BOTH the module var and the stage flag; never call
    // enter/exitMapMode here (they each commit). Only enter if the scene has a map.
    // Rides with the background lane (the choreographed swap handles both).
    if (aff.mapMode && !skip.has('background')) {
      const wantMap = !!snap.mapMode && sceneHasMap(scene);
      mapMode = wantMap;
      state.stage.mapMode = wantMap;
    }
    // Curtain -- a cue that affects the curtain sets it; one that does not leaves
    // it exactly as-is (so a quick character swap never flashes the black plate).
    if (aff.curtain && !skip.has('curtain')) {
      state.stage.visible = opts.wasBlackedOut ? false : (snap.visible !== false);
    }
    // Characters -- the compositor diffs each side and animates only what changed.
    if (aff.characters && !skip.has('characters')) {
      const side = (s) => ({ shown: !!(s && s.shown), srcOverride: (s && s.srcOverride) || null });
      state.stage.left = side(snap.left);
      state.stage.right = side(snap.right);
    }
    // Tokens -- fresh instIds via the savedLayout expansion.
    if (aff.tokens && !skip.has('tokens')) state.stage.tokens = expandLayout(snap.tokens);
    // Audio beds -- flip each existing track's playing to match the snapshot set
    // (the engine cross-fades both ways) and rebuild the panel. Gated by 'audio'.
    if (aff.audio && snap.audio && !skip.has('audio')) {
      const tracks = state.audio.tracks || {};
      // Map the legacy single-music key to the first bed so cues captured before
      // the music library still play (tracks are 'mus:<i>' now).
      const set = new Set((snap.audio.playing || []).map((k) => (k === 'music' ? 'mus:0' : k)));
      for (const k of Object.keys(tracks)) tracks[k].playing = set.has(k);
      if (snap.audio.master != null) state.audio.master = snap.audio.master;
      builtAudioSceneId = null;       // force the audio panel to reflect the new set
    }
    // SFX one-shots -- independent of the bed set, so a cue can fire a sound
    // without touching the music. Gated by 'sfx' so its lane can be keyframed.
    if (snap.audio && !skip.has('sfx')) {
      for (const id of (snap.audio.sfx || [])) {
        state.audio.sfxTrigger[id] = (state.audio.sfxTrigger[id] || 0) + 1;
      }
    }
    activeCueId = cue ? cue.id : null;
  }
  function applyCue(cue) {
    const scene = sceneById(state.sceneId);
    if (!scene || !cue) return;
    cancelCueTimeline();                 // a new press always wins over a running one
    activeCueId = cue.id;                // light the button immediately
    // The cue plays as a timed sequence only for the elements the GM chose to
    // keyframe; everything else it affects snaps at t=0. No keyframed element ->
    // a single instant commit (the classic one-press behavior).
    const keyed = cue.opening ? [] : keyframedLanes(cue);
    if (keyed.length) { renderUI(); playCueTimeline(cue, scene, keyed); }
    else { applyCueState(cue, scene, { wasBlackedOut: false }); commit(); }
  }

  // ============================================================
  //  Cue keyframes: choreographed (timed) cue playback
  // ------------------------------------------------------------
  //  A sequenced cue (cue.timeline present) plays its change as a short timeline
  //  of beats -- fade to black + audio out -> swap the backdrop behind the black
  //  -> reveal -> SFX -> characters enter -- instead of one instant commit. Each
  //  beat mutates a SUBSET of state, sets the transition speed for that element
  //  (state.stage.fx / state.audio.ramp -> the compositor + engine animate it),
  //  and commits; the GM authors each lane's Start + Ramp in the builder.
  // ============================================================
  function defaultTimeline() {
    return {
      blackout:   { at: 0,    ramp: 700 },   // curtain down
      audioOut:   { at: 0,    ramp: 600 },   // current beds fade down
      background: { at: 800,  ramp: 400 },   // swap variant behind the black
      audioIn:    { at: 1000, ramp: 1000 },  // the cue's beds fade up
      reveal:     { at: 1000, ramp: 700 },   // curtain up
      sfx:        { at: 1600 },              // one-shot(s)
      characters: { at: 2000, ramp: 500 }    // left/right enter
    };
  }
  // Validate a timeline for save/export: clamp every lane's start/ramp to a
  // non-negative integer ms, keeping only known lanes. null when absent/empty.
  function normalizeTimeline(tl) {
    if (!tl || typeof tl !== 'object') return null;
    const def = defaultTimeline();
    const out = {};
    for (const k of Object.keys(def)) {
      const l = tl[k];
      if (!l || typeof l !== 'object') continue;
      const at = Math.max(0, Math.round(+l.at || 0));
      const lane = { at };
      if (def[k].ramp != null) lane.ramp = Math.max(0, Math.round(l.ramp != null ? +l.ramp : def[k].ramp));
      out[k] = lane;
    }
    return Object.keys(out).length ? out : null;
  }
  // Which lanes a cue CAN run, gated by what it affects (and whether it carries
  // SFX). The curtain spine (fade to black / reveal) is only in play when the cue
  // affects the curtain -- "Fade to black first". Mirrors the builder editor.
  function cueLanes(cue) {
    const aff = cueAffects(cue);
    const snap = cue.snapshot || {};
    const hasSfx = !!(snap.audio && (snap.audio.sfx || []).length);
    return [
      ['blackout', !!aff.curtain],
      ['audioOut', !!aff.audio],
      ['background', !!aff.background],
      ['audioIn', !!aff.audio],
      ['reveal', !!aff.curtain],
      ['sfx', hasSfx],
      ['characters', !!aff.characters]
    ].filter(([, on]) => on).map(([k]) => k);
  }
  // The applicable lanes the GM actually keyframed (present in cue.timeline).
  // These play on the timeline; every other affected aspect snaps at t=0.
  function keyframedLanes(cue) {
    const tl = (cue && cue.timeline) || {};
    return cueLanes(cue).filter((name) => tl[name] && typeof tl[name] === 'object');
  }
  function hasTimeline(cue) { return keyframedLanes(cue).length > 0; }
  // Map keyframed lanes to the applyCueState aspect keys they own, so the t=0
  // instant pass skips exactly those (they animate on the timeline instead).
  const LANE_ASPECT = { blackout: 'curtain', reveal: 'curtain', audioOut: 'audio',
    audioIn: 'audio', background: 'background', sfx: 'sfx', characters: 'characters' };
  function lanesToAspects(lanes) {
    const s = new Set();
    for (const l of lanes) if (LANE_ASPECT[l]) s.add(LANE_ASPECT[l]);
    return s;
  }
  // Push a ramp (ms) onto a stage object's transient fx so stageView animates
  // that element at the cue's speed. Used for both the live state and the
  // builder's Test-in-preview state.
  function setFx(stage, key, ramp) {
    if (!stage) return;
    if (!stage.fx) stage.fx = {};
    if (ramp != null && isFinite(+ramp)) stage.fx[key] = Math.max(0, +ramp);
  }
  function setStageFx(key, ramp) { setFx(state.stage, key, ramp); }
  // Drop the transient ramp hints so ordinary play uses the CSS/engine defaults.
  function clearCueFx() {
    if (state.stage && state.stage.fx) delete state.stage.fx;
    if (state.audio && state.audio.ramp != null) delete state.audio.ramp;
  }
  function cancelCueTimeline() {
    for (const id of cueTimers) clearTimeout(id);
    cueTimers = [];
    clearCueFx();
  }
  // Apply one lane's change to live state (no commit -- the scheduler commits).
  function runCueLane(name, lane, cue, scene) {
    ensureAudio();
    if (!state.stage) {
      state.stage = { visible: true, left: { shown: false, srcOverride: null }, right: { shown: false, srcOverride: null }, tokens: [], mapMode: false };
    }
    const snap = cue.snapshot || {};
    const aff = cueAffects(cue);
    const tracks = state.audio.tracks || {};
    if (name === 'blackout') {
      state.stage.visible = false;
      setStageFx('curtain', lane.ramp);
    } else if (name === 'audioOut') {
      for (const k of Object.keys(tracks)) tracks[k].playing = false;   // everything fades down
      state.audio.ramp = Math.max(0, +lane.ramp || 0);
      builtAudioSceneId = null;
    } else if (name === 'background') {
      if (snap.mapState != null && scene.maps && Object.prototype.hasOwnProperty.call(scene.maps, snap.mapState)) {
        state.mapState = snap.mapState;
      }
      if (aff.mapMode) { const wantMap = !!snap.mapMode && sceneHasMap(scene); mapMode = wantMap; state.stage.mapMode = wantMap; }
      setStageFx('crossfade', lane.ramp);
    } else if (name === 'audioIn') {
      const set = new Set(((snap.audio && snap.audio.playing) || []).map((k) => (k === 'music' ? 'mus:0' : k)));
      for (const k of Object.keys(tracks)) tracks[k].playing = set.has(k);
      if (snap.audio && snap.audio.master != null) state.audio.master = snap.audio.master;
      state.audio.ramp = Math.max(0, +lane.ramp || 0);
      builtAudioSceneId = null;
    } else if (name === 'reveal') {
      state.stage.visible = !(snap.visible === false);
      setStageFx('curtain', lane.ramp);
    } else if (name === 'sfx') {
      for (const id of ((snap.audio && snap.audio.sfx) || [])) {
        state.audio.sfxTrigger[id] = (state.audio.sfxTrigger[id] || 0) + 1;
      }
    } else if (name === 'characters') {
      const side = (s) => ({ shown: !!(s && s.shown), srcOverride: (s && s.srcOverride) || null });
      state.stage.left = side(snap.left);
      state.stage.right = side(snap.right);
      setStageFx('char', lane.ramp);
    }
    activeCueId = cue.id;
  }
  function playCueTimeline(cue, scene, keyed) {
    keyed = keyed || keyframedLanes(cue);
    const tl = { ...defaultTimeline(), ...(cue.timeline || {}) };
    // t=0: snap every affected aspect that is NOT keyframed (background, audio,
    // characters... whatever the GM left un-timed), in one commit. The keyframed
    // lanes own the rest and animate at their Start.
    applyCueState(cue, scene, { wasBlackedOut: false, skip: lanesToAspects(keyed) });
    commit();
    let lastEnd = 0;
    for (const name of keyed) {
      const lane = tl[name] || defaultTimeline()[name];
      const at = Math.max(0, +lane.at || 0);
      lastEnd = Math.max(lastEnd, at + (+lane.ramp || 0));
      cueTimers.push(setTimeout(() => { runCueLane(name, lane, cue, scene); commit(); }, at));
    }
    // Once the last beat has settled, drop the transient ramp hints + commit so
    // any later manual action animates at the normal speed.
    cueTimers.push(setTimeout(() => { clearCueFx(); commit(); }, lastEnd + 300));
  }
  function cancelTestTimeline() {
    for (const id of testTimers) clearTimeout(id);
    testTimers = [];
  }
  // Play a cue's VISUAL choreography in the GM preview only (no commit, no
  // broadcast, no audio) so the GM can dial in Start/Ramp from the builder
  // without opening a Player window. Runs against a throwaway preview state and
  // restores the draft preview when done.
  function testCueTimeline(cue) {
    cancelTestTimeline();
    if (!draft) return;
    const scene = draftToScene(draft);
    const tl = { ...defaultTimeline(), ...(cue.timeline || {}) };
    const snap = cue.snapshot || {};
    const aff = { ...defaultAffects(), ...(cue.affects || {}) };
    const keyed = new Set(keyframedLanes(cue));   // only these animate; the rest snap
    const firstKey = Object.keys(scene.maps || {})[0] || 'revealed';
    const side = (s) => ({ shown: !!(s && s.shown), srcOverride: (s && s.srcOverride) || null });
    // Baseline: the scene's first backdrop, curtain up, nobody on. Then snap every
    // affected VISUAL aspect the GM did NOT keyframe, so the test shows only the
    // timed elements moving (a character walking in over a settled background).
    const ps = { sceneId: scene.id, mapState: firstKey,
      stage: { visible: true, left: { shown: false, srcOverride: null }, right: { shown: false, srcOverride: null }, tokens: [], mapMode: false } };
    const hasVariant = snap.mapState != null && scene.maps && Object.prototype.hasOwnProperty.call(scene.maps, snap.mapState);
    if (aff.background !== false && !keyed.has('background') && hasVariant) ps.mapState = snap.mapState;
    if (aff.characters !== false && !keyed.has('characters')) { ps.stage.left = side(snap.left); ps.stage.right = side(snap.right); }
    if (aff.curtain !== false && !keyed.has('blackout') && !keyed.has('reveal')) ps.stage.visible = !(snap.visible === false);
    const paint = () => previewView.render(ps, scene, {});
    paint();
    // Visual beats, scheduled only when the GM keyframed them.
    const beats = [
      ['blackout', () => { ps.stage.visible = false; setFx(ps.stage, 'curtain', tl.blackout.ramp); }],
      ['background', () => { if (hasVariant) ps.mapState = snap.mapState; setFx(ps.stage, 'crossfade', tl.background.ramp); }],
      ['reveal', () => { ps.stage.visible = !(snap.visible === false); setFx(ps.stage, 'curtain', tl.reveal.ramp); }],
      ['characters', () => { ps.stage.left = side(snap.left); ps.stage.right = side(snap.right); setFx(ps.stage, 'char', tl.characters.ramp); }]
    ];
    let lastEnd = 0;
    for (const [name, fn] of beats) {
      if (!keyed.has(name)) continue;
      const lane = tl[name] || defaultTimeline()[name];
      const at = Math.max(0, +lane.at || 0);
      lastEnd = Math.max(lastEnd, at + (+lane.ramp || 0));
      testTimers.push(setTimeout(() => { fn(); paint(); }, at));
    }
    // Hold the final frame a beat, then return the preview to the editing baseline.
    testTimers.push(setTimeout(() => { cancelTestTimeline(); renderBuilderPreview(); }, lastEnd + 900));
  }
  function renderCueButtons(scene) {
    const cues = (scene && scene.cues) || [];
    els.cueButtons.innerHTML = '';
    for (const cue of cues) {
      const btn = document.createElement('button');
      btn.className = 'gm-button btn--toggle cue-button';
      btn.type = 'button';
      btn.textContent = cue.label || cue.id;
      if (cue.opening) btn.classList.add('is-opening');
      if (hasTimeline(cue)) btn.classList.add('is-sequenced');   // wears a ▸ play glyph
      const note = [cue.opening ? 'opening cue (fires on select)' : '', hasTimeline(cue) ? 'plays as a timed sequence' : '']
        .filter(Boolean).join(', ');
      btn.title = note ? (cue.label || cue.id) + ' — ' + note : (cue.label || cue.id);
      btn.classList.toggle('active', cue.id === activeCueId);
      btn.addEventListener('click', () => applyCue(cue));
      els.cueButtons.appendChild(btn);
    }
    // Show the cue rail only when the scene has cues (they are authored in the
    // editor now, not captured live, so there is no always-on Save button here).
    els.cueRow.hidden = cues.length === 0;
  }
  // ---- Quick actions (live manual surface): background + characters ----
  // The always-on row of common live tweaks, below the cue bar. Background chips
  // switch the backdrop instantly; each character side has a hot-swap dropdown
  // (picking someone brings them on at once) and a Hide/Show toggle.
  function renderQuick(scene) {
    buildVariantButtons(els.quickBgButtons, scene);   // cinematic variants; lights the active one
    for (const side of ['left', 'right']) {
      const hasChar = !!(scene.characters && scene.characters[side]) || !!state.stage[side].srcOverride;
      fillCharSelect(els.quickSwap[side], state.stage[side].srcOverride || '', true);   // first option = Scene default
      const shown = state.stage[side].shown;
      els.quickHide[side].textContent = shown ? 'Hide' : 'Show';
      els.quickHide[side].classList.toggle('is-on', !shown);   // lit while that side is hidden
      els.quickHide[side].disabled = !hasChar;
    }
  }

  // ---- Audio mixer (compact live surface): faders + mute + fade + SFX ----
  // The live track keys for a category ('mus'/'amb'); 'master' is special-cased.
  function mixerTrackKeys(kind) {
    ensureAudio();
    const t = state.audio.tracks || {};
    return Object.keys(t).filter((k) => k.indexOf(kind + ':') === 0);
  }
  function mixerGroupMuted(kind) {
    const keys = mixerTrackKeys(kind);
    return keys.length > 0 && keys.every((k) => state.audio.tracks[k].muted);
  }
  // A labelled vertical fader + a mute. kind: 'master' | 'mus' | 'amb'. The group
  // faders drive every bed in their category together (one live level), with the
  // first bed as the representative reading.
  function buildFader(label, kind) {
    const col = document.createElement('div'); col.className = 'mixer-fader';
    const name = document.createElement('span'); name.className = 'mixer-fader-name'; name.textContent = label;
    const sliderWrap = document.createElement('div'); sliderWrap.className = 'mixer-slider-wrap';
    const slider = document.createElement('input');
    slider.type = 'range'; slider.className = 'mixer-slider'; slider.min = 0; slider.max = 1; slider.step = 0.01;
    sliderWrap.append(slider);
    const groupVal = () => {
      if (kind === 'master') return state.audio.master == null ? 0.8 : state.audio.master;
      const keys = mixerTrackKeys(kind);
      return keys.length ? state.audio.tracks[keys[0]].volume : 0.8;
    };
    slider.value = groupVal();
    slider.addEventListener('input', () => {
      ensureAudio();
      const v = +slider.value;
      if (kind === 'master') state.audio.master = v;
      else for (const k of mixerTrackKeys(kind)) state.audio.tracks[k].volume = v;
      commitAudio();
    });
    const mute = document.createElement('button');
    mute.className = 'gm-button btn--toggle mixer-mute'; mute.type = 'button'; mute.textContent = 'Mute';
    mute.dataset.kind = kind;
    const isMuted = () => kind === 'master' ? !!state.audio.masterMuted : mixerGroupMuted(kind);
    mute.classList.toggle('is-on', isMuted());
    mute.addEventListener('click', () => {
      ensureAudio();
      if (kind === 'master') state.audio.masterMuted = !state.audio.masterMuted;
      else { const want = !isMuted(); for (const k of mixerTrackKeys(kind)) state.audio.tracks[k].muted = want; }
      mute.classList.toggle('is-on', isMuted());
      commitAudio();
    });
    col.append(name, sliderWrap, mute);
    return col;
  }
  // Fade the whole mix out (or back in) over a slow ramp -- one toggle button.
  // Rides masterMuted (so it shares the Master mute state) but with a long ramp.
  function fadeAudio() {
    ensureAudio();
    state.audio.ramp = 1800;                              // slow gain ramp for the fade
    state.audio.masterMuted = !state.audio.masterMuted;
    commitAudio();
    renderMixer(sceneById(state.sceneId));               // refresh Fade + Master-mute lit states
    setTimeout(() => { if (state.audio) { delete state.audio.ramp; commitAudio(); } }, 2100);
  }
  function renderMixer(scene) {
    ensureAudio();
    els.mixerFaders.innerHTML = '';
    els.mixerExtra.innerHTML = '';
    const a = (scene && scene.audio) || {};
    els.mixerFaders.append(buildFader('Master', 'master'));
    if (musicBeds(a).length) els.mixerFaders.append(buildFader('Music', 'mus'));
    if ((a.ambience || []).length) els.mixerFaders.append(buildFader('Ambience', 'amb'));

    // SFX get their own mixer column: a label with the one-shot buttons stacked
    // beneath it, sitting alongside the faders.
    if ((a.sfx || []).length) {
      const col = document.createElement('div'); col.className = 'mixer-fader mixer-sfx-col';
      const name = document.createElement('span'); name.className = 'mixer-fader-name'; name.textContent = 'SFX';
      const btns = document.createElement('div'); btns.className = 'mixer-sfx-buttons';
      for (const s of (a.sfx || [])) {
        const b = document.createElement('button');
        b.className = 'gm-button mixer-sfx'; b.type = 'button'; b.dataset.sfx = s.id; b.textContent = humanize(s.id);
        b.addEventListener('click', () => { ensureAudio(); state.audio.sfxTrigger[s.id] = (state.audio.sfxTrigger[s.id] || 0) + 1; commitAudio(); });
        btns.append(b);
      }
      col.append(name, btns);
      els.mixerFaders.append(col);
    }

    // The whole-mix Fade sits on its own row below the columns.
    const fade = document.createElement('button');
    fade.className = 'gm-button btn--toggle mixer-fade'; fade.type = 'button';
    fade.textContent = state.audio.masterMuted ? 'Fade in' : 'Fade out';
    fade.classList.toggle('is-on', !!state.audio.masterMuted);
    fade.title = 'Fade all audio out / back in';
    fade.addEventListener('click', fadeAudio);
    els.mixerExtra.append(fade);
  }

  // GM notes shown live: a cue's own notes when it is the active cue (so blocking
  // text follows the beat), otherwise the scene's default note.
  function activeCueNotes(scene) {
    const cue = scene && (scene.cues || []).find((c) => c.id === activeCueId);
    if (cue && (cue.notes || '').trim()) return cue.notes;
    return scene ? (scene.gmNotes || '') : '';
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

    // GM notes follow the active cue: when the active cue has its own note, the
    // panel is titled with that cue's name (so it reads as the cue's blocking),
    // otherwise it falls back to the scene's default note under "GM notes".
    const activeCue = scene && (scene.cues || []).find((c) => c.id === activeCueId);
    const cueHasNote = !!(activeCue && (activeCue.notes || '').trim());
    els.notesTitle.textContent = cueHasNote ? (activeCue.label || 'Cue') : 'GM notes';
    els.notesBody.textContent = activeCueNotes(scene);
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
  // A scene's music as an array of beds, accepting either the new array form or
  // a single legacy `{src,...}` object. Multiple beds let cues vary the music.
  function musicBeds(a) {
    if (!a) return [];
    const m = a.music;
    if (Array.isArray(m)) return m.filter((x) => x && x.src);
    return (m && m.src) ? [m] : [];
  }
  // Seed live tracks from a scene's audio config, preserving the GM's session
  // master/outputs. Music/ambience start NOT playing (cued deliberately).
  function seedAudioFromScene(scene, prev) {
    prev = prev || {};
    const a = (scene && scene.audio) || {};
    const tracks = {};
    musicBeds(a).forEach((m, i) => { tracks['mus:' + i] = trackFromCfg(m); });
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
    // Tune each music bed in place, preserving the stored shape (array or the
    // single legacy object) so existing scenes are not reshaped on a Save.
    if (Array.isArray(a.music)) a.music.forEach((m, i) => { const t = tr['mus:' + i]; if (t && m) Object.assign(m, tune(t)); });
    else if (a.music && a.music.src) { const t = tr['mus:0']; if (t) Object.assign(a.music, tune(t)); }
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

    const beds = musicBeds(a);
    beds.forEach((m, i) => {
      els.audioBody.append(buildTrackBlock('mus:' + i, beds.length > 1 ? 'Music ' + (i + 1) : 'Music', m));
    });
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
    // Music is now a LIBRARY of beds (checkbox list, like Ambience); cues pick
    // which bed plays. draft.audio.music is an array of {src,volume,pan,loop}.
    buildAudioChecks(els.bMusic, audioMusic,
      (item) => draft.audio.music.some((x) => x.src === item.src),
      (item, on) => {
        if (on) { if (!draft.audio.music.some((x) => x.src === item.src)) draft.audio.music.push({ src: item.src, volume: 0.8, pan: 0, loop: true }); }
        else draft.audio.music = draft.audio.music.filter((x) => x.src !== item.src);
      });
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
    // Music is a library of beds now; accept the new array or a legacy single.
    const music = (Array.isArray(da.music) ? da.music : (da.music ? [da.music] : [])).filter((x) => x && x.src);
    const ambience = (da.ambience || []).filter((x) => x && x.src);
    const sfx = (da.sfx || []).filter((x) => x && x.id && x.src);
    if (!music.length && !ambience.length && !sfx.length) return null;
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
      // New scenes open on the Aldermere title screen (scene mode only), then
      // reveal to a backdrop shown in both modes.
      variants: [
        { key: 'hidden', src: TITLE_SRC, scene: true, map: false },
        { key: 'revealed', src: (backgrounds[0] && backgrounds[0].src) || '', scene: true, map: true }
      ],
      left:  { src: '', enter: DEFAULT_ENTER, scale: 1, flip: false, x: 0, y: 0 },
      right: { src: '', enter: DEFAULT_ENTER, scale: 1, flip: false, x: 0, y: 0 },
      roster: { heroes: [], enemies: [] },
      savedLayout: [],
      cues: [],
      audio: { music: [], ambience: [], sfx: [] }
    };
  }
  function sceneToDraft(scene) {
    // An empty map src is a title-screen variant; surface it as such in the
    // picker. Each variant carries its scene/map visibility; with no stored
    // variantModes the default is both (title screens default to scene-only).
    const variants = Object.entries(scene.maps || {}).map(([key, src]) => {
      const isTitle = src === '';
      const vm = scene.variantModes && scene.variantModes[key];
      return { key, src: isTitle ? TITLE_SRC : src,
        scene: vm ? vm.scene !== false : true,
        map: vm ? vm.map !== false : !isTitle };
    });
    if (!variants.length) variants.push({ key: 'revealed', src: '', scene: true, map: true });
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
      // Captured live; the builder only renames / re-scopes / reorders them.
      cues: Array.isArray(scene.cues) ? JSON.parse(JSON.stringify(scene.cues)) : [],
      audio: scene.audio
        ? { music: musicBeds(scene.audio).map((m) => ({ ...m })),   // normalize legacy single bed -> array
            ambience: Array.isArray(scene.audio.ambience) ? JSON.parse(JSON.stringify(scene.audio.ambience)) : [],
            sfx: Array.isArray(scene.audio.sfx) ? JSON.parse(JSON.stringify(scene.audio.sfx)) : [] }
        : { music: [], ambience: [], sfx: [] }
    };
  }

  function draftToScene(d) {
    const maps = {};
    const variantModes = {};
    d.variants.forEach((v, i) => {
      if (!v.src) return;                              // unset variant -- skip
      let base = slug(v.key) || ('variant-' + (i + 1));
      let key = base; let n = 2;
      while (Object.prototype.hasOwnProperty.call(maps, key)) { key = base + '-' + n; n += 1; }
      maps[key] = v.src === TITLE_SRC ? '' : v.src;     // title screen saves as an empty src
      // Which mode(s) this variant appears in; the rail picker filters by it.
      variantModes[key] = { scene: v.scene !== false, map: v.map !== false };
    });
    const keys = Object.keys(maps);
    const id = d.editingId || slug(d.name);
    const roster = d.roster || { heroes: [], enemies: [] };
    const hasRoster = (roster.heroes && roster.heroes.length) || (roster.enemies && roster.enemies.length);
    const scene = {
      id,
      name: (d.name || '').trim() || humanize(id),
      maps,
      variantModes,
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
    // Cues ride through opaquely (captured live; renamed/re-scoped/reordered in
    // the builder). Normalize the editable fields; keep the captured snapshot.
    if (Array.isArray(d.cues) && d.cues.length) {
      scene.cues = d.cues.map((c) => {
        const out = {
          id: c.id || slug(c.label || 'cue'),
          label: (c.label || c.id || 'Cue'),
          opening: !!c.opening,
          affects: { ...defaultAffects(), ...(c.affects || {}) },
          snapshot: c.snapshot || {}
        };
        if ((c.notes || '').trim()) out.notes = c.notes.trim();   // per-cue GM note (optional)
        const tl = normalizeTimeline(c.timeline);
        if (tl) out.timeline = tl;   // only sequenced cues carry a timeline
        return out;
      });
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
    cancelCueTimeline();   // stop any running sequence before editing
    draft = scene ? sceneToDraft(scene) : blankDraft();
    renderBuilderInputs();
    renderUI();
  }
  function closeBuilder() { cancelTestTimeline(); draft = null; renderUI(); }

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

      // Per-variant visibility: which mode(s) this backdrop appears in. The rail
      // picker filters by the current mode, so map backdrops stay out of the
      // cinematic view and vice versa.
      const modes = document.createElement('span');
      modes.className = 'v-modes';
      const modeBtn = (label, prop, title) => {
        const btn = document.createElement('button');
        btn.className = 'gm-button btn--toggle v-mode';
        btn.type = 'button';
        btn.textContent = label;
        btn.title = title;
        const sync = () => { const on = v[prop] !== false; btn.classList.toggle('is-on', on); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); };
        sync();
        btn.addEventListener('click', () => { v[prop] = (v[prop] === false); sync(); });
        return btn;
      };
      modes.append(modeBtn('Scene', 'scene', 'Show this variant in scene (cinematic) mode'),
                   modeBtn('Map', 'map', 'Show this variant in map mode'));

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

      row.append(keyInput, sel, modes, tag, rm);
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
    renderCueRows();
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

  // ---- Explicit cue builder -------------------------------------------------
  // A cue is AUTHORED here, not captured live: the GM picks the Background, who is
  // on the Left/Right, the Audio + SFX, and whether to fade to black first -- then
  // chooses, per element, whether it snaps instantly or animates on a keyframe
  // (its own Start + Ramp). Each cue is a collapsible card so the list stays
  // scannable; the new/edited one is expanded.

  // Make a fresh, empty cue. Nothing is affected until the GM picks content, so a
  // brand-new cue does nothing until built -- no accidental fade-to-title.
  function blankCue(cues) {
    const n = (cues || []).length + 1;
    const label = 'Cue ' + n;
    return {
      id: uniqueCueId(cues, slug(label)),
      label,
      opening: false,
      notes: '',
      affects: { background: false, characters: false, audio: false, mapMode: false, curtain: false, tokens: false },
      snapshot: { mapState: null, mapMode: false, visible: true,
        left: { shown: false, srcOverride: null }, right: { shown: false, srcOverride: null },
        tokens: [], audio: { playing: [], master: 0.8, sfx: [] } }
    };
  }
  function addCue() {
    const cues = draft.cues || (draft.cues = []);
    const cue = blankCue(cues);
    cues.push(cue);
    cueOpen.add(cue.id);
    renderCueRows();
  }
  // The scene's backdrops, as the canonical keys the cue will reference on apply.
  function cueBackdropOptions() {
    const maps = draftToScene(draft).maps || {};
    return Object.keys(maps).map((key) => ({ key, label: humanize(key) + (maps[key] === '' ? ' (title card)' : '') }));
  }
  // The scene's audio beds as the track keys a cue plays (mus:<i>/amb:<i>), labelled
  // from the asset catalog. Built from the draft so it matches what the scene saves.
  function nameForSrc(src, catalog) {
    const hit = (catalog || []).find((x) => x.src === src);
    if (hit) return hit.name;
    return (String(src || '').split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '') || src;
  }
  function cueBedOptions() {
    const a = draft.audio || {};
    const beds = [];
    (a.music || []).forEach((m, i) => { if (m && m.src) beds.push({ key: 'mus:' + i, name: nameForSrc(m.src, audioMusic) }); });
    (a.ambience || []).forEach((m, i) => { if (m && m.src) beds.push({ key: 'amb:' + i, name: nameForSrc(m.src, audioAmbience) }); });
    return beds;
  }

  function renderCueRows() {
    if (!els.cueList) return;
    cancelTestTimeline();   // rebuilding the cue rows ends any running Test
    els.cueList.innerHTML = '';
    const cues = draft.cues || (draft.cues = []);
    if (els.cueEmptyHint) els.cueEmptyHint.hidden = cues.length > 0;
    cues.forEach((cue, i) => {
      // Normalize once so every reference below sees the same object.
      const aff = (cue.affects = { ...defaultAffects(), ...(cue.affects || {}) });
      const snap = (cue.snapshot = cue.snapshot || {});
      snap.audio = snap.audio || { playing: [], master: 0.8, sfx: [] };
      snap.audio.playing = snap.audio.playing || [];
      snap.audio.sfx = snap.audio.sfx || [];
      const isOpen = cueOpen.has(cue.id);

      const card = document.createElement('div');
      card.className = 'cue-edit' + (isOpen ? ' is-open' : '');

      // ---- Head: expand chevron, name, Opening, reorder, remove ----
      const head = document.createElement('div');
      head.className = 'cue-edit-head';

      const chev = document.createElement('button');
      chev.className = 'gm-button btn--quiet cue-expand';
      chev.type = 'button';
      chev.textContent = isOpen ? '▾' : '▸';
      chev.title = isOpen ? 'Collapse' : 'Edit this cue';
      chev.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      chev.addEventListener('click', () => {
        if (cueOpen.has(cue.id)) cueOpen.delete(cue.id); else cueOpen.add(cue.id);
        renderCueRows();
      });

      const label = document.createElement('input');
      label.type = 'text';
      label.className = 'cue-label';
      label.value = cue.label || '';
      label.placeholder = 'Cue name';
      label.addEventListener('input', () => { cue.label = label.value; });

      const open = document.createElement('button');
      open.className = 'gm-button btn--toggle cue-opening';
      open.type = 'button';
      open.textContent = 'Opening';
      open.title = 'Fire this cue automatically when the scene is selected (snaps, no fade)';
      const syncOpen = () => { open.classList.toggle('is-on', !!cue.opening); open.setAttribute('aria-pressed', cue.opening ? 'true' : 'false'); };
      syncOpen();
      open.addEventListener('click', () => {     // exactly one opening cue
        const turnOn = !cue.opening;
        cues.forEach((c) => { c.opening = false; });
        cue.opening = turnOn;
        renderCueRows();
      });

      const move = (from, to) => {
        if (to < 0 || to >= cues.length) return;
        const [c] = cues.splice(from, 1);
        cues.splice(to, 0, c);
        renderCueRows();
      };
      const up = document.createElement('button');
      up.className = 'gm-button btn--quiet cue-up';
      up.type = 'button'; up.textContent = '↑'; up.title = 'Move up';
      up.disabled = i === 0;
      up.addEventListener('click', () => move(i, i - 1));
      const down = document.createElement('button');
      down.className = 'gm-button btn--quiet cue-down';
      down.type = 'button'; down.textContent = '↓'; down.title = 'Move down';
      down.disabled = i === cues.length - 1;
      down.addEventListener('click', () => move(i, i + 1));
      const rm = document.createElement('button');
      rm.className = 'cue-remove';
      rm.type = 'button'; rm.textContent = 'Remove'; rm.title = 'Delete this cue';
      rm.addEventListener('click', () => { cueOpen.delete(cue.id); cues.splice(i, 1); renderCueRows(); });

      head.append(chev, label, open, up, down, rm);
      card.append(head);

      // ---- Body: content pickers + per-element keyframes (only when expanded) ----
      if (isOpen) {
        const body = document.createElement('div');
        body.className = 'cue-edit-body';
        buildCueContent(cue, aff, snap, body);
        const tlHost = document.createElement('div');
        tlHost.className = 'cue-timeline';
        renderCueTimeline(cue, tlHost);
        body.append(tlHost);
        card.append(body);
      }
      els.cueList.appendChild(card);
    });
  }

  // The content section: choose WHAT the cue sets. Selecting content flips the
  // matching affect on; "No change" leaves that aspect alone. Re-renders on change
  // so the keyframe lanes below track what the cue now affects.
  function buildCueContent(cue, aff, snap, host) {
    const side = (s) => ({ shown: !!(s && s.shown), srcOverride: (s && s.srcOverride) || null });

    const field = (labelText) => {
      const f = document.createElement('div'); f.className = 'cue-field';
      const sp = document.createElement('span'); sp.className = 'cue-field-label'; sp.textContent = labelText;
      f.append(sp); return f;
    };

    // Background variant (or no change).
    const bgF = field('Background');
    const bgSel = document.createElement('select'); bgSel.className = 'cue-bg';
    const none = document.createElement('option'); none.value = ''; none.textContent = '— No change —'; bgSel.append(none);
    for (const o of cueBackdropOptions()) { const op = document.createElement('option'); op.value = o.key; op.textContent = o.label; bgSel.append(op); }
    bgSel.value = aff.background ? (snap.mapState || '') : '';
    bgSel.addEventListener('change', () => {
      if (bgSel.value) { aff.background = true; snap.mapState = bgSel.value; }
      else { aff.background = false; snap.mapState = null; }
      renderCueRows();
    });
    bgF.append(bgSel); host.append(bgF);

    // Characters: a toggle + Left/Right pickers when on.
    const chF = field('Characters');
    const chToggle = document.createElement('button');
    chToggle.className = 'gm-button btn--toggle cue-aff-chars';
    chToggle.type = 'button'; chToggle.textContent = aff.characters ? 'On' : 'No change';
    chToggle.setAttribute('aria-pressed', aff.characters ? 'true' : 'false');
    chToggle.classList.toggle('is-on', !!aff.characters);
    chToggle.addEventListener('click', () => { aff.characters = !aff.characters; renderCueRows(); });
    chF.append(chToggle);
    if (aff.characters) {
      const mk = (which) => {
        const wrap = document.createElement('label'); wrap.className = 'cue-side';
        const cap = document.createElement('span'); cap.textContent = which === 'left' ? 'Left' : 'Right';
        const sel = document.createElement('select'); sel.className = 'cue-char-' + which;
        fillCharSelect(sel, (snap[which] && snap[which].srcOverride) || '', false);   // first option = "None"
        sel.value = (snap[which] && snap[which].srcOverride) || '';
        sel.addEventListener('change', () => { snap[which] = { shown: !!sel.value, srcOverride: sel.value || null }; });
        wrap.append(cap, sel); return wrap;
      };
      const sides = document.createElement('div'); sides.className = 'cue-sides';
      sides.append(mk('left'), mk('right'));
      chF.append(sides);
    }
    host.append(chF);

    // Audio beds: a toggle + which beds play when on.
    const auF = field('Audio');
    const auToggle = document.createElement('button');
    auToggle.className = 'gm-button btn--toggle cue-aff-audio';
    auToggle.type = 'button'; auToggle.textContent = aff.audio ? 'On' : 'No change';
    auToggle.setAttribute('aria-pressed', aff.audio ? 'true' : 'false');
    auToggle.classList.toggle('is-on', !!aff.audio);
    auToggle.addEventListener('click', () => { aff.audio = !aff.audio; renderCueRows(); });
    auF.append(auToggle);
    if (aff.audio) {
      const beds = cueBedOptions();
      const list = document.createElement('div'); list.className = 'cue-checks';
      if (!beds.length) {
        const hint = document.createElement('span'); hint.className = 'cue-checks-hint';
        hint.textContent = 'No beds yet — add Music/Ambience in the Audio section above, then they appear here.';
        list.append(hint);
      } else {
        for (const b of beds) {
          const lab = document.createElement('label'); lab.className = 'roster-item';
          const cb = document.createElement('input'); cb.type = 'checkbox';
          cb.checked = snap.audio.playing.includes(b.key);
          cb.addEventListener('change', () => {
            const set = new Set(snap.audio.playing);
            if (cb.checked) set.add(b.key); else set.delete(b.key);
            snap.audio.playing = [...set];
          });
          const nm = document.createElement('span'); nm.textContent = b.name;
          lab.append(cb, nm); list.append(lab);
        }
      }
      auF.append(list);
    }
    host.append(auF);

    // SFX one-shots (independent of the bed toggle): which fire on this cue.
    const sfxList = (draft.audio && draft.audio.sfx) || [];
    if (sfxList.length) {
      const sfxF = field('SFX');
      const list = document.createElement('div'); list.className = 'cue-checks';
      for (const s of sfxList) {
        const lab = document.createElement('label'); lab.className = 'roster-item';
        const cb = document.createElement('input'); cb.type = 'checkbox';
        cb.checked = snap.audio.sfx.includes(s.id);
        cb.addEventListener('change', () => {
          const set = new Set(snap.audio.sfx);
          if (cb.checked) set.add(s.id); else set.delete(s.id);
          snap.audio.sfx = [...set];
          renderCueRows();   // SFX presence adds/removes its keyframe lane
        });
        const nm = document.createElement('span'); nm.textContent = nameForSrc(s.src, audioSfx);
        lab.append(cb, nm); list.append(lab);
      }
      sfxF.append(list); host.append(sfxF);
    }

    // Fade to black first: the curtain spine (drop, swap behind it, lift).
    const cuF = field('Fade to black first');
    const cuToggle = document.createElement('button');
    cuToggle.className = 'gm-button btn--toggle cue-aff-curtain';
    cuToggle.type = 'button'; cuToggle.textContent = aff.curtain ? 'On' : 'Off';
    cuToggle.title = 'Drop the black curtain, change behind it, then reveal';
    cuToggle.setAttribute('aria-pressed', aff.curtain ? 'true' : 'false');
    cuToggle.classList.toggle('is-on', !!aff.curtain);
    cuToggle.addEventListener('click', () => { aff.curtain = !aff.curtain; if (aff.curtain) snap.visible = true; renderCueRows(); });
    cuF.append(cuToggle); host.append(cuF);

    // Per-cue GM notes: shown live in place of the scene note while this cue is
    // the active one, so the blocking text follows the beat. Empty -> the scene
    // default note shows instead.
    const noteF = field('Notes');
    const ta = document.createElement('textarea');
    ta.className = 'cue-notes'; ta.rows = 2;
    ta.placeholder = 'Shown while this cue is live (falls back to the scene note)';
    ta.value = cue.notes || '';
    ta.addEventListener('input', () => { cue.notes = ta.value; });
    noteF.append(ta); host.append(noteF);

    // Reference of what side carries which char (keeps the snapshot consistent
    // when characters is on but a side was never touched).
    if (aff.characters) { snap.left = side(snap.left); snap.right = side(snap.right); }
  }

  // The per-element keyframe editor. One row per APPLICABLE lane (gated by what the
  // cue affects + whether it carries SFX). Each row leads with a Keyframe checkbox:
  // OFF -> the element snaps with the cue at t=0; ON -> it animates on its own
  // Start (+ Ramp), the times in seconds. This is the flexibility the GM asked for:
  // keyframe only what you want timed, leave the rest instant.
  function renderCueTimeline(cue, host) {
    host.innerHTML = '';
    const aff = { ...defaultAffects(), ...(cue.affects || {}) };
    const snap = cue.snapshot || {};
    const hasSfx = !!(snap.audio && (snap.audio.sfx || []).length);
    // [key, label, applicable, hasRamp]
    const lanes = [
      ['blackout', 'Fade to black', aff.curtain !== false, true],
      ['audioOut', 'Audio out', aff.audio !== false, true],
      ['background', 'Background', aff.background !== false, true],
      ['audioIn', 'Audio in', aff.audio !== false, true],
      ['reveal', 'Lights up', aff.curtain !== false, true],
      ['sfx', 'SFX', hasSfx, false],
      ['characters', 'Characters', aff.characters !== false, true]
    ].filter(([, , on]) => on);

    const heading = document.createElement('div');
    heading.className = 'cue-tl-head';
    const htxt = document.createElement('span'); htxt.className = 'cue-tl-title'; htxt.textContent = 'Timing';
    heading.append(htxt);
    if (lanes.length) {
      const allBtn = document.createElement('button');
      allBtn.className = 'gm-button btn--quiet cue-tl-all';
      allBtn.type = 'button'; allBtn.textContent = 'Keyframe all';
      allBtn.title = 'Keyframe every element with the default fade-to-black choreography';
      allBtn.addEventListener('click', () => {
        const def = defaultTimeline();
        cue.timeline = {};
        for (const [key] of lanes) cue.timeline[key] = { ...def[key] };
        renderCueRows();
      });
      const testBtn = document.createElement('button');
      testBtn.className = 'gm-button btn--quiet cue-tl-test';
      testBtn.type = 'button'; testBtn.textContent = '▸ Test in preview';
      testBtn.title = 'Play this cue in the preview above (visual only)';
      testBtn.addEventListener('click', () => testCueTimeline(cue));
      heading.append(allBtn, testBtn);
    }
    host.append(heading);

    if (!lanes.length) {
      const hint = document.createElement('p'); hint.className = 'cue-tl-empty';
      hint.textContent = 'Pick some content above (background, characters, audio…) to choose what to keyframe.';
      host.append(hint);
      return;
    }

    const secField = (laneObj, prop, cap) => {
      const wrap = document.createElement('label');
      wrap.className = 'cue-lane-field';
      const c = document.createElement('span'); c.textContent = cap;
      const inp = document.createElement('input');
      inp.type = 'number'; inp.className = 'cue-lane-' + prop; inp.min = '0'; inp.step = '0.1';
      inp.value = ((+laneObj[prop] || 0) / 1000).toFixed(1);
      inp.addEventListener('input', () => { laneObj[prop] = Math.max(0, Math.round((+inp.value || 0) * 1000)); });
      wrap.append(c, inp);
      return wrap;
    };
    const def = defaultTimeline();
    for (const [key, label, , hasRamp] of lanes) {
      const tl = cue.timeline || (cue.timeline = {});
      const on = !!(tl[key] && typeof tl[key] === 'object');
      const r = document.createElement('div'); r.className = 'cue-lane' + (on ? ' is-keyed' : '');
      const kf = document.createElement('label'); kf.className = 'cue-lane-kf';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'cue-lane-on'; cb.checked = on;
      cb.title = on ? 'Animate this element on a timeline' : 'Snap this element instantly with the cue';
      cb.addEventListener('change', () => {
        if (cb.checked) tl[key] = { ...def[key] }; else delete tl[key];
        renderCueRows();
      });
      const nm = document.createElement('span'); nm.className = 'cue-lane-name'; nm.textContent = label;
      kf.append(cb, nm); r.append(kf);
      if (on) {
        const laneObj = tl[key];
        r.append(secField(laneObj, 'at', 'Start'));
        if (hasRamp) r.append(secField(laneObj, 'ramp', 'Ramp'));
      } else {
        const snapTag = document.createElement('span'); snapTag.className = 'cue-lane-snap'; snapTag.textContent = 'instant';
        r.append(snapTag);
      }
      host.append(r);
    }
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
    cancelTestTimeline();   // a manual preview refresh ends any running Test
    const scene = draftToScene(draft);
    const keys = Object.keys(scene.maps);
    // Preview against the first REAL backdrop, not a title screen -- characters
    // never composite over the title plate, so editing the size/position of a
    // left/right character has to happen against a backdrop to be visible.
    const previewKey = keys.find((k) => scene.maps[k] !== '') || keys[0] || 'revealed';
    const pstate = {
      sceneId: scene.id,
      mapState: previewKey,
      stage: {
        visible: true,
        // Force both sides shown in the builder so you can place them (live they
        // only appear once armed/entered); the compositor still applies each
        // character's scale / flip / x / y from the draft.
        left:  { shown: !!(scene.characters && scene.characters.left),  srcOverride: null },
        right: { shown: !!(scene.characters && scene.characters.right), srcOverride: null }
      }
    };
    previewView.render(pstate, scene, { instant: previewFirstPaint }); previewFirstPaint = false;
    els.previewName.textContent = scene.name || 'New scene';
    els.badge.textContent = (scene.maps && scene.maps[previewKey] === '') ? 'Title screen' : humanize(previewKey);
    els.badge.classList.remove('badge-revealed');
  }

  // Builder input wiring (elements persist; only their options change).
  els.bName.addEventListener('input', () => { draft.name = els.bName.value; renderBuilderPreview(); });
  els.bNotes.addEventListener('input', () => { draft.gmNotes = els.bNotes.value; });
  els.addVariant.addEventListener('click', () => {
    draft.variants.push({ key: 'variant-' + (draft.variants.length + 1), src: (backgrounds[0] && backgrounds[0].src) || '', scene: true, map: true });
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
  // Music is a checkbox library now (see renderAudioPick) -- no <select> handler.
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
    els.controlsMap.hidden = !inMap;              // save/reset layout: map only
    els.notes.hidden = inMap || building || !scene;
    els.builder.hidden = !building;
    els.mapmode.hidden = !inMap;
    // In the builder, shrink the preview and pin it so it stays visible while
    // scrolling the controls (so "Test in preview" is actually watchable). The
    // is-map class drops the compact 3-zone grid for map mode (board takes over).
    els.stage.classList.toggle('is-building', building);
    els.stage.classList.toggle('is-map', inMap);

    // Persistent rail nav -- Black out + Background + Map<->Exit at one fixed spot,
    // so a quick transition never hunts for a button that moved.
    if (scene && !building) {
      els.visToggle.textContent = state.stage.visible === false ? 'Show scene' : 'Black out';
      els.visToggle.classList.toggle('is-on', state.stage.visible === false);  // lit while blacked out
      els.mapModeToggle.hidden = !sceneHasMap(scene);
      els.mapModeToggle.textContent = inMap ? 'Exit map mode' : 'Map mode';
      els.mapModeToggle.classList.toggle('is-on', inMap);
      renderCueButtons(scene);
      // Live: the quick-actions + mixer modules are the manual surface. Map mode
      // swaps in its own controls (variant reveal + Save/Reset layout).
      els.quick.hidden = inMap;
      els.mixer.hidden = inMap || !scene.audio;
      els.allControls.hidden = !inMap;
      if (inMap) {
        renderVariantButtons(scene);     // the map-reveal chips in the Map controls
        els.allControls.open = true;
      } else {
        renderQuick(scene);
        if (scene.audio) renderMixer(scene);
      }
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

  // GM-only dice tray, pinned to the lower-left of the console (local UI).
  mountDiceRoller(root);
}

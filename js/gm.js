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
import { BACKGROUNDS, CHARACTERS, MUSIC, AMBIENCE, SFX, TOKENART } from '../data/manifest.js';
import { CAST } from '../data/cast.js';
import { CONDITIONS, CONDITION_INFO } from './conditions.js';
import { createAudioEngine } from './audioEngine.js';
import { mountDiceRoller } from './diceRoller.js';
import { overrideFor, saveTokenOverride, resetTokenOverride, globalDisplay, saveGlobalDisplay, applyGlobalDisplay, condArcPath, addCharacter, removeAddedCharacter, setHidden, isAdded, isHidden, rosterPayload } from './tokenOverrides.js';

export function mountGm(root) {
  let state = loadState();
  let draft = null;                 // the in-progress scene while building
  // While building, which roster entry's src to spotlight in the preview per
  // side (so editing the 2nd character shows it, not the 1st). null -> the
  // side's first roster entry.
  let builderPick = { left: null, right: null };
  let mapMode = false;              // map mode replaces the live panel for token play
  let armedBg = null;               // Stage row: a background variant PICKED but not yet applied (GM-local)
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
        <button class="gm-button btn--quiet tokens-btn" type="button">Tokens</button>
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

          <!-- Quick actions (live, the "Visual" section): the global Black-out lives
               on the section header -- it dims the WHOLE stage, not just the backdrop.
               Below, three aligned rows, each a dropdown: Background variant, then the
               Left/Right characters with a per-side Show/Hide. -->
          <div class="gm-quick" hidden>
            <div class="quick-head">
              <span class="quick-section">Visual</span>
              <button class="gm-button btn--toggle vis-toggle" type="button" title="Black out the screen (hide everything)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v9"/><path d="M5.6 7.6a9 9 0 1 0 12.8 0"/></svg><span class="btn-label">Black out</span></button>
            </div>
            <div class="quick-row quick-bg-row">
              <span class="control-label">Stage</span>
              <select class="quick-bg-select" aria-label="Background variant (hot-swap)"></select>
              <button class="gm-button btn--toggle quick-hide quick-bg-vis" type="button" title="Show the backdrop / hide it (characters on black)">Hide</button>
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
            <button class="gm-button btn--quiet edit-scene" type="button" title="Edit this scene"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span class="btn-label">Edit</span></button>
          </div>

          <!-- Map-mode controls: reveal the map variant + Save/Reset layout. Shown
               only in map mode; the quick + mixer modules take over in live. -->
          <details class="all-controls" hidden>
            <summary class="all-controls-summary">Map controls</summary>
            <div class="all-controls-body">
              <div class="control-row variant-row">
                <span class="control-label">Map</span>
                <div class="variant-buttons"></div>
              </div>
              <div class="controls-map" hidden>
                <div class="control-row">
                  <button class="gm-button btn--save mm-save-layout" type="button" title="Save the current token layout"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg><span class="btn-label">Save</span></button>
                  <button class="gm-button btn--quiet mm-reset-layout" type="button" hidden title="Reset to the last saved layout"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg><span class="btn-label">Reset</span></button>
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

        <!-- The old full audio panel is retired: per-bed Vol/Pan/fades are
             configured in the scene builder, the sidebar mixer carries the live
             levels + Fade, and the TV/Laptop outputs moved onto the mixer. -->

        <div class="gm-builder" hidden>
          <div class="builder-head">
            <h3 class="gm-h3 builder-title">Build a scene</h3>
            <!-- Inline SVG icons (one shared 24x24 viewBox, stroke=currentColor) so
                 the four buttons read as an even, equally-weighted set -- the old
                 mix of a colour emoji (save) and thin text glyphs looked uneven. -->
            <div class="builder-tools">
              <button class="u-icon-btn b-save" type="button" title="Save scene" aria-label="Save scene">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>
              </button>
              <button class="u-icon-btn b-export" type="button" title="Export scene JSON" aria-label="Export scene JSON">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
              </button>
              <button class="u-icon-btn b-copy" type="button" title="Copy export to clipboard" aria-label="Copy export to clipboard" hidden>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
              <button class="u-icon-btn b-cancel" type="button" title="Cancel editing" aria-label="Cancel editing">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </div>
          </div>

          <div class="builder-grid">
            <div class="builder-col">
              <div class="builder-namerow">
                <label class="field">
                  <span>Title</span>
                  <input class="b-name" type="text" placeholder="A Word at the Gate">
                </label>
                <label class="field">
                  <span>Header</span>
                  <input class="b-title-header" type="text" placeholder="Aldermere">
                </label>
              </div>

              <details class="field builder-collapse" open>
                <summary>Background variants</summary>
                <div class="variant-head" aria-hidden="true">
                  <span>Name</span><span>Background</span><span>Use</span><span></span>
                </div>
                <div class="variant-list"></div>
                <button class="gm-button btn--quiet add-variant" type="button">Add variant</button>
              </details>

              <details class="field char-field builder-collapse" open>
                <summary>Left characters</summary>
                <div class="char-roster" data-side="left"></div>
                <button class="gm-button btn--quiet add-char" data-side="left" type="button">Add character</button>
              </details>
              <details class="field char-field builder-collapse" open>
                <summary>Right characters</summary>
                <div class="char-roster" data-side="right"></div>
                <button class="gm-button btn--quiet add-char" data-side="right" type="button">Add character</button>
              </details>
            </div>

            <div class="builder-col">
              <details class="field builder-collapse">
                <summary>Roster</summary>
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
                      <span class="roster-group-label">NPCs</span>
                      <button class="roster-all" data-group="npcs" type="button">Select all</button>
                    </div>
                    <div class="roster-npcs"></div>
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
                <summary>Audio</summary>
                <div class="audio-pick">
                  <div class="audio-pick-group"><span class="audio-pick-label">Music</span><div class="b-music"></div></div>
                  <div class="audio-pick-group"><span class="audio-pick-label">Ambience</span><div class="b-ambience"></div></div>
                  <div class="audio-pick-group"><span class="audio-pick-label">SFX</span><div class="b-sfx"></div></div>
                </div>
              </details>

              <details class="field builder-collapse" open>
                <summary>Cues</summary>
                <div class="cue-list"></div>
                <p class="cue-empty-hint" hidden>No cues yet. Press <strong>+ New cue</strong> to build one.</p>
                <button class="gm-button btn--quiet cue-new" type="button">+ New cue</button>
              </details>

              <label class="field">
                <span>GM notes</span>
                <textarea class="b-notes" rows="2"></textarea>
              </label>
            </div>
          </div>

          <p class="b-export-hint" hidden>Copy this into the SCENES array in data/scenes.js to commit or share it.</p>
          <textarea class="b-export-out" hidden readonly rows="8"></textarea>
        </div>

        <div class="gm-mapmode" hidden>
          <div class="mapmode-head">
            <h3 class="gm-h3 mapmode-title"></h3>
            <!-- The Edit / Exit-map-mode nav is relocated here (next to the title)
                 in map mode by renderUI, so it's reachable without scrolling. -->
            <div class="mapmode-head-actions"></div>
          </div>
          <div class="mapmode-board"></div>
          <div class="mapmode-roster"></div>
        </div>
      </section>
    </div>
  `;

  const els = {
    sceneList:    root.querySelector('.scene-list'),
    rescanBtn:    root.querySelector('.rescan'),
    tokensBtn:    root.querySelector('.tokens-btn'),
    rescanStatus: root.querySelector('.rescan-status'),
    newScene:     root.querySelector('.new-scene'),
    empty:        root.querySelector('.gm-empty'),
    stage:        root.querySelector('.gm-stage'),
    preview:      root.querySelector('.gm-preview'),
    previewFrame: root.querySelector('.preview-frame'),
    previewSize:  root.querySelector('.preview-size'),
    previewCap:   root.querySelector('.preview-cap'),
    previewName:  root.querySelector('.preview-name'),
    badge:        root.querySelector('.badge'),
    controls:     root.querySelector('.gm-controls'),
    controlsNav:  root.querySelector('.controls-nav'),
    cueRow:       root.querySelector('.cue-row'),
    cueButtons:   root.querySelector('.cue-buttons'),
    quick:        root.querySelector('.gm-quick'),
    quickBgSelect: root.querySelector('.quick-bg-select'),
    quickBgVis:   root.querySelector('.quick-bg-vis'),
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
    bTitleHeader: root.querySelector('.b-title-header'),
    variantList:  root.querySelector('.variant-list'),
    addVariant:   root.querySelector('.add-variant'),
    charRoster: {
      left:  root.querySelector('.char-roster[data-side="left"]'),
      right: root.querySelector('.char-roster[data-side="right"]')
    },
    addChar: {
      left:  root.querySelector('.add-char[data-side="left"]'),
      right: root.querySelector('.add-char[data-side="right"]')
    },
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
    mapmodeHeadActions: root.querySelector('.mapmode-head-actions'),
    mmSaveLayout: root.querySelector('.mm-save-layout'),
    mmResetLayout: root.querySelector('.mm-reset-layout'),
    mapRoster:    root.querySelector('.mapmode-roster'),
    rosterHeroes: root.querySelector('.roster-heroes'),
    rosterNpcs:   root.querySelector('.roster-npcs'),
    rosterEnemies: root.querySelector('.roster-enemies'),
    rosterAllHeroes:  root.querySelector('.roster-all[data-group="heroes"]'),
    rosterAllNpcs:    root.querySelector('.roster-all[data-group="npcs"]'),
    rosterAllEnemies: root.querySelector('.roster-all[data-group="enemies"]'),
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
  els.perfSide = perfSide;
  els.mixer.before(perfSide);
  perfSide.append(els.quick, els.mixer);   // quick (visual) over the mixer (audio)
  const surface = document.createElement('div');
  surface.className = 'gm-surface';
  els.preview.before(surface);
  surface.append(els.preview, els.controls);   // preview centre; controls flow via display:contents
  els.surface = surface;
  els.scenes = root.querySelector('.gm-scenes');
  els.scenes.appendChild(els.notes);  // notes fill the rail bottom (rail is hidden in map mode)
  // Map mode is a combat surface: the head row, then a BODY grid
  // [ initiative + stat-block column | board ], then the rosters full-width below.
  // The combat column lifts the initiative tracker and the active combatant's stat
  // card out of the (now-hidden) scenes rail to sit beside the board.
  const initPanel = document.createElement('div');
  initPanel.className = 'gm-initiative'; initPanel.hidden = true;
  els.initiative = initPanel;
  const statSheet = document.createElement('div');
  statSheet.className = 'gm-statsheet'; statSheet.hidden = true;
  els.statsheet = statSheet;
  // Interactive combat notices (Spike-Growth damage, concentration checks): a fixed
  // bottom-right stack OUTSIDE the stat card, so prompts never reshape the card.
  els.notices = document.createElement('div');
  els.notices.className = 'gm-notices'; els.notices.hidden = true;
  document.body.appendChild(els.notices);
  const combatCol = document.createElement('div');
  combatCol.className = 'mm-combat-col';
  combatCol.append(initPanel, statSheet);
  // Wrap the board in a body grid and seat the combat column to its left. The
  // roster stays in markup order (after the board) -> full-width row below.
  const mapBody = document.createElement('div');
  mapBody.className = 'mapmode-body';
  els.mapboard.replaceWith(mapBody);
  // A slim toolbar directly above the board holds the on-map display toggles:
  // hero/NPC HP bars + condition icons, drawn on the GM board AND the Player TV.
  const boardWrap = document.createElement('div'); boardWrap.className = 'mm-board-wrap';
  const boardToolbar = document.createElement('div'); boardToolbar.className = 'mm-board-toolbar';
  const tbLabel = document.createElement('span'); tbLabel.className = 'mm-toolbar-label'; tbLabel.textContent = 'On map';
  els.hpToggle = document.createElement('button');
  els.hpToggle.type = 'button'; els.hpToggle.className = 'gm-button btn--toggle mm-toggle mm-hp-toggle';
  els.hpToggle.textContent = 'Hero HP';
  els.hpToggle.title = 'Show HP bars on hero / NPC tokens (GM board + Player TV)';
  els.hpToggle.addEventListener('click', () => { ensureTokens(); state.stage.hpOnMap = !state.stage.hpOnMap; commit(); });
  els.condToggle = document.createElement('button');
  els.condToggle.type = 'button'; els.condToggle.className = 'gm-button btn--toggle mm-toggle mm-cond-toggle';
  els.condToggle.textContent = 'Conditions';
  els.condToggle.title = 'Show condition icons on every token (GM board + Player TV)';
  els.condToggle.addEventListener('click', () => { ensureTokens(); state.stage.conditionsOnMap = !state.stage.conditionsOnMap; commit(); });
  // PR 6C.1: mirror every resolved card roll onto the Player TV (labelled + verdict).
  els.rollsToggle = document.createElement('button');
  els.rollsToggle.type = 'button'; els.rollsToggle.className = 'gm-button btn--toggle mm-toggle mm-rolls-toggle';
  els.rollsToggle.textContent = 'Rolls on TV';
  els.rollsToggle.title = 'Flash each card roll (Hit / Save / Dmg / Heal) on the Player TV, labelled + verdict';
  els.rollsToggle.addEventListener('click', () => { ensureTokens(); state.stage.rollsOnTv = !state.stage.rollsOnTv; commit(); });
  boardToolbar.append(tbLabel, els.hpToggle, els.condToggle, els.rollsToggle);
  mapBody.append(combatCol, boardWrap);
  boardWrap.append(boardToolbar, els.mapboard);
  // The map-variant reveal + Save/Reset layout ride ON the board header row, next
  // to the title and the Edit/Exit nav -- no separate controls strip.
  els.mapmodeHeadActions.append(els.variantRow, els.controlsMap);

  const boardView = createStageView(els.mapboard);
  boardView.el.classList.add('board-interactive');   // tokens are draggable here
  boardView.el.addEventListener('pointerdown', onBoardPointerDown);
  boardView.el.addEventListener('pointermove', onBoardPointerMove);
  boardView.el.addEventListener('pointerup', onBoardPointerUp);
  boardView.el.addEventListener('pointercancel', onBoardPointerUp);

  // ---- Map grid (PR 6A): a board-toolbar Grid toggle (on/off for the CURRENT map)
  //      plus an "Align" button that opens a collapsible calibration panel -- it's
  //      only needed once per map, so it stays collapsed by default. The grid is PER
  //      MAP VARIANT: geometry rides state.stage.grids[mapState] (broadcast to the
  //      Player TV), mirrored to scene.grids[mapState]. Built after boardView so the
  //      handlers can re-pin the board. ----
  const gridControls = [];   // { inp, out?, fmt?, get, color?, select?, title? } -- synced per variant
  let gridPanelOpen = false; // the calibration panel is collapsed until Align opens it
  els.gridToggle = document.createElement('button');
  els.gridToggle.type = 'button';
  els.gridToggle.className = 'gm-button btn--toggle mm-toggle mm-grid-toggle';
  els.gridToggle.textContent = 'Grid';
  els.gridToggle.title = 'Show a square grid on THIS map (GM board + Player TV)';
  els.gridToggle.addEventListener('click', toggleGrid);
  els.gridAlign = document.createElement('button');
  els.gridAlign.type = 'button';
  els.gridAlign.className = 'gm-button btn--quiet mm-toggle mm-grid-align';
  els.gridAlign.textContent = 'Align…';
  els.gridAlign.title = 'Open the alignment controls for this map’s grid';
  els.gridAlign.addEventListener('click', openGridAlign);
  boardToolbar.append(els.gridToggle, els.gridAlign);

  els.gridPanel = document.createElement('div');
  els.gridPanel.className = 'mm-grid-panel';
  els.gridPanel.hidden = true;
  const gridPanelTitle = document.createElement('div');
  gridPanelTitle.className = 'mm-grid-panel-title';
  els.gridPanel.append(gridPanelTitle);
  gridControls.push({ title: gridPanelTitle });   // shows which map variant is being aligned
  // Controls are grouped into labeled sections (Size / Position / Style) so the
  // growing panel reads clearly.
  const gridGroup = (name) => {
    const g = document.createElement('div'); g.className = 'mm-grid-group';
    const h = document.createElement('div'); h.className = 'mm-grid-group-h'; h.textContent = name;
    g.append(h); els.gridPanel.append(g); return g;
  };
  const gridSlider = (group, label, min, max, step, get, set, fmt) => {
    const lab = document.createElement('label'); lab.className = 'mm-grid-set';
    const key = document.createElement('span'); key.className = 'mm-grid-label';
    const txt = document.createElement('span'); txt.textContent = label;
    const out = document.createElement('em'); out.className = 'mm-grid-val';
    key.append(txt, out);
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.className = 'mm-grid-range';
    inp.addEventListener('input', () => { set(ensureLiveGrid(), +inp.value); out.textContent = fmt(+inp.value); gridLiveUpdate(); });
    lab.append(key, inp);
    gridControls.push({ inp, out, get, fmt });
    group.append(lab);
  };
  // Size: cell count (cellSize = 1/N of the map width) + the real-world scale.
  const gSize = gridGroup('Size');
  gridSlider(gSize, 'Cells', 4, 50, 1, (g) => Math.round(1 / (g.cellSize || 1 / 16)), (g, v) => { g.cellSize = 1 / v; }, (v) => String(v));
  const feetLab = document.createElement('label'); feetLab.className = 'mm-grid-set';
  const feetKey = document.createElement('span'); feetKey.className = 'mm-grid-label';
  const feetTxt = document.createElement('span'); feetTxt.textContent = 'Feet/cell'; feetKey.append(feetTxt);
  const feetSel = document.createElement('select'); feetSel.className = 'mm-grid-select';
  for (const ft of [5, 10, 15, 20, 30, 50]) { const o = document.createElement('option'); o.value = String(ft); o.textContent = ft + ' ft'; feetSel.append(o); }
  feetSel.addEventListener('change', () => { ensureLiveGrid().feetPerCell = +feetSel.value; gridLiveUpdate(); });
  feetLab.append(feetKey, feetSel);
  gridControls.push({ inp: feetSel, select: true, get: (g) => String(g.feetPerCell || 5) });
  gSize.append(feetLab);
  // Position: nudge the grid to register against the map's own lines. Offset is a
  // fraction of a CELL, so ±50% always spans one full cell of alignment.
  const gPos = gridGroup('Position');
  gridSlider(gPos, 'Offset X', -50, 50, 2, (g) => Math.round((g.offsetX || 0) * 100), (g, v) => { g.offsetX = v / 100; }, (v) => v + '%');
  gridSlider(gPos, 'Offset Y', -50, 50, 2, (g) => Math.round((g.offsetY || 0) * 100), (g, v) => { g.offsetY = v / 100; }, (v) => v + '%');
  // Style: how the lines read against the art.
  const gStyle = gridGroup('Style');
  gridSlider(gStyle, 'Opacity', 15, 100, 5, (g) => Math.round((g.opacity == null ? 0.5 : g.opacity) * 100), (g, v) => { g.opacity = v / 100; }, (v) => v + '%');
  gridSlider(gStyle, 'Width', 0.5, 3, 0.25, (g) => g.lineWidth || 1, (g, v) => { g.lineWidth = v; }, (v) => v + 'px');
  const colLab = document.createElement('label'); colLab.className = 'mm-grid-set mm-grid-colorset';
  const colKey = document.createElement('span'); colKey.className = 'mm-grid-label'; colKey.textContent = 'Color';
  const colInp = document.createElement('input'); colInp.type = 'color'; colInp.className = 'mm-grid-colorinp';
  colInp.title = 'Grid line colour (opacity is separate)';
  colInp.addEventListener('input', () => { ensureLiveGrid().color = colInp.value; gridLiveUpdate(); });
  colLab.append(colKey, colInp);
  gridControls.push({ inp: colInp, color: true, get: (g) => g.color || '#ffffff' });
  gStyle.append(colLab);
  boardWrap.insertBefore(els.gridPanel, els.mapboard);

  // The GM can monitor audio locally (role 'gm', off by default); the first
  // click anywhere unlocks its AudioContext (browser autoplay rule).
  const audioEngine = createAudioEngine({ role: 'gm', gestureTarget: root });
  window.__audio = audioEngine;   // debug / test hook
  window.__board = boardView;     // debug / test hook (grid snapping, layout)

  // ---- Sync: broadcast state; reply to a Player hello with current state. ----
  const sync = createSync((msg) => {
    if (msg && msg.type === 'hello') broadcast();
  });
  function broadcast() { sync.post({ type: 'state', state }); }
  function commit() { pruneZones(); saveState(state); broadcast(); renderUI(); }
  // PR 6E: zones die with their caster -- when the caster's token leaves the board (or the
  // scene changes and the tokens reset), its zones clear on the next commit.
  function pruneZones() {
    const st = state.stage;
    if (!st || !Array.isArray(st.zones) || !st.zones.length) return;
    const ids = new Set((st.tokens || []).map((t) => t.instId));
    const kept = st.zones.filter((z) => !z.casterId || ids.has(z.casterId));
    if (kept.length !== st.zones.length) st.zones = kept;
  }

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
  // A scene side's character roster (one shown at a time): accepts the legacy
  // single object or an array and returns the entries that carry a src. Mirrors
  // the compositor's charRoster and audio's musicBeds single-or-array handling.
  function charRoster(cfg) {
    if (!cfg) return [];
    if (Array.isArray(cfg)) return cfg.filter((c) => c && c.src);
    return cfg.src ? [cfg] : [];
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
    state.stage = {
      visible: wasBlackedOut ? false : (d.visible !== false),  // a global black-out carries across scene changes
      // Characters are CUE-DRIVEN ("cues pick who enters"): a scene starts with
      // both sides empty and a cue brings someone on -- the opening cue included,
      // since it fires as part of select. (Previously a non-empty roster auto-armed
      // its first character as shown, so a cue that merely switched off the title
      // screen would pop that character in even though no cue had picked anyone.)
      left:  { shown: false, srcOverride: null },
      right: { shown: false, srcOverride: null },
      tokens: expandSavedLayout(scene),  // auto-place a saved layout, else empty
      mapMode: false,                    // selecting a scene starts on the cinematic controls
      // Per-variant map grids: seed the LIVE (broadcast) grids from the scene's saved
      // defaults so selecting a scene restores each map's grid; null when it has none.
      grids: seedGrids(scene)
    };
    state.audio = seedAudioFromScene(scene, state.audio);
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
  // Quick hot-swap: picking someone from the dropdown ARMS that side but leaves it
  // HIDDEN -- the GM queues who is next, then presses Show (the Hide/Show toggle) to
  // reveal on cue. Choosing "Scene default" clears the override; either way the side
  // stays hidden until Show, so a selection never pops on screen on its own.
  function quickSwap(side, src) {
    state.stage[side].srcOverride = src || null;
    state.stage[side].shown = false;
    commit();
  }
  // Stage row Show/Hide. "Show" (a variant is armed, or the backdrop is hidden):
  // apply the armed variant + reveal the backdrop. "Hide": black the backdrop only,
  // leaving the characters composited on black -- separate from the global Black-out.
  function toggleBackdrop() {
    if (bgPending() || (state.stage && state.stage.bgHidden)) {
      if (bgPending()) state.mapState = armedBg;
      if (state.stage) state.stage.bgHidden = false;
      armedBg = null;
    } else if (state.stage) {
      state.stage.bgHidden = true;
    }
    commit();
  }

  els.visToggle.addEventListener('click', toggleVisible);
  // Picking a Stage variant ARMS it (does not change the backdrop live) -- the Stage
  // Show button applies it. Re-render the quick panel so the button flips to "Show".
  els.quickBgSelect.addEventListener('change', () => { armedBg = els.quickBgSelect.value; const sc = sceneById(state.sceneId); if (sc) renderQuick(sc); });
  els.quickBgVis.addEventListener('click', toggleBackdrop);
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
  // The live Background picker is a dropdown (matching the Left/Right character
  // rows) instead of chips, so the quick panel reads as three consistent rows and
  // never wraps when a scene has many backgrounds. Same variant filter as the chips.
  function fillVariantSelect(sel, scene) {
    sel.innerHTML = '';
    const keys = (scene.maps ? Object.keys(scene.maps) : []).filter((k) => variantInMode(scene, k, mapMode));
    for (const key of keys) {
      const o = document.createElement('option');
      o.value = key;
      o.textContent = (scene.maps && scene.maps[key] === '') ? 'Title screen' : humanize(key);
      sel.appendChild(o);
    }
    // Show the ARMED (pending) variant if one is picked, else the live backdrop.
    sel.value = (armedBg != null && keys.includes(armedBg)) ? armedBg : state.mapState;
    return keys.length;
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
    // A side captured as null is "carry over" (No change): the cue leaves it
    // exactly as-is, so changing one side never disturbs / re-enters the other.
    if (aff.characters && !skip.has('characters')) {
      const side = (s) => ({ shown: !!(s && s.shown), srcOverride: (s && s.srcOverride) || null });
      if (snap.left !== null) state.stage.left = side(snap.left);
      if (snap.right !== null) state.stage.right = side(snap.right);
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
      // A cue sets WHICH beds play, not the master OUTPUT level -- master is the
      // GM's live mix fader, so applying a cue must never reset it (it was snapping
      // back to the 0.8 default every cue press).
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
    } else if (name === 'background') {
      if (snap.mapState != null && scene.maps && Object.prototype.hasOwnProperty.call(scene.maps, snap.mapState)) {
        state.mapState = snap.mapState;
      }
      if (aff.mapMode) { const wantMap = !!snap.mapMode && sceneHasMap(scene); mapMode = wantMap; state.stage.mapMode = wantMap; }
      setStageFx('crossfade', lane.ramp);
    } else if (name === 'audioIn') {
      const set = new Set(((snap.audio && snap.audio.playing) || []).map((k) => (k === 'music' ? 'mus:0' : k)));
      for (const k of Object.keys(tracks)) tracks[k].playing = set.has(k);
      state.audio.ramp = Math.max(0, +lane.ramp || 0);   // master is the GM's live mix; cues don't set it
    } else if (name === 'reveal') {
      state.stage.visible = !(snap.visible === false);
      setStageFx('curtain', lane.ramp);
    } else if (name === 'sfx') {
      for (const id of ((snap.audio && snap.audio.sfx) || [])) {
        state.audio.sfxTrigger[id] = (state.audio.sfxTrigger[id] || 0) + 1;
      }
    } else if (name === 'characters') {
      const side = (s) => ({ shown: !!(s && s.shown), srcOverride: (s && s.srcOverride) || null });
      // Carry a bumped entrance nonce so the compositor replays the transition
      // even if the side is already on stage from an earlier (instant) cue. A side
      // captured as null is "carry over" -- left untouched, so its entrance does
      // not re-fire when only the other side changes.
      const bump = (prev) => ((prev && +prev.enterSeq) || 0) + 1;
      if (snap.left !== null) { const nl = side(snap.left); nl.enterSeq = bump(state.stage.left); state.stage.left = nl; }
      if (snap.right !== null) { const nr = side(snap.right); nr.enterSeq = bump(state.stage.right); state.stage.right = nr; }
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
  // without opening a Player window. Runs against a throwaway preview state.
  // opts.hold (the cue-row "Preview" button): play it like a live cue button --
  // baseline from who the builder currently shows and LEAVE the result on screen
  // instead of flashing it and snapping back; the keyframe editor's "Test" passes
  // no hold, so it returns to the editing baseline to be re-run cleanly.
  function testCueTimeline(cue, opts) {
    cancelTestTimeline();
    if (!draft) return;
    const hold = !!(opts && opts.hold);
    const scene = draftToScene(draft);
    const tl = { ...defaultTimeline(), ...(cue.timeline || {}) };
    const snap = cue.snapshot || {};
    const aff = { ...defaultAffects(), ...(cue.affects || {}) };
    const keyed = new Set(keyframedLanes(cue));   // only these animate; the rest snap
    // Baseline on the first REAL backdrop, not the first variant -- when the scene
    // leads with a title-screen variant (empty src), a cue that doesn't change the
    // background must still preview over a map (characters never composite on the
    // title plate, and its viewport-sized type looks huge in the small preview).
    // Mirrors renderBuilderPreview's previewKey.
    const mapKeys = Object.keys(scene.maps || {});
    const firstKey = mapKeys.find((k) => scene.maps[k] !== '') || mapKeys[0] || 'revealed';
    const side = (s) => ({ shown: !!(s && s.shown), srcOverride: (s && s.srcOverride) || null });
    // Baseline sides: a clean test starts with nobody on (so an entrance animates
    // visibly); a "hold" preview starts from who the builder currently shows, so a
    // carry-over (No change) side visibly stays put while the other side changes.
    const baseSide = (which) => hold
      ? { shown: charRoster(draft && draft[which]).length > 0, srcOverride: builderPick[which] }
      : { shown: false, srcOverride: null };
    // Baseline: the scene's first backdrop, curtain up. Then snap every affected
    // VISUAL aspect the GM did NOT keyframe, so the test shows only the timed
    // elements moving (a character walking in over a settled background). A side
    // captured as null is "carry over" -- left at the baseline, never touched.
    const ps = { sceneId: scene.id, mapState: firstKey,
      stage: { visible: true, left: baseSide('left'), right: baseSide('right'), tokens: [], mapMode: false } };
    const hasVariant = snap.mapState != null && scene.maps && Object.prototype.hasOwnProperty.call(scene.maps, snap.mapState);
    if (aff.background !== false && !keyed.has('background') && hasVariant) ps.mapState = snap.mapState;
    if (aff.characters !== false && !keyed.has('characters')) {
      if (snap.left !== null) ps.stage.left = side(snap.left);
      if (snap.right !== null) ps.stage.right = side(snap.right);
    }
    if (aff.curtain !== false && !keyed.has('blackout') && !keyed.has('reveal')) ps.stage.visible = !(snap.visible === false);
    const paint = () => previewView.render(ps, scene, {});
    paint();
    // Visual beats, scheduled only when the GM keyframed them.
    const beats = [
      ['blackout', () => { ps.stage.visible = false; setFx(ps.stage, 'curtain', tl.blackout.ramp); }],
      ['background', () => { if (hasVariant) ps.mapState = snap.mapState; setFx(ps.stage, 'crossfade', tl.background.ramp); }],
      ['reveal', () => { ps.stage.visible = !(snap.visible === false); setFx(ps.stage, 'curtain', tl.reveal.ramp); }],
      ['characters', () => {
        if (snap.left !== null) ps.stage.left = side(snap.left);
        if (snap.right !== null) ps.stage.right = side(snap.right);
        setFx(ps.stage, 'char', tl.characters.ramp);
      }]
    ];
    let lastEnd = 0;
    for (const [name, fn] of beats) {
      if (!keyed.has(name)) continue;
      const lane = tl[name] || defaultTimeline()[name];
      const at = Math.max(0, +lane.at || 0);
      lastEnd = Math.max(lastEnd, at + (+lane.ramp || 0));
      testTimers.push(setTimeout(() => { fn(); paint(); }, at));
    }
    // The keyframe-editor "Test" snaps back to the editing baseline so it can be
    // re-run; the cue-row "Preview" (hold) leaves the result up, like a live cue.
    if (!hold) testTimers.push(setTimeout(() => { cancelTestTimeline(); renderBuilderPreview(); }, lastEnd + 900));
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
  // Is a different background variant armed (picked) but not yet applied?
  function bgPending() { return armedBg != null && armedBg !== state.mapState; }
  // ---- Quick actions (live manual surface): background + characters ----
  // The always-on "Visual" section: three rows, each a dropdown + a Show/Hide. The
  // Stage row's Show/Hide applies the armed variant + reveals the backdrop, or hides
  // it (characters on black); the global Black-out sits on the section header.
  function renderQuick(scene) {
    fillVariantSelect(els.quickBgSelect, scene);   // background variant dropdown (shows the armed pick)
    // Stage backdrop Show/Hide: "Show" when a new variant is armed OR the backdrop
    // is hidden (press to apply / reveal); "Hide" when it is live (press for
    // characters-on-black). Lit while the backdrop is hidden.
    const bgHidden = !!(state.stage && state.stage.bgHidden);
    els.quickBgVis.textContent = (bgPending() || bgHidden) ? 'Show' : 'Hide';
    els.quickBgVis.classList.toggle('is-on', bgHidden);
    for (const side of ['left', 'right']) {
      const hasChar = charRoster(scene.characters && scene.characters[side]).length > 0 || !!state.stage[side].srcOverride;
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
      if (kind === 'sfx') return state.audio.sfxVolume == null ? 0.8 : state.audio.sfxVolume;
      const keys = mixerTrackKeys(kind);
      return keys.length ? state.audio.tracks[keys[0]].volume : 0.8;
    };
    slider.value = groupVal();
    slider.addEventListener('input', () => {
      ensureAudio();
      const v = +slider.value;
      if (kind === 'master') state.audio.master = v;
      else if (kind === 'sfx') state.audio.sfxVolume = v;
      else for (const k of mixerTrackKeys(kind)) state.audio.tracks[k].volume = v;
      commitAudio();
    });
    const mute = document.createElement('button');
    mute.className = 'gm-button btn--toggle mixer-mute'; mute.type = 'button'; mute.textContent = 'Mute';
    mute.dataset.kind = kind;
    const isMuted = () => kind === 'master' ? !!state.audio.masterMuted : kind === 'sfx' ? !!state.audio.sfxMuted : mixerGroupMuted(kind);
    mute.classList.toggle('is-on', isMuted());
    mute.addEventListener('click', () => {
      ensureAudio();
      if (kind === 'master') state.audio.masterMuted = !state.audio.masterMuted;
      else if (kind === 'sfx') state.audio.sfxMuted = !state.audio.sfxMuted;
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

    // Mixer footer: which windows actually SOUND (TV = Player, Laptop = GM
    // monitor) + the whole-mix Fade. Outputs live here now that the full panel
    // is retired -- they sit right next to the Fade button.
    const outWrap = document.createElement('div'); outWrap.className = 'mixer-outputs';
    const outLabel = document.createElement('span'); outLabel.className = 'mixer-out-label'; outLabel.textContent = 'Out';
    outWrap.append(outLabel);
    for (const [key, text] of [['player', 'TV'], ['gm', 'Laptop']]) {
      const b = document.createElement('button');
      b.className = 'gm-button btn--toggle mixer-output'; b.type = 'button'; b.dataset.out = key; b.textContent = text;
      const isOn = () => !!(state.audio.outputs && state.audio.outputs[key]);
      b.classList.toggle('active', isOn());
      b.addEventListener('click', () => { ensureAudio(); state.audio.outputs[key] = !isOn(); b.classList.toggle('active', isOn()); commitAudio(); });
      outWrap.append(b);
    }
    const fade = document.createElement('button');
    fade.className = 'gm-button btn--toggle mixer-fade'; fade.type = 'button';
    fade.textContent = state.audio.masterMuted ? 'Fade in' : 'Fade out';
    fade.classList.toggle('is-on', !!state.audio.masterMuted);
    fade.title = 'Fade all audio out / back in';
    fade.addEventListener('click', fadeAudio);
    els.mixerExtra.append(outWrap, fade);
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
  //  Audio: a state-driven control surface. The GM monitors locally; the Player
  //  is the room output. Controls mutate state.audio then commitAudio() (save +
  //  broadcast + engine.sync) -- NOT renderUI(), so sliders are never rebuilt
  //  mid-drag. The live surface is the sidebar mixer (renderMixer); per-bed
  //  levels & fades are configured in the scene builder.
  // ============================================================
  function ensureAudio() {
    if (!state.audio) state.audio = { master: 0.8, sfxVolume: 0.8, sfxMuted: false, outputs: { player: true, gm: false }, tracks: {}, sfxTrigger: {} };
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
      loop: cfg.loop !== false,
      fadeIn: Math.max(0, +cfg.fadeIn || 0),    // seconds: gentle fade-in on start
      fadeOut: Math.max(0, +cfg.fadeOut || 0)   // seconds: fade-out on stop / before a non-loop ends
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
  // ---- small DOM helpers (a labelled range / knob), reused by the builder's
  //      per-bed audio editor (vol / pan / fades). ----
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

  // (The full live audio panel -- per-bed Vol/Pan/Play/fades + outputs + Save --
  // is retired: per-bed levels & fades are set in the builder, the sidebar mixer
  // carries live levels + Fade + the TV/Laptop outputs, and cues start/stop beds.)

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
  // Music/ambience beds: pick which the scene carries AND tune each selected bed
  // in place -- volume, pan, and the per-loop fade in/out (seconds) the engine
  // dips at every loop seam. This is where fades are configured now (the old live
  // "full panel" is gone); the live sidebar mixer just rides the saved levels.
  function buildBedPicks(container, list, beds) {
    container.innerHTML = '';
    if (!list.length) { const p = document.createElement('span'); p.className = 'audio-pick-empty'; p.textContent = '(none found -- add files under assets/audio, then Rescan)'; container.append(p); return; }
    for (const item of list) {
      const bed = beds.find((x) => x.src === item.src);
      const wrap = document.createElement('div'); wrap.className = 'bed-pick' + (bed ? ' is-on' : '');
      const lab = document.createElement('label'); lab.className = 'roster-item';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!bed;
      cb.addEventListener('change', () => {
        if (cb.checked) { if (!beds.some((x) => x.src === item.src)) beds.push({ src: item.src, volume: 0.8, pan: 0, loop: true, fadeIn: 0, fadeOut: 0 }); }
        else { const i = beds.findIndex((x) => x.src === item.src); if (i >= 0) beds.splice(i, 1); }
        buildBedPicks(container, list, beds);   // re-render to reveal/hide the bed's controls
      });
      const nm = document.createElement('span'); nm.textContent = item.name;
      lab.append(cb, nm); wrap.append(lab);
      if (bed) {
        const ctl = document.createElement('div'); ctl.className = 'bed-controls';
        const vol = aRange('audio-vol', 0, 1, bed.volume == null ? 0.8 : bed.volume);
        vol.addEventListener('input', () => { bed.volume = +vol.value; });
        const pan = aRange('audio-pan', -1, 1, bed.pan || 0);
        pan.addEventListener('input', () => { bed.pan = +pan.value; });
        ctl.append(aKnob('Vol', vol), aKnob('Pan', pan));
        const mkFade = (prop, label) => {
          const inp = document.createElement('input'); inp.type = 'number'; inp.className = 'audio-fade';
          inp.min = '0'; inp.max = '30'; inp.step = '0.5'; inp.value = bed[prop] || 0; inp.title = label + ' in seconds (0 = none)';
          inp.addEventListener('change', () => { bed[prop] = Math.max(0, +inp.value || 0); });
          return aKnob(label, inp);
        };
        ctl.append(mkFade('fadeIn', 'Fade in'), mkFade('fadeOut', 'Fade out'));
        wrap.append(ctl);
      }
      container.append(wrap);
    }
  }
  function renderAudioPick() {
    // Music + ambience are libraries of beds, each tuned in place (vol/pan/fades);
    // cues pick which play. SFX are one-shots (a plain check list, no fades).
    buildBedPicks(els.bMusic, audioMusic, draft.audio.music);
    buildBedPicks(els.bAmbience, audioAmbience, draft.audio.ambience);
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
    const list = kind === 'hero' ? CAST.heroes : kind === 'npc' ? CAST.npcs : CAST.enemies;
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
    if (kind === 'hero' || kind === 'npc') {
      if (tokens.some((t) => t.kind === kind && t.castId === castId)) return;  // heroes/NPCs are unique
      label = cast.name;
      visible = true;                              // allies are placed in the open
    } else {
      label = enemySingular(cast) + ' ' + nextEnemyNumber(tokens, castId);
      visible = false;                             // enemies are staged hidden, revealed on cue
    }
    // Scatter around the center so stacked drops do not perfectly overlap.
    const k = tokens.length;
    const x = clamp01(0.5 + ((k % 5) - 2) * 0.045);
    const y = clamp01(0.5 + ((Math.floor(k / 5) % 5) - 2) * 0.045);
    // Seed combat tracking: HP starts full from the cast stat block (null when the
    // type has no stats yet -- e.g. heroes before their sheet is added).
    const maxHp = (cast.stats && cast.stats.hp != null && isFinite(+cast.stats.hp)) ? Math.round(+cast.stats.hp) : null;
    tokens.push({ instId: 'tk' + (++tokenSeq), castId, kind, label, x, y, visible, hp: { current: maxHp, max: maxHp }, conditions: [] });
    commit();
  }
  function removeToken(instId) {
    ensureTokens();
    state.stage.tokens = state.stage.tokens.filter((t) => t.instId !== instId);
    // A removed token leaves the initiative line; the cursor clamps + the active
    // highlight moves to whoever now sits at that slot. Only re-sort an EXISTING
    // order (built by Apply) -- don't build one from a half-entered set.
    if (state.initiative && state.initiative.rolls) {
      delete state.initiative.rolls[instId];
      if (Array.isArray(state.initiative.order) && state.initiative.order.length) rebuildInitOrder();
    }
    commit();
  }
  function toggleTokenVisible(instId) {
    ensureTokens();
    const t = state.stage.tokens.find((x) => x.instId === instId);
    if (t) { t.visible = t.visible === false; commit(); }
  }
  function findToken(instId) {
    ensureTokens();
    return state.stage.tokens.find((x) => x.instId === instId) || null;
  }
  // ---- Per-token HP + conditions (map-mode combat tracking) --------------------
  //  applyHp(delta): +heal / -damage on current HP, clamped to [0, max]. Seeds max
  //  on first edit if it was never set (e.g. a hero before stats existed).
  function applyHp(instId, delta) {
    const t = findToken(instId);
    if (!t || !isFinite(+delta) || !delta) return;
    if (!t.hp || typeof t.hp !== 'object') t.hp = { current: null, max: null };
    const cast = castEntry(t.castId, t.kind);
    if (t.hp.max == null && cast && cast.stats && cast.stats.hp != null) t.hp.max = Math.round(+cast.stats.hp);
    const base = t.hp.current != null ? t.hp.current : (t.hp.max != null ? t.hp.max : 0);
    let next = Math.round(base + (+delta));
    if (next < 0) next = 0;
    if (t.hp.max != null && next > t.hp.max) next = t.hp.max;
    t.hp.current = next;
    // PR 6E: a damaged caster who is CONCENTRATING on a zone gets a reminder banner on
    // the GM card (drop it -> the caster's zones clear). Damage only, never heals.
    if (delta < 0 && state.stage && Array.isArray(state.stage.zones) &&
        state.stage.zones.some((z) => z.concentration && z.casterId === instId)) {
      concWarn = { instId, dmg: Math.round(-delta) };
    }
    commit();
  }
  function setHpMax(instId, max) {
    const t = findToken(instId); if (!t) return;
    if (!t.hp || typeof t.hp !== 'object') t.hp = { current: null, max: null };
    const m = (max == null || max === '' || !isFinite(+max)) ? null : Math.max(0, Math.round(+max));
    t.hp.max = m;
    if (m != null && (t.hp.current == null || t.hp.current > m)) t.hp.current = m;
    commit();
  }
  function addCondition(instId, name) {
    const t = findToken(instId); if (!t || !name) return;
    name = String(name).trim(); if (!name) return;
    if (!Array.isArray(t.conditions)) t.conditions = [];
    if (!t.conditions.some((c) => c.toLowerCase() === name.toLowerCase())) { t.conditions.push(name); commit(); }
  }
  function removeCondition(instId, name) {
    const t = findToken(instId); if (!t || !Array.isArray(t.conditions)) return;
    t.conditions = t.conditions.filter((c) => c.toLowerCase() !== String(name).toLowerCase());
    commit();
  }

  // ---- Initiative tracker (GM-only combat state) -------------------------------
  //  state.initiative = { mods:{castId:int}, rolls:{instId:int}, order:[instId], idx:int }
  //  Enemies roll a d20 + their type's modifier; heroes are typed in. The order is
  //  the placed tokens that have a roll, sorted high-to-low; cycling sets
  //  state.stage.activeTokenId (broadcast -> the golden ring on BOTH screens).
  function d20() { return Math.floor(Math.random() * 20) + 1; }   // browser RNG -- fine for dice
  function ensureInit() {
    if (!state.initiative || typeof state.initiative !== 'object') state.initiative = {};
    const i = state.initiative;
    if (!i.mods || typeof i.mods !== 'object') i.mods = {};
    if (!i.rolls || typeof i.rolls !== 'object') i.rolls = {};
    if (!Array.isArray(i.order)) i.order = [];
    if (typeof i.idx !== 'number' || i.idx < 0) i.idx = 0;
    return i;
  }
  function syncActiveToken() {
    const i = ensureInit();
    if (!state.stage) return;
    state.stage.activeTokenId = i.order.length ? i.order[Math.min(i.idx, i.order.length - 1)] : null;
  }
  // Rebuild the order from placed tokens that have a roll, high-to-low.
  function rebuildInitOrder() {
    const i = ensureInit();
    const placed = (state.stage && state.stage.tokens) || [];
    const have = placed.filter((t) => i.rolls[t.instId] != null);
    have.sort((a, b) => (i.rolls[b.instId] - i.rolls[a.instId]));
    i.order = have.map((t) => t.instId);
    if (i.idx >= i.order.length) i.idx = 0;
    syncActiveToken();
  }
  // Roll every placed enemy into its own initiative field (d20 + the type
  // modifier). Fills the fields only -- the GM presses Apply to build the order.
  function rollEnemies() {
    ensureTokens(); const i = ensureInit();
    for (const t of state.stage.tokens) {
      if (t.kind === 'enemy') i.rolls[t.instId] = d20() + (parseInt(i.mods[t.castId], 10) || 0);
    }
    commit();   // show the rolled values in the roster fields; no re-sort yet
  }
  function setEnemyMod(castId, val) {
    const i = ensureInit();
    const n = parseInt(val, 10);
    if (val === '' || isNaN(n)) delete i.mods[castId]; else i.mods[castId] = n;
    saveState(state);   // stored for the next roll; no re-render (keeps input focus)
  }
  // A single token's initiative value (typed for heroes, rolled-or-overridden for
  // enemies). Stores the value only; Apply builds the sorted order from the values.
  function setTokenRoll(instId, val) {
    const i = ensureInit();
    const n = parseInt(val, 10);
    if (val === '' || isNaN(n)) delete i.rolls[instId]; else i.rolls[instId] = n;
    commit();
  }
  // Build (or rebuild) the turn order from the entered values, high-to-low, and
  // start at the top. This is the GM's explicit "sort now" action.
  function applyInitiative() {
    const i = ensureInit();
    i.idx = 0;
    rebuildInitOrder();
    commit();
  }
  function initStep(delta) {
    const i = ensureInit();
    if (!i.order.length) return;
    i.idx = (i.idx + delta + i.order.length) % i.order.length;
    syncActiveToken();
    clearAttackState();   // a new turn drops any half-finished attack roll/target
    commit();
  }
  function setInitIdx(n) {
    const i = ensureInit();
    if (n < 0 || n >= i.order.length) return;
    i.idx = n; syncActiveToken(); clearAttackState(); commit();
  }
  function clearInitiative() {
    const mods = (state.initiative && state.initiative.mods) || {};
    state.initiative = { mods, rolls: {}, order: [], idx: 0 };   // keep the type modifiers
    if (state.stage) state.stage.activeTokenId = null;
    clearAttackState();
    commit();
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
  // A token's initiative value field -- typed for a hero (players roll their own),
  // filled by "Roll enemies" for an enemy (and still editable to override). Stores
  // the value only; the GM presses Apply to sort. Commits on change (blur), not per
  // keystroke, so the re-render does not steal focus mid-type.
  function tokenRollInput(t) {
    const i = ensureInit();
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'mmr-init'; inp.placeholder = 'init';
    inp.title = 'Initiative roll'; inp.setAttribute('aria-label', t.label + ' initiative');
    inp.value = (i.rolls[t.instId] != null ? i.rolls[t.instId] : '');
    inp.addEventListener('change', () => setTokenRoll(t.instId, inp.value));
    return inp;
  }
  // An enemy TYPE's initiative modifier: one per type, applied to every token of
  // that type when rolled. Inline on the type row to match the hero init field;
  // commits via setEnemyMod (saves without a focus-stealing re-render).
  function enemyModInput(castId) {
    const i = ensureInit();
    const c = castEntry(castId, 'enemy');
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'mmr-init'; inp.placeholder = '+0';
    inp.title = 'Initiative modifier (applied to every ' + (c ? enemySingular(c) : 'token') + ' of this type)';
    inp.setAttribute('aria-label', (c ? c.name : 'enemy') + ' initiative modifier');
    inp.value = (i.mods[castId] != null ? i.mods[castId] : '');
    inp.addEventListener('change', () => setEnemyMod(castId, inp.value));
    return inp;
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
  // Batch-set visibility for a group's placed tokens (Reveal all / Hide all).
  function setGroupVisible(placed, visible) {
    ensureTokens();
    for (const p of placed) {
      const live = state.stage.tokens.find((x) => x.instId === p.instId);
      if (live) live.visible = visible;
    }
    commit();
  }
  // ---- Per-token combat controls in the roster (map mode) ----
  // HP: cur/max + a typed amount with Damage(-) / Heal(+) -- the quick
  // D&D-Beyond style. Max seeds from the cast stat block; applyHp clamps [0,max].
  // Returns the two labelled columns' contents: the cur/max readout ("HP") and the
  // − [amount] + cluster ("dmg / heal"), with the sign buttons EITHER SIDE of the box.
  function tokenHpControl(t) {
    const cast = castEntry(t.castId, t.kind);
    const hp = t.hp || {};
    const max = hp.max != null ? hp.max : ((cast && cast.stats && cast.stats.hp != null) ? Math.round(+cast.stats.hp) : null);
    const cur = hp.current != null ? hp.current : max;
    const num = document.createElement('span');
    num.className = 'mmr-hpnum' + (max != null && cur != null && cur < max ? ' is-hurt' : '');
    num.textContent = (cur != null ? cur : '—') + ' / ' + (max != null ? max : '—');
    const amt = document.createElement('input');
    amt.type = 'number'; amt.className = 'mmr-hpamt'; amt.placeholder = '0'; amt.min = '0';
    amt.title = 'Amount to apply'; amt.setAttribute('aria-label', t.label + ' damage / heal amount');
    const mk = (cls, sign, glyph, label) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'mmr-hpbtn ' + cls; b.textContent = glyph;
      b.title = label; b.setAttribute('aria-label', label + ' ' + t.label);
      b.addEventListener('click', () => { const v = parseInt(amt.value, 10); if (isFinite(v) && v > 0) applyHp(t.instId, sign * v); });
      return b;
    };
    const ctrl = document.createElement('div'); ctrl.className = 'mmr-hp';
    ctrl.append(mk('is-dmg', -1, '−', 'Damage'), amt, mk('is-heal', 1, '+', 'Heal'));
    return { num, ctrl };
  }
  // Conditions: removable chips + an add control (5e presets + a custom entry).
  function tokenConditionsControl(t) {
    const wrap = document.createElement('div'); wrap.className = 'mmr-cond';
    const conds = Array.isArray(t.conditions) ? t.conditions : [];
    for (const cn of conds) {
      const chip = document.createElement('span'); chip.className = 'cond-chip';
      chip.append(document.createTextNode(cn));
      const x = document.createElement('button'); x.type = 'button'; x.className = 'cond-x'; x.textContent = '✕';
      x.title = 'Remove ' + cn; x.setAttribute('aria-label', 'Remove ' + cn + ' from ' + t.label);
      x.addEventListener('click', () => removeCondition(t.instId, cn));
      chip.append(x); wrap.append(chip);
    }
    const sel = document.createElement('select'); sel.className = 'cond-add';
    sel.setAttribute('aria-label', 'Add a condition to ' + t.label);
    const ph = document.createElement('option'); ph.value = ''; ph.textContent = '+ condition'; sel.append(ph);
    for (const name of CONDITIONS) {
      if (conds.some((c) => c.toLowerCase() === name.toLowerCase())) continue;
      const o = document.createElement('option'); o.value = name; o.textContent = name; sel.append(o);
    }
    const cu = document.createElement('option'); cu.value = '__custom__'; cu.textContent = 'Custom…'; sel.append(cu);
    sel.addEventListener('change', () => {
      const v = sel.value; sel.value = '';
      if (!v) return;
      if (v === '__custom__') { const name = (window.prompt('Condition name?') || '').trim(); if (name) addCondition(t.instId, name); return; }
      addCondition(t.instId, v);
    });
    wrap.append(sel);
    return wrap;
  }
  // A roster category as a columnar table: Name · Init · HP · Condition · Vis · ✕.
  function rosterColumn(label, addAll, placed) {
    const col = document.createElement('div'); col.className = 'mmr-cat';
    const head = document.createElement('div'); head.className = 'mmr-head';
    const lab = document.createElement('span'); lab.className = 'mmr-label'; lab.textContent = label;
    const all = document.createElement('button'); all.className = 'gm-button btn--quiet mmr-addall'; all.type = 'button'; all.textContent = 'Add all';
    all.addEventListener('click', addAll);
    head.append(lab, all);
    if (placed && placed.length) {
      const anyHidden = placed.some((t) => t.visible === false);
      const rev = document.createElement('button'); rev.className = 'gm-button btn--quiet mmr-revealall'; rev.type = 'button';
      rev.textContent = anyHidden ? 'Reveal all' : 'Hide all';
      rev.addEventListener('click', () => setGroupVisible(placed, anyHidden));
      head.append(rev);
    }
    const table = document.createElement('table'); table.className = 'mmr-table';
    const thead = document.createElement('thead'); const htr = document.createElement('tr');
    for (const [txt, cls] of [['Name', ''], ['Init', 'c'], ['Roll', 'c'], ['HP', 'c'], ['− dmg · heal +', 'c'], ['Condition', ''], ['Vis', 'c'], ['', 'c']]) {
      const th = document.createElement('th'); if (cls) th.className = cls; th.textContent = txt; htr.append(th);
    }
    thead.append(htr);
    const tbody = document.createElement('tbody');
    table.append(thead, tbody); col.append(head, table);
    return { col, tbody };
  }
  // A placed token's full row (hero, or an enemy instance via rowClass 'mmr-copy').
  // PR 6C.1: per-combatant Auto/Manual roll mode. Auto = the app rolls; Manual = the
  // player rolled physically and the GM types the total. Appears in the roster row
  // (compact ✍/🎲) and the active card header (labelled); both flip token.manual + commit.
  function manualToggleBtn(t, labelled) {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'gm-button btn--quiet roster-manual' + (t.manual ? ' is-manual' : '');
    b.textContent = labelled ? (t.manual ? '✍ Manual' : '🎲 Auto') : (t.manual ? '✍' : '🎲');
    b.title = t.manual ? 'Manual rolls — you type the value. Click for Auto.' : 'Auto rolls — the app rolls. Click for Manual.';
    b.setAttribute('aria-label', 'Roll mode for ' + t.label + ': ' + (t.manual ? 'manual' : 'auto') + ' — click to toggle');
    b.addEventListener('click', () => { const tok = findToken(t.instId); if (tok) { tok.manual = !tok.manual; commit(); } });
    return b;
  }
  function placedRow(t, c, rowClass) {
    const tr = document.createElement('tr');
    tr.className = 'mmr-row is-placed' + (rowClass ? ' ' + rowClass : '') + (state.stage && t.instId === state.stage.activeTokenId ? ' is-active' : '');
    tr.dataset.instId = t.instId;
    const nameTd = document.createElement('td'); nameTd.className = 'mmr-namecell';
    nameTd.append(rosterSwatch(c ? c.ringColor : '#888'), rosterName(t.label, t.visible === false));
    const initTd = document.createElement('td'); initTd.className = 'c'; initTd.append(tokenRollInput(t));
    const rollTd = document.createElement('td'); rollTd.className = 'c'; rollTd.append(manualToggleBtn(t, false));   // its own labelled "Roll" column
    const hpParts = tokenHpControl(t);
    const hpTd = document.createElement('td'); hpTd.className = 'c'; hpTd.append(hpParts.num);
    const dmgTd = document.createElement('td'); dmgTd.className = 'c'; dmgTd.append(hpParts.ctrl);
    const condTd = document.createElement('td'); condTd.append(tokenConditionsControl(t));
    const visTd = document.createElement('td'); visTd.className = 'c'; visTd.append(rosterVisBtn(t));
    const delTd = document.createElement('td'); delTd.className = 'c'; delTd.append(rosterDelBtn(t));
    tr.append(nameTd, initTd, rollTd, hpTd, dmgTd, condTd, visTd, delTd);
    return tr;
  }

  function renderRoster(scene) {
    const roster = scene.tokens || {};
    const heroes = Array.isArray(roster.heroes) ? roster.heroes : [];
    const npcs = Array.isArray(roster.npcs) ? roster.npcs : [];
    const enemies = Array.isArray(roster.enemies) ? roster.enemies : [];
    const placed = (state.stage && state.stage.tokens) || [];
    els.mapRoster.innerHTML = '';

    if (!heroes.length && !enemies.length && !npcs.length) {
      const p = document.createElement('p'); p.className = 'mmr-empty';
      p.textContent = 'No roster set. Edit the scene to choose heroes and enemies.';
      els.mapRoster.append(p); return;
    }

    const cell = (cls, span) => { const e = document.createElement('td'); if (cls) e.className = cls; if (span) e.colSpan = span; return e; };
    const nameCell = (c, label, hidden) => { const e = cell('mmr-namecell'); e.append(rosterSwatch(c ? c.ringColor : '#888'), rosterName(label, hidden)); return e; };
    const addRow = (tbody, cells, cls) => { const tr = document.createElement('tr'); tr.className = 'mmr-row' + (cls ? ' ' + cls : ''); for (const td of cells) tr.append(td); tbody.append(tr); };

    if (heroes.length || npcs.length) {
      const { col, tbody } = rosterColumn('Heroes', () => { for (const id of heroes) addToken(id, 'hero'); }, placed.filter((t) => t.kind === 'hero' || t.kind === 'npc'));
      for (const id of heroes) {
        const c = castEntry(id, 'hero'); if (!c) continue;
        const inst = placed.find((t) => t.kind === 'hero' && t.castId === id);
        if (inst) tbody.append(placedRow(inst, c));
        else { const addTd = cell('c'); addTd.append(rosterAddBtn(id, 'hero')); addRow(tbody, [nameCell(c, c.name, false), cell('mmr-spacer', 6), addTd]); }
      }
      // Allied NPCs live under the Heroes column, in their own labelled sub-section.
      if (npcs.length) {
        const sub = document.createElement('tr'); sub.className = 'mmr-subhead';
        const sc = document.createElement('td'); sc.colSpan = 8; sc.textContent = 'NPCs'; sub.append(sc); tbody.append(sub);
        for (const id of npcs) {
          const c = castEntry(id, 'npc'); if (!c) continue;
          const inst = placed.find((t) => t.kind === 'npc' && t.castId === id);
          if (inst) tbody.append(placedRow(inst, c));
          else { const addTd = cell('c'); addTd.append(rosterAddBtn(id, 'npc')); addRow(tbody, [nameCell(c, c.name, false), cell('mmr-spacer', 6), addTd]); }
        }
      }
      els.mapRoster.append(col);
    }

    if (enemies.length) {
      const { col, tbody } = rosterColumn('Enemies', () => { for (const id of enemies) addToken(id, 'enemy'); }, placed.filter((t) => t.kind === 'enemy'));
      // (Roll enemies lives in the initiative panel footer; the per-type modifier
      // field stays here on the type row.)
      for (const id of enemies) {
        const c = castEntry(id, 'enemy'); if (!c) continue;
        const modTd = cell('c'); modTd.append(enemyModInput(id));
        const addTd = cell('c', 2); addTd.append(rosterAddBtn(id, 'enemy'));
        addRow(tbody, [nameCell(c, c.name, false), modTd, cell('mmr-spacer', 4), addTd], 'mmr-type');
        for (const t of placed.filter((p) => p.kind === 'enemy' && p.castId === id)) tbody.append(placedRow(t, c, 'mmr-copy'));
      }
      els.mapRoster.append(col);
    }
  }

  // The initiative panel (map mode): per-enemy-type modifiers, Roll enemies /
  // Roll all, then the sorted tracker with prev/next. Active row + active token
  // ride state.stage.activeTokenId (the gold ring on both screens).
  let initShowAll = false;   // expand the sliding window to the full order
  const INIT_WINDOW = 3;     // how many combatants the "who's next" window shows (active + next 2)
  function renderInitiative(scene) {
    if (!els.initiative) return;
    const host = els.initiative; host.innerHTML = '';
    const i = ensureInit();
    const placed = (state.stage && state.stage.tokens) || [];
    const tokenFor = (instId) => placed.find((x) => x.instId === instId);

    // ---- Header: title + Turn x/y + Prev/Next (the per-turn nav lives up here) ----
    const head = document.createElement('div'); head.className = 'init-head';
    const title = document.createElement('span'); title.className = 'init-title'; title.textContent = 'Initiative';
    head.append(title);
    if (i.order.length) {
      const prev = document.createElement('button'); prev.className = 'gm-button btn--quiet init-prev'; prev.type = 'button';
      prev.textContent = '◀ Prev'; prev.title = 'Previous turn'; prev.addEventListener('click', () => initStep(-1));
      const next = document.createElement('button'); next.className = 'gm-button init-next'; next.type = 'button';
      next.textContent = 'Next ▶'; next.title = 'Next turn'; next.addEventListener('click', () => initStep(1));
      head.append(prev, next);
    }
    host.append(head);

    // ---- Tracker: a sliding window that starts at the ACTIVE turn and shows who's
    //      up next (wrapping past end-of-round), so a big fight stays on screen. ----
    const track = document.createElement('div'); track.className = 'init-track';
    if (!i.order.length) {
      const hint = document.createElement('p'); hint.className = 'init-empty';
      hint.textContent = 'Type the heroes’ rolls, Roll enemies, then Apply to build the order.';
      track.append(hint);
    } else {
      const total = i.order.length;
      const windowed = !initShowAll && total > INIT_WINDOW;
      const slots = [];
      if (windowed) { for (let k = 0; k < INIT_WINDOW; k++) slots.push((i.idx + k) % total); }
      else { for (let n = 0; n < total; n++) slots.push(n); }
      // Header row: "Turn x/y · up next" on the left, the Show-all toggle on the right.
      const winrow = document.createElement('div'); winrow.className = 'init-winrow';
      const cap = document.createElement('div'); cap.className = 'init-win-label';
      cap.textContent = 'Turn ' + (i.idx + 1) + ' / ' + total + (windowed ? ' · up next' : '');
      winrow.append(cap);
      if (total > INIT_WINDOW) {
        const more = document.createElement('button'); more.className = 'init-more'; more.type = 'button';
        more.textContent = initShowAll ? 'Show fewer' : ('Show all (' + total + ')');
        more.addEventListener('click', () => { initShowAll = !initShowAll; renderInitiative(scene); });
        winrow.append(more);
      }
      track.append(winrow);
      const list = document.createElement('ol'); list.className = 'init-list';
      slots.forEach((n) => {
        const instId = i.order[n];
        const t = tokenFor(instId); if (!t) return;
        const c = castEntry(t.castId, t.kind);
        const li = document.createElement('li'); li.className = 'init-row' + (n === i.idx ? ' is-active' : '');
        if (windowed && n < i.idx) li.classList.add('is-wrap');   // wrapped = next round, faded
        const ord = document.createElement('span'); ord.className = 'init-ord'; ord.textContent = (n + 1);
        const nm = document.createElement('span'); nm.className = 'init-name'; nm.textContent = t.label;
        const val = document.createElement('span'); val.className = 'init-val'; val.textContent = i.rolls[instId];
        li.append(ord, rosterSwatch(c ? c.ringColor : '#888'), nm, val);
        li.title = 'Jump to this turn';
        li.addEventListener('click', () => setInitIdx(n));
        list.append(li);
      });
      track.append(list);
    }
    host.append(track);

    // ---- Footer: the once-per-combat setup cluster, divided off below the list so
    //      it sits far from the Prev/Next up top (no mid-fight mis-clicks). ----
    const foot = document.createElement('div'); foot.className = 'init-foot';
    const roll = document.createElement('button'); roll.className = 'gm-button btn--quiet init-roll'; roll.type = 'button';
    roll.textContent = 'Roll enemies'; roll.title = "Roll a d20 + each type's modifier into every enemy's initiative field";
    roll.addEventListener('click', rollEnemies);
    const apply = document.createElement('button'); apply.className = 'gm-button init-apply'; apply.type = 'button';
    apply.textContent = 'Apply'; apply.title = 'Sort the order from the entered initiative values (highest first)';
    apply.addEventListener('click', applyInitiative);
    const clr = document.createElement('button'); clr.className = 'gm-button btn--quiet init-clear'; clr.type = 'button';
    clr.textContent = 'Clear'; clr.title = 'Clear the rolls + order (keeps the type modifiers)';
    clr.addEventListener('click', clearInitiative);
    foot.append(roll, apply, clr);
    host.append(foot);
  }

  // The card to show: the ACTIVE combatant (hero or enemy). When no turn is set
  // yet, keep the last-shown card if its token is still placed, else fall to the
  // first placed enemy with a stat block (a foe card during setup). Tracking by
  // instId keeps it scene-local -- a previous scene's token is never resurrected.
  let lastStatToken = null;
  let lastAtkName = null;   // PR 6C.1 fix: keep the picked attack selected across re-renders
  function activeStatContext() {
    const placed = (state.stage && state.stage.tokens) || [];
    const byId = (id) => placed.find((t) => t.instId === id);
    const ctxFor = (t) => { if (!t) return null; const c = castEntry(t.castId, t.kind); return { token: t, cast: c, stats: (c && c.stats) || null }; };
    const active = (state.stage && state.stage.activeTokenId) && byId(state.stage.activeTokenId);
    if (active) { lastStatToken = active.instId; return ctxFor(active); }
    if (lastStatToken && byId(lastStatToken)) return ctxFor(byId(lastStatToken));
    lastStatToken = null;
    const foe = placed.find((t) => t.kind === 'enemy' && (castEntry(t.castId, 'enemy') || {}).stats);
    if (foe) { lastStatToken = foe.instId; return ctxFor(foe); }
    return null;
  }
  // ---- Attack resolution: pick a TARGET on the board (a red targeting arrow +
  //      glow show who's aimed at, on the GM board AND the TV), then roll to Hit
  //      (auto-checked vs the target's AC) and Dmg (applied to the target). The
  //      link rides state.stage.targetLink so it broadcasts. Future: AoE/cones. ----
  let attackRoll = null;   // { instId, kind:'hit'|'dmg', ... } the last roll on the active card
  let targeting = false;   // armed: the next board-token click sets the target
  let aoePlacing = null;   // PR 6D/6E: { token, atk, shape, zone?, committed, hits[], results } while aiming/resolving an area
  let spikePrompt = null;  // PR 6E: { instId, label, zone, dice, per, feet, times } after a drag through an on-move zone
  let concWarn = null;     // PR 6E: { instId, dmg } when a concentrating caster takes damage
  const rollN = (count, sides) => { let s = 0; for (let k = 0; k < count; k++) s += Math.floor(Math.random() * sides) + 1; return s; };
  const parseHitMod = (toHit) => { const m = /^\s*([+-]?\d+)\s*$/.exec(String(toHit || '')); return m ? parseInt(m[1], 10) : null; };
  const parseDamage = (dmg) => { const m = /(\d+)\s*d\s*(\d+)\s*([+-]\s*\d+)?/i.exec(String(dmg || '')); if (!m) return null; return { count: +m[1], sides: +m[2], mod: m[3] ? parseInt(m[3].replace(/\s+/g, ''), 10) : 0, type: String(dmg).replace(m[0], '').replace(/\(.*?\)/g, '').trim() }; };   // strip a "(1/rest)"-style note from the damage TYPE (it stays on the card's attack line)
  // PR 6C: an attack whose toHit reads "DEX save 13" is a saving throw, not an attack
  // roll. Parse the ability + DC so we can auto-roll the target's save when its stats
  // are known (else fall back to a manual verdict).
  const parseSave = (toHit) => { const m = /(STR|DEX|CON|INT|WIS|CHA)\s+save\s+(\d+)/i.exec(String(toHit || '')); return m ? { ability: m[1].toUpperCase(), dc: +m[2] } : null; };
  const sceneHasSfx = (id) => { const sc = sceneById(state.sceneId); return !!(sc && sc.audio && (sc.audio.sfx || []).some((s) => s.id === id)); };
  function fireAttackSfx(id) { if (!id || !sceneHasSfx(id)) return; ensureAudio(); state.audio.sfxTrigger[id] = (state.audio.sfxTrigger[id] || 0) + 1; commitAudio(); }
  function renderBoardTargeting() { if (boardView && boardView.el) boardView.el.classList.toggle('is-targeting', !!targeting); }
  function currentTarget() {
    const link = state.stage && state.stage.targetLink;
    return (link && link.from === state.stage.activeTokenId) ? findToken(link.to) : null;
  }
  // ---- PR 6B: grid range check. Parse an attack's range string, measure the grid
  //      distance to the target (Chebyshev * feet/cell), and verdict it. Degrades to
  //      no-op when the scene/map has no grid. ----
  function parseAtkRange(rangeStr) {
    const s = String(rangeStr || '');
    let m;
    if ((m = /reach\s+(\d+)/i.exec(s))) return { type: 'melee', reach: +m[1] };
    if ((m = /(?:range|thrown)\s+(\d+)\s*\/\s*(\d+)/i.exec(s))) return { type: 'ranged', normal: +m[1], long: +m[2] };
    if ((m = /(?:range|thrown)\s+(\d+)/i.exec(s))) return { type: 'ranged', normal: +m[1], long: +m[1] };
    return null;   // a save or an unparseable range -> no check
  }
  function rangeVerdict(pr, feet) {
    if (pr.type === 'melee') return feet <= pr.reach ? { status: 'in', label: 'in reach' } : { status: 'out', label: 'out of reach' };
    if (feet <= pr.normal) return { status: 'in', label: 'in range' };
    if (feet <= pr.long) return { status: 'disadv', label: 'long · disadv' };
    return { status: 'out', label: 'out of range' };
  }
  // Grid distance from the active attacker to its target ({cells, feet}), or null.
  function targetDistance() {
    const link = state.stage && state.stage.targetLink;
    if (!link) return null;
    const from = findToken(link.from), to = findToken(link.to);
    if (!from || !to) return null;
    return boardView.gridDistance({ x: from.x, y: from.y }, { x: to.x, y: to.y });
  }
  // Refresh targetLink.feet + overall range status (best across the attacker's
  // attacks) so the board arrow can label + tint. Called after target-set / a move.
  function computeTargetRange() {
    const link = state.stage && state.stage.targetLink;
    if (!link) return;
    const dist = targetDistance();
    if (!dist) { delete link.feet; delete link.status; return; }
    link.feet = dist.feet;
    const from = findToken(link.from);
    const cast = from && castEntry(from.castId, from.kind);
    const attacks = (cast && cast.stats && cast.stats.attacks) || [];
    let best = null;
    for (const atk of attacks) {
      const pr = parseAtkRange(atk.range); if (!pr) continue;
      const st = rangeVerdict(pr, dist.feet).status;
      if (st === 'in') { best = 'in'; break; }
      if (st === 'disadv' && best !== 'in') best = 'disadv';
      else if (st === 'out' && !best) best = 'out';
    }
    if (best) link.status = best; else delete link.status;
  }
  function armTargeting() { if (aoePlacing) { aoePlacing = null; if (state.stage) state.stage.aoeTemplate = null; renderBoardAoe(); } targeting = true; renderBoardTargeting(); renderStatSheet(); setStatus('Click the target token on the board', false); }
  // Range gate (defense in depth behind the disabled buttons): true when the current
  // target sits beyond this attack's parsed range at the measured grid distance.
  function atkOutOfRange(atk) {
    if (atk.heal && atk.target === 'self') return false;
    const d = targetDistance(); if (!d) return false;   // no grid/target -> no gating
    const pr = parseAtkRange(atk.range); if (!pr) return false;
    return rangeVerdict(pr, d.feet).status === 'out';
  }
  function setTarget(toInstId) {
    const from = state.stage && state.stage.activeTokenId;
    targeting = false; renderBoardTargeting();
    if (!from || from === toInstId) { renderStatSheet(); return; }   // no self-target
    ensureTokens();
    state.stage.targetLink = { from, to: toInstId };
    attackRoll = null;
    computeTargetRange();   // grid distance + range tint for the arrow
    commit();   // broadcasts the arrow + target glow, re-renders the card
  }
  function clearTarget() { if (state.stage) state.stage.targetLink = null; attackRoll = null; targeting = false; renderBoardTargeting(); commit(); }
  function clearAttackState() { attackRoll = null; targeting = false; aoePlacing = null; if (state.stage) { state.stage.targetLink = null; state.stage.aoeTemplate = null; } renderBoardTargeting(); renderBoardAoe(); }
  // ---- PR 6C.1: mirror a resolved card roll onto the Player TV when "Rolls on TV" is
  //      on, as a plain-language three-line pop-up: who did what ("Telstar used Thorn
  //      Whip Attack"), the dice math ("D20 (1) + 5 = 6 vs AC 11"), and the verdict
  //      ("MISS"). Rides state.stage.roomDice (the dice tray's channel); bump n so a
  //      repeat re-triggers it. Commits so the Player updates; no-op when off. ----
  function tvRoll(label, outcome, tone, opts) {
    if (!(state.stage && state.stage.rollsOnTv)) return;
    opts = opts || {};
    const n = ((state.stage.roomDice && state.stage.roomDice.n) || 0) + 1;
    state.stage.roomDice = { flat: opts.flat || [], total: opts.total || 0, notation: opts.notation || '', label: label || '', detail: opts.detail || '', outcome: outcome || '', tone: tone || '', n };
    commit();
  }
  const HIT_TONE = { crit: 'crit', hit: 'good', miss: 'bad' };
  const HIT_WORD = { crit: 'CRIT', hit: 'HIT', miss: 'MISS' };
  // Spell dice math out for the TV's middle line: faces in parens, then the modifier —
  // "D20 (17) + 5", "D6 (4, 2)", "D4 (3, 2, 4) + 3". Callers append "= total vs AC/DC".
  const rollFaces = (count, sides) => { const f = []; for (let k = 0; k < count; k++) f.push(Math.floor(Math.random() * sides) + 1); return f; };
  const diceMath = (sides, faces, mod) => 'D' + sides + ' (' + faces.join(', ') + ')' + (mod > 0 ? ' + ' + mod : mod < 0 ? ' − ' + Math.abs(mod) : '');
  function targetAc(target) { const tc = castEntry(target.castId, target.kind); return (tc && tc.stats && tc.stats.ac != null) ? +tc.stats.ac : null; }

  function rollHit(token, atk) {
    const target = currentTarget();
    if (!target) { armTargeting(); return; }   // enforce: target first
    if (atkOutOfRange(atk)) { setStatus(target.label + ' is out of range for ' + atk.name, false); return; }
    const mod = parseHitMod(atk.toHit);
    if (mod == null) { setStatus(atk.name + ' is a save (' + atk.toHit + '), not an attack roll', false); return; }
    if (token.manual) {   // PR 6C.1: the player rolled physically -> the GM types the total
      attackRoll = { instId: token.instId, kind: 'hit', name: atk.name, manualPending: 'hit', atk, targetLabel: target.label };
      renderStatSheet(); return;
    }
    const d = d20();
    const total = d + mod;
    const ac = targetAc(target);
    const outcome = d === 20 ? 'crit' : d === 1 ? 'miss' : (ac != null ? (total >= ac ? 'hit' : 'miss') : null);
    attackRoll = { instId: token.instId, kind: 'hit', name: atk.name, d, mod, total, ac, outcome, targetLabel: target.label };
    if (atk.sfxId) fireAttackSfx(atk.sfxId);
    renderStatSheet();
    if (outcome) tvRoll(token.label + ' used ' + atk.name + ' Attack', HIT_WORD[outcome], HIT_TONE[outcome],
      { detail: diceMath(20, [d], mod) + ' = ' + total + (ac != null ? ' vs AC ' + ac : '') });
  }
  // Manual attack: the GM types the finished total; the app only compares to AC. A Crit
  // checkbox flags a natural 20 (the raw die is hidden when only a total is entered).
  function applyManualHit(token, atk, total, crit) {
    const target = currentTarget(); if (!target) return;
    const ac = targetAc(target);
    const outcome = crit ? 'crit' : (ac != null ? (total >= ac ? 'hit' : 'miss') : null);
    attackRoll = { instId: token.instId, kind: 'hit', name: atk.name, manual: true, total, ac, outcome, targetLabel: target.label };
    if (atk.sfxId) fireAttackSfx(atk.sfxId);
    renderStatSheet();
    if (outcome) tvRoll(token.label + ' used ' + atk.name + ' Attack', HIT_WORD[outcome], HIT_TONE[outcome],
      { detail: total + (ac != null ? ' vs AC ' + ac : ' (entered)') });
  }
  function rollDmg(token, atk) {
    const target = currentTarget();
    if (!target) { armTargeting(); return; }
    if (atkOutOfRange(atk)) { setStatus(target.label + ' is out of range for ' + atk.name, false); return; }
    const p = parseDamage(atk.damage); if (!p) return;
    if (token.manual) { attackRoll = { instId: token.instId, kind: 'dmg', name: atk.name, manualPending: 'dmg', atk, dtype: p.type, targetLabel: target.label }; renderStatSheet(); return; }
    // Magic Missile & friends: multi.darts rolls the die that many times (was a
    // single-die under-roll before). One die otherwise. Faces are kept individually
    // so the TV can spell the math out ("D4 (3, 2, 4) + 3").
    const darts = (atk.multi && atk.multi.darts > 1) ? atk.multi.darts : 1;
    const faces = rollFaces(darts * p.count, p.sides);
    const mod = darts * p.mod;
    const total = Math.max(0, faces.reduce((a, b) => a + b, 0) + mod);
    finishDmg(token, atk, target, total, (darts > 1 ? darts + '× ' : '') + p.count + 'd' + p.sides + (p.mod ? (p.mod > 0 ? '+' : '') + p.mod : ''), p.type, diceMath(p.sides, faces, mod));
  }
  function applyManualDmg(token, atk, total) {
    const target = currentTarget(); if (!target) return;
    const p = parseDamage(atk.damage);
    finishDmg(token, atk, target, Math.max(0, total), 'entered', p ? p.type : '', '');
  }
  function finishDmg(token, atk, target, total, notation, dtype, detail) {
    attackRoll = { instId: token.instId, kind: 'dmg', name: atk.name, total, notation, dtype, targetLabel: target.label };
    if (atk.sfxId) fireAttackSfx(atk.sfxId);
    tvRoll(token.label + ' hit ' + target.label, total + (dtype ? ' ' + dtype : '') + ' dmg', 'bad', { detail });
    applyHp(target.instId, -total);   // clamps + commits -> HP drop + hit flash + card re-render
  }
  // ---- PR 6C: saving throws. A save action (toHit like "DEX save 13") resolves in one
  //      click: auto-roll the target's d20 + its ability modifier vs the DC when the
  //      target has a stat block; a MANUAL target types the total; a statless target
  //      gets a ✓/✗. On a FAILED save apply full damage + any condition; on a SUCCESS,
  //      half damage (save.half) or none. ----
  function abilityMod(tok, ability) {
    if (!tok || !ability) return null;
    const c = castEntry(tok.castId, tok.kind);
    const ab = c && c.stats && c.stats.abilities;
    const v = ab ? ab[ability.toLowerCase()] : undefined;
    return (v == null || !isFinite(+v)) ? null : +v;
  }
  function applySaveOutcome(token, atk, target, outcome, roll) {
    const ps = parseSave(atk.toHit) || {};
    const p = parseDamage(atk.damage);   // null for a condition-only save (Entangle/Turn Undead)
    let dmg = 0;
    if (p) { const full = Math.max(0, rollN(p.count, p.sides) + p.mod); dmg = outcome === 'fail' ? full : ((atk.save && atk.save.half) ? Math.floor(full / 2) : 0); }
    const cond = (outcome === 'fail' && atk.condition) ? atk.condition : null;
    const hasDie = !!(roll && roll.d != null);   // auto roll shows the d20 breakdown; manual/✓✗ don't
    attackRoll = { instId: token.instId, kind: 'save', name: atk.name, outcome, ability: (roll && roll.ability) || ps.ability, dc: (roll && roll.dc) || ps.dc, d: hasDie ? roll.d : null, mod: hasDie ? roll.mod : null, total: roll ? roll.total : null, manual: !hasDie, dmg, dtype: p ? p.type : '', condition: cond, targetLabel: target.label };
    if (atk.sfxId) fireAttackSfx(atk.sfxId);
    const dmgTxt = dmg > 0 ? ' · ' + dmg + (p && p.type ? ' ' + p.type : '') + ' dmg' : '';
    const dc = (roll && roll.dc) || ps.dc;
    const saveDetail = hasDie ? diceMath(20, [roll.d], roll.mod) + ' = ' + roll.total + (dc ? ' vs DC ' + dc : '')
      : (roll && roll.total != null) ? roll.total + (dc ? ' vs DC ' + dc : '')
      : ((ps.ability || '') + ' save' + (dc ? ' vs DC ' + dc : '')).trim();
    tvRoll(target.label + ' saves vs ' + atk.name, (outcome === 'fail' ? 'FAILED' : 'SAVED') + dmgTxt + (cond ? ' · ' + cond : ''), outcome === 'save' ? 'good' : 'bad', { detail: saveDetail });
    if (cond) addCondition(target.instId, cond);   // commits + re-renders
    if (dmg > 0) applyHp(target.instId, -dmg);      // commits + re-renders
    if (!cond && dmg === 0) renderStatSheet();       // a clean save with no damage: just show the verdict
  }
  function rollSave(token, atk) {
    const target = currentTarget();
    if (!target) { armTargeting(); return; }   // enforce: target first
    if (atkOutOfRange(atk)) { setStatus(target.label + ' is out of range for ' + atk.name, false); return; }
    const ps = parseSave(atk.toHit);
    if (!ps) { setStatus(atk.name + ' has no save to roll', false); return; }
    const mod = abilityMod(target, ps.ability);
    if (target.manual || mod == null) {   // GM records the roll: a typed total (manual) or ✓/✗ (statless)
      attackRoll = { instId: token.instId, kind: 'save', name: atk.name, pending: target.manual ? 'total' : 'verdict', atk, target: target.instId, ability: ps.ability, dc: ps.dc, targetLabel: target.label };
      renderStatSheet();
      return;
    }
    const d = d20(); const total = d + mod;
    applySaveOutcome(token, atk, target, total >= ps.dc ? 'save' : 'fail', { ability: ps.ability, dc: ps.dc, d, mod, total });
  }
  function resolveSaveManual(token, atk, outcome) {   // statless ✓/✗
    const target = currentTarget(); if (!target) return;
    applySaveOutcome(token, atk, target, outcome, null);
  }
  function applyManualSave(token, atk, total) {   // manual target typed the save total
    const target = currentTarget(); if (!target) return;
    const ps = parseSave(atk.toHit) || {};
    applySaveOutcome(token, atk, target, total >= ps.dc ? 'save' : 'fail', { ability: ps.ability, dc: ps.dc, total });
  }
  // ---- PR 6C: healing. Roll the "heal NdM+K" and add it back (clamped to max). A
  //      self-heal (Second Wind) applies to the caster with no target; an ally heal
  //      (Cure Wounds / Healing Word) uses the normal arm→click target. A MANUAL caster
  //      types the heal total. ----
  function rollHeal(token, atk) {
    const target = atk.target === 'self' ? token : currentTarget();
    if (!target) { armTargeting(); return; }
    if (atkOutOfRange(atk)) { setStatus(target.label + ' is out of range for ' + atk.name, false); return; }
    const p = parseDamage(String(atk.damage).replace(/^\s*heal\s+/i, '')); if (!p) return;
    if (token.manual) { attackRoll = { instId: token.instId, kind: 'heal', name: atk.name, manualPending: 'heal', atk, targetLabel: target.label }; renderStatSheet(); return; }
    const faces = rollFaces(p.count, p.sides);
    finishHeal(token, atk, target, Math.max(0, faces.reduce((a, b) => a + b, 0) + p.mod), p.count + 'd' + p.sides + (p.mod ? (p.mod > 0 ? '+' : '') + p.mod : ''), diceMath(p.sides, faces, p.mod));
  }
  function applyManualHeal(token, atk, total) {
    const target = atk.target === 'self' ? token : currentTarget(); if (!target) return;
    finishHeal(token, atk, target, Math.max(0, total), 'entered', '');
  }
  function finishHeal(token, atk, target, total, notation, detail) {
    attackRoll = { instId: token.instId, kind: 'heal', name: atk.name, total, notation, targetLabel: target.label };
    if (atk.sfxId) fireAttackSfx(atk.sfxId);
    tvRoll(target.instId === token.instId ? token.label + ' used ' + atk.name : token.label + ' healed ' + target.label, '+' + total + ' HP', 'heal', { detail });
    applyHp(target.instId, +total);
  }
  // ---- PR 6D: instant AoE templates (Breath Weapon cone, Turn Undead radius). [Area] enters
  //      placement: the template follows the pointer on the board (a cone aims from the caster's
  //      cell; a circle centres on the cursor, grid-snapped), a click LOCKS it, then Resolve runs
  //      the 6C save engine over everyone caught inside. All geometry + hit-testing lives in
  //      stageView (shared by both screens); gm.js just drives placement + resolution. ----
  let aoeRAF = 0, aoePending = false;
  function flushAoeBroadcast() { aoePending = false; aoeRAF = 0; broadcast(); }
  function scheduleAoeBroadcast() { if (aoePending) return; aoePending = true; aoeRAF = requestAnimationFrame(flushAoeBroadcast); }
  function renderBoardAoe() { if (boardView && boardView.el) boardView.el.classList.toggle('is-placing-aoe', !!(aoePlacing && !aoePlacing.committed)); }
  // Template tint: a heal is green, a control-only save (Turn Undead) violet, damage red.
  function aoeColorFor(atk) { return atk.heal ? '#4c9f70' : (atk.condition && !parseDamage(atk.damage) ? '#7d5bd0' : '#e5533a'); }
  function beginAoe(token, atk) {
    const spec = atk.aoe || atk.zone;                    // a zone (PR 6E) places through the same flow
    if (!spec) return;
    clearAttackState();                                  // drop any in-progress target / roll / area
    ensureTokens();
    const shape = spec.shape === 'cone' ? 'cone' : (spec.shape === 'square' || spec.shape === 'cube') ? 'square' : 'circle';
    aoePlacing = { token, atk, shape, zone: !!atk.zone, committed: false, hits: [], results: null };
    lastAtkName = atk.name;   // the >4-attack picker keeps THIS attack's row (the panel lives in it) on screen
    state.stage.aoeTemplate = { shape, originX: token.x, originY: token.y, angleDeg: 0, sizeFeet: spec.sizeFeet, color: aoeColorFor(atk), committed: false, casterId: token.instId };
    renderBoardAoe();
    setStatus(shape === 'cone' ? 'Aim the cone from ' + token.label + ' — move over the board, click to place' : 'Move the ' + spec.sizeFeet + '-ft area — click the board to place', false);
    commit();
  }
  function updateAoeFromPointer(e) {
    const t = state.stage && state.stage.aoeTemplate;
    if (!aoePlacing || aoePlacing.committed || !t) return;
    if (t.shape === 'cone') {
      t.angleDeg = boardView.aoePointerAngle({ x: t.originX, y: t.originY }, e.clientX, e.clientY);
    } else {
      let frac = boardView.pointToFraction(e.clientX, e.clientY); if (!frac) return;
      if (!e.altKey) frac = boardView.snapFractionToCell(frac);   // centre on a cell; hold Alt = free
      t.originX = frac.x; t.originY = frac.y;
    }
    boardView.layoutTokens();          // live local redraw (smooth on the GM board)
    scheduleAoeBroadcast();            // throttled mirror to the Player TV
  }
  function commitAoePlacement() {
    if (!aoePlacing || aoePlacing.committed) return;
    aoePlacing.committed = true;
    if (aoeRAF) { cancelAnimationFrame(aoeRAF); aoeRAF = 0; aoePending = false; }
    if (aoePlacing.zone) { commitZonePlacement(); return; }
    if (state.stage.aoeTemplate) state.stage.aoeTemplate.committed = true;
    aoePlacing.hits = (boardView.aoeHits() || []).filter((id) => id !== aoePlacing.token.instId);   // the caster isn't in its own blast
    renderBoardAoe();
    setStatus(aoePlacing.hits.length + ' caught in the area — Resolve to roll their saves', false);
    commit();
  }
  // A zone attack's click-to-place: the transient template becomes a PERSISTENT zone
  // (state.stage.zones, drawn + chipped on both screens), then the entry save resolves
  // immediately (Entangle STR / Web DEX -> restrained on a fail). Spike Growth has no
  // entry save -- its onMove damage is prompted when a token is dragged through it.
  function commitZonePlacement() {
    const pl = aoePlacing, t = state.stage.aoeTemplate;
    if (!pl || !t) return;
    const z = pl.atk.zone || {};
    const zone = {
      id: 'z' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
      name: pl.atk.name, shape: t.shape === 'square' ? 'square' : 'circle',
      originX: t.originX, originY: t.originY, sizeFeet: t.sizeFeet, color: t.color,
      casterId: pl.token.instId, condition: pl.atk.condition || null,
      concentration: !!z.concentration, rounds: 10,
      onMove: z.onMove && z.onMove.dice ? { dice: z.onMove.dice, per: z.onMove.per || 5 } : null
    };
    if (!Array.isArray(state.stage.zones)) state.stage.zones = [];
    state.stage.zones.push(zone);
    state.stage.aoeTemplate = null;                      // the zone drawing takes over from the preview
    pl.zoneId = zone.id;
    renderBoardAoe();
    commit();                                            // broadcast the zone so hit-testing sees it
    pl.hits = boardView.zoneHits(zone.id) || [];
    if (pl.atk.save) {
      resolveAoe();                                      // entry saves resolve right away (condition-only)
      setStatus(pl.atk.name + ' placed — ' + pl.hits.length + ' inside rolled their entry save', false);
    } else {
      pl.results = [];                                   // Spike Growth: no entry save; damage rides movement
      setStatus(pl.atk.name + ' placed — it damages creatures that MOVE through it (drag prompts the roll)', false);
      renderStatSheet();
    }
  }
  // Dismiss the zone panel WITHOUT touching the placed zone (its chip manages its life).
  function dismissAoePanel() { aoePlacing = null; renderBoardAoe(); renderStatSheet(); }
  // Apply one creature's save outcome: 5e rolls the area's damage ONCE (fullDmg) and each
  // creature takes full on a fail, half on a save (save.half), or none; a failed save also
  // takes the condition (Turn Undead -> frightened). Reuses applyHp / addCondition.
  function applyAoeOutcome(atk, target, outcome, fullDmg) {
    let dmg = 0;
    if (fullDmg != null) dmg = outcome === 'fail' ? fullDmg : ((atk.save && atk.save.half) ? Math.floor(fullDmg / 2) : 0);
    const cond = (outcome === 'fail' && atk.condition) ? atk.condition : null;
    if (cond) addCondition(target.instId, cond);
    if (dmg > 0) applyHp(target.instId, -dmg);
    return { dmg, cond };
  }
  function resolveAoe() {
    const pl = aoePlacing; if (!pl || !pl.committed) return;
    const { token, atk } = pl;
    const ps = parseSave(atk.toHit);
    const p = parseDamage(atk.damage);
    const fullDmg = p ? Math.max(0, rollN(p.count, p.sides) + p.mod) : null;   // one damage roll for the whole area
    pl.dtype = p ? p.type : ''; pl.fullDmg = fullDmg; pl.ps = ps; pl.results = [];
    for (const id of pl.hits) {
      const target = findToken(id); if (!target) continue;
      const mod = ps ? abilityMod(target, ps.ability) : null;
      if (ps && mod != null && !target.manual) {          // auto-roll a known-stats creature
        const d = d20(), total = d + mod, outcome = total >= ps.dc ? 'save' : 'fail';
        pl.results.push(Object.assign({ instId: id, label: target.label, outcome, roll: total, mode: 'auto' }, applyAoeOutcome(atk, target, outcome, fullDmg)));
      } else if (!ps) {                                    // no save (defensive) -> just apply
        pl.results.push(Object.assign({ instId: id, label: target.label, outcome: 'fail', mode: 'auto' }, applyAoeOutcome(atk, target, 'fail', fullDmg)));
      } else {                                             // statless / manual -> per-creature ✓/✗
        pl.results.push({ instId: id, label: target.label, mode: 'pending' });
      }
    }
    const nFail = pl.results.filter((r) => r.outcome === 'fail').length;
    const nSave = pl.results.filter((r) => r.outcome === 'save').length;
    tvRoll(token.label + ' used ' + atk.name, pl.hits.length + ' caught · ' + nFail + ' failed / ' + nSave + ' saved', 'bad',
      { detail: ps ? ps.ability + ' save vs DC ' + ps.dc + (fullDmg ? ' · ' + fullDmg + (p.type ? ' ' + p.type : '') + ' dmg on a fail' : '') : '' });
    renderStatSheet();
    commit();
  }
  function resolveAoeCreature(instId, outcome) {   // the ✓/✗ for a statless creature in the blast
    const pl = aoePlacing; if (!pl || !pl.results) return;
    const target = findToken(instId); if (!target) return;
    const applied = applyAoeOutcome(pl.atk, target, outcome, pl.fullDmg);
    const row = pl.results.find((r) => r.instId === instId);
    if (row) { row.mode = 'auto'; row.outcome = outcome; Object.assign(row, applied); }
    renderStatSheet();
  }
  function clearAoe() {
    aoePlacing = null;
    if (aoeRAF) { cancelAnimationFrame(aoeRAF); aoeRAF = 0; aoePending = false; }
    if (state.stage) state.stage.aoeTemplate = null;
    renderBoardAoe();
    commit();
  }
  // The AoE/zone placement + resolve panel, rendered INSIDE the owning attack's row so
  // (e.g.) Breath Weapon's controls live in Breath Weapon's section of the card.
  function aoePanel(pl) {
    const box = document.createElement('div'); box.className = 'stat-aoe';
    const hint = (txt) => { const h = document.createElement('div'); h.className = 'stat-aoe-hint'; h.textContent = txt; return h; };
    const clearBtn = (label) => { const c = document.createElement('button'); c.type = 'button'; c.className = 'gm-button btn--quiet stat-aoe-cancel'; c.textContent = label; c.addEventListener('click', clearAoe); return c; };
    if (!pl.committed) {
      box.append(hint('◎ ' + (pl.shape === 'cone' ? 'aim the cone, then click the board to place' : 'position the area, then click to place')), clearBtn('Cancel'));
    } else if (!pl.results) {
      const names = pl.hits.map((id) => (findToken(id) || {}).label).filter(Boolean);
      box.append(hint('◎ ' + pl.hits.length + ' in the area' + (names.length ? ': ' + names.join(', ') : '')));
      const row = document.createElement('div'); row.className = 'stat-aoe-btns';
      if (pl.hits.length) { const rb = document.createElement('button'); rb.type = 'button'; rb.className = 'gm-button atk-save'; rb.textContent = 'Resolve'; rb.title = 'Roll each caught creature’s save and apply it'; rb.addEventListener('click', resolveAoe); row.append(rb); }
      row.append(clearBtn('Clear')); box.append(row);
    } else {
      const spike = pl.zone && !pl.atk.save;
      box.append(hint('◎ ' + (pl.ps ? pl.ps.ability + ' save vs ' + pl.ps.dc : spike ? 'damages creatures that move through it' : pl.atk.name) + (pl.fullDmg ? ' · ' + pl.fullDmg + (pl.dtype ? ' ' + pl.dtype : '') + ' on a fail' : '')));
      for (const res of pl.results) {
        const lineEl = document.createElement('div'); lineEl.className = 'stat-aoe-res';
        if (res.mode === 'pending') {
          const q = document.createElement('span'); q.className = 'stat-aoe-name'; q.textContent = res.label + ' — save?';
          const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'gm-button btn--quiet atk-save-yes'; yes.textContent = '✓'; yes.title = 'Saved'; yes.addEventListener('click', () => resolveAoeCreature(res.instId, 'save'));
          const no = document.createElement('button'); no.type = 'button'; no.className = 'gm-button atk-save-no'; no.textContent = '✗'; no.title = 'Failed'; no.addEventListener('click', () => resolveAoeCreature(res.instId, 'fail'));
          lineEl.append(q, yes, no);
        } else {
          const failed = res.outcome === 'fail';
          lineEl.classList.add(failed ? 'is-fail' : 'is-save');
          const bits = [res.label, (failed ? 'FAILED' : 'SAVED') + (res.roll != null ? ' (' + res.roll + ')' : '')];
          if (res.dmg > 0) bits.push('−' + res.dmg + (pl.dtype ? ' ' + pl.dtype : ''));
          if (res.cond) bits.push(res.cond);
          lineEl.textContent = bits.join(' · ');
        }
        box.append(lineEl);
      }
      if (pl.zone) {
        // The zone lives on -- its board chip carries the round counter + Clear. Done
        // just dismisses this panel.
        const done = document.createElement('button'); done.type = 'button'; done.className = 'gm-button btn--quiet stat-aoe-cancel'; done.textContent = 'Done'; done.addEventListener('click', dismissAoePanel);
        box.append(done);
      } else {
        box.append(clearBtn('Clear area'));
      }
    }
    return box;
  }
  // One attack line + its roll buttons (+ ▶ if it carries SFX). Targeting is SHARED —
  // the single Target button lives in the stat-target strip above; when the picked
  // target is out of THIS attack's range, its roll buttons disable (range gating).
  function attackRow(token, atk, compact, dist) {
    const a = document.createElement('div'); a.className = 'stat-attack';
    // Range verdict for this attack at the current target's distance — an inline badge
    // on the name line (no extra rows), and the gate for the buttons below.
    const pr = dist ? parseAtkRange(atk.range) : null;
    const v = pr ? rangeVerdict(pr, dist.feet) : null;
    const badge = v ? (() => { const rb = document.createElement('span'); rb.className = 'atk-range atk-range-' + v.status; rb.textContent = dist.feet + ' ft · ' + v.label; return rb; })() : null;
    if (!compact) {
      const nm = document.createElement('div'); nm.className = 'stat-attack-name';
      const nt = document.createElement('span'); nt.textContent = atk.name; nm.append(nt);
      if (badge) nm.append(badge);
      a.append(nm);
    }
    const line = document.createElement('div'); line.className = 'stat-attack-line';
    const hit = atk.toHit ? (/^[+-]?\d/.test(String(atk.toHit)) ? atk.toHit + ' to hit' : atk.toHit) : '';
    const dmgText = (atk.multi && atk.multi.darts > 1) ? atk.multi.darts + '× ' + atk.damage : atk.damage;
    const lt = document.createElement('span'); lt.textContent = [hit, atk.range, dmgText].filter(Boolean).join(' · ');
    line.append(lt);
    if (compact && badge) line.append(badge);   // the picker's detail row has no name line
    a.append(line);
    const outOfRange = !!(v && v.status === 'out');
    const gate = (b, blocked, why) => { if (blocked) { b.disabled = true; b.classList.add('is-blocked'); b.title = why; } return b; };
    const btns = document.createElement('div'); btns.className = 'stat-atk-btns';
    // Buttons depend on the action's shape: an AoE/zone provides its OWN targeting via
    // [Area]; a heal gets Heal; a save gets Save; else the attack-roll Hit + Dmg.
    if (atk.aoe || atk.zone) {
      const spec = atk.aoe || atk.zone;
      const ab = document.createElement('button'); ab.type = 'button'; ab.className = 'gm-button atk-area' + (aoePlacing && aoePlacing.atk === atk ? ' is-armed' : '');
      ab.textContent = 'Area';
      ab.title = atk.zone ? 'Place the persistent ' + spec.sizeFeet + '-ft ' + spec.shape + ' zone on the board (entry saves resolve on placement)'
                          : 'Place the ' + spec.sizeFeet + '-ft ' + spec.shape + ' on the board, then resolve saves for everyone inside';
      ab.addEventListener('click', () => beginAoe(token, atk)); btns.append(ab);
    } else if (atk.heal) {
      const hb = document.createElement('button'); hb.type = 'button'; hb.className = 'gm-button atk-heal'; hb.textContent = 'Heal';
      hb.title = atk.target === 'self' ? 'Heal the caster (' + String(atk.damage).replace(/^\s*heal\s+/i, '') + ')' : 'Heal the targeted ally';
      hb.addEventListener('click', () => rollHeal(token, atk));
      btns.append(gate(hb, outOfRange && atk.target !== 'self', 'Target is out of range'));
    } else if (atk.save) {
      const ps = parseSave(atk.toHit); const sv = document.createElement('button'); sv.type = 'button'; sv.className = 'gm-button atk-save'; sv.textContent = 'Save';
      sv.title = 'Resolve the ' + (ps ? ps.ability + ' save vs ' + ps.dc : 'saving throw') + ' on the target';
      sv.addEventListener('click', () => rollSave(token, atk));
      btns.append(gate(sv, outOfRange, 'Target is out of range'));
    } else {
      if (parseHitMod(atk.toHit) != null) { const hb = document.createElement('button'); hb.type = 'button'; hb.className = 'gm-button btn--quiet atk-hit'; hb.textContent = 'Hit'; hb.title = 'Roll d20 ' + atk.toHit + ' vs the target’s AC'; hb.addEventListener('click', () => rollHit(token, atk)); btns.append(gate(hb, outOfRange, 'Target is out of range')); }
      if (parseDamage(atk.damage)) { const db = document.createElement('button'); db.type = 'button'; db.className = 'gm-button atk-dmg'; db.textContent = 'Dmg'; db.title = 'Roll ' + atk.damage + ' and apply it to the target'; db.addEventListener('click', () => rollDmg(token, atk)); btns.append(gate(db, outOfRange, 'Target is out of range')); }
    }
    if (atk.sfxId && sceneHasSfx(atk.sfxId)) { const sb = document.createElement('button'); sb.type = 'button'; sb.className = 'gm-button btn--quiet atk-sfx'; sb.textContent = '▶'; sb.title = 'Play attack SFX'; sb.addEventListener('click', () => fireAttackSfx(atk.sfxId)); btns.append(sb); }
    a.append(btns);
    // This attack's own placement/resolve panel stays inside ITS row (capped height in CSS).
    if (aoePlacing && aoePlacing.token.instId === token.instId && aoePlacing.atk === atk) a.append(aoePanel(aoePlacing));
    return a;
  }
  // ---- Interactive notices (bottom-right stack): combat prompts that carry BUTTONS —
  //      the Spike-Growth movement damage and the concentration reminder — live here,
  //      OUTSIDE the stat card, so the card never changes shape under the GM's cursor.
  //      (Plain text tips ride setStatus, the bottom-center toast.) ----
  function renderNotices() {
    if (!els.notices) return;
    const host = els.notices; host.innerHTML = '';
    if (spikePrompt) {
      const sp = spikePrompt;
      const box = document.createElement('div'); box.className = 'gm-notice stat-spike';
      const q = document.createElement('span'); q.className = 'gm-notice-txt';
      q.textContent = '⚠ ' + sp.label + ' moved ' + sp.feet + ' ft through ' + sp.zone + ' — ' + sp.dice + ' × ' + sp.times + '?';
      const roll = document.createElement('button'); roll.type = 'button'; roll.className = 'gm-button atk-dmg'; roll.textContent = 'Roll'; roll.title = 'Roll the movement damage and apply it';
      roll.addEventListener('click', applySpikeDamage);
      const skip = document.createElement('button'); skip.type = 'button'; skip.className = 'gm-button btn--quiet'; skip.textContent = 'Skip';
      skip.addEventListener('click', () => { spikePrompt = null; renderNotices(); });
      box.append(q, roll, skip); host.append(box);
    }
    if (concWarn) {
      const ct = findToken(concWarn.instId);
      const zs = (state.stage && state.stage.zones) || [];
      if (!ct || !zs.some((z) => z.concentration && z.casterId === ct.instId)) { concWarn = null; }
      else {
        const dc = Math.max(10, Math.ceil(concWarn.dmg / 2));
        const box = document.createElement('div'); box.className = 'gm-notice stat-conc';
        const q = document.createElement('span'); q.className = 'gm-notice-txt';
        q.textContent = '⚠ ' + ct.label + ' took ' + concWarn.dmg + ' damage while concentrating — CON save DC ' + dc + ' or the spell drops';
        const drop = document.createElement('button'); drop.type = 'button'; drop.className = 'gm-button atk-save-no'; drop.textContent = 'Drop it';
        drop.addEventListener('click', () => { state.stage.zones = zs.filter((z) => !(z.concentration && z.casterId === ct.instId)); concWarn = null; commit(); });
        const keep = document.createElement('button'); keep.type = 'button'; keep.className = 'gm-button btn--quiet atk-save-yes'; keep.textContent = 'Kept it';
        keep.addEventListener('click', () => { concWarn = null; renderNotices(); });
        box.append(q, drop, keep); host.append(box);
      }
    }
    host.hidden = !host.children.length;
  }
  function renderStatSheet() {
    if (!els.statsheet) return;
    const host = els.statsheet; host.innerHTML = '';
    const ctx = activeStatContext();
    host.classList.toggle('is-hero', !!ctx && ctx.token.kind === 'hero');
    host.classList.toggle('is-npc', !!ctx && ctx.token.kind === 'npc');
    if (!ctx) {
      const p = document.createElement('p'); p.className = 'stat-empty';
      p.textContent = 'Place a combatant and apply initiative to see its card.';
      host.append(p); return;
    }
    const { token, cast, stats } = ctx;

    // ---- Head: face-centered profile picture + name / subtitle / active tag ----
    const head = document.createElement('div'); head.className = 'stat-head';
    if (cast && cast.tokenImage) {
      const pic = document.createElement('img'); pic.className = 'stat-pic'; pic.src = cast.tokenImage; pic.alt = '';
      if (cast.face) pic.style.objectPosition = cast.face;
      head.append(pic);
    }
    const idBox = document.createElement('div'); idBox.className = 'stat-id';
    const nameRow = document.createElement('div'); nameRow.className = 'stat-name-row';
    // Heading is the token's own label so the numbered iteration shows ("Pale Husk 3").
    const nm = document.createElement('h3'); nm.className = 'stat-name'; nm.textContent = token.label;
    const kindTag = token.kind === 'hero' ? 'is-hero' : token.kind === 'npc' ? 'is-npc' : 'is-enemy';
    const kindLabel = token.kind === 'hero' ? 'Hero' : token.kind === 'npc' ? 'NPC' : 'Enemy';
    const tag = document.createElement('span'); tag.className = 'stat-tag ' + kindTag;
    tag.textContent = 'Active · ' + kindLabel;
    // The Active tag and the (icon-only) Auto/Manual toggle right-align on the name line,
    // so the head stays a single tidy row.
    nameRow.append(nm, tag, manualToggleBtn(token, false)); idBox.append(nameRow);
    // Subtitle: the class line if present, else the stat block's flavour name when the
    // label doesn't already carry it (so "Brigand 1" shows "Roadside Raider", but
    // "Pale Husk 1" doesn't repeat "Pale Husk").
    const subText = (stats && stats.subtitle) || (stats && stats.name && !token.label.includes(stats.name) ? stats.name : '');
    if (subText) { const sub = document.createElement('div'); sub.className = 'stat-sub'; sub.textContent = subText; idBox.append(sub); }
    head.append(idBox); host.append(head);

    // ---- Conditions on the active combatant (read-only here; edited in the roster) ----
    const conds = Array.isArray(token.conditions) ? token.conditions : [];
    if (conds.length) {
      const cw = document.createElement('div'); cw.className = 'stat-conditions';
      const cl = document.createElement('span'); cl.className = 'stat-cond-label'; cl.textContent = 'Conditions'; cw.append(cl);
      for (const cn of conds) { const chip = document.createElement('span'); chip.className = 'cond-chip'; chip.textContent = cn; cw.append(chip); }
      host.append(cw);
    }

    // ---- HP first (live, from the token), then AC + Speed ----
    const line = (k, v) => { const r = document.createElement('div'); r.className = 'stat-line';
      const a = document.createElement('span'); a.className = 'stat-k'; a.textContent = k;
      const b = document.createElement('span'); b.className = 'stat-v'; b.textContent = v; r.append(a, b); return r; };
    const lines = document.createElement('div'); lines.className = 'stat-lines';
    const hp = token.hp || {};
    const max = hp.max != null ? hp.max : (stats && stats.hp != null ? stats.hp : null);
    const cur = hp.current != null ? hp.current : max;
    if (max != null) {
      lines.append(line('Hit Points', (cur != null ? cur : '?') + ' / ' + max));
      const bar = document.createElement('div'); bar.className = 'stat-hpbar';
      const fill = document.createElement('i');
      fill.style.width = Math.max(0, Math.min(100, max ? Math.round(((cur != null ? cur : max) / max) * 100) : 0)) + '%';
      if (cur != null && max && cur / max <= 0.34) fill.classList.add('is-low');
      bar.append(fill); lines.append(bar);
    }
    if (stats && stats.ac != null) lines.append(line('Armor Class', stats.ac));
    if (stats && stats.speed) {
      // Two-column speed row: the stat on the left, the per-turn movement controls
      // (Move toggle · feet-left numerator · Apply — PR "turn engine") on the right.
      const sp = line('Speed', stats.speed); sp.classList.add('stat-speed');
      const tc = document.createElement('div'); tc.className = 'turn-move';
      sp.append(tc); lines.append(sp);
    }
    if (lines.children.length) host.append(lines);

    // A stat block present -> full card (abilities + attacks). Absent (a hero before
    // their sheet, an NPC, a plain enemy) -> compact card; name + HP + conditions.
    if (stats) {
      // ---- Abilities ----
      if (stats.abilities) {
        const ab = document.createElement('div'); ab.className = 'stat-abils';
        for (const [k, lab] of [['str', 'STR'], ['dex', 'DEX'], ['con', 'CON'], ['int', 'INT'], ['wis', 'WIS'], ['cha', 'CHA']]) {
          const v = stats.abilities[k] == null ? 0 : stats.abilities[k];
          const tile = document.createElement('div'); tile.className = 'stat-abil';
          const t = document.createElement('span'); t.className = 'stat-abil-k'; t.textContent = lab;
          const n = document.createElement('span'); n.className = 'stat-abil-v'; n.textContent = (v >= 0 ? '+' : '') + v;
          tile.append(t, n); ab.append(tile);
        }
        host.append(ab);
      }
      // ---- Target strip: ONE shared Target button for every attack (they all aimed the
      //      same way anyway), always rendered so the card never changes shape. Shows the
      //      current target + grid distance, the arming hint, or "No target". ----
      const tgt = currentTarget();
      const dist = tgt ? targetDistance() : null;   // grid distance to the target (PR 6B), or null
      const tl = document.createElement('div'); tl.className = 'stat-target' + (targeting ? ' is-arming' : tgt ? '' : ' is-idle');
      const txt = document.createElement('span'); txt.className = 'stat-target-txt';
      txt.textContent = targeting ? '⌖ Click the target token on the board…'
        : tgt ? '⌖ Targeting ' + tgt.label + (dist ? ' · ' + dist.feet + ' ft' : '')
        : 'No target';
      tl.append(txt);
      if (tgt && !targeting) {
        const clr = document.createElement('button'); clr.type = 'button'; clr.className = 'gm-button btn--quiet stat-target-cancel'; clr.textContent = 'Clear'; clr.addEventListener('click', clearTarget);
        tl.append(clr);
      }
      const arm = document.createElement('button'); arm.type = 'button';
      arm.className = 'gm-button btn--quiet target-arm' + (targeting ? ' is-armed' : '');
      arm.textContent = tgt ? 'Retarget' : 'Target';
      arm.title = 'Pick the target on the board — shared by every attack below';
      arm.addEventListener('click', armTargeting);
      tl.append(arm);
      host.append(tl);
      // ---- Attacks with Target / Hit / Dmg: inline for short lists, a picker
      //      dropdown for long ones (spellcasters), so the card stays capped. ----
      const attacks = stats.attacks || [];
      if (attacks.length) {
        const wrap = document.createElement('div'); wrap.className = 'stat-attacks';
        if (attacks.length <= 4) {
          for (const atk of attacks) wrap.append(attackRow(token, atk, false, dist));
        } else {
          const sel = document.createElement('select'); sel.className = 'stat-atk-select';
          attacks.forEach((atk, i) => { const o = document.createElement('option'); o.value = i; o.textContent = atk.name; sel.append(o); });
          // Keep the GM's chosen attack selected across the many re-renders combat triggers
          // (arm target, pick target, roll) instead of snapping back to the first one.
          const keepIdx = lastAtkName ? attacks.findIndex((a) => a.name === lastAtkName) : -1;
          if (keepIdx >= 0) sel.value = String(keepIdx);
          const detail = document.createElement('div'); detail.className = 'stat-atk-detail';
          const draw = () => { detail.innerHTML = ''; detail.append(attackRow(token, attacks[+sel.value] || attacks[0], true, dist)); };
          sel.addEventListener('change', () => { lastAtkName = (attacks[+sel.value] || {}).name || null; draw(); });
          wrap.append(sel, detail); draw();
        }
        host.append(wrap);
      }
      // (The AoE placement/resolve panel renders INSIDE its owning attack row — attackRow
      //  appends aoePanel() — so Breath Weapon's controls stay in Breath Weapon's section.)
      // ---- Roll result: Hit auto-checks vs AC; Dmg names the target; Save shows the
      //      d20 vs DC (or a manual ✓/✗ for statless targets) and what it applied; Heal
      //      names the mended target. ----
      if (attackRoll && attackRoll.instId === token.instId) {
        const ar = attackRoll;
        // PR 6C.1: a manual roll (this combatant's dice are entered by the GM) shows a
        // number box + Apply; an attack adds an optional Crit tick (the raw die is hidden
        // once only a total is entered).
        const manualEntry = (labelText, apply, withCrit) => {
          const r = document.createElement('div'); r.className = 'stat-roll is-pending';
          const q = document.createElement('span'); q.className = 'stat-roll-q'; q.textContent = labelText;
          const inp = document.createElement('input'); inp.type = 'number'; inp.className = 'stat-roll-input'; inp.min = '0'; inp.placeholder = '#';
          r.append(q, inp);
          let critBox = null;
          if (withCrit) { const lb = document.createElement('label'); lb.className = 'stat-roll-crit'; critBox = document.createElement('input'); critBox.type = 'checkbox'; lb.append(critBox, document.createTextNode(' crit')); r.append(lb); }
          const go = () => { const v = parseInt(inp.value, 10); if (isFinite(v)) apply(v, critBox && critBox.checked); };
          const b = document.createElement('button'); b.type = 'button'; b.className = 'gm-button atk-apply'; b.textContent = 'Apply'; b.addEventListener('click', go);
          inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
          r.append(b); host.append(r); setTimeout(() => inp.focus(), 0);
        };
        if (ar.manualPending === 'hit') {
          manualEntry('Enter ' + ar.name + ' attack total vs ' + ar.targetLabel + ': ', (v, crit) => applyManualHit(token, ar.atk, v, crit), true);
        } else if (ar.manualPending === 'dmg') {
          manualEntry('Enter ' + ar.name + ' damage total → ' + ar.targetLabel + ': ', (v) => applyManualDmg(token, ar.atk, v), false);
        } else if (ar.manualPending === 'heal') {
          manualEntry('Enter ' + ar.name + ' heal total → ' + ar.targetLabel + ': ', (v) => applyManualHeal(token, ar.atk, v), false);
        } else if (ar.kind === 'save' && ar.pending === 'total') {
          manualEntry(ar.targetLabel + ' ' + ar.ability + ' save total vs ' + ar.dc + ': ', (v) => applyManualSave(token, ar.atk, v), false);
        } else if (ar.kind === 'save' && ar.pending) {
          // Statless target: the GM records the player's own save roll with a ✓/✗.
          const r = document.createElement('div'); r.className = 'stat-roll is-pending';
          const q = document.createElement('span'); q.className = 'stat-roll-q'; q.textContent = ar.name + ' — ' + ar.ability + ' save vs ' + ar.dc + ' · did ' + ar.targetLabel + ' save? ';
          const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'gm-button btn--quiet atk-save-yes'; yes.textContent = '✓ Saved'; yes.addEventListener('click', () => resolveSaveManual(token, ar.atk, 'save'));
          const no = document.createElement('button'); no.type = 'button'; no.className = 'gm-button atk-save-no'; no.textContent = '✗ Failed'; no.addEventListener('click', () => resolveSaveManual(token, ar.atk, 'fail'));
          r.append(q, yes, no); host.append(r);
        } else if (ar.kind === 'save') {
          const failed = ar.outcome === 'fail';
          const r = document.createElement('div'); r.className = 'stat-roll ' + (failed ? 'is-hit' : 'is-miss');
          const rollTxt = ar.d != null ? ' — d20 (' + ar.d + ') ' + (ar.mod >= 0 ? '+' : '') + ar.mod + ' = ' + ar.total : (ar.total != null ? ' — ' + ar.total + ' (entered)' : '');
          const dmgTxt = ar.dmg > 0 ? ' · ' + ar.dmg + (ar.dtype ? ' ' + ar.dtype : '') : (failed ? '' : ' · no damage');
          const condTxt = ar.condition ? ' · ' + ar.condition : '';
          r.textContent = ar.name + ' — ' + ar.ability + ' save vs ' + ar.dc + rollTxt + (failed ? ' → FAILED' : ' → SAVED') + dmgTxt + condTxt + ' → ' + ar.targetLabel;
          host.append(r);
        } else if (ar.kind === 'heal') {
          const r = document.createElement('div'); r.className = 'stat-roll is-heal';
          r.textContent = ar.name + ' — ' + (ar.notation === 'entered' ? ar.total + ' (entered)' : ar.notation + ' = +' + ar.total) + ' HP → ' + ar.targetLabel;
          host.append(r);
        } else if (ar.kind === 'hit') {
          const oc = ar.outcome;
          const r = document.createElement('div'); r.className = 'stat-roll' + (oc === 'crit' || oc === 'hit' ? ' is-hit' : oc === 'miss' ? ' is-miss' : '');
          const vs = ar.ac != null ? ' vs AC ' + ar.ac : '';
          const rollTxt = ar.d != null ? 'd20 (' + ar.d + ') ' + (ar.mod >= 0 ? '+' : '') + ar.mod + ' = ' + ar.total : ar.total + ' (entered)';
          const verdict = oc === 'crit' ? ' → CRIT' : oc === 'hit' ? ' → HIT' : oc === 'miss' ? (ar.d === 1 ? ' → MISS (nat 1)' : ' → MISS') : '';
          r.textContent = ar.name + ' — ' + rollTxt + vs + verdict;
          host.append(r);
        } else {
          const r = document.createElement('div'); r.className = 'stat-roll';
          r.textContent = ar.name + ' — ' + (ar.notation === 'entered' ? ar.total + ' (entered)' : ar.notation + ' = ' + ar.total) + (ar.dtype ? ' ' + ar.dtype : '') + ' → ' + ar.targetLabel;
          host.append(r);
        }
      }
    } else if (max == null) {
      const p = document.createElement('p'); p.className = 'stat-empty'; p.textContent = 'No stat block yet — add one in data/cast.js.'; host.append(p);
    }

    // ---- Condition effects: the rules text for each active condition, at the very
    //      bottom, so the GM never has to look one up (e.g. what Prone actually does). ----
    if (conds.length) {
      const cx = document.createElement('div'); cx.className = 'stat-cond-info';
      const lbl = document.createElement('div'); lbl.className = 'stat-cond-info-label'; lbl.textContent = 'Condition effects';
      cx.append(lbl);
      for (const cn of conds) {
        const entry = document.createElement('div'); entry.className = 'stat-cond-entry';
        const enm = document.createElement('span'); enm.className = 'stat-cond-name'; enm.textContent = cn;
        entry.append(enm);
        const info = CONDITION_INFO[cn];
        if (info) { const ed = document.createElement('span'); ed.className = 'stat-cond-desc'; ed.textContent = ' — ' + info; entry.append(ed); }
        cx.append(entry);
      }
      host.append(cx);
    }
  }

  function renderMapMode(scene) {
    els.mapmodeTitle.textContent = scene.name;
    if (els.hpToggle) els.hpToggle.classList.toggle('is-on', !!(state.stage && state.stage.hpOnMap));
    if (els.condToggle) els.condToggle.classList.toggle('is-on', !!(state.stage && state.stage.conditionsOnMap));
    if (els.rollsToggle) els.rollsToggle.classList.toggle('is-on', !!(state.stage && state.stage.rollsOnTv));
    updateGridUi();
    els.mmResetLayout.hidden = !(scene && Array.isArray(scene.savedLayout) && scene.savedLayout.length);
    boardView.render(state, scene, { instant: true });
    boardView.layoutTokens();          // the board was just unhidden; re-pin now
    renderRoster(scene);
    renderInitiative(scene);
    renderStatSheet();
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
  // A token is a SQUARE element drawn as a circle, and the active token sits above the rest
  // (z-index:5), so its transparent corner can overhang a neighbour and swallow the click --
  // which read as self-targeting and silently did nothing. Resolve a board click to the token
  // whose CIRCLE is actually under the pointer (nearest centre wins when circles overlap), so
  // you always target/grab the marker you see, not whichever square the DOM happened to hit.
  function tokenElAtPoint(cx, cy) {
    const tokens = (state.stage && state.stage.tokens) || [];
    let bestEl = null, bestDist = Infinity;
    boardView.el.querySelectorAll('.token').forEach((el) => {
      if (!tokens.some((t) => t.instId === el.dataset.instId)) return;
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const rad = r.width / 2;
      const dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2);
      const d2 = dx * dx + dy * dy;
      if (d2 <= rad * rad && d2 < bestDist) { bestDist = d2; bestEl = el; }
    });
    return bestEl;
  }
  function onBoardPointerDown(e) {
    // PR 6E: a zone chip's − / ✕ buttons act on their zone; never treat that as a board click.
    if (e.target.closest && e.target.closest('.zone-chip')) { onZoneChipPress(e); return; }
    // PR 6D: while aiming an area, a board click LOCKS it at the pointer (empty map or token alike).
    if (aoePlacing && !aoePlacing.committed) { updateAoeFromPointer(e); commitAoePlacement(); e.preventDefault(); return; }
    let tokenEl = e.target.closest && e.target.closest('.token');
    if (!tokenEl || !boardView.el.contains(tokenEl)) return;
    tokenEl = tokenElAtPoint(e.clientX, e.clientY) || tokenEl;   // prefer the circle under the pointer
    const instId = tokenEl.dataset.instId;
    const tokens = (state.stage && state.stage.tokens) || [];
    const tok = tokens.find((t) => t.instId === instId);
    if (!tok) return;
    if (targeting) { setTarget(instId); e.preventDefault(); return; }   // targeting mode: aim the active attacker at this token
    drag = { instId, el: tokenEl, x0: tok.x, y0: tok.y };   // start point feeds the on-move zone check (6E)
    tokenEl.classList.add('dragging');
    if (tokenEl.setPointerCapture) { try { tokenEl.setPointerCapture(e.pointerId); } catch (_) {} }
    e.preventDefault();
  }
  function onBoardPointerMove(e) {
    if (aoePlacing && !aoePlacing.committed) { updateAoeFromPointer(e); return; }   // PR 6D: aim/position the area
    if (!drag) return;
    let frac = boardView.pointToFraction(e.clientX, e.clientY);
    if (!frac) return;
    // Snap the token's CENTER to the nearest grid cell; hold Alt to free-place.
    // (snapFractionToCell no-ops when there's no enabled grid.)
    if (!e.altKey) frac = boardView.snapFractionToCell(frac);
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
    const moved = drag;
    drag = null;
    if (dragRAF) cancelAnimationFrame(dragRAF);
    dragPending = false;
    checkZoneMove(moved);              // PR 6E: dragging through Spike Growth prompts its damage
    computeTargetRange();              // a moved token changes the range verdict
    commit();                          // final save + broadcast + refreshed lists
  }
  // PR 6E: after a drag, if the token started or ended inside an on-move zone (Spike
  // Growth) and actually covered ground, queue the "2d4 per 5 ft" prompt on the GM card.
  function checkZoneMove(moved) {
    const t = findToken(moved.instId);
    if (!t || (t.x === moved.x0 && t.y === moved.y0)) return;
    const zs = new Map();
    for (const z of boardView.zonesAtFraction({ x: moved.x0, y: moved.y0 })) if (z.onMove) zs.set(z.id, z);
    for (const z of boardView.zonesAtFraction({ x: t.x, y: t.y })) if (z.onMove) zs.set(z.id, z);
    const z = zs.values().next().value;
    if (!z) return;
    const dist = boardView.gridDistance({ x: moved.x0, y: moved.y0 }, { x: t.x, y: t.y });
    const feet = dist ? dist.feet : z.onMove.per;      // no grid -> assume one increment
    if (!(feet > 0)) return;
    spikePrompt = { instId: t.instId, label: t.label, zone: z.name, dice: z.onMove.dice, per: z.onMove.per, feet, times: Math.max(1, Math.ceil(feet / z.onMove.per)) };
  }
  function applySpikeDamage() {
    const sp = spikePrompt; if (!sp) return;
    spikePrompt = null;
    const p = parseDamage(sp.dice);
    if (!p) { renderStatSheet(); return; }
    const faces = rollFaces(p.count * sp.times, p.sides);
    const total = Math.max(0, faces.reduce((a, b) => a + b, 0) + p.mod * sp.times);
    tvRoll(sp.label + ' moved through ' + sp.zone, total + ' dmg', 'bad', { detail: diceMath(p.sides, faces, p.mod * sp.times) });
    applyHp(sp.instId, -total);        // commits + re-renders (clears the prompt from the card)
  }
  // PR 6E: the zone chip's controls -- − ticks a round off (0 ends it), ✕ ends it now.
  function onZoneChipPress(e) {
    const chip = e.target.closest('.zone-chip');
    const zones = (state.stage && state.stage.zones) || [];
    const z = chip && zones.find((x) => x.id === chip.dataset.zoneId);
    if (!z) return;
    e.preventDefault(); e.stopPropagation();
    if (e.target.closest('.zone-clear')) state.stage.zones = zones.filter((x) => x !== z);
    else if (e.target.closest('.zone-tick')) { z.rounds = Math.max(0, (z.rounds || 0) - 1); if (z.rounds === 0) state.stage.zones = zones.filter((x) => x !== z); }
    else return;
    commit();
  }

  // ---- Map grid helpers (PR 6A). The grid is PER MAP VARIANT: the live geometry
  //      rides state.stage.grids[state.mapState] (broadcast); scene.grids[key] is the
  //      persisted default it seeds from / mirrors to. ----
  function gridDefaults() {
    return { enabled: true, cellSize: 1 / 16, offsetX: 0, offsetY: 0, feetPerCell: 5, color: '#ffffff', opacity: 0.5, lineWidth: 1 };
  }
  function curGridKey() { return state.mapState; }
  function curGrid() { return (state.stage && state.stage.grids) ? state.stage.grids[curGridKey()] : null; }
  function ensureLiveGrid() {
    if (!state.stage.grids) state.stage.grids = {};
    const k = curGridKey();
    if (!state.stage.grids[k]) state.stage.grids[k] = gridDefaults();
    return state.stage.grids[k];
  }
  // Seed a scene's per-variant live grids (deep-cloned so edits don't mutate the
  // scene, defaults filled). Back-compat: a pre-per-variant single scene.grid seeds
  // the default variant. Called from selectScene.
  function seedGrids(scene) {
    let src = scene && scene.grids;
    if (!src && scene && scene.grid) {
      const k = scene.defaultMapState || Object.keys(scene.maps || {})[0] || 'revealed';
      src = { [k]: scene.grid };
    }
    if (!src) return null;
    const out = {};
    for (const k of Object.keys(src)) out[k] = { ...gridDefaults(), ...src[k], enabled: !!src[k].enabled };
    return Object.keys(out).length ? out : null;
  }
  let gridPersistTimer = 0;
  function persistSceneGrid() {
    const scene = sceneById(state.sceneId);
    const g = curGrid();
    if (!scene || !g) return;
    const grids = { ...(scene.grids || {}), [curGridKey()]: { ...g } };
    const updated = { ...scene, grids };
    addUserScene(updated);        // localStorage upsert -> the scene's saved grid default
    saveSceneToFile(updated);     // disk write-through (best-effort, async)
  }
  function schedulePersistSceneGrid() { clearTimeout(gridPersistTimer); gridPersistTimer = setTimeout(persistSceneGrid, 500); }
  // A live grid edit (slider / select / color): local save + broadcast + re-pin the
  // board, WITHOUT a full renderUI churn (which would rebuild the roster/stat panels
  // every tick). The disk write of the scene default is debounced.
  function gridLiveUpdate() {
    saveState(state);
    broadcast();
    boardView.render(state, sceneById(state.sceneId), { instant: true });
    boardView.layoutTokens();
    schedulePersistSceneGrid();
  }
  function syncGridControls() {
    const g = curGrid() || gridDefaults();
    gridControls.forEach((c) => {
      if (c.title) { c.title.textContent = 'Aligning grid · ' + humanize(curGridKey() || 'map'); return; }
      const v = c.get(g);
      c.inp.value = v;
      if (c.out && c.fmt) c.out.textContent = c.fmt(+v);
    });
  }
  // Reflect grid state in the toolbar + panel: Grid toggle lit = THIS map's grid is
  // on; Align lit = the panel is open; the panel shows only while open.
  function updateGridUi() {
    const g = curGrid();
    if (els.gridToggle) els.gridToggle.classList.toggle('is-on', !!(g && g.enabled));
    if (els.gridAlign) els.gridAlign.classList.toggle('is-on', gridPanelOpen);
    if (els.gridPanel) els.gridPanel.hidden = !gridPanelOpen;
    syncGridControls();
  }
  function toggleGrid() {
    ensureTokens();
    if (!state.stage.grids) state.stage.grids = {};
    const k = curGridKey();
    if (!state.stage.grids[k]) state.stage.grids[k] = gridDefaults();                        // first enable -> seed a default
    else state.stage.grids[k] = { ...state.stage.grids[k], enabled: !state.stage.grids[k].enabled };
    updateGridUi();
    persistSceneGrid();           // toggle is infrequent -> persist the scene default now
    rebuildSceneList();           // an edited built-in becomes a saved scene (gets the badge)
    commit();
  }
  // The "Align…" button: open/close the collapsible calibration panel. Opening it
  // ensures THIS map's grid exists + is on, so there's something to align against.
  function openGridAlign() {
    gridPanelOpen = !gridPanelOpen;
    if (gridPanelOpen) { ensureTokens(); ensureLiveGrid().enabled = true; persistSceneGrid(); rebuildSceneList(); }
    updateGridUi();
    commit();
  }

  // ============================================================
  //  Scene builder
  // ============================================================
  function blankDraft() {
    return {
      editingId: null,
      name: '',
      titleHeader: '',
      gmNotes: '',
      // New scenes open on the Aldermere title screen (scene mode only), then
      // reveal to a backdrop shown in both modes.
      variants: [
        { key: 'hidden', src: TITLE_SRC, scene: true, map: false },
        { key: 'revealed', src: (backgrounds[0] && backgrounds[0].src) || '', scene: true, map: true }
      ],
      // Each side is a roster (array) of cutouts; a new scene starts empty.
      left:  [],
      right: [],
      roster: { heroes: [], enemies: [], npcs: [] },
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
    // Each side is a ROSTER (array of cutouts). A legacy single-character scene
    // reads as a one-entry list; an empty side reads as an empty list.
    const sideList = (cfg) => charRoster(cfg).map((s) => ({
      src: s.src || '', enter: s.enter || DEFAULT_ENTER,
      scale: +s.scale > 0 ? +s.scale : 1, flip: !!s.flip, x: +s.x || 0, y: +s.y || 0
    }));
    const t = scene.tokens || {};
    return {
      editingId: scene.id,
      name: scene.name || '',
      titleHeader: scene.titleHeader || '',
      gmNotes: scene.gmNotes || '',
      variants,
      left:  sideList(scene.characters && scene.characters.left),
      right: sideList(scene.characters && scene.characters.right),
      roster: {
        heroes: Array.isArray(t.heroes) ? t.heroes.slice() : [],
        npcs: Array.isArray(t.npcs) ? t.npcs.slice() : [],
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
    const roster = d.roster || { heroes: [], enemies: [], npcs: [] };
    const hasRoster = (roster.heroes && roster.heroes.length) || (roster.enemies && roster.enemies.length) || (roster.npcs && roster.npcs.length);
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
    // Each side saves as an ARRAY of cutouts (one shown at a time; a cue's
    // srcOverride picks who). Per-character display tuning (size / flip / offset)
    // is only stored when it differs from the default, to keep scenes clean.
    const sideCfg = (e) => {
      const c = { id: charIdOf(e.src), src: e.src, enter: e.enter };
      if (+e.scale > 0 && +e.scale !== 1) c.scale = +e.scale;
      if (e.flip) c.flip = true;
      if (+e.x) c.x = +e.x;
      if (+e.y) c.y = +e.y;
      return c;
    };
    const sideRoster = (list) => (Array.isArray(list) ? list : []).filter((e) => e && e.src).map(sideCfg);
    const leftRoster = sideRoster(d.left);
    const rightRoster = sideRoster(d.right);
    if (leftRoster.length)  chars.left  = leftRoster;
    if (rightRoster.length) chars.right = rightRoster;
    if (chars.left || chars.right) scene.characters = chars;
    // Characters are cue-driven, so a scene no longer records a "show on select"
    // flag -- the opening cue reveals whoever should be on screen at the start.
    scene.defaults = { visible: true };
    // Per-scene title-card header (the small line above the name); only stored
    // when set, so an unset scene falls back to the default "Aldermere".
    if ((d.titleHeader || '').trim()) scene.titleHeader = d.titleHeader.trim();
    return scene;
  }

  // A small themed confirmation modal -- the in-app replacement for window.confirm
  // on destructive edits (delete a saved scene, remove a variant / character /
  // cue). Returns a Promise<boolean>: true on confirm, false on cancel / backdrop
  // click / Esc. Confirm is autofocused so Enter accepts and Esc rejects -- a
  // one-keystroke gate that still stops an accidental click.
  function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'Delete', cancelText = 'Cancel' } = {}) {
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const overlay = document.createElement('div');
      overlay.className = 'gm-confirm';
      const box = document.createElement('div');
      box.className = 'gm-confirm-box';
      box.setAttribute('role', 'alertdialog');
      box.setAttribute('aria-modal', 'true');
      const h = document.createElement('h4'); h.className = 'gm-confirm-title'; h.textContent = title;
      box.appendChild(h);
      if (message) { const p = document.createElement('p'); p.className = 'gm-confirm-msg'; p.textContent = message; box.appendChild(p); }
      const row = document.createElement('div'); row.className = 'gm-confirm-actions';
      const no = document.createElement('button'); no.type = 'button'; no.className = 'gm-button btn--quiet gm-confirm-no'; no.textContent = cancelText;
      const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'gm-button gm-confirm-yes'; yes.textContent = confirmText;
      row.append(no, yes); box.appendChild(row); overlay.appendChild(box);
      document.body.appendChild(overlay);

      let done = false;
      const close = (val) => {
        if (done) return; done = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (_) {} }
        resolve(val);
      };
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        else if (e.key === 'Enter') { e.preventDefault(); close(true); }
      }
      document.addEventListener('keydown', onKey, true);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
      no.addEventListener('click', () => close(false));
      yes.addEventListener('click', () => close(true));
      yes.focus();
    });
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
      title.textContent = 'Title screen';
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
      rm.textContent = '✕';
      rm.title = 'Remove this variant';
      rm.setAttribute('aria-label', 'Remove variant');
      rm.disabled = draft.variants.length <= 1;
      rm.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Remove variant?', message: 'Remove the “' + (v.key || 'untitled') + '” background variant?', confirmText: 'Remove' }))) return;
        draft.variants.splice(i, 1);
        renderVariantRows();
        renderBuilderPreview();
      });

      row.append(keyInput, sel, modes, rm);
      els.variantList.appendChild(row);
    });
  }

  // ---- Builder per-side character roster: a stack of cards, one per cutout
  //      eligible to occupy the side (only one shown at a time; cues pick who
  //      enters). Each card carries the character, its own entrance transition,
  //      and its own size / horizontal / vertical / flip placement.
  function buildCharCard(side, entry, i) {
    const card = document.createElement('div');
    card.className = 'char-card';
    // Touching any control spotlights THIS entry in the preview, so editing the
    // 2nd character on a side shows the 2nd character (not the 1st).
    const spotlight = () => { builderPick[side] = entry.src || null; renderBuilderPreview(); };

    const src = document.createElement('select');
    src.className = 'cc-src';
    fillCharSelect(src, entry.src, false);   // first option = "None"
    src.addEventListener('change', () => { entry.src = src.value; spotlight(); });

    const enter = document.createElement('select');
    enter.className = 'cc-enter';
    fillEnterSelect(enter, entry.enter);
    enter.addEventListener('change', () => { entry.enter = enter.value; spotlight(); });

    const adjust = document.createElement('div');
    adjust.className = 'char-adjust';
    const mkRange = (label, cls, min, max, step, val, title, set) => {
      const lab = document.createElement('label'); lab.className = 'char-size';
      if (title) lab.title = title;
      lab.append(document.createTextNode(label + ' '));
      const inp = document.createElement('input');
      inp.type = 'range'; inp.className = cls;
      inp.min = min; inp.max = max; inp.step = step; inp.value = val;
      inp.addEventListener('input', () => { set(+inp.value); spotlight(); });
      lab.append(inp); return lab;
    };
    adjust.append(
      // Size tops out at 2x: a cutout fills the 16:9 frame at 1x, and even a square
      // letterboxed cutout only needs ~1.8x to fill it -- 2..4 was dead travel, so
      // the usable band now spans the whole slider (finer 0.05 step to match).
      mkRange('Size', 'cc-scale', 0.5, 2, 0.05, entry.scale || 1, '', (v) => { entry.scale = v; }),
      // Symmetric around 0 so the default sits CENTERED on the slider with equal,
      // useful travel each way (the old -10..45 / -10..30 ranges parked 0 near the
      // left end and ran far past anything useful on the right).
      mkRange('↔', 'cc-x', -20, 20, 1, entry.x || 0, 'Horizontal position (0 = centered)', (v) => { entry.x = v; }),
      mkRange('↕', 'cc-y', -20, 20, 1, entry.y || 0, 'Vertical position (0 = centered; raise to lift toward the backdrop bottom)', (v) => { entry.y = v; })
    );

    const flip = document.createElement('button');
    flip.type = 'button'; flip.className = 'gm-button btn--toggle cc-flip';
    flip.textContent = 'Flip'; flip.title = 'Flip the character to face the other way';
    flip.classList.toggle('is-on', !!entry.flip);
    flip.addEventListener('click', () => { entry.flip = !entry.flip; flip.classList.toggle('is-on', entry.flip); spotlight(); });

    const del = document.createElement('button');
    del.type = 'button'; del.className = 'cc-del';
    del.textContent = '✕'; del.title = 'Remove this character from the side';
    del.setAttribute('aria-label', 'Remove character');
    del.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Remove character?', message: 'Remove this character from the ' + side + ' side?', confirmText: 'Remove' }))) return;
      draft[side].splice(i, 1);
      builderPick[side] = (draft[side][0] && draft[side][0].src) || null;
      renderCharRoster(side);
      renderBuilderPreview();
    });

    adjust.append(flip, del);
    // Two-row card: pickers (character + entrance) on top, placement on the bottom.
    const row1 = document.createElement('div');
    row1.className = 'cc-row';
    row1.append(src, enter);
    card.append(row1, adjust);
    return card;
  }

  function renderCharRoster(side) {
    const host = els.charRoster[side];
    host.innerHTML = '';
    const list = draft[side] || [];
    if (!list.length) {
      const hint = document.createElement('p');
      hint.className = 'char-empty';
      hint.textContent = 'No one on this side yet — add a character to enter it via cues.';
      host.append(hint);
      return;
    }
    list.forEach((entry, i) => host.append(buildCharCard(side, entry, i)));
  }

  function renderBuilderInputs() {
    els.builderTitle = els.builder.querySelector('.builder-title');
    els.builderTitle.textContent = draft.editingId ? 'Edit scene' : 'Build a scene';
    els.bName.value = draft.name;
    els.bTitleHeader.value = draft.titleHeader || '';
    els.bNotes.value = draft.gmNotes;
    renderVariantRows();
    // Default the preview spotlight to each side's first character.
    builderPick = { left: (draft.left[0] && draft.left[0].src) || null,
                    right: (draft.right[0] && draft.right[0].src) || null };
    renderCharRoster('left');
    renderCharRoster('right');
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
    // Hidden tokens (token builder) are dropped from the scene-eligible pickers.
    const shown = (arr) => (arr || []).filter((c) => !c.hidden);
    build(els.rosterHeroes, els.rosterAllHeroes, shown(CAST.heroes), draft.roster.heroes);
    build(els.rosterNpcs, els.rosterAllNpcs, shown(CAST.npcs), (draft.roster.npcs || (draft.roster.npcs = [])));
    build(els.rosterEnemies, els.rosterAllEnemies, shown(CAST.enemies), draft.roster.enemies);
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
      // Character sides default to null = "carry over" (No change), so a new cue
      // only touches a side once the GM explicitly picks a character or Hide for it.
      snapshot: { mapState: null, mapMode: false, visible: true,
        left: null, right: null,
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
    const scene = draftToScene(draft);
    const maps = scene.maps || {};
    const vm = scene.variantModes || {};
    return Object.keys(maps).map((key) => ({
      key, label: humanize(key) + (maps[key] === '' ? ' (title card)' : ''),
      map: !!(vm[key] && vm[key].map)   // a battle map vs a scene-mode background
    }));
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
      rm.type = 'button'; rm.textContent = '✕'; rm.title = 'Delete this cue';
      rm.setAttribute('aria-label', 'Delete cue');
      rm.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Delete cue?', message: 'Delete the cue “' + (cue.label || 'untitled') + '”? Its keyframes will be lost.', confirmText: 'Delete cue' }))) return;
        cueOpen.delete(cue.id); cues.splice(i, 1); renderCueRows();
      });

      // Play THIS cue -- with its keyframe transitions -- in the docked preview,
      // without scrolling up or opening the keyframe editor.
      const prev = document.createElement('button');
      prev.className = 'gm-button btn--quiet cue-preview';
      prev.type = 'button'; prev.textContent = '▶';
      prev.title = 'Play this cue (with its keyframe transitions) in the preview, and leave it up';
      prev.setAttribute('aria-label', 'Preview this cue');
      prev.addEventListener('click', () => testCueTimeline(cue, { hold: true }));

      // The action cluster stays together at the row end so a tight column wraps
      // the whole group (never an orphaned ✕) -- collapsed, the cue is one row.
      const actions = document.createElement('div');
      actions.className = 'cue-head-actions';
      actions.append(prev, open, up, down, rm);
      head.append(chev, label, actions);
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
    const field = (labelText) => {
      const f = document.createElement('div'); f.className = 'cue-field';
      const sp = document.createElement('span'); sp.className = 'cue-field-label'; sp.textContent = labelText;
      f.append(sp); return f;
    };

    // Background variant (or no change).
    const bgF = field('Background');
    const bgSel = document.createElement('select'); bgSel.className = 'cue-bg';
    const none = document.createElement('option'); none.value = ''; none.textContent = '— No change —'; bgSel.append(none);
    // Group so the GM can tell scene-mode backgrounds from battle maps at a glance.
    const bgOpts = cueBackdropOptions();
    const bgGroup = (label, list) => {
      if (!list.length) return;
      const g = document.createElement('optgroup'); g.label = label;
      for (const o of list) { const op = document.createElement('option'); op.value = o.key; op.textContent = o.label; g.append(op); }
      bgSel.append(g);
    };
    bgGroup('Backgrounds', bgOpts.filter((o) => !o.map));
    bgGroup('Maps', bgOpts.filter((o) => o.map));
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
      const charName = (src) => { const c = characters.find((x) => x.src === src); return c ? c.name : charIdOf(src); };
      // The cue's side picker lists THIS scene's roster for the side, by name,
      // plus Hide. An off-roster current selection is kept so editing an old cue
      // never silently drops who it placed.
      const fillCueSide = (sel, roster, current) => {
        sel.innerHTML = '';
        const hide = document.createElement('option'); hide.value = ''; hide.textContent = '— Hide —';
        sel.append(hide);
        const seen = new Set();
        const add = (src, suffix) => {
          if (!src || seen.has(src)) return; seen.add(src);
          const o = document.createElement('option'); o.value = src;
          o.textContent = charName(src) + (suffix || ''); sel.append(o);
        };
        roster.forEach((e) => add(e.src));
        if (current && !seen.has(current)) add(current, ' (not in roster)');
      };
      const KEEP = '__keep__';   // sentinel: leave this side exactly as it is
      const mk = (which) => {
        const wrap = document.createElement('label'); wrap.className = 'cue-side';
        const cap = document.createElement('span'); cap.textContent = which === 'left' ? 'Left' : 'Right';
        const sel = document.createElement('select'); sel.className = 'cue-char-' + which;
        const isKeep = snap[which] === null;                       // null => carry over
        const cur = (snap[which] && snap[which].srcOverride) || '';
        const roster = charRoster(draft && draft[which]);
        // With a roster, pick from it; with none yet, fall back to the full cast
        // so a cue can still place someone on an otherwise-empty side.
        if (roster.length) fillCueSide(sel, roster, cur);
        else fillCharSelect(sel, cur, false);   // first option = "None"
        // Carry-over option, first: the cue leaves this side untouched (so changing
        // the other side doesn't re-trigger this one's entrance).
        const keep = document.createElement('option'); keep.value = KEEP; keep.textContent = '— No change (carry over) —';
        sel.insertBefore(keep, sel.firstChild);
        sel.value = isKeep ? KEEP : cur;
        sel.addEventListener('change', () => {
          snap[which] = sel.value === KEEP ? null : { shown: !!sel.value, srcOverride: sel.value || null };
        });
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
    ta.placeholder = 'Shown while this cue is live';
    ta.value = cue.notes || '';
    ta.addEventListener('input', () => { cue.notes = ta.value; });
    noteF.append(ta); host.append(noteF);
    // (No side normalization here: a side is null = "carry over" or a concrete
    // {shown, srcOverride}; every apply path guards null, so forcing both sides
    // concrete would silently turn a carry-over side into Hide.)
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
      hint.textContent = 'Pick some content above to choose what to keyframe.';
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
        // character's scale / flip / x / y. builderPick spotlights the roster
        // entry being edited (else the side's first entry shows).
        left:  { shown: charRoster(scene.characters && scene.characters.left).length > 0,  srcOverride: builderPick.left },
        right: { shown: charRoster(scene.characters && scene.characters.right).length > 0, srcOverride: builderPick.right }
      }
    };
    previewView.render(pstate, scene, { instant: previewFirstPaint }); previewFirstPaint = false;
    els.previewName.textContent = scene.name || 'New scene';
    els.badge.textContent = (scene.maps && scene.maps[previewKey] === '') ? 'Title screen' : humanize(previewKey);
    els.badge.classList.remove('badge-revealed');
  }

  // Builder input wiring (elements persist; only their options change).
  els.bName.addEventListener('input', () => { draft.name = els.bName.value; renderBuilderPreview(); });
  els.bTitleHeader.addEventListener('input', () => { draft.titleHeader = els.bTitleHeader.value; renderBuilderPreview(); });
  els.bNotes.addEventListener('input', () => { draft.gmNotes = els.bNotes.value; });
  els.addVariant.addEventListener('click', () => {
    draft.variants.push({ key: 'variant-' + (draft.variants.length + 1), src: (backgrounds[0] && backgrounds[0].src) || '', scene: true, map: true });
    renderVariantRows();
    renderBuilderPreview();
  });
  // Add a blank character to a side's roster (each card wires its own controls
  // in buildCharCard); spotlight the new one so the GM places it straight away.
  for (const side of ['left', 'right']) {
    els.addChar[side].addEventListener('click', () => {
      draft[side].push({ src: '', enter: DEFAULT_ENTER, scale: 1, flip: false, x: 0, y: 0 });
      builderPick[side] = null;
      renderCharRoster(side);
      renderBuilderPreview();
    });
  }
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

  // The GM's custom scene order: an array of scene ids the drag handle rewrites.
  // Persisted locally; scenes not yet in it (freshly added) keep their natural
  // position at the end, so a new scene never vanishes.
  const ORDER_KEY = 'aldermere.gm.sceneOrder.v1';
  function loadOrder() {
    try { const a = JSON.parse(localStorage.getItem(ORDER_KEY)); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; }
    catch (e) { return []; }
  }
  function saveOrder() { try { localStorage.setItem(ORDER_KEY, JSON.stringify(sceneOrder)); } catch (e) {} }
  let sceneOrder = loadOrder();
  let draggingLi = null;
  // Read the live DOM row order back into sceneOrder after a drag, then rebuild
  // so pin-float re-applies canonically.
  function persistSceneOrder() {
    const ids = [...els.sceneList.querySelectorAll('.scene-button')].map((b) => b.dataset.id);
    if (ids.length) { sceneOrder = ids; saveOrder(); }
    rebuildSceneList();
  }

  function rebuildSceneList() {
    els.sceneList.innerHTML = '';
    // Order: the GM's custom drag order first (unknown ids fall to the end in
    // natural order), then pinned scenes float to the top -- a stable partition,
    // so unpinning drops a scene back into its ordered place.
    const all = allScenes();
    const rank = new Map(sceneOrder.map((id, i) => [id, i]));
    const base = [...all].sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
      const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
      return ra === rb ? 0 : ra - rb;
    });
    const ordered = [...base.filter((s) => pinned.has(s.id)), ...base.filter((s) => !pinned.has(s.id))];
    for (const scene of ordered) {
      const li = document.createElement('li');
      const isPinned = pinned.has(scene.id);
      if (isPinned) li.classList.add('is-pinned');

      // Drag handle: the only draggable element, so a click on the row still
      // selects/edits while a grab on the grip reorders. dragover on each row
      // live-moves the dragged row above/below by the pointer's midpoint test.
      const grip = document.createElement('span');
      grip.className = 'scene-grip';
      grip.draggable = true;
      grip.textContent = '⠿';
      grip.title = 'Drag to reorder';
      grip.setAttribute('aria-label', 'Drag to reorder ' + scene.name);
      grip.addEventListener('dragstart', (e) => {
        draggingLi = li; li.classList.add('dragging');
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', scene.id); } catch (_) {} }
      });
      grip.addEventListener('dragend', () => { li.classList.remove('dragging'); draggingLi = null; persistSceneOrder(); });
      li.appendChild(grip);
      li.addEventListener('dragover', (e) => {
        if (!draggingLi || draggingLi === li) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const rect = li.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        if (after) li.after(draggingLi); else li.before(draggingLi);
      });
      li.addEventListener('drop', (e) => { if (draggingLi) e.preventDefault(); });

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
      // A pencil to open the builder for this scene directly (any scene).
      const edit = document.createElement('button');
      edit.className = 'scene-edit';
      edit.type = 'button';
      edit.textContent = '✎';
      edit.title = 'Edit this scene';
      edit.setAttribute('aria-label', 'Edit ' + scene.name);
      edit.addEventListener('click', (e) => { e.stopPropagation(); openBuilder(scene); });
      li.appendChild(edit);
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
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          // Deleting a saved scene is destructive and irreversible -- confirm first.
          if (!(await confirmDialog({ title: 'Delete saved scene?', message: 'Delete the saved scene “' + scene.name + '”? This cannot be undone.', confirmText: 'Delete scene' }))) return;
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

  // A transient toast: shows the message, then auto-dismisses after a few seconds
  // (pass sticky=true to keep an error up until the next status). It used to be a
  // permanent line in the rail, so "Saved ..." lingered forever.
  let statusTimer = 0;
  function setStatus(msg, sticky) {
    const el = els.rescanStatus;
    el.hidden = false;
    el.textContent = msg;
    el.classList.add('is-visible');
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = 0; }
    if (!sticky) statusTimer = setTimeout(() => { el.classList.remove('is-visible'); statusTimer = 0; }, 3200);
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
      setStatus('Rescan needs the local server (run: python3 scripts/serve.py). Or run scripts/sync-assets.sh and reload. (' + err.message + ')', true);
    }
  }
  els.rescanBtn.addEventListener('click', rescan);

  // ============================================================
  //  Top-level render
  // ============================================================
  function renderUI() {
    highlightActive();
    renderNotices();
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
    els.initiative.hidden = !inMap;
    els.statsheet.hidden = !inMap;
    // In the builder, shrink the preview and pin it so it stays visible while
    // scrolling the controls (so "Test in preview" is actually watchable). The
    // is-map class drops the compact 3-zone grid for map mode (board takes over).
    els.stage.classList.toggle('is-building', building);
    els.stage.classList.toggle('is-map', inMap);

    // In map mode the Edit / Exit-map-mode nav rides in the board header (next to
    // the title) so it's reachable without scrolling; in live mode it rides in the
    // preview caption next to the size toggle (so the live nav sits with the scene
    // title, not as a stray row at the bottom); building parks it in the hidden
    // controls block so it doesn't dock into the build rail with the preview.
    // Idempotent -- only moves when the parent is wrong, so renders don't thrash.
    if (inMap) {
      if (els.controlsNav.parentElement !== els.mapmodeHeadActions) els.mapmodeHeadActions.appendChild(els.controlsNav);
    } else if (scene && !building) {
      if (els.controlsNav.nextElementSibling !== els.previewSize) els.previewCap.insertBefore(els.controlsNav, els.previewSize);
    } else if (els.controlsNav.parentElement !== els.controls) {
      els.controls.insertBefore(els.controlsNav, els.allControls);
    }

    // Build mode docks the preview into the sticky left rail (under the scene
    // list) so it stays visible while scrolling a long cue editor; otherwise it
    // sits in the centre stage. Idempotent -- only moves when the parent is wrong.
    if (building) {
      if (els.preview.parentElement !== els.scenes) els.scenes.appendChild(els.preview);
    } else if (els.preview.parentElement !== els.surface) {
      els.surface.insertBefore(els.preview, els.controls);
    }

    // Persistent rail nav -- Black out + Background + Map<->Exit at one fixed spot,
    // so a quick transition never hunts for a button that moved.
    if (scene && !building) {
      // Set only the label span -- the leading power glyph stays put.
      (els.visToggle.querySelector('.btn-label') || els.visToggle).textContent = state.stage.visible === false ? 'Show scene' : 'Black out';
      els.visToggle.classList.toggle('is-on', state.stage.visible === false);  // lit (red) while blacked out
      els.mapModeToggle.hidden = !sceneHasMap(scene);
      // Icon + label: a folded-map icon to enter, a log-out icon to leave -- the
      // label says which, so the button reads the same in the live rail and the
      // map header where it relocates.
      els.mapModeToggle.innerHTML = inMap
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg><span class="btn-label">Exit map mode</span>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3z"/><path d="M9 3v15"/><path d="M15 6v15"/></svg><span class="btn-label">Map mode</span>';
      els.mapModeToggle.classList.toggle('is-on', inMap);
      renderCueButtons(scene);
      // Live: the quick-actions + mixer modules are the manual surface. Map mode
      // swaps in its own controls (variant reveal + Save/Reset layout).
      els.quick.hidden = inMap;
      els.mixer.hidden = inMap || !scene.audio;
      els.perfSide.hidden = inMap;          // quick+mixer empty in map -> drop the blank panel
      if (inMap) els.cueRow.hidden = true;  // cues are a scene/cinematic tool; hidden in map
      els.allControls.hidden = !inMap;
      if (inMap) {
        renderVariantButtons(scene);     // the map-reveal chips in the Map controls
        els.allControls.open = true;
      } else {
        renderQuick(scene);
        if (scene.audio) renderMixer(scene);
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

  // GM-only dice tray (lower-left). With "To room" on, a roll is pushed to the
  // Player TV via state.stage.roomDice (broadcast); the GM breakdown stays local.
  mountDiceRoller(root, {
    showToRoom(payload) {
      if (!state.stage) return;
      const n = ((state.stage.roomDice && state.stage.roomDice.n) || 0) + 1;
      state.stage.roomDice = { flat: payload.flat, total: payload.total, notation: payload.notation, n };
      commit();
    },
    clearRoom() { if (state.stage && state.stage.roomDice) { state.stage.roomDice = null; commit(); } }
  });
  mountAudioFloater();
  mountTokenBuilder();

  // Floating audio menu (lower-right, opposite the dice): Master / Music / SFX
  // volume + mute + the TV/Laptop output toggles -- quick reach mid-combat.
  function mountAudioFloater() {
    const host = document.createElement('div'); host.className = 'audio-floater';
    host.innerHTML = `
      <button class="audio-launcher" type="button" aria-label="Audio" aria-expanded="false" title="Audio">
        <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M7 19h9l12-9v28l-12-9H7z"/><path class="wave" d="M33 18a9 9 0 0 1 0 12"/><path class="wave" d="M38 13a16 16 0 0 1 0 22"/></svg>
      </button>
      <div class="audio-floater-panel" hidden>
        <div class="af-head"><span class="af-title">Audio</span><button class="af-close" type="button" aria-label="Close audio menu">&times;</button></div>
        <div class="af-faders"></div>
        <div class="af-out"></div>
      </div>`;
    root.appendChild(host);
    const launcher = host.querySelector('.audio-launcher');
    const panel = host.querySelector('.audio-floater-panel');
    const faders = host.querySelector('.af-faders');
    const out = host.querySelector('.af-out');
    function rebuild() {
      ensureAudio();
      faders.innerHTML = '';
      faders.append(buildFader('Master', 'master'), buildFader('Music', 'mus'), buildFader('SFX', 'sfx'));
      out.innerHTML = '';
      const lbl = document.createElement('span'); lbl.className = 'af-out-label'; lbl.textContent = 'Out';
      out.append(lbl);
      for (const [key, name] of [['player', 'TV'], ['gm', 'Laptop']]) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'gm-button btn--toggle af-output';
        b.textContent = name; b.classList.toggle('is-on', !!state.audio.outputs[key]);
        b.addEventListener('click', () => { ensureAudio(); state.audio.outputs[key] = !state.audio.outputs[key]; commitAudio(); b.classList.toggle('is-on', !!state.audio.outputs[key]); });
        out.append(b);
      }
    }
    function setOpen(open) { panel.hidden = !open; launcher.setAttribute('aria-expanded', open ? 'true' : 'false'); host.classList.toggle('is-open', open); if (open) rebuild(); }
    launcher.addEventListener('click', () => setOpen(panel.hidden));
    host.querySelector('.af-close').addEventListener('click', () => setOpen(false));
  }

  // ============================================================
  //  Token builder (opened from the header "Tokens" button)
  // ------------------------------------------------------------
  //  A setup tool, per character not per scene: drag the portrait to center
  //  the face in the round token, recolor the ring, and tune the on-map
  //  overlays (name size, condition word size + position, HP-bar position).
  //  Saves per castId to data/tokenOverrides.json (merged over CAST at load),
  //  applies live to the GM board, and broadcasts so the Player TV re-crops.
  // ============================================================
  function mountTokenBuilder() {
    const RING_SWATCHES = ['#2f6b43', '#2a4d7a', '#6f9bd1', '#8a2e2e', '#b8862f', '#6a4d8a'];
    const clampN = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
    const parseFace = (f) => { const m = /(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%/.exec(f || ''); return m ? { x: +m[1], y: +m[2] } : { x: 50, y: 50 }; };
    const fmtFace = (p) => `${Math.round(clampN(p.x, 0, 100))}% ${Math.round(clampN(p.y, 0, 100))}%`;
    const defRing = (kind) => (kind === 'enemy' ? '#8a2e2e' : kind === 'npc' ? '#6f9bd1' : '#2f6b43');
    const iniOf = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    const findCast = (castId) => {
      for (const [kind, arr] of [['hero', CAST.heroes], ['npc', CAST.npcs], ['enemy', CAST.enemies]]) {
        const c = (arr || []).find((x) => x.id === castId);
        if (c) return { cast: c, kind };
      }
      return null;
    };

    const overlay = document.createElement('div');
    overlay.className = 'token-builder';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="tb-backdrop"></div>
      <div class="tb-dialog" role="dialog" aria-modal="true" aria-label="Token builder">
        <div class="tb-head"><h2 class="tb-title">Token builder</h2><button class="tb-close" type="button" aria-label="Close token builder">&times;</button></div>
        <div class="tb-body">
          <div class="tb-picker">
            <div class="tb-picker-head">
              <button class="gm-button btn--quiet tb-new-token" type="button">+ New token</button>
              <label class="tb-show-hidden"><input type="checkbox" class="tb-show-hidden-cb"> Show hidden</label>
            </div>
            <div class="tb-picker-list"></div>
          </div>
          <div class="tb-editor">
            <p class="tb-empty">Pick a character on the left to shape their token, or add a new one.</p>
            <div class="tb-add" hidden>
              <h3 class="tb-section-h">New token</h3>
              <label class="tb-set"><span class="tb-set-label">Name</span><input type="text" class="tb-add-name" placeholder="e.g. Bandit Captain"></label>
              <div class="tb-set"><span class="tb-set-label">Category</span><div class="tb-seg tb-add-kind"><button type="button" data-v="hero">Hero</button><button type="button" data-v="npc">NPC</button><button type="button" data-v="enemy">Enemy</button></div></div>
              <div class="tb-actions"><button class="gm-button btn--primary tb-add-create" type="button">Create</button><button class="gm-button btn--quiet tb-add-cancel" type="button">Cancel</button></div>
            </div>
            <div class="tb-edit" hidden>
              <div class="tb-edit-cols">
                <section class="tb-col tb-token-col">
                  <h3 class="tb-section-h">This token</h3>
                  <div class="tb-crop" title="Drag to center the face">
                    <div class="tb-crop-fallback"></div>
                    <img class="tb-crop-img" alt="" draggable="false">
                    <div class="tb-crop-ring"></div>
                  </div>
                  <p class="tb-hint">Drag the portrait to center the face</p>
                  <label class="tb-set tb-zoom-row"><span class="tb-set-label">Zoom</span><input type="range" class="tb-crop-zoom" min="1" max="3" step="0.05" value="1"></label>
                  <div class="tb-ring"><span class="tb-set-label">Ring color</span><div class="tb-swatches"></div></div>
                  <div class="tb-image">
                    <div class="tb-image-head"><span class="tb-set-label">Token image</span><button class="gm-button btn--quiet tb-upload-btn" type="button">Upload&hellip;</button></div>
                    <input type="file" class="tb-upload-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
                    <div class="tb-image-grid"></div>
                    <p class="tb-upload-status" role="status" aria-live="polite" hidden></p>
                  </div>
                  <div class="tb-actions"><button class="gm-button btn--primary tb-save" type="button">Save token</button><button class="gm-button btn--quiet tb-reset" type="button">Reset token</button><span class="tb-saved" role="status" aria-live="polite" hidden>Saved &#10003;</span></div>
                </section>
                <section class="tb-col tb-global-col">
                  <h3 class="tb-section-h">All tokens<span class="tb-section-note"> &middot; applies to every token</span></h3>
                  <div class="tb-subgroup">
                    <span class="tb-subgroup-h">Name</span>
                    <label class="tb-set"><span class="tb-set-label">Text size</span><input type="range" class="tb-name-size" min="0.6" max="1.6" step="0.05"></label>
                    <label class="tb-set"><span class="tb-set-label">Letter spacing</span><input type="range" class="tb-name-spacing" min="0" max="100" step="5"></label>
                  </div>
                  <div class="tb-subgroup">
                    <span class="tb-subgroup-h">Conditions</span>
                    <label class="tb-set"><span class="tb-set-label">Text size</span><input type="range" class="tb-cond-size" min="0.6" max="1.8" step="0.05"></label>
                    <label class="tb-set"><span class="tb-set-label">Letter spacing</span><input type="range" class="tb-cond-spacing" min="0" max="100" step="5"></label>
                    <label class="tb-set"><span class="tb-set-label">Position <span class="tb-set-hint">below &harr; above</span></span><input type="range" class="tb-cond-pos" min="0" max="100" step="2"></label>
                    <label class="tb-set"><span class="tb-set-label">Curve <span class="tb-set-hint">flat &harr; wrapped</span></span><input type="range" class="tb-cond-curve" min="0" max="100" step="5"></label>
                    <div class="tb-colors">
                      <label class="tb-color"><span class="tb-set-label">Text color</span><input type="color" class="tb-cond-color"></label>
                      <label class="tb-color"><span class="tb-set-label">Outline</span><input type="color" class="tb-cond-outline"></label>
                    </div>
                  </div>
                  <div class="tb-subgroup">
                    <span class="tb-subgroup-h">HP bar</span>
                    <label class="tb-set"><span class="tb-set-label">Position <span class="tb-set-hint">down &harr; up</span></span><input type="range" class="tb-hp-pos" min="0" max="100" step="5"></label>
                  </div>
                  <div class="tb-sample-wrap"><span class="tb-set-label">On-map preview</span><div class="tb-sample"><div class="stage tb-stage"></div></div></div>
                </section>
              </div>
            </div>
          </div>
        </div>`;
    root.appendChild(overlay);

    const q = (s) => overlay.querySelector(s);
    const editBox = q('.tb-edit'), emptyMsg = q('.tb-empty'), addBox = q('.tb-add');
    const crop = q('.tb-crop'), cropImg = q('.tb-crop-img'), cropFb = q('.tb-crop-fallback'), cropRing = q('.tb-crop-ring'), cropZoom = q('.tb-crop-zoom');
    const swatches = q('.tb-swatches'), imageGrid = q('.tb-image-grid');
    const uploadBtn = q('.tb-upload-btn'), uploadInput = q('.tb-upload-input'), uploadStatus = q('.tb-upload-status');
    const nameSize = q('.tb-name-size'), nameSpacing = q('.tb-name-spacing'), condSize = q('.tb-cond-size'), condSpacing = q('.tb-cond-spacing'), condPosSlider = q('.tb-cond-pos'), condCurve = q('.tb-cond-curve'), condColor = q('.tb-cond-color'), condOutline = q('.tb-cond-outline'), hpPos = q('.tb-hp-pos');
    const savedTag = q('.tb-saved');
    const stage = q('.tb-stage');

    let sel = null;     // { cast, kind }  -- the character being edited
    let draft = null;   // per-token identity: { face, ringColor, tokenImage }
    let gd = null;      // GLOBAL display (all tokens): {nameSize,nameSpacing,condSize,condSpacing,condPosY,condCurve,condColor,condOutline,hpPos}
    let showHidden = false;   // reveal hidden tokens in the picker
    let addKind = 'hero';     // category for a new token being created
    const extraImages = [];   // images uploaded this session, shown in the grid before a rescan

    const showEmpty = () => { emptyMsg.hidden = false; editBox.hidden = true; addBox.hidden = true; };
    const showAdd = () => { emptyMsg.hidden = true; editBox.hidden = true; addBox.hidden = false; };
    const showEdit = () => { emptyMsg.hidden = true; editBox.hidden = false; addBox.hidden = true; };
    const broadcastRoster = () => { sync.post({ type: 'tokens', roster: rosterPayload() }); repaintBoards(); };

    // Ring swatches (built once).
    for (const color of RING_SWATCHES) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tb-swatch'; b.dataset.color = color;
      b.style.background = color; b.setAttribute('aria-label', 'Ring ' + color);
      b.addEventListener('click', () => { if (!draft) return; draft.ringColor = color; markDirty(); renderRing(); renderSample(); });
      swatches.append(b);
    }

    // The live sample token: the exact .stage .token markup + classes, so the
    // display settings render precisely as they will on the board / TV.
    const sampleTok = document.createElement('div');
    sampleTok.className = 'token token-hero';
    sampleTok.innerHTML =
      '<div class="token-crop"><div class="token-fallback"></div><img class="token-portrait" alt=""></div>' +
      '<div class="token-label"></div>' +
      '<div class="token-hpbar"><i></i></div>' +
      '<svg class="token-cond" viewBox="0 0 100 100"><defs><path id="tb-cond-arc" d="' + condArcPath(55, false) + '" fill="none"></path></defs>' +
      '<text class="token-cond-text"><textPath startOffset="50%" text-anchor="middle" href="#tb-cond-arc" xlink:href="#tb-cond-arc">Prone</textPath></text></svg>';
    stage.append(sampleTok);
    const sampleImg = sampleTok.querySelector('.token-portrait');
    const sampleFb = sampleTok.querySelector('.token-fallback');

    // Art may not be vendored yet (NPC portraits especially): fall back to the
    // initials on the ring if the image fails, exactly like the board token.
    cropImg.onload = () => { cropImg.style.display = ''; cropFb.style.display = 'none'; };
    cropImg.onerror = () => { cropImg.style.display = 'none'; cropFb.style.display = ''; };
    sampleImg.onload = () => { sampleImg.style.display = ''; sampleFb.style.display = 'none'; };
    sampleImg.onerror = () => { sampleImg.style.display = 'none'; sampleFb.style.display = ''; };

    // ---- per-token renders ----
    function renderCrop() {
      cropRing.style.borderColor = draft.ringColor;
      cropFb.style.background = draft.ringColor;
      cropFb.textContent = iniOf(sel.cast.name);
      if (cropZoom) cropZoom.value = draft.faceZoom || 1;
      cropImg.style.transformOrigin = draft.face;
      cropImg.style.transform = 'scale(' + (draft.faceZoom || 1) + ')';
      if (draft.tokenImage) {
        cropImg.style.objectPosition = draft.face;
        // Only toggle display on a real src change, so onload/onerror stays the
        // authority (a setting tweak must not un-hide a broken image).
        if (cropImg.getAttribute('src') !== draft.tokenImage) {
          cropImg.src = draft.tokenImage; cropImg.style.display = ''; cropFb.style.display = 'none';
        }
      } else { cropImg.removeAttribute('src'); cropImg.style.display = 'none'; cropFb.style.display = ''; }
    }
    function renderRing() {
      swatches.querySelectorAll('.tb-swatch').forEach((b) => b.classList.toggle('is-on', b.dataset.color === draft.ringColor));
      cropRing.style.borderColor = draft.ringColor;
    }
    function renderImageGrid() {
      imageGrid.innerHTML = '';
      const seen = new Set();
      for (const it of [...extraImages, ...(TOKENART || [])]) {
        if (!it || !it.src || seen.has(it.src)) continue;
        seen.add(it.src);
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'tb-img-opt'; b.dataset.src = it.src; b.title = it.name || it.src;
        if (it.src === draft.tokenImage) b.classList.add('is-on');
        const im = document.createElement('img'); im.alt = ''; im.src = it.src;
        b.append(im);
        b.addEventListener('click', () => {
          draft.tokenImage = it.src; markDirty(); renderCrop(); renderSample();
          imageGrid.querySelectorAll('.tb-img-opt').forEach((x) => x.classList.toggle('is-on', x.dataset.src === draft.tokenImage));
        });
        imageGrid.append(b);
      }
    }
    function renderSample() {
      sampleTok.style.borderColor = draft.ringColor;
      sampleFb.style.background = draft.ringColor; sampleFb.textContent = iniOf(sel.cast.name);
      sampleImg.style.transformOrigin = draft.face;
      sampleImg.style.transform = 'scale(' + (draft.faceZoom || 1) + ')';
      if (draft.tokenImage) {
        sampleImg.style.objectPosition = draft.face;
        if (sampleImg.getAttribute('src') !== draft.tokenImage) {
          sampleImg.src = draft.tokenImage; sampleImg.style.display = ''; sampleFb.style.display = 'none';
        }
      } else { sampleImg.removeAttribute('src'); sampleImg.style.display = 'none'; sampleFb.style.display = ''; }
      sampleTok.querySelector('.token-label').textContent = sel.cast.name;
      const fill = sampleTok.querySelector('.token-hpbar > i'); fill.style.width = '62%'; fill.style.background = '#e0a52e';
      styleSampleGlobal();
    }

    // ---- global (all-tokens) display ----
    function renderSeg(cls, val) {
      q(cls).querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === val));
    }
    function styleSampleGlobal() {
      sampleTok.style.setProperty('--token-name-scale', gd.nameSize);
      sampleTok.style.setProperty('--token-name-spacing', (gd.nameSpacing / 100 * 0.4).toFixed(3) + 'em');
      sampleTok.style.setProperty('--token-cond-scale', gd.condSize);
      sampleTok.style.setProperty('--token-cond-spacing', (gd.condSpacing / 100 * 10).toFixed(2) + 'px');
      sampleTok.style.setProperty('--token-cond-color', gd.condColor);
      sampleTok.style.setProperty('--token-cond-outline', gd.condOutline);
      sampleTok.classList.toggle('cond-below', gd.condPosY < 50);
      sampleTok.style.setProperty('--token-hp-y', (84 - gd.hpPos * 0.82).toFixed(1) + '%');
      sampleTok.querySelector('.token-cond path').setAttribute('d', condArcPath(gd.condCurve, gd.condPosY));
    }
    function seedGlobal() {
      const g = globalDisplay();
      gd = { nameSize: g.nameSize || 1, nameSpacing: g.nameSpacing || 0, condSize: g.condSize || 1, condSpacing: g.condSpacing == null ? 8 : g.condSpacing, condPosY: g.condPosY == null ? 100 : g.condPosY, condCurve: g.condCurve == null ? 55 : g.condCurve, condColor: g.condColor || '#ffffff', condOutline: g.condOutline || '#000000', hpPos: g.hpPos || 0 };
    }
    function renderGlobalControls() {
      nameSize.value = gd.nameSize; nameSpacing.value = gd.nameSpacing; condSize.value = gd.condSize; condSpacing.value = gd.condSpacing;
      condPosSlider.value = gd.condPosY; condCurve.value = gd.condCurve; condColor.value = gd.condColor; condOutline.value = gd.condOutline; hpPos.value = gd.hpPos;
    }
    // Live: update this window's cache + repaint + broadcast so the Player TV mirrors the
    // change immediately (small message, no disk). Persist: write to disk on release.
    function applyGlobalLive() { applyGlobalDisplay(gd); if (sel) styleSampleGlobal(); repaintBoards(); sync.post({ type: 'tokens', global: globalDisplay() }); }
    async function persistGlobal() { await saveGlobalDisplay(gd); sync.post({ type: 'tokens', global: globalDisplay() }); }

    function markDirty() { savedTag.hidden = true; }

    function selectChar(castId) {
      const found = findCast(castId);
      if (!found) return;
      sel = found;
      const c = found.cast;
      draft = {
        face: c.face || '50% 50%',
        faceZoom: (c.faceZoom != null && isFinite(+c.faceZoom)) ? +c.faceZoom : 1,
        ringColor: c.ringColor || defRing(found.kind),
        // Heroes/enemies ship token art; an NPC borrows its portrait until given its own.
        tokenImage: c.tokenImage || c.portrait || ''
      };
      overlay.querySelectorAll('.tb-chip').forEach((ch) => ch.classList.toggle('is-active', ch.dataset.id === castId));
      savedTag.hidden = true; showEdit();
      renderCrop(); renderRing(); renderImageGrid(); renderSample();
    }

    function renderPicker() {
      const list = q('.tb-picker-list');
      list.innerHTML = '';
      for (const [kind, label, arr] of [['hero', 'Heroes', CAST.heroes], ['npc', 'NPCs', CAST.npcs], ['enemy', 'Enemies', CAST.enemies]]) {
        const items = (arr || []).filter((c) => showHidden || !c.hidden);
        if (!items.length) continue;
        const group = document.createElement('div'); group.className = 'tb-group';
        const h = document.createElement('h3'); h.className = 'tb-group-h'; h.textContent = label; group.append(h);
        const glist = document.createElement('div'); glist.className = 'tb-list';
        for (const c of items) {
          const chip = document.createElement('div'); chip.className = 'tb-chip'; chip.dataset.id = c.id;
          if (c.hidden) chip.classList.add('is-token-hidden');
          if (sel && sel.cast.id === c.id) chip.classList.add('is-active');
          const selBtn = document.createElement('button'); selBtn.type = 'button'; selBtn.className = 'tb-chip-sel';
          const art = c.tokenImage || c.portrait;
          const tok = document.createElement('span'); tok.className = 'tb-chip-tok'; tok.style.borderColor = c.ringColor || defRing(kind);
          if (art) { const im = document.createElement('img'); im.alt = ''; im.src = art; im.style.objectPosition = c.face || '50% 50%'; tok.append(im); }
          else { const ini = document.createElement('span'); ini.className = 'tb-chip-ini'; ini.textContent = iniOf(c.name); tok.append(ini); }
          const nm = document.createElement('span'); nm.className = 'tb-chip-name'; nm.textContent = c.name;
          selBtn.append(tok, nm);
          selBtn.addEventListener('click', () => selectChar(c.id));
          // Trailing control: remove (a token you added) / hide / unhide (built-ins).
          const xBtn = document.createElement('button'); xBtn.type = 'button'; xBtn.className = 'tb-chip-x';
          if (isAdded(c.id)) { xBtn.textContent = '×'; xBtn.title = 'Remove this token'; xBtn.addEventListener('click', async () => { await removeAddedCharacter(c.id); if (sel && sel.cast.id === c.id) { sel = null; showEmpty(); } broadcastRoster(); renderPicker(); }); }
          else if (c.hidden) { xBtn.textContent = '↺'; xBtn.title = 'Unhide'; xBtn.addEventListener('click', async () => { await setHidden(c.id, false); broadcastRoster(); renderPicker(); }); }
          else { xBtn.textContent = '⦸'; xBtn.title = 'Hide from the roster'; xBtn.addEventListener('click', async () => { await setHidden(c.id, true); broadcastRoster(); renderPicker(); }); }
          chip.append(selBtn, xBtn);
          glist.append(chip);
        }
        group.append(glist); list.append(group);
      }
    }

    // ---- Crop drag: move the portrait within the ring to center the face ----
    let dragging = false, startPt = null, startFace = null;
    crop.addEventListener('pointerdown', (e) => {
      if (!draft || !draft.tokenImage) return;
      dragging = true; startPt = { x: e.clientX, y: e.clientY }; startFace = parseFace(draft.face);
      try { crop.setPointerCapture(e.pointerId); } catch (_) {}
      crop.classList.add('is-dragging'); e.preventDefault();
    });
    crop.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const r = crop.getBoundingClientRect();
      const dx = (e.clientX - startPt.x) / (r.width || 1) * 100;
      const dy = (e.clientY - startPt.y) / (r.height || 1) * 100;
      draft.face = fmtFace({ x: startFace.x - dx, y: startFace.y - dy });
      cropImg.style.objectPosition = draft.face;
      renderSample(); markDirty();
    });
    const endDrag = (e) => { if (!dragging) return; dragging = false; crop.classList.remove('is-dragging'); try { crop.releasePointerCapture(e.pointerId); } catch (_) {} };
    crop.addEventListener('pointerup', endDrag);
    crop.addEventListener('pointercancel', endDrag);
    // Zoom the token image (1..3). Previews live; saved with the token.
    if (cropZoom) cropZoom.addEventListener('input', () => { if (!draft) return; draft.faceZoom = +cropZoom.value || 1; cropImg.style.transformOrigin = draft.face; cropImg.style.transform = 'scale(' + draft.faceZoom + ')'; renderSample(); markDirty(); });

    // ---- Upload a new token image (needs the helper server) ----
    uploadBtn.addEventListener('click', () => uploadInput.click());
    uploadInput.addEventListener('change', async () => {
      const file = uploadInput.files && uploadInput.files[0];
      uploadInput.value = '';
      if (!file || !sel) return;
      uploadStatus.hidden = false; uploadStatus.textContent = 'Uploading…';
      try {
        const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
        const resp = await fetch('/upload-token-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, dataUrl }) });
        const j = await resp.json().catch(() => ({}));
        if (resp.ok && j.src) {
          if (!extraImages.some((x) => x.src === j.src)) extraImages.unshift({ src: j.src, name: file.name });
          draft.tokenImage = j.src; markDirty(); renderCrop(); renderSample(); renderImageGrid();
          uploadStatus.textContent = 'Uploaded ✓';
        } else { uploadStatus.textContent = 'Upload failed' + (j.error ? ': ' + j.error : ''); }
      } catch (e) { uploadStatus.textContent = 'Upload needs the local server running'; }
      setTimeout(() => { uploadStatus.hidden = true; }, 3000);
    });

    // ---- Global settings inputs (live on input, persist + broadcast on change) ----
    nameSize.addEventListener('input', () => { gd.nameSize = +nameSize.value; applyGlobalLive(); });
    nameSize.addEventListener('change', persistGlobal);
    nameSpacing.addEventListener('input', () => { gd.nameSpacing = +nameSpacing.value; applyGlobalLive(); });
    nameSpacing.addEventListener('change', persistGlobal);
    condSize.addEventListener('input', () => { gd.condSize = +condSize.value; applyGlobalLive(); });
    condSize.addEventListener('change', persistGlobal);
    condSpacing.addEventListener('input', () => { gd.condSpacing = +condSpacing.value; applyGlobalLive(); });
    condSpacing.addEventListener('change', persistGlobal);
    condPosSlider.addEventListener('input', () => { gd.condPosY = +condPosSlider.value; applyGlobalLive(); });
    condPosSlider.addEventListener('change', persistGlobal);
    condCurve.addEventListener('input', () => { gd.condCurve = +condCurve.value; applyGlobalLive(); });
    condCurve.addEventListener('change', persistGlobal);
    condColor.addEventListener('input', () => { gd.condColor = condColor.value; applyGlobalLive(); });
    condColor.addEventListener('change', persistGlobal);
    condOutline.addEventListener('input', () => { gd.condOutline = condOutline.value; applyGlobalLive(); });
    condOutline.addEventListener('change', persistGlobal);
    hpPos.addEventListener('input', () => { gd.hpPos = +hpPos.value; applyGlobalLive(); });
    hpPos.addEventListener('change', persistGlobal);

    // ---- Save / Reset (per-token identity: image, crop, ring) ----
    function repaintBoards() {
      const scene = sceneById(state.sceneId);
      try { previewView.render(state, scene, {}); } catch (_) {}
      try { boardView.render(state, scene, {}); boardView.layoutTokens(); } catch (_) {}
    }
    q('.tb-save').addEventListener('click', async () => {
      if (!sel) return;
      const patch = { face: draft.face, faceZoom: draft.faceZoom, ringColor: draft.ringColor };
      if (draft.tokenImage) patch.tokenImage = draft.tokenImage;
      await saveTokenOverride(sel.cast.id, patch);
      sync.post({ type: 'tokens', castId: sel.cast.id, override: overrideFor(sel.cast.id) });
      repaintBoards(); renderPicker();
      savedTag.hidden = false;
    });
    q('.tb-reset').addEventListener('click', async () => {
      if (!sel) return;
      await resetTokenOverride(sel.cast.id);
      sync.post({ type: 'tokens', castId: sel.cast.id, override: null });
      selectChar(sel.cast.id);   // reseed the draft from the restored built-in
      repaintBoards(); renderPicker();
    });

    // ---- Add / remove / hide tokens ----
    q('.tb-new-token').addEventListener('click', () => { q('.tb-add-name').value = ''; addKind = 'hero'; renderSeg('.tb-add-kind', addKind); showAdd(); q('.tb-add-name').focus(); });
    q('.tb-add-kind').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; addKind = b.dataset.v; renderSeg('.tb-add-kind', addKind); });
    q('.tb-add-cancel').addEventListener('click', () => { if (sel) showEdit(); else showEmpty(); });
    q('.tb-add-create').addEventListener('click', async () => {
      const name = q('.tb-add-name').value.trim();
      if (!name) { q('.tb-add-name').focus(); return; }
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'token';
      const id = 'usr_' + slug + '_' + Date.now().toString(36).slice(-4);
      await addCharacter({ id, name, kind: addKind, ringColor: defRing(addKind) });
      broadcastRoster(); renderPicker(); selectChar(id);   // now assign its art + crop
    });
    q('.tb-show-hidden-cb').addEventListener('change', (e) => { showHidden = e.target.checked; renderPicker(); });

    // ---- Open / close ----
    function open() { seedGlobal(); renderGlobalControls(); showHidden = false; q('.tb-show-hidden-cb').checked = false; renderPicker(); if (!sel) showEmpty(); overlay.hidden = false; }
    function close() { overlay.hidden = true; }
    els.tokensBtn.addEventListener('click', open);
    q('.tb-close').addEventListener('click', close);
    q('.tb-backdrop').addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });
  }
}

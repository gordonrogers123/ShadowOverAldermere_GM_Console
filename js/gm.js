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
import { loadState, saveState } from './state.js';
import { createSync } from './sync.js';
import { createStageView } from './stageView.js';
import { ENTER_TRANSITIONS, DEFAULT_ENTER } from './transitions.js';
import { BACKGROUNDS, CHARACTERS } from '../data/manifest.js';
import { CAST } from '../data/cast.js';

export function mountGm(root) {
  let state = loadState();
  let draft = null;                 // the in-progress scene while building
  let mapMode = false;              // map mode replaces the live panel for token play
  let tokenSeq = 0;                 // monotonic source of unique token instIds
  let backgrounds = BACKGROUNDS.slice();   // mutable so Rescan can replace them
  let characters = CHARACTERS.slice();

  root.innerHTML = `
    <header class="gm-header">
      <h1 class="gm-title">Aldermere GM Console</h1>
      <div class="gm-header-actions">
        <button class="gm-button rescan" type="button">Rescan assets</button>
        <a class="gm-button gm-open" href="?view=player" target="aldermere-player" rel="noopener">Open Player window</a>
      </div>
    </header>

    <div class="gm-main">
      <aside class="gm-scenes">
        <div class="gm-scenes-head">
          <h2 class="gm-h2">Scenes</h2>
          <button class="gm-button new-scene" type="button">New scene</button>
        </div>
        <ul class="scene-list"></ul>
        <p class="rescan-status" hidden></p>
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

        <div class="gm-controls" hidden>
          <div class="control-row">
            <button class="gm-button vis-toggle" type="button">Hide scene</button>
            <button class="gm-button map-mode-btn" type="button">Map mode</button>
            <button class="gm-button edit-scene" type="button">Edit in builder</button>
          </div>
          <div class="control-row variant-row">
            <span class="control-label">Background</span>
            <div class="variant-buttons"></div>
          </div>
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

        <div class="gm-notes" hidden>
          <h3 class="gm-h3">GM notes</h3>
          <p class="notes-body"></p>
        </div>

        <div class="gm-builder" hidden>
          <h3 class="gm-h3 builder-title">Build a scene</h3>

          <label class="field">
            <span>Name</span>
            <input class="b-name" type="text" placeholder="A Word at the Gate">
          </label>

          <div class="field">
            <span>Background variants <small>(the first one is shown first)</small></span>
            <div class="variant-list"></div>
            <button class="gm-button add-variant" type="button">Add variant</button>
          </div>

          <div class="field char-field">
            <span>Left character</span>
            <select class="b-left-src"></select>
            <select class="b-left-enter"></select>
          </div>
          <div class="field char-field">
            <span>Right character</span>
            <select class="b-right-src"></select>
            <select class="b-right-enter"></select>
          </div>

          <div class="field">
            <span>Roster <small>(who can be placed on the map)</small></span>
            <div class="roster-pick">
              <div class="roster-group">
                <span class="roster-group-label">Heroes</span>
                <div class="roster-heroes"></div>
              </div>
              <div class="roster-group">
                <span class="roster-group-label">Enemies</span>
                <div class="roster-enemies"></div>
              </div>
            </div>
          </div>

          <label class="field">
            <span>GM notes</span>
            <textarea class="b-notes" rows="2"></textarea>
          </label>

          <div class="builder-actions">
            <button class="gm-button b-save" type="button">Save scene</button>
            <button class="gm-button b-export" type="button">Export</button>
            <button class="gm-button b-cancel" type="button">Cancel</button>
          </div>
          <p class="b-export-hint" hidden>Copy this into the SCENES array in data/scenes.js to commit or share it.</p>
          <textarea class="b-export-out" hidden readonly rows="8"></textarea>
        </div>

        <div class="gm-mapmode" hidden>
          <div class="mapmode-head">
            <h3 class="gm-h3 mapmode-title"></h3>
            <div class="mapmode-head-actions">
              <button class="gm-button mm-vis" type="button">Hide scene</button>
              <button class="gm-button mm-exit" type="button">Exit map mode</button>
            </div>
          </div>
          <div class="mapmode-board"></div>
          <div class="mapmode-cols">
            <div class="mapmode-tray">
              <h4 class="mapmode-h4">Roster</h4>
              <div class="tray-group">
                <span class="tray-label">Heroes</span>
                <div class="tray-heroes"></div>
              </div>
              <div class="tray-group">
                <span class="tray-label">Enemies</span>
                <div class="tray-enemies"></div>
              </div>
              <p class="tray-empty" hidden>No roster set. Edit the scene to choose heroes and enemies.</p>
            </div>
            <div class="mapmode-onboard">
              <h4 class="mapmode-h4">On the board</h4>
              <ul class="onboard-list"></ul>
              <p class="onboard-empty">Nothing placed yet. Add tokens from the roster.</p>
            </div>
          </div>
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
    bRightSrc:    root.querySelector('.b-right-src'),
    bRightEnter:  root.querySelector('.b-right-enter'),
    bNotes:       root.querySelector('.b-notes'),
    bSave:        root.querySelector('.b-save'),
    bExport:      root.querySelector('.b-export'),
    bCancel:      root.querySelector('.b-cancel'),
    bExportHint:  root.querySelector('.b-export-hint'),
    bExportOut:   root.querySelector('.b-export-out'),
    mapModeBtn:   root.querySelector('.map-mode-btn'),
    mapmode:      root.querySelector('.gm-mapmode'),
    mapboard:     root.querySelector('.mapmode-board'),
    mapmodeTitle: root.querySelector('.mapmode-title'),
    mmVis:        root.querySelector('.mm-vis'),
    mmExit:       root.querySelector('.mm-exit'),
    trayHeroes:   root.querySelector('.tray-heroes'),
    trayEnemies:  root.querySelector('.tray-enemies'),
    trayEmpty:    root.querySelector('.tray-empty'),
    onboardList:  root.querySelector('.onboard-list'),
    onboardEmpty: root.querySelector('.onboard-empty'),
    rosterHeroes: root.querySelector('.roster-heroes'),
    rosterEnemies: root.querySelector('.roster-enemies'),
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
  function selectScene(id) {
    const scene = sceneById(id);
    if (!scene) return;
    draft = null;
    state.sceneId = id;
    const keys = scene.maps ? Object.keys(scene.maps) : [];
    const def = scene.defaultMapState;
    state.mapState = (def && scene.maps && scene.maps[def]) ? def : (keys[0] || 'hidden');
    const d = scene.defaults || {};
    const hasLeft = !!(scene.characters && scene.characters.left);
    const hasRight = !!(scene.characters && scene.characters.right);
    state.stage = {
      visible: d.visible !== false,
      left:  { shown: d.leftShown  != null ? !!d.leftShown  : hasLeft,  srcOverride: null },
      right: { shown: d.rightShown != null ? !!d.rightShown : hasRight, srcOverride: null },
      tokens: []                       // a fresh board per scene selection
    };
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
    if (src) { state.stage[side].srcOverride = src; state.stage[side].shown = true; }
    else { state.stage[side].srcOverride = null; }
    commit();
  }
  function resetSide(side) { state.stage[side].srcOverride = null; commit(); }

  els.visToggle.addEventListener('click', toggleVisible);
  els.editScene.addEventListener('click', () => openBuilder(sceneById(state.sceneId)));
  els.mapModeBtn.addEventListener('click', enterMapMode);
  els.mmExit.addEventListener('click', exitMapMode);
  els.mmVis.addEventListener('click', toggleVisible);
  for (const side of ['left', 'right']) {
    els.charToggle[side].addEventListener('click', () => toggleSide(side));
    els.charReset[side].addEventListener('click', () => resetSide(side));
    els.charSwap[side].addEventListener('change', () => swapSide(side, els.charSwap[side].value));
  }

  function renderVariantButtons(scene) {
    els.variantButtons.innerHTML = '';
    const keys = scene.maps ? Object.keys(scene.maps) : [];
    for (const key of keys) {
      const btn = document.createElement('button');
      btn.className = 'gm-button variant-button';
      btn.type = 'button';
      btn.textContent = humanize(key);
      btn.classList.toggle('active', key === state.mapState);
      btn.addEventListener('click', () => setVariant(key));
      els.variantButtons.appendChild(btn);
    }
    els.variantRow.hidden = keys.length <= 1;
  }

  function fillCharSelect(sel, value, withDefaultLabel) {
    sel.innerHTML = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = withDefaultLabel ? 'Scene default' : 'None';
    sel.appendChild(first);
    for (const c of characters) {
      const o = document.createElement('option');
      o.value = c.src;
      o.textContent = c.name;
      sel.appendChild(o);
    }
    sel.value = value || '';
  }

  function renderLive(scene) {
    previewView.render(state, scene, { instant: true });
    els.previewName.textContent = scene.name;

    const keys = scene.maps ? Object.keys(scene.maps) : [];
    els.badge.textContent = humanize(state.mapState);
    els.badge.classList.toggle('badge-revealed', keys.length > 1 && state.mapState !== keys[0]);

    els.visToggle.textContent = state.stage.visible === false ? 'Show scene' : 'Hide scene';
    renderVariantButtons(scene);

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
    if (!state.stage) state.stage = { visible: true, left: { shown: false, srcOverride: null }, right: { shown: false, srcOverride: null }, tokens: [] };
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

  function enterMapMode() { if (sceneHasMap(sceneById(state.sceneId))) { mapMode = true; renderUI(); } }
  function exitMapMode() { mapMode = false; renderUI(); }

  function renderTray(scene) {
    const roster = scene.tokens || {};
    const heroes = Array.isArray(roster.heroes) ? roster.heroes : [];
    const enemies = Array.isArray(roster.enemies) ? roster.enemies : [];
    const placed = (state.stage && state.stage.tokens) || [];
    const build = (container, ids, kind) => {
      container.innerHTML = '';
      for (const id of ids) {
        const cast = castEntry(id, kind);
        if (!cast) continue;
        const row = document.createElement('div');
        row.className = 'tray-item';
        const sw = document.createElement('span');
        sw.className = 'roster-swatch';
        sw.style.background = cast.ringColor || '#888';
        const nm = document.createElement('span');
        nm.className = 'tray-name';
        nm.textContent = cast.name;
        const add = document.createElement('button');
        add.className = 'gm-button tray-add';
        add.type = 'button';
        if (kind === 'hero' && placed.some((t) => t.kind === 'hero' && t.castId === id)) {
          add.textContent = 'On board';
          add.disabled = true;
        } else {
          add.textContent = 'Add';
          add.addEventListener('click', () => addToken(id, kind));
        }
        row.append(sw, nm, add);
        container.appendChild(row);
      }
    };
    build(els.trayHeroes, heroes, 'hero');
    build(els.trayEnemies, enemies, 'enemy');
    els.trayEmpty.hidden = (heroes.length + enemies.length) > 0;
  }

  function renderOnboard() {
    const tokens = (state.stage && state.stage.tokens) || [];
    els.onboardList.innerHTML = '';
    els.onboardEmpty.hidden = tokens.length > 0;
    for (const t of tokens) {
      const li = document.createElement('li');
      li.className = 'onboard-item';
      const sw = document.createElement('span');
      sw.className = 'roster-swatch';
      const cast = castEntry(t.castId, t.kind);
      sw.style.background = (cast && cast.ringColor) || '#888';
      const nm = document.createElement('span');
      nm.className = 'onboard-name';
      nm.textContent = t.label;
      if (t.visible === false) nm.classList.add('is-hidden-name');
      const vis = document.createElement('button');
      vis.className = 'gm-button onboard-vis';
      vis.type = 'button';
      vis.textContent = t.visible === false ? 'Reveal' : 'Hide';
      vis.addEventListener('click', () => toggleTokenVisible(t.instId));
      const rm = document.createElement('button');
      rm.className = 'onboard-del';
      rm.type = 'button';
      rm.textContent = '×';
      rm.title = 'Remove from board';
      rm.addEventListener('click', () => removeToken(t.instId));
      li.append(sw, nm, vis, rm);
      els.onboardList.appendChild(li);
    }
  }

  function renderMapMode(scene) {
    els.mapmodeTitle.textContent = scene.name;
    els.mmVis.textContent = state.stage.visible === false ? 'Show scene' : 'Hide scene';
    boardView.render(state, scene, { instant: true });
    boardView.layoutTokens();          // the board was just unhidden; re-pin now
    renderTray(scene);
    renderOnboard();
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
      variants: [{ key: 'revealed', src: (backgrounds[0] && backgrounds[0].src) || '' }],
      left:  { src: '', enter: DEFAULT_ENTER },
      right: { src: '', enter: DEFAULT_ENTER },
      roster: { heroes: [], enemies: [] }
    };
  }
  function sceneToDraft(scene) {
    const variants = Object.entries(scene.maps || {}).map(([key, src]) => ({ key, src }));
    if (!variants.length) variants.push({ key: 'revealed', src: '' });
    const sideOf = (s) => (s ? { src: s.src || '', enter: s.enter || DEFAULT_ENTER } : { src: '', enter: DEFAULT_ENTER });
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
      }
    };
  }

  function draftToScene(d) {
    const maps = {};
    d.variants.forEach((v, i) => {
      if (!v.src) return;
      let base = slug(v.key) || ('variant-' + (i + 1));
      let key = base; let n = 2;
      while (Object.prototype.hasOwnProperty.call(maps, key)) { key = base + '-' + n; n += 1; }
      maps[key] = v.src;
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
      audio: null,
      gmNotes: (d.gmNotes || '').trim()
    };
    const chars = {};
    if (d.left.src)  chars.left  = { id: charIdOf(d.left.src),  src: d.left.src,  enter: d.left.enter };
    if (d.right.src) chars.right = { id: charIdOf(d.right.src), src: d.right.src, enter: d.right.enter };
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
      for (const b of backgrounds) {
        const o = document.createElement('option');
        o.value = b.src;
        o.textContent = b.name;
        sel.appendChild(o);
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
    renderRosterPick();
    els.bExportOut.hidden = true;
    els.bExportHint.hidden = true;
  }

  // Roster checkboxes from CAST; toggling one edits draft.roster in place.
  // No preview refresh -- the roster does not change the composited image.
  function renderRosterPick() {
    const build = (container, list, selected) => {
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
        });
        const sw = document.createElement('span');
        sw.className = 'roster-swatch';
        sw.style.background = c.ringColor || '#888';
        const nm = document.createElement('span');
        nm.textContent = c.name;
        lab.append(cb, sw, nm);
        container.appendChild(lab);
      }
    };
    build(els.rosterHeroes, CAST.heroes || [], draft.roster.heroes);
    build(els.rosterEnemies, CAST.enemies || [], draft.roster.enemies);
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
    previewView.render(pstate, scene, { instant: true });
    els.previewName.textContent = scene.name || 'New scene';
    els.badge.textContent = humanize(firstKey);
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
  els.bCancel.addEventListener('click', closeBuilder);
  els.newScene.addEventListener('click', () => openBuilder(null));

  els.bSave.addEventListener('click', () => {
    if (!draft) return;
    if (!draft.name.trim()) { setStatus('Name the scene before saving.'); els.bName.focus(); return; }
    const scene = draftToScene(draft);
    addUserScene(scene);
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
    els.bExportOut.focus();
    els.bExportOut.select();
  });

  // ============================================================
  //  Scene list + Rescan
  // ============================================================
  function rebuildSceneList() {
    els.sceneList.innerHTML = '';
    for (const scene of allScenes()) {
      const li = document.createElement('li');
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
        del.addEventListener('click', (e) => { e.stopPropagation(); deleteScene(scene.id); });
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
    if (state.sceneId === id) {
      state.sceneId = null;
      state.stage = { visible: true, left: { shown: false, srcOverride: null }, right: { shown: false, srcOverride: null }, tokens: [] };
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
      if (draft) renderBuilderInputs();
      const scene = sceneById(state.sceneId);
      if (scene && !draft) renderLive(scene);
      setStatus('Rescanned: ' + backgrounds.length + ' backgrounds, ' + characters.length + ' characters.');
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
    els.controls.hidden = inMap || building || !scene;
    els.notes.hidden = inMap || building || !scene;
    els.builder.hidden = !building;
    els.mapmode.hidden = !inMap;

    if (inMap) renderMapMode(scene);
    else if (building) renderBuilderPreview();
    else if (scene) renderLive(scene);

    // The Map mode entry button only makes sense for a scene with a map.
    els.mapModeBtn.hidden = !(scene && sceneHasMap(scene));
  }

  // First paint, and a broadcast so a Player window already waiting updates.
  seedTokenSeq();
  rebuildSceneList();
  renderUI();
  broadcast();
}

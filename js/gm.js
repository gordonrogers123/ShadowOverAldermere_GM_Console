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

export function mountGm(root) {
  let state = loadState();
  let draft = null;                 // the in-progress scene while building
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
      right: { shown: d.rightShown != null ? !!d.rightShown : hasRight, srcOverride: null }
    };
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
  //  Scene builder
  // ============================================================
  function blankDraft() {
    return {
      editingId: null,
      name: '',
      gmNotes: '',
      variants: [{ key: 'revealed', src: (backgrounds[0] && backgrounds[0].src) || '' }],
      left:  { src: '', enter: DEFAULT_ENTER },
      right: { src: '', enter: DEFAULT_ENTER }
    };
  }
  function sceneToDraft(scene) {
    const variants = Object.entries(scene.maps || {}).map(([key, src]) => ({ key, src }));
    if (!variants.length) variants.push({ key: 'revealed', src: '' });
    const sideOf = (s) => (s ? { src: s.src || '', enter: s.enter || DEFAULT_ENTER } : { src: '', enter: DEFAULT_ENTER });
    return {
      editingId: scene.id,
      name: scene.name || '',
      gmNotes: scene.gmNotes || '',
      variants,
      left:  sideOf(scene.characters && scene.characters.left),
      right: sideOf(scene.characters && scene.characters.right)
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
    const scene = {
      id,
      name: (d.name || '').trim() || humanize(id),
      maps,
      defaultMapState: keys[0] || 'revealed',
      tokens: null,
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
    els.bExportOut.hidden = true;
    els.bExportHint.hidden = true;
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
      state.stage = { visible: true, left: { shown: false, srcOverride: null }, right: { shown: false, srcOverride: null } };
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

    els.empty.hidden = building || !!scene;
    els.preview.hidden = !(building || scene);
    els.controls.hidden = building || !scene;
    els.notes.hidden = building || !scene;
    els.builder.hidden = !building;

    if (building) renderBuilderPreview();
    else if (scene) renderLive(scene);
  }

  // First paint, and a broadcast so a Player window already waiting updates.
  rebuildSceneList();
  renderUI();
  broadcast();
}

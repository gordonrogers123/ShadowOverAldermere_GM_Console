// ============================================================
//  gm.js  --  the laptop control surface
// ------------------------------------------------------------
//  The GM window is the source of truth. It renders the scene list
//  from the data file, lets the GM pick a scene and toggle the
//  hidden/revealed map, saves state to localStorage, and broadcasts
//  every change to the Player window.
//
//  GM-only content (the notes, the scene internals) lives here and
//  is never sent to or shown on the Player window.
// ============================================================

import { SCENES } from '../data/scenes.js';
import { loadState, saveState } from './state.js';
import { createSync } from './sync.js';

export function mountGm(root) {
  let state = loadState();

  root.innerHTML = `
    <header class="gm-header">
      <h1 class="gm-title">Aldermere GM Console</h1>
      <a class="gm-button gm-open" href="?view=player" target="aldermere-player" rel="noopener">
        Open Player window
      </a>
    </header>

    <div class="gm-main">
      <aside class="gm-scenes">
        <h2 class="gm-h2">Scenes</h2>
        <ul class="scene-list"></ul>
      </aside>

      <section class="gm-stage">
        <p class="gm-empty">Pick a scene to begin.</p>

        <figure class="gm-preview" hidden>
          <div class="preview-frame"></div>
          <figcaption class="preview-cap">
            <span class="preview-name"></span>
            <span class="badge"></span>
          </figcaption>
        </figure>

        <div class="gm-controls" hidden>
          <button class="gm-button toggle">Reveal map</button>
        </div>

        <div class="gm-notes" hidden>
          <h3 class="gm-h3">GM notes</h3>
          <p class="notes-body"></p>
        </div>
      </section>
    </div>
  `;

  // Element references.
  const els = {
    sceneList:   root.querySelector('.scene-list'),
    empty:       root.querySelector('.gm-empty'),
    preview:     root.querySelector('.gm-preview'),
    previewFrame:root.querySelector('.preview-frame'),
    previewName: root.querySelector('.preview-name'),
    badge:       root.querySelector('.badge'),
    controls:    root.querySelector('.gm-controls'),
    toggle:      root.querySelector('.toggle'),
    notes:       root.querySelector('.gm-notes'),
    notesBody:   root.querySelector('.notes-body')
  };

  // ---- Sync: source of truth broadcasts state; replies to a Player hello.
  const sync = createSync((msg) => {
    if (msg && msg.type === 'hello') broadcast();
  });
  function broadcast() {
    sync.post({ type: 'state', state });
  }

  // ---- Mutations all funnel through commit(): save, broadcast, redraw.
  function commit() {
    saveState(state);
    broadcast();
    renderUI();
  }

  function selectScene(id) {
    const scene = SCENES.find((s) => s.id === id);
    if (!scene) return;
    state.sceneId = id;
    state.mapState = scene.defaultMapState === 'revealed' ? 'revealed' : 'hidden';
    commit();
  }

  function toggleMap() {
    state.mapState = state.mapState === 'hidden' ? 'revealed' : 'hidden';
    commit();
  }

  els.toggle.addEventListener('click', toggleMap);

  // ---- Build the scene list once (data drives it; add a scene in the
  //      data file and it appears here on reload, no code change).
  for (const scene of SCENES) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'scene-button';
    btn.dataset.id = scene.id;
    btn.textContent = scene.name;
    btn.addEventListener('click', () => selectScene(scene.id));
    li.appendChild(btn);
    els.sceneList.appendChild(li);
  }

  function mapSrc(scene, mapState) {
    return scene && scene.maps ? scene.maps[mapState] : null;
  }

  function previewPlate(label) {
    const plate = document.createElement('div');
    plate.className = 'preview-plate';
    plate.textContent = label + ' (not yet revealed)';
    return plate;
  }

  function renderPreview(scene) {
    els.previewFrame.innerHTML = '';
    const src = mapSrc(scene, state.mapState);
    if (src) {
      const img = document.createElement('img');
      img.className = 'preview-img';
      img.alt = '';
      img.onerror = () => {
        els.previewFrame.innerHTML = '';
        els.previewFrame.appendChild(previewPlate(scene.name));
      };
      img.src = src;
      els.previewFrame.appendChild(img);
    } else {
      els.previewFrame.appendChild(previewPlate(scene.name));
    }
  }

  function renderUI() {
    // Highlight the active scene button.
    els.sceneList.querySelectorAll('.scene-button').forEach((b) => {
      b.classList.toggle('active', b.dataset.id === state.sceneId);
    });

    const scene = SCENES.find((s) => s.id === state.sceneId) || null;

    if (!scene) {
      els.empty.hidden = false;
      els.preview.hidden = true;
      els.controls.hidden = true;
      els.notes.hidden = true;
      return;
    }

    els.empty.hidden = true;
    els.preview.hidden = false;
    els.controls.hidden = false;
    els.notes.hidden = false;

    renderPreview(scene);
    els.previewName.textContent = scene.name;

    const revealed = state.mapState === 'revealed';
    els.badge.textContent = revealed ? 'Revealed' : 'Hidden';
    els.badge.classList.toggle('badge-revealed', revealed);
    els.toggle.textContent = revealed ? 'Hide map' : 'Reveal map';

    els.notesBody.textContent = scene.gmNotes || '';
  }

  // First paint, and a broadcast so a Player window already waiting updates.
  renderUI();
  broadcast();
}

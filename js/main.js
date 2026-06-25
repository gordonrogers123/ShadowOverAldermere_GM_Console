// ============================================================
//  main.js  --  entry point and view router
// ------------------------------------------------------------
//  One app, two views, chosen by a URL parameter:
//    ?view=gm      the laptop control surface
//    ?view=player  the TV output (pure renderer, no controls)
//  Anything else shows a small chooser with links to both.
// ============================================================

const params = new URLSearchParams(location.search);
const view = params.get('view');
const app = document.getElementById('app');

if (view === 'gm') {
  document.body.classList.add('view-gm');
  const { mountGm } = await import('./gm.js');
  mountGm(app);
} else if (view === 'player') {
  document.body.classList.add('view-player');
  const { mountPlayer } = await import('./player.js');
  mountPlayer(app);
} else {
  document.body.classList.add('view-chooser');
  renderChooser(app);
}

function renderChooser(root) {
  root.innerHTML = `
    <div class="chooser">
      <h1 class="chooser-title">Aldermere GM Console</h1>
      <p class="chooser-sub">Open each view in its own window.</p>
      <div class="chooser-links">
        <a class="chooser-link" href="?view=gm">GM Control</a>
        <a class="chooser-link" href="?view=player">Player Screen</a>
      </div>
      <p class="chooser-hint">Put the Player window on the TV and fullscreen it.</p>
    </div>
  `;
}

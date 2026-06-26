// ============================================================
//  diceRoller.js  --  GM-only dice tray (lower-left of the console)
// ------------------------------------------------------------
//  A compact, styled roller in the spirit of D&D Beyond: tap polyhedral
//  dice to set how many of each (the count shows ON the die), Roll, and
//  read a clear result -- the per-die breakdown and a big total, with a
//  crit highlight on a d20. No modifier, no history: just dice + result.
//
//  Local UI only -- it lives in the GM window and broadcasts nothing to
//  the Player TV (no dice on the board, by design).
// ============================================================

const DICE = [4, 6, 8, 10, 12, 20, 100];

// Flat polyhedral silhouettes (viewBox 0 0 48 48). The die TYPE reads from the
// shape + its caption; the COUNT renders as a number over the die.
const SHAPES = {
  4:   '<polygon points="24,5 43,41 5,41"/>',
  6:   '<rect x="9" y="9" width="30" height="30" rx="5"/>',
  8:   '<polygon points="24,4 44,24 24,44 4,24"/>',
  10:  '<polygon points="24,44 5,18 14,5 34,5 43,18"/>',
  12:  '<polygon points="24,4 43,18 35,42 13,42 5,18"/>',
  20:  '<polygon points="24,4 42,14 42,34 24,44 6,34 6,14"/><polygon class="facet" points="24,4 42,34 6,34"/>',
  100: '<polygon points="24,4 42,14 42,34 24,44 6,34 6,14"/><polygon class="facet" points="6,14 42,14 24,44"/>'
};
const dieSvg = (d) => `<svg viewBox="0 0 48 48" aria-hidden="true">${SHAPES[d]}</svg>`;
const dieLabel = (d) => 'd' + d;

export function mountDiceRoller(root) {
  const host = document.createElement('div');
  host.className = 'dice-roller';
  host.innerHTML = `
    <button class="dice-launcher" type="button" aria-label="Dice roller" aria-expanded="false" title="Dice roller">
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <polygon points="24,3 43,14 43,34 24,45 5,34 5,14"/>
        <polygon class="facet" points="24,3 43,34 5,34"/>
        <text x="24" y="30" text-anchor="middle">20</text>
      </svg>
    </button>
    <div class="dice-panel" hidden>
      <div class="dice-head">
        <span class="dice-title">Dice</span>
        <button class="dice-close" type="button" aria-label="Close dice roller">&times;</button>
      </div>
      <div class="dice-tray"></div>
      <div class="dice-actions">
        <button class="dice-roll" type="button">Roll</button>
        <button class="dice-clear" type="button">Clear</button>
      </div>
      <div class="dice-result" hidden></div>
      <p class="dice-hint">Tap to add &middot; right-click to remove</p>
    </div>`;
  root.appendChild(host);

  const q = (s) => host.querySelector(s);
  const launcher = q('.dice-launcher');
  const panel = q('.dice-panel');
  const tray = q('.dice-tray');
  const resultEl = q('.dice-result');

  const counts = {};      // sides -> count
  const dieEls = {};

  for (const d of DICE) {
    const die = document.createElement('button');
    die.className = 'die';
    die.type = 'button';
    die.dataset.d = String(d);
    die.setAttribute('aria-label', dieLabel(d));
    die.innerHTML =
      '<span class="die-shape">' + dieSvg(d) + '</span>' +
      '<span class="die-count" hidden></span>' +
      '<span class="die-label">' + dieLabel(d) + '</span>';
    die.addEventListener('click', () => bump(d, +1));
    die.addEventListener('contextmenu', (e) => { e.preventDefault(); bump(d, -1); });
    tray.appendChild(die);
    dieEls[d] = die;
  }

  function bump(d, by) {
    const c = Math.max(0, (counts[d] || 0) + by);
    counts[d] = c;
    const die = dieEls[d];
    const badge = die.querySelector('.die-count');
    badge.hidden = c === 0;
    badge.textContent = c ? String(c) : '';
    die.classList.toggle('is-selected', c > 0);
  }

  function clearAll() {
    for (const d of DICE) if (counts[d]) bump(d, -counts[d]);
  }

  function roll() {
    const active = DICE.filter((d) => counts[d]);
    if (!active.length) return;
    const flat = [];   // { d, r } per individual die, in tray order
    let total = 0;
    for (const d of active) {
      for (let i = 0; i < counts[d]; i++) {
        const r = Math.floor(Math.random() * d) + 1;   // browser RNG -- fine for dice
        flat.push({ d, r });
        total += r;
      }
    }
    const notation = active.map((d) => counts[d] + 'd' + d).join(' + ');
    renderResult(flat, total, notation);
  }

  function renderResult(flat, total, notation) {
    resultEl.hidden = false;
    resultEl.innerHTML = '';

    const dismiss = document.createElement('button');
    dismiss.className = 'dr-dismiss';
    dismiss.type = 'button';
    dismiss.textContent = '×';
    dismiss.title = 'Dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss result');
    dismiss.addEventListener('click', () => { resultEl.hidden = true; });

    const note = document.createElement('div');
    note.className = 'dr-notation';
    note.textContent = notation;

    const math = document.createElement('div');
    math.className = 'dr-math';
    const breakdown = document.createElement('span');
    breakdown.className = 'dr-breakdown';
    flat.forEach((x, i) => {
      if (i) {
        const plus = document.createElement('span');
        plus.className = 'dr-plus';
        plus.textContent = ' + ';
        breakdown.appendChild(plus);
      }
      const v = document.createElement('span');
      v.className = 'dr-die';
      if (x.d === 20 && x.r === 20) v.classList.add('is-crit');     // nat 20
      if (x.d === 20 && x.r === 1) v.classList.add('is-fumble');    // nat 1
      v.textContent = String(x.r);
      v.title = 'd' + x.d;
      breakdown.appendChild(v);
    });
    const eq = document.createElement('span');
    eq.className = 'dr-eq';
    eq.textContent = '=';
    const totalEl = document.createElement('span');
    totalEl.className = 'dr-total';
    totalEl.textContent = String(total);
    math.append(breakdown, eq, totalEl);

    resultEl.append(dismiss, note, math);
  }

  function setOpen(open) {
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
    host.classList.toggle('is-open', open);
  }

  launcher.addEventListener('click', () => setOpen(panel.hidden));
  q('.dice-close').addEventListener('click', () => setOpen(false));
  q('.dice-roll').addEventListener('click', roll);
  q('.dice-clear').addEventListener('click', () => { clearAll(); resultEl.hidden = true; });
}

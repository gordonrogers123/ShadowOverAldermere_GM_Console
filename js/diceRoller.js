// ============================================================
//  diceRoller.js  --  a GM-only dice tray (lower-left of the console)
// ------------------------------------------------------------
//  Build a pool of polyhedral dice + a modifier, roll, and read a
//  result card: per-die breakdown, summed total, and a crit highlight
//  on a d20 (nat 20 / nat 1). Keeps a short history; the result stays
//  until you dismiss it.
//
//  Local UI only -- it lives in the GM window and broadcasts nothing to
//  the Player TV (no dice on the board, by design).
// ============================================================

const DICE = [4, 6, 8, 10, 12, 20, 100];
const HISTORY_MAX = 5;

export function mountDiceRoller(root) {
  const host = document.createElement('div');
  host.className = 'dice-roller';
  host.innerHTML = `
    <button class="dice-launcher" type="button" aria-expanded="false" title="Dice roller">
      <span class="dice-launcher-face" aria-hidden="true">&#127922;</span> Dice
    </button>
    <div class="dice-panel" hidden>
      <div class="dice-head">
        <span class="dice-title">Dice roller</span>
        <button class="dice-close" type="button" aria-label="Close dice roller">&times;</button>
      </div>
      <div class="dice-tray"></div>
      <div class="dice-pool"></div>
      <div class="dice-mod-row">
        <span class="dice-mod-label">Modifier</span>
        <button class="dice-mod-dec" type="button" aria-label="Decrease modifier">&minus;</button>
        <span class="dice-mod-val">+0</span>
        <button class="dice-mod-inc" type="button" aria-label="Increase modifier">+</button>
      </div>
      <div class="dice-actions">
        <button class="dice-roll gm-button btn--primary" type="button">Roll</button>
        <button class="dice-clear gm-button btn--quiet" type="button">Clear</button>
      </div>
      <div class="dice-result" hidden></div>
      <div class="dice-history" hidden></div>
    </div>`;
  root.appendChild(host);

  const q = (s) => host.querySelector(s);
  const launcher = q('.dice-launcher');
  const panel = q('.dice-panel');
  const tray = q('.dice-tray');
  const poolEl = q('.dice-pool');
  const modVal = q('.dice-mod-val');
  const resultEl = q('.dice-result');
  const historyEl = q('.dice-history');

  let pool = {};        // sides -> count
  let modifier = 0;
  const history = [];

  for (const d of DICE) {
    const b = document.createElement('button');
    b.className = 'die-btn gm-button';
    b.type = 'button';
    b.dataset.d = String(d);
    b.textContent = 'd' + d;
    b.addEventListener('click', () => { pool[d] = (pool[d] || 0) + 1; renderPool(); });
    tray.appendChild(b);
  }

  function modText(m) { return (m >= 0 ? '+' : '−') + Math.abs(m); }
  function notation() {
    const parts = DICE.filter((d) => pool[d]).map((d) => pool[d] + 'd' + d);
    let n = parts.join(' + ');
    if (modifier) n += ' ' + modText(modifier);
    return n || '—';
  }

  function renderPool() {
    poolEl.innerHTML = '';
    const active = DICE.filter((d) => pool[d]);
    if (!active.length) {
      const e = document.createElement('span');
      e.className = 'dice-pool-empty';
      e.textContent = 'Tap dice above to build a roll';
      poolEl.appendChild(e);
      return;
    }
    for (const d of active) {
      const chip = document.createElement('button');
      chip.className = 'dice-chip gm-button';
      chip.type = 'button';
      chip.textContent = pool[d] + 'd' + d;
      chip.title = 'Remove one d' + d;
      chip.setAttribute('aria-label', 'Remove one d' + d);
      chip.addEventListener('click', () => { pool[d] -= 1; if (pool[d] <= 0) delete pool[d]; renderPool(); });
      poolEl.appendChild(chip);
    }
  }

  function setMod(m) { modifier = m; modVal.textContent = modText(modifier); }

  function roll() {
    const active = DICE.filter((d) => pool[d]);
    if (!active.length) return;
    const groups = [];
    let total = 0;
    for (const d of active) {
      const rolls = [];
      for (let i = 0; i < pool[d]; i++) {
        const r = Math.floor(Math.random() * d) + 1;   // browser RNG -- fine for dice
        rolls.push(r);
        total += r;
      }
      groups.push({ d, rolls });
    }
    total += modifier;
    const entry = { notation: notation(), groups, modifier, total };
    history.unshift(entry);
    if (history.length > HISTORY_MAX) history.pop();
    renderResult(entry);
    renderHistory();
  }

  function renderResult(entry) {
    resultEl.hidden = false;
    resultEl.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'dice-result-head';
    const note = document.createElement('span');
    note.className = 'dice-result-note';
    note.textContent = entry.notation;
    const dismiss = document.createElement('button');
    dismiss.className = 'dice-dismiss';
    dismiss.type = 'button';
    dismiss.textContent = '×';
    dismiss.title = 'Dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss result');
    dismiss.addEventListener('click', () => { resultEl.hidden = true; });
    head.append(note, dismiss);

    const dice = document.createElement('div');
    dice.className = 'dice-result-dice';
    for (const g of entry.groups) {
      for (const r of g.rolls) {
        const face = document.createElement('span');
        face.className = 'die-face';
        if (g.d === 20 && r === 20) face.classList.add('is-crit');     // nat 20
        if (g.d === 20 && r === 1) face.classList.add('is-fumble');    // nat 1
        face.textContent = String(r);
        face.title = 'd' + g.d;
        dice.appendChild(face);
      }
    }

    const totalEl = document.createElement('div');
    totalEl.className = 'dice-total';
    const lab = document.createElement('span');
    lab.className = 'dice-total-label';
    lab.textContent = 'Total';
    const val = document.createElement('span');
    val.className = 'dice-total-val';
    val.textContent = String(entry.total);
    totalEl.append(lab, val);

    resultEl.append(head, dice, totalEl);
  }

  function renderHistory() {
    if (!history.length) { historyEl.hidden = true; return; }
    historyEl.hidden = false;
    historyEl.innerHTML = '';
    const label = document.createElement('div');
    label.className = 'dice-history-label';
    label.textContent = 'Recent';
    historyEl.appendChild(label);
    for (const e of history) {
      const row = document.createElement('div');
      row.className = 'dice-history-row';
      row.textContent = e.notation + ' = ' + e.total;
      historyEl.appendChild(row);
    }
  }

  function setOpen(open) {
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
    host.classList.toggle('is-open', open);
  }

  launcher.addEventListener('click', () => setOpen(panel.hidden));
  q('.dice-close').addEventListener('click', () => setOpen(false));
  q('.dice-mod-dec').addEventListener('click', () => setMod(modifier - 1));
  q('.dice-mod-inc').addEventListener('click', () => setMod(modifier + 1));
  q('.dice-roll').addEventListener('click', roll);
  q('.dice-clear').addEventListener('click', () => { pool = {}; setMod(0); renderPool(); resultEl.hidden = true; });

  renderPool();
}

// ============================================================
//  audioEngine.js  --  the Web Audio driver (shared, state-driven)
// ------------------------------------------------------------
//  Mounted in BOTH windows. Like the stage compositor, it is driven
//  entirely by state: the GM mutates state.audio and broadcasts; each
//  window's engine diffs the incoming state and reconciles its graph.
//  Nothing here is ever put on `state` (AudioContext/buffers are local).
//
//  createAudioEngine({ role, gestureTarget }) -> { sync, unlock, isUnlocked, snapshot }
//    role         'player' | 'gm' -- a track sounds only if state.audio
//                 .outputs[role] is true (so the TV plays the room while the
//                 GM can monitor, selectable), AND this window is unlocked.
//    gestureTarget an element whose first click/tap unlocks the AudioContext
//                 (browsers block audio until a user gesture, per window).
//
//  Per-track graph (built once, tweaked live):
//    BufferSource(loop) -> stereo panner -> track gain -> master gain -> destination
//  One-shot SFX are fired when state.audio.sfxTrigger[id] increases.
// ============================================================

const clamp01 = (n) => { n = +n; return !isFinite(n) ? 0 : n < 0 ? 0 : n > 1 ? 1 : n; };
const clampPan = (n) => { n = +n; return !isFinite(n) ? 0 : n < -1 ? -1 : n > 1 ? 1 : n; };

// A sequenced cue can ask audio to fade over a chosen ramp (state.audio.ramp, in
// ms) so "audio ramps down/up" honours the cue's timing. Map it to a
// setTargetAtTime time-constant (~3*tau to settle). Absent -> the snappy default.
function rampTau(audio) {
  const r = audio && +audio.ramp;
  return (isFinite(r) && r > 0) ? Math.min(2, Math.max(0.005, r / 3000)) : 0.03;
}

// A scene's music as an array of beds, accepting either the new array form or
// a single legacy `{src,...}` object. Lets cues play different music per cue.
function musicBeds(a) {
  if (!a) return [];
  const m = a.music;
  if (Array.isArray(m)) return m.filter((x) => x && x.src);
  return (m && m.src) ? [m] : [];
}

// Which scene track a live track key refers to: 'mus:<i>' (a music bed),
// 'amb:<i>' (an ambience loop), or the legacy 'music' key (-> first bed).
function resolveTrackSrc(scene, key) {
  const a = scene && scene.audio;
  if (!a) return null;
  if (key === 'music') { const beds = musicBeds(a); return beds.length ? beds[0].src : null; }
  if (key.indexOf('mus:') === 0) {
    const i = parseInt(key.slice(4), 10);
    const beds = musicBeds(a);
    return (beds[i] && beds[i].src) || null;
  }
  if (key.indexOf('amb:') === 0) {
    const i = parseInt(key.slice(4), 10);
    return (a.ambience && a.ambience[i] && a.ambience[i].src) || null;
  }
  return null;
}

export function createAudioEngine({ role, gestureTarget } = {}) {
  let ctx = null;
  let masterGain = null;
  let unlocked = false;
  let lastState = null;
  let lastScene = null;
  let currentTau = 0.03;        // gain ramp time-constant; a cue can stretch it

  const live = new Map();       // trackKey -> graph handle (currently sounding)
  const starting = new Set();   // trackKeys mid-decode, to avoid double starts
  const buffers = new Map();    // src -> AudioBuffer | null (null = unavailable)
  const decoding = new Map();   // src -> Promise<AudioBuffer|null>
  const lastSfx = new Map();    // sfxId -> last trigger count fired

  function ensureContext() {
    if (ctx) return ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.8;
      masterGain.connect(ctx.destination);
    } catch (e) { ctx = null; }
    return ctx;
  }

  // Fetch + decode a source once; cache the buffer (or null if missing/garbage)
  // so the engine never throws and never retries a bad file in a tight loop.
  function loadBuffer(src) {
    if (buffers.has(src)) return Promise.resolve(buffers.get(src));
    if (decoding.has(src)) return decoding.get(src);
    const p = fetch(src)
      .then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => { buffers.set(src, buf); decoding.delete(src); return buf; })
      .catch(() => { buffers.set(src, null); decoding.delete(src); return null; });
    decoding.set(src, p);
    return p;
  }

  function buildTrackGraph(buffer, t) {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = t.loop !== false;

    const panner = ctx.createStereoPanner();
    const trackGain = ctx.createGain(); trackGain.gain.value = 0;   // ramp up from silence

    source.connect(panner); panner.connect(trackGain); trackGain.connect(masterGain);

    // A bed can carry its own fade envelope (seconds): a gentle ramp in on start
    // and out on stop, plus a fade-out tail before a NON-looping file ends so it
    // doesn't hard-cut. fadeIn=0 keeps the old behaviour (snap / cue ramp).
    const fadeIn = Math.max(0, +t.fadeIn || 0);
    const fadeOut = Math.max(0, +t.fadeOut || 0);
    let stopped = false;
    let fadeInUntil = 0;   // ctx-time the start fade-in finishes -- update() won't fight it
    let tailFrom = 0;      // ctx-time a non-looping bed begins its end-of-file fade-out

    const targetVol = (tt) => clamp01(tt.muted ? 0 : (tt.volume == null ? 0.8 : tt.volume));

    function start(tt) {
      const now = ctx.currentTime;
      const vol = targetVol(tt);
      panner.pan.value = clampPan(tt.pan);
      source.loop = tt.loop !== false;
      try { source.start(now); } catch (e) {}
      const g = trackGain.gain;
      try {
        g.cancelScheduledValues(now); g.setValueAtTime(0, now);
        if (fadeIn > 0) { g.linearRampToValueAtTime(vol, now + fadeIn); fadeInUntil = now + fadeIn; }
        else { g.setTargetAtTime(vol, now, currentTau); }
        // Non-looping bed with a tail: hold, then ramp to silence as the file ends.
        if (source.loop === false && fadeOut > 0 && buffer.duration > fadeIn + fadeOut) {
          tailFrom = now + buffer.duration - fadeOut;
          g.setValueAtTime(vol, tailFrom);
          g.linearRampToValueAtTime(0, now + buffer.duration);
        }
      } catch (e) {}
    }
    function update(tt, tau) {
      const now = ctx.currentTime;
      panner.pan.setTargetAtTime(clampPan(tt.pan), now, 0.03);
      source.loop = tt.loop !== false;
      // Don't override a scheduled start fade-in / end-of-file fade-out mid-flight.
      if (now < fadeInUntil) return;
      if (tailFrom && now >= tailFrom - 0.05) return;
      // A muted track holds its volume but plays at silence -- the mixer can drop
      // it without stopping the bed (so unmute snaps it back at the same level).
      trackGain.gain.setTargetAtTime(targetVol(tt), now, tau || currentTau);
    }
    function stop() {
      if (stopped) return; stopped = true;
      const now = ctx.currentTime;
      // Fade out over the bed's fadeOut, else over the active cue ramp; hold the
      // source alive long enough for the fade to finish so it is not cut mid-fade.
      const out = fadeOut > 0 ? fadeOut : Math.max(0.15, currentTau * 3);
      try {
        trackGain.gain.cancelScheduledValues(now);
        trackGain.gain.setValueAtTime(Math.max(0.0001, trackGain.gain.value), now);
        trackGain.gain.linearRampToValueAtTime(0, now + out);
      } catch (e) {}
      try { source.stop(now + out + 0.05); } catch (e) {}
      setTimeout(() => { try { source.disconnect(); panner.disconnect(); trackGain.disconnect(); } catch (e) {} }, (out + 0.25) * 1000);
    }
    return { source, start, update, stop };
  }

  function stopTrack(key) {
    const h = live.get(key);
    if (h) { h.stop(); live.delete(key); }
  }
  function stopAll() {
    for (const key of [...live.keys()]) stopTrack(key);
  }

  function fireSfx(sfxId) {
    const scene = lastScene;
    const cfg = scene && scene.audio && (scene.audio.sfx || []).find((s) => s.id === sfxId);
    if (!cfg || !cfg.src) return;
    loadBuffer(cfg.src).then((buf) => {
      if (!buf) return;
      const stillOut = lastState && lastState.audio && lastState.audio.outputs && lastState.audio.outputs[role];
      if (!stillOut || !unlocked) return;
      const t = { volume: cfg.volume == null ? 0.8 : cfg.volume, pan: cfg.pan || 0, loop: false };
      const handle = buildTrackGraph(buf, t);
      handle.update(t, 0.01);   // one-shots hit sharply, never on a cue's slow ramp
      handle.source.onended = () => handle.stop();
      try { handle.source.start(); } catch (e) {}
    });
  }

  // Reconcile the live graph against lastState/lastScene. Idempotent: re-running
  // with the same state is a no-op, so re-broadcasts never double-fire anything.
  function reconcile() {
    if (!ctx || !unlocked || !masterGain) return;
    const state = lastState;
    const scene = lastScene;
    const audio = state && state.audio;
    if (!audio) { stopAll(); return; }

    const outputting = !!(audio.outputs && audio.outputs[role]);
    if (!outputting) { stopAll(); return; }   // this window is silent: no decode/play work
    currentTau = rampTau(audio);   // a cue can stretch how fast gains move this pass
    // masterMuted drops the whole mix to silence (the mixer's Master mute / Fade)
    // while keeping the stored master level for an instant un-mute.
    const effMaster = audio.masterMuted ? 0 : audio.master;
    masterGain.gain.setTargetAtTime(clamp01(effMaster), ctx.currentTime, currentTau);

    const want = new Set();
    for (const [key, t] of Object.entries(audio.tracks || {})) {
      if (!t || !t.playing) continue;
      const src = resolveTrackSrc(scene, key);
      if (!src) continue;
      want.add(key);
      const existing = live.get(key);
      if (existing) {
        existing.update(t);
      } else if (!starting.has(key)) {
        starting.add(key);
        loadBuffer(src).then((buf) => {
          starting.delete(key);
          // Re-check against the LATEST state: still wanted, same src, still output, not already live?
          const a2 = lastState && lastState.audio;
          const t2 = a2 && a2.tracks && a2.tracks[key];
          const out2 = a2 && a2.outputs && a2.outputs[role];
          if (!buf || !t2 || !t2.playing || !out2 || !unlocked || live.has(key)) return;
          if (resolveTrackSrc(lastScene, key) !== src) return;
          const handle = buildTrackGraph(buf, t2);
          live.set(key, handle);
          handle.start(t2);   // begins playback with the bed's fade-in envelope
        });
      }
    }
    for (const key of [...live.keys()]) {
      if (!want.has(key)) stopTrack(key);
    }

    for (const [sfxId, count] of Object.entries(audio.sfxTrigger || {})) {
      const last = lastSfx.get(sfxId) || 0;
      if (count > last) { lastSfx.set(sfxId, count); fireSfx(sfxId); }
    }
  }

  function unlock() {
    ensureContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    unlocked = !!ctx;
    reconcile();
    return unlocked;
  }

  // First user gesture anywhere on the target unlocks audio (Player sound gate
  // calls unlock() directly; the GM unlocks on its first click).
  if (gestureTarget && gestureTarget.addEventListener) {
    const onGesture = () => unlock();
    gestureTarget.addEventListener('click', onGesture, { once: true });
    gestureTarget.addEventListener('touchstart', onGesture, { once: true, passive: true });
  }

  return {
    sync(state, scene) { lastState = state; lastScene = scene; reconcile(); },
    unlock,
    isUnlocked() { return unlocked && !!ctx && ctx.state !== 'closed'; },
    snapshot() {
      const audio = lastState && lastState.audio;
      const outputsActive = !!(audio && audio.outputs && audio.outputs[role]) && unlocked;
      return {
        role,
        unlocked,
        outputsActive,
        master: audio ? audio.master : null,
        masterMuted: !!(audio && audio.masterMuted),
        tracks: [...live.keys()].map((k) => {
          const t = audio && audio.tracks && audio.tracks[k];
          return { key: k, playing: true, volume: t ? t.volume : null, pan: t ? t.pan : null, muted: !!(t && t.muted) };
        }),
        firedSfx: Object.fromEntries(lastSfx)
      };
    }
  };
}

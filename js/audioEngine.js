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
//    BufferSource(loop, detune=pitch)
//      -> lowpass -> highpass -> waveshaper(distortion)
//      -> [ dry + delay-send(->delay+feedback) + reverb-send(->convolver) ] = sum
//      -> stereo panner -> track gain -> master gain -> destination
//  Reverb impulses are synthesised (decaying noise) per preset -- no asset.
//  One-shot SFX are fired when state.audio.sfxTrigger[id] increases.
// ============================================================

import { REVERB_PRESETS } from './audioFx.js';

const clamp01 = (n) => { n = +n; return !isFinite(n) ? 0 : n < 0 ? 0 : n > 1 ? 1 : n; };
const clampPan = (n) => { n = +n; return !isFinite(n) ? 0 : n < -1 ? -1 : n > 1 ? 1 : n; };

// Which scene track a live track key refers to: 'music' or 'amb:<index>'.
function resolveTrackSrc(scene, key) {
  const a = scene && scene.audio;
  if (!a) return null;
  if (key === 'music') return (a.music && a.music.src) || null;
  if (key.indexOf('amb:') === 0) {
    const i = parseInt(key.slice(4), 10);
    return (a.ambience && a.ambience[i] && a.ambience[i].src) || null;
  }
  return null;
}

// Soft-clip waveshaper curve; drive 0 -> ~identity, 1 -> heavy.
function distortionCurve(drive) {
  const k = Math.max(0, drive) * 100;
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = (1 + k) * x / (1 + k * Math.abs(x));
  }
  return curve;
}

export function createAudioEngine({ role, gestureTarget } = {}) {
  let ctx = null;
  let masterGain = null;
  let unlocked = false;
  let lastState = null;
  let lastScene = null;

  const live = new Map();       // trackKey -> graph handle (currently sounding)
  const starting = new Set();   // trackKeys mid-decode, to avoid double starts
  const buffers = new Map();    // src -> AudioBuffer | null (null = unavailable)
  const decoding = new Map();   // src -> Promise<AudioBuffer|null>
  const irCache = new Map();    // reverb preset -> impulse AudioBuffer
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

  function reverbIR(preset) {
    if (irCache.has(preset)) return irCache.get(preset);
    const p = REVERB_PRESETS[preset] || REVERB_PRESETS.hall;
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * p.seconds));
    const ir = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, p.decay);
    }
    irCache.set(preset, ir);
    return ir;
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

    const lowpass = ctx.createBiquadFilter(); lowpass.type = 'lowpass'; lowpass.frequency.value = 20000;
    const highpass = ctx.createBiquadFilter(); highpass.type = 'highpass'; highpass.frequency.value = 20;
    const shaper = ctx.createWaveShaper();
    const dry = ctx.createGain(); dry.gain.value = 1;
    const delaySend = ctx.createGain(); delaySend.gain.value = 0;
    const delay = ctx.createDelay(1.0); delay.delayTime.value = 0.3;
    const feedback = ctx.createGain(); feedback.gain.value = 0;
    const reverbSend = ctx.createGain(); reverbSend.gain.value = 0;
    const convolver = ctx.createConvolver(); convolver.buffer = reverbIR('hall');
    let currentPreset = 'hall';
    const sum = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const trackGain = ctx.createGain(); trackGain.gain.value = 0;   // ramp up from silence

    source.connect(lowpass); lowpass.connect(highpass); highpass.connect(shaper);
    shaper.connect(dry); dry.connect(sum);
    shaper.connect(delaySend); delaySend.connect(delay); delay.connect(feedback); feedback.connect(delay); delay.connect(sum);
    shaper.connect(reverbSend); reverbSend.connect(convolver); convolver.connect(sum);
    sum.connect(panner); panner.connect(trackGain); trackGain.connect(masterGain);

    let stopped = false;
    function update(tt) {
      const fx = (tt && tt.effects) || {};
      const now = ctx.currentTime;
      trackGain.gain.setTargetAtTime(clamp01(tt.volume == null ? 0.8 : tt.volume), now, 0.03);
      panner.pan.setTargetAtTime(clampPan(tt.pan), now, 0.03);
      source.loop = tt.loop !== false;
      source.detune.value = fx.pitch ? fx.pitch.semitones * 100 : 0;
      lowpass.frequency.value = fx.lowpass ? fx.lowpass.freq : 20000;
      highpass.frequency.value = fx.highpass ? fx.highpass.freq : 20;
      shaper.curve = fx.distort ? distortionCurve(fx.distort.drive) : null;
      if (fx.delay) {
        delaySend.gain.value = fx.delay.mix;
        delay.delayTime.value = fx.delay.time;
        feedback.gain.value = fx.delay.feedback;
      } else { delaySend.gain.value = 0; feedback.gain.value = 0; }
      if (fx.reverb) {
        reverbSend.gain.value = fx.reverb.mix;
        if (fx.reverb.preset && fx.reverb.preset !== currentPreset) {
          convolver.buffer = reverbIR(fx.reverb.preset); currentPreset = fx.reverb.preset;
        }
      } else { reverbSend.gain.value = 0; }
    }
    function stop() {
      if (stopped) return; stopped = true;
      try { trackGain.gain.setTargetAtTime(0, ctx.currentTime, 0.03); } catch (e) {}
      try { source.stop(ctx.currentTime + 0.15); } catch (e) {}
      setTimeout(() => { try { source.disconnect(); sum.disconnect(); trackGain.disconnect(); } catch (e) {} }, 250);
    }
    return { source, update, stop };
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
      const t = { volume: cfg.volume == null ? 0.8 : cfg.volume, pan: cfg.pan || 0, loop: false, effects: cfg.effects || {} };
      const handle = buildTrackGraph(buf, t);
      handle.update(t);
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
    masterGain.gain.setTargetAtTime(clamp01(audio.master), ctx.currentTime, 0.03);

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
          try { handle.source.start(); } catch (e) {}
          handle.update(t2);
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
        tracks: [...live.keys()].map((k) => {
          const t = audio && audio.tracks && audio.tracks[k];
          return { key: k, playing: true, volume: t ? t.volume : null, pan: t ? t.pan : null, effects: t ? t.effects : null };
        }),
        firedSfx: Object.fromEntries(lastSfx)
      };
    }
  };
}

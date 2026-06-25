// ============================================================
//  audioFx.js  --  the audio effect catalog
// ------------------------------------------------------------
//  One source of truth for the per-track effects rack, in the same
//  spirit as transitions.js. It drives BOTH the GM effect controls
//  (sliders/selects) and state.js's normalizeEffects() clamping.
//
//  An effect is "on" when its id is present in a track's `effects`
//  map; its value is a small params object. Defaults are chosen to be
//  AUDIBLE the moment an effect is switched on, so toggling it does
//  something without further dialing (pitch is the exception: a bipolar
//  slider centered at 0).
//
//  A param spec is [min, max, default] for a numeric slider, or
//  { options:[...], default } for a select.
//
//  Engine order: pitch (on the source) -> filters -> distortion ->
//  parallel delay + reverb sends -> pan. NOTE: pitch is detune-based,
//  so it changes SPEED as well as pitch (lower = slower, deeper) --
//  the Web Audio API has no tempo-preserving shifter.
// ============================================================

export const AUDIO_FX = [
  { id: 'pitch',    label: 'Pitch',     note: 'also changes speed (lower = slower, deeper)',
    params: { semitones: [-12, 12, 0] } },
  { id: 'lowpass',  label: 'Low-pass',  note: 'muffled / behind a door',
    params: { freq: [120, 18000, 1000] } },
  { id: 'highpass', label: 'High-pass', note: 'thin / distant',
    params: { freq: [20, 6000, 600] } },
  { id: 'distort',  label: 'Distortion / lo-fi',
    params: { drive: [0, 1, 0.4] } },
  { id: 'delay',    label: 'Delay / echo',
    params: { time: [0.02, 1, 0.3], feedback: [0, 0.85, 0.35], mix: [0, 1, 0.3] } },
  { id: 'reverb',   label: 'Reverb',
    params: { preset: { options: ['room', 'hall', 'cave'], default: 'hall' }, mix: [0, 1, 0.35] } }
];

// Procedural reverb impulse parameters per preset (no asset needed): a
// decaying-noise buffer of `seconds` length with an exponential `decay`.
export const REVERB_PRESETS = {
  room: { seconds: 0.7, decay: 2.8 },
  hall: { seconds: 2.0, decay: 2.0 },
  cave: { seconds: 3.6, decay: 1.4 }
};

export function fxSpec(id) {
  return AUDIO_FX.find((f) => f.id === id) || null;
}

// Default params for an effect, used when the GM switches it on.
export function defaultEffectParams(id) {
  const spec = fxSpec(id);
  if (!spec) return {};
  const out = {};
  for (const [name, p] of Object.entries(spec.params)) {
    out[name] = Array.isArray(p) ? p[2] : p.default;
  }
  return out;
}

// Clamp one effect's params to its spec, filling any missing with defaults.
export function clampEffectParams(id, params) {
  const spec = fxSpec(id);
  if (!spec) return {};
  params = params || {};
  const out = {};
  for (const [name, p] of Object.entries(spec.params)) {
    if (Array.isArray(p)) {
      const [min, max, def] = p;
      let v = +params[name];
      if (!isFinite(v)) v = def;
      out[name] = v < min ? min : v > max ? max : v;
    } else {
      out[name] = p.options.includes(params[name]) ? params[name] : p.default;
    }
  }
  return out;
}

// Normalize a whole effects map: keep only known ids, clamp each. Used by
// state.js for live state and when sanitizing a scene's audio config.
export function normalizeEffects(effects) {
  const out = {};
  if (!effects || typeof effects !== 'object') return out;
  for (const f of AUDIO_FX) {
    if (effects[f.id]) out[f.id] = clampEffectParams(f.id, effects[f.id]);
  }
  return out;
}

// ============================================================
//  transitions.js  --  the fixed set of stage transitions
// ------------------------------------------------------------
//  These are part of the app, not the dropped-in assets, so they
//  live in code (the asset manifest is scanned; this is not).
//  The scene builder offers ENTER_TRANSITIONS as the per-character
//  entrance choice; the Player reads the chosen id off the scene.
//
//    slide -> the character enters from its own side edge
//             (left character from the left, right from the right)
//             and leaves the same way.
//    fade  -> the character fades in where it stands, and fades out.
//
//  The whole-scene show/hide (the black curtain fading up from or
//  down to black) is not a per-scene choice; it is the fixed
//  mechanism for showing and hiding a scene. Timings live as CSS
//  custom properties in css/app.css.
// ============================================================

export const ENTER_TRANSITIONS = [
  { id: 'slide', label: 'Enter from side' },
  { id: 'fade',  label: 'Fade in' }
];

export const ENTER_IDS = ENTER_TRANSITIONS.map((t) => t.id);

export const DEFAULT_ENTER = 'fade';

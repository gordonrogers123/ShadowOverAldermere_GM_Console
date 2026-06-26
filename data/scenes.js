// ============================================================
//  scenes.js  --  the content of the GM Console
// ------------------------------------------------------------
//  A "scene" is a composition shown on the Player TV:
//    a BACKGROUND (a tactical map or cinematic art) with one or
//    more named reveal variants, plus an optional LEFT and RIGHT
//    character (transparent PNG) shown over it with transitions,
//    plus (later) tokens and audio.
//
//  TO ADD A SCENE BY HAND: copy a block below, give it a new unique
//  `id`, set its name, background, and characters, and save. It shows
//  up in the GM scene list on the next reload. No code change. You can
//  also build and save scenes from the GM window itself; those live in
//  the browser and can be exported back into this file to share.
//
//  Scene shape:
//    {
//      id:   "unique-id",
//      name: "Display Name",
//
//      // BACKGROUND. Named, ordered reveal variants. Two variants read
//      // as the familiar Hidden / Revealed toggle; three or more show a
//      // variant picker. The first / default variant is the one players
//      // see first, so keep spoilers in a later variant. A scene needs at
//      // least one variant. The key is just a label; any name works.
//      maps: { hidden: "assets/maps/<id>_hidden.jpg",
//              revealed: "assets/maps/<file>.jpg" },
//      defaultMapState: "hidden",     // which variant key shows on select
//
//      // CHARACTERS. Optional, independent left and right. Each points at a
//      // transparent PNG in assets/characters/{heroes,npcs,enemies} and a
//      // default entrance: "slide" (in from its own side) or "fade".
//      characters: {
//        left:  { id: "lysander", src: "assets/characters/heroes/lysander.png", enter: "slide" },
//        right: { id: "thraka",   src: "assets/characters/heroes/thraka.png",   enter: "fade" }
//      },
//
//      // Optional opening posture when the scene is selected. If absent,
//      // the curtain is up and each side shows only if it has a character.
//      defaults: { visible: true, leftShown: true, rightShown: true },
//
//      // Token roster for map mode: which cast ids (data/cast.js) may be
//      // placed on this map. null or omitted means none. The GM places and
//      // moves them live during play.
//      tokens:   { heroes:[id...], enemies:[id...] },   // or null
//      music:    null,   // legacy, unused (audio now lives in `audio`)
//      ambience: [],     // legacy, unused
//      // Audio (Phase 4): a music bed + ambience loops + one-shot SFX, each
//      // with volume, pan, and loop. null = silent. Picked in the builder; tuned
//      // live in the audio panel and captured with "Save audio to scene".
//      audio:    null,   // or { music:[{src,volume,pan,loop}...],   // beds; cues pick which plays
//                        //      ambience:[{src,...}], sfx:[{id,src,volume,pan}] }
//                        // (a single music object is still accepted for back-compat)
//
//      // CUES (optional). One-press stage transitions: each cue AUTHORS a target
//      // for the stage (which variant is up, scene/map mode, the curtain, who is
//      // on left/right, which audio + SFX play). Pressing a cue moves every aspect
//      // it affects to that target; an `opening:true` cue fires automatically on
//      // select (e.g. title card + title music). Built in the GM scene editor
//      // ("+ New cue") and scoped per cue via `affects` so a quick character swap
//      // leaves the background and music alone. Carried opaquely; old scenes
//      // without it load fine.
//      cues: [ { id, label, opening:false,
//                affects:{background,mapMode,curtain,characters,tokens,audio},
//                snapshot:{ mapState, mapMode, visible,
//                           left:{shown,srcOverride}, right:{shown,srcOverride},
//                           tokens:[{castId,kind,label,x,y,visible}],
//                           audio:{playing:[trackKeys], master, sfx:[ids]} },
//                // OPTIONAL per-element keyframes. Any lane present in `timeline`
//                // ANIMATES on its own Start `at` (+ where it fades, a `ramp`), in
//                // ms; every affected aspect NOT keyframed snaps at t=0 with the
//                // press. So the GM keyframes only what should be timed (e.g. a
//                // character walking in 2s after an instant background swap), or
//                // keyframes the whole spine (fade to black -> swap -> reveal ->
//                // SFX -> characters). Authored via each cue's "Timing" editor.
//                timeline:{ blackout:{at,ramp}, audioOut:{at,ramp}, background:{at,ramp},
//                           audioIn:{at,ramp}, reveal:{at,ramp}, sfx:{at}, characters:{at,ramp} } } ],
//
//      gmNotes:  "GM only text."   // shown in the GM window only
//    }
//
//  Hidden background variants are GM-only. They live only in THIS repo,
//  never in the public reference repo. The shared maps below come from the
//  shared assets (run scripts/sync-assets.sh to refresh). Drop your own
//  hidden art at the paths named; until you do, the Player shows a neutral
//  "not yet revealed" plate and the reveal still cross-fades. Character PNGs
//  are dropped into assets/characters/{heroes,npcs,enemies} (SEED_SAMPLES seeds
//  hero samples).
// ============================================================

export const SCENES = [];

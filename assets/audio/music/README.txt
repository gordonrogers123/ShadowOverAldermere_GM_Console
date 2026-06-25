Music beds go here (looping background tracks): .mp3 .ogg .wav .m4a .webm

Drop files in, then either click "Rescan assets" in the GM window (with
serve.py running) or run ./scripts/sync-assets.sh -- both regenerate
data/manifest.js so the scene builder's audio picker lists them.

Synthesized placeholder beds ship as a demo (theme-calm, theme-tense), made by
scripts/gen_demo_audio.py. Replace them with your own audio.

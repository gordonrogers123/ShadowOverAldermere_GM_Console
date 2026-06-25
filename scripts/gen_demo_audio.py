#!/usr/bin/env python3
"""gen_demo_audio.py -- synthesize small PLACEHOLDER audio for the demo.

These are simple synthesized tones/noise so the audio panel can be exercised
end-to-end (music bed + ambience loops + one-shot SFX) on a fresh checkout,
with no copyrighted material. Replace them with real audio by dropping files
into assets/audio/{music,ambience,sfx} and clicking "Rescan assets".

Offline, standard library only (wave + struct + math + random). Run:
    python3 scripts/gen_demo_audio.py
"""
from __future__ import annotations

import math
import os
import random
import struct
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
AUDIO = os.path.join(ROOT, "assets", "audio")
RATE = 22050


def _write(rel: str, samples, *, loop: bool):
    """Write mono 16-bit samples (floats in [-1,1]) to assets/audio/<rel>.wav.

    Loop files get short fades at both ends to soften the loop seam; one-shots
    get a fade-out tail so they never click."""
    n = len(samples)
    fade = int(0.012 * RATE)  # 12 ms
    out = list(samples)
    for i in range(min(fade, n)):
        g = i / fade
        out[i] *= g
        out[n - 1 - i] *= g if loop else 1.0
    if not loop:  # one-shot: fade only the tail
        tail = int(0.05 * RATE)
        for i in range(min(tail, n)):
            out[n - 1 - i] *= i / tail
    path = os.path.join(AUDIO, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        frames = bytearray()
        for s in out:
            v = max(-1.0, min(1.0, s))
            frames += struct.pack("<h", int(v * 32767))
        w.writeframes(bytes(frames))
    return path, n / RATE


def _sine(freq, t):
    return math.sin(2 * math.pi * freq * t)


def music_calm(dur=4.0):
    notes = [261.63, 329.63, 392.00, 523.25]  # C4 E4 G4 C5 arpeggio
    step = 0.5
    out = []
    for i in range(int(dur * RATE)):
        t = i / RATE
        idx = int(t / step) % len(notes)
        local = (t % step) / step
        env = math.sin(math.pi * local) ** 1.5          # soft swell per note
        f = notes[idx]
        s = (_sine(f, t) + 0.3 * _sine(2 * f, t)) * env
        out.append(0.34 * s)
    return out


def music_tense(dur=4.0):
    out = []
    for i in range(int(dur * RATE)):
        t = i / RATE
        drone = 0.5 * _sine(110, t) + 0.35 * _sine(110.6, t)   # detuned A2
        trem = 0.6 + 0.4 * _sine(2.2, t)                       # slow pulse
        third = 0.3 * _sine(164.81, t) * trem                  # E3 over the top
        sub = 0.25 * _sine(55, t)
        out.append(0.30 * (drone + third + sub))
    return out


def ambience_wind(dur=4.0):
    out, y = [], 0.0
    for i in range(int(dur * RATE)):
        t = i / RATE
        x = random.uniform(-1, 1)
        y += 0.04 * (x - y)                 # one-pole low-pass -> airy hiss
        lfo = 0.55 + 0.45 * _sine(0.15, t)  # slow gusts
        out.append(0.5 * y * lfo)
    return out


def ambience_tavern(dur=4.0):
    out, brown = [], 0.0
    for i in range(int(dur * RATE)):
        t = i / RATE
        brown += 0.02 * random.uniform(-1, 1)
        brown = max(-1, min(1, brown * 0.999))
        hum = 0.12 * _sine(110, t) + 0.08 * _sine(220, t)   # low warm hum
        out.append(0.6 * brown + hum)
    return out


def sfx_door_thud(dur=0.6):
    out = []
    for i in range(int(dur * RATE)):
        t = i / RATE
        env = math.exp(-9 * t)
        body = _sine(70 * (1 + 0.5 * math.exp(-30 * t)), t)  # pitch drops fast
        click = random.uniform(-1, 1) * math.exp(-80 * t)
        out.append(0.7 * (body * env + 0.4 * click))
    return out


def sfx_chime(dur=0.9):
    partials = [(880, 1.0), (880 * 2.0, 0.5), (880 * 2.76, 0.3), (880 * 5.4, 0.15)]
    out = []
    for i in range(int(dur * RATE)):
        t = i / RATE
        s = sum(a * math.exp(-4.5 * t) * _sine(f, t) for f, a in partials)
        out.append(0.4 * s)
    return out


def sfx_sword_clash(dur=0.5):
    partials = [(2100, 1.0), (3300, 0.7), (5200, 0.4)]
    out, y = [], 0.0
    for i in range(int(dur * RATE)):
        t = i / RATE
        x = random.uniform(-1, 1)
        y = x - 0.5 * y                         # crude high-pass -> bright noise
        ring = sum(a * _sine(f, t) for f, a in partials) * math.exp(-12 * t)
        burst = 0.6 * y * math.exp(-30 * t)
        out.append(0.45 * (ring * math.exp(-7 * t) + burst))
    return out


JOBS = [
    ("music/theme-calm.wav", music_calm, True),
    ("music/theme-tense.wav", music_tense, True),
    ("ambience/wind.wav", ambience_wind, True),
    ("ambience/tavern.wav", ambience_tavern, True),
    ("sfx/door-thud.wav", sfx_door_thud, False),
    ("sfx/chime.wav", sfx_chime, False),
    ("sfx/sword-clash.wav", sfx_sword_clash, False),
]


if __name__ == "__main__":
    random.seed(7)  # deterministic output for stable diffs
    for rel, fn, loop in JOBS:
        path, secs = _write(rel, fn(), loop=loop)
        size = os.path.getsize(path)
        print(f"wrote {rel:28s} {secs:4.1f}s  {size // 1024} KB")

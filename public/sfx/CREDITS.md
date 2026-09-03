# Pascal Strike sound credits

All audio in this directory is original, deterministic FFmpeg synthesis created for Pascal
Strike by the project authors and dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). No third-party recording is
included.

Kenney's CC0 packs were the preferred source, but `curl` could not resolve `kenney.nl` in the
build environment on 2026-09-03. The W5-B fallback therefore generated every sound from
FFmpeg's `anoisesrc` and `sine` sources. Exact, reproducible commands and seeds are in
`scripts/sfx/build-sfx.sh`.

All masters are synthesized at 44.1 kHz mono, normalized with `loudnorm` and a -3 dBFS limiter,
then exported as AAC (96 kb/s, mono) and OGG Vorbis q4. This FFmpeg build's native Vorbis
encoder only accepts stereo, so each OGG contains the same mono signal in both channels. Peaks
below are measured after decoding with FFmpeg `volumedetect`; sizes are encoded file sizes.

| Files | Source and processing | Duration (OGG / M4A) | Peak (OGG / M4A) | Size (OGG / M4A) |
| --- | --- | ---: | ---: | ---: |
| `shot-1.ogg`, `shot-1.m4a` | CC0 original synthesis: seeded 8 ms band-passed noise pop, cross-layered 120/60 Hz 40 ms thump, 610 Hz pink-noise impact body, delayed 15 ms high-passed hiss; loudness normalized | 0.075 / 0.075 s | -3.6 / -3.2 dBFS | 5,745 / 2,149 B |
| `shot-2.ogg`, `shot-2.m4a` | CC0 original synthesis: alternate seeds, 3.05 kHz pop and 700 Hz impact body using the marker recipe; loudness normalized | 0.075 / 0.075 s | -3.6 / -3.8 dBFS | 5,756 / 2,182 B |
| `pistol-shot.ogg`, `pistol-shot.m4a` | CC0 original synthesis: brighter 8 ms 3.9 kHz air snap, shorter 150/75 Hz body, 1.15 kHz transient and 15 ms hiss; loudness normalized | 0.054 / 0.053 s | -3.1 / -3.4 dBFS | 5,758 / 1,855 B |
| `splat-1.ogg`, `splat-1.m4a` | CC0 original synthesis: seeded brown/pink noise, 920 Hz low-pass wet body and 118 Hz tone; shaped fades and loudness normalization | 0.190 / 0.190 s | -3.0 / -3.1 dBFS | 5,004 / 3,480 B |
| `splat-2.ogg`, `splat-2.m4a` | CC0 original synthesis: alternate seeds, 1.08 kHz wet body and 132 Hz tone; shaped fades and loudness normalization | 0.190 / 0.190 s | -3.2 / -3.0 dBFS | 5,023 / 3,751 B |
| `footstep-1.ogg`, `footstep-1.m4a` | CC0 original synthesis: seeded low-passed pink sole noise, short brown-noise contact and 82 Hz body; soft fades and loudness normalization | 0.126 / 0.125 s | -2.8 / -3.0 dBFS | 4,471 / 2,833 B |
| `footstep-2.ogg`, `footstep-2.m4a` | CC0 original synthesis: alternate seeds, brighter 830 Hz sole cutoff and 91 Hz body; soft fades and loudness normalization | 0.126 / 0.125 s | -2.7 / -3.1 dBFS | 4,532 / 2,664 B |
| `glass-1.ogg`, `glass-1.m4a` | CC0 original synthesis: seeded high-passed noise crash plus four staggered 2.48–4.87 kHz sine shard resonances; decay shaping and loudness normalization | 0.521 / 0.520 s | -4.7 / -2.8 dBFS | 19,698 / 7,535 B |
| `glass-2.ogg`, `glass-2.m4a` | CC0 original synthesis: alternate seed and 2.69–5.08 kHz shard resonances; decay shaping and loudness normalization | 0.521 / 0.520 s | -4.6 / -3.2 dBFS | 19,673 / 7,542 B |
| `mechanical-click.ogg`, `mechanical-click.m4a` | CC0 original synthesis: two seeded band-passed noise clicks with 920/620 Hz mechanical tones 62 ms apart; loudness normalized | 0.093 / 0.092 s | -3.3 / -3.4 dBFS | 5,769 / 2,431 B |
| `respawn-chime.ogg`, `respawn-chime.m4a` | CC0 original synthesis: staggered 440/660/880 Hz sine chime with short attack/decay envelopes; loudness normalized, AAC attenuated 6.5 dB to control transform overshoot | 0.441 / 0.440 s | -2.9 / -2.4 dBFS | 4,589 / 3,550 B |
| `door-handle.ogg`, `door-handle.m4a` | CC0 original synthesis: seeded 430 Hz brown-noise hinge, delayed 1.9 kHz latch click and 115 Hz close thud; loudness normalized | 0.361 / 0.360 s | -3.1 / -3.0 dBFS | 6,888 / 5,659 B |

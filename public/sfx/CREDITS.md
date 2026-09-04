# Pascal Strike sound credits

The recordings used here are by [Kenney](https://kenney.nl/) and licensed
[Creative Commons Zero (CC0 1.0)](https://creativecommons.org/publicdomain/zero/1.0/):

- [Impact Sounds](https://kenney.nl/assets/impact-sounds), version 1.0, 2019-12-19
- [Interface Sounds](https://kenney.nl/assets/interface-sounds), version 1.0, 2020-02-11
- [Sci-Fi Sounds](https://kenney.nl/assets/sci-fi-sounds), version 1.0, 2020-10-11

Pascal Strike's added generated layers are also dedicated to the public domain under CC0 1.0.
Exact processing and deterministic synthesis seeds are in `scripts/sfx/build-sfx.sh`.

All sources are mixed to unclipped 44.1 kHz mono float masters. FFmpeg `astats` measures each
master and applies gain-only peak normalization; no loudness normalization, compression, or
limiting is used. Each lossy encode is measured and gain-corrected toward -1 dBFS. M4A is AAC
mono at 128 kbps. The installed native Vorbis encoder requires stereo, so OGG Vorbis q4 files
contain identical copies of the mono master.

Source processing uses 60–100 Hz high-passes only for rumble removal, except intentionally thin
interface clicks and the specified 3 kHz shot hiss. No source layer is low-passed below 9 kHz.
The sole exception is each splat's quiet 2.5 kHz low-passed wet layer, mixed beneath its full-band
soft impact. Shots, pistol, reloads, and glass receive a +3 dB presence bell at 3.5 kHz. Glass has
no low-pass at all, and footsteps have only a 100 Hz high-pass plus their output fades.

Metrics below were measured after decoding. “High RMS” applies `highpass=f=3000` twice; delta is
High RMS minus full-signal RMS. Values within each cell are ordered OGG / M4A.

| Output pair | Exact Kenney source file(s) and processing | Full RMS | High RMS (delta) | Peak | Duration | Size |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `shot-1` | Impact `impactPunch_heavy_000.ogg`; full-band punch, wide CO2 pop, bright hiss | -16.2 / -16.8 dBFS | -26.4 (-10.2) / -25.9 (-9.1) dBFS | -1.0 / -0.9 dBFS | .181 / .180 s | 5,687 / 3,926 B |
| `shot-2` | Impact `impactPunch_heavy_002.ogg`; alternate punch and deterministic noise seeds | -18.2 / -18.0 dBFS | -29.3 (-11.0) / -28.0 (-9.9) dBFS | -1.0 / -1.0 dBFS | .181 / .180 s | 5,411 / 3,865 B |
| `pistol-shot` | Impact `impactPlate_light_001.ogg`; brighter full-band plate, wide pop, stronger hiss | -21.4 / -20.7 dBFS | -26.8 (-5.4) / -25.8 (-5.1) dBFS | -1.2 / -0.9 dBFS | .126 / .125 s | 6,078 / 3,330 B |
| `splat-1` | Impact `impactSoft_heavy_000.ogg`; full-band impact over quiet 2.5 kHz wet layer | -14.6 / -16.9 dBFS | -67.9 (-53.3) / -69.7 (-52.8) dBFS | -1.0 / -0.5 dBFS | .280 / .280 s | 5,046 / 4,814 B |
| `splat-2` | Impact `impactSoft_heavy_001.ogg`; alternate impact, wet timing, and seed | -14.5 / -18.2 dBFS | -67.0 (-52.5) / -70.5 (-52.3) dBFS | -1.0 / -1.5 dBFS | .280 / .280 s | 5,049 / 5,032 B |
| `splat-3` | Impact `impactSoft_heavy_003.ogg`; alternate heavy/knife impact and wet seed | -13.1 / -16.4 dBFS | -63.5 (-50.4) / -66.7 (-50.3) dBFS | -0.9 / -0.9 dBFS | .280 / .280 s | 5,128 / 5,015 B |
| `soft-hit` | Impact `impactSoft_medium_001.ogg`; full-band 150 ms soft impact | -14.2 / -14.0 dBFS | -82.8 (-68.6) / -75.4 (-61.4) dBFS | -1.0 / -1.5 dBFS | .151 / .150 s | 4,011 / 2,934 B |
| `reload-start` | Impact `impactMetal_light_002.ogg`; full-band magazine-release click with presence | -18.2 / -18.0 dBFS | -22.6 (-4.5) / -22.5 (-4.5) dBFS | -0.9 / -1.0 dBFS | .161 / .160 s | 4,764 / 3,370 B |
| `reload-end` | Impact `impactMetal_medium_001.ogg`; Interface `click_003.ogg`; full-band seat and delayed click | -16.7 / -16.8 dBFS | -35.2 (-18.5) / -35.3 (-18.5) dBFS | -1.1 / -1.1 dBFS | .141 / .140 s | 5,130 / 3,344 B |
| `door-handle` | Impact `impactWood_light_002.ogg`; full-band wood latch over a 9 kHz hinge layer | -18.8 / -18.8 dBFS | -44.1 (-25.3) / -44.3 (-25.4) dBFS | -0.9 / -1.0 dBFS | .361 / .360 s | 8,128 / 6,646 B |
| `footstep-1` | Impact `footstep_concrete_000.ogg`; 100 Hz rumble removal only | -19.1 / -19.2 dBFS | -63.0 (-43.9) / -60.9 (-41.7) dBFS | -1.0 / -1.0 dBFS | .103 / .103 s | 4,586 / 2,697 B |
| `footstep-2` | Impact `footstep_concrete_001.ogg`; 100 Hz rumble removal only | -20.9 / -20.9 dBFS | -44.1 (-23.2) / -44.3 (-23.4) dBFS | -1.0 / -1.0 dBFS | .106 / .104 s | 4,894 / 2,694 B |
| `footstep-3` | Impact `footstep_wood_000.ogg`; 100 Hz rumble removal only | -19.7 / -19.7 dBFS | -84.9 (-65.3) / -77.7 (-58.1) dBFS | -1.0 / -1.0 dBFS | .210 / .210 s | 4,313 / 3,014 B |
| `footstep-4` | Impact `footstep_wood_001.ogg`; 100 Hz rumble removal only | -19.8 / -19.8 dBFS | -83.0 (-63.2) / -75.7 (-55.9) dBFS | -0.9 / -1.0 dBFS | .210 / .210 s | 4,272 / 2,984 B |
| `knife-swing` | Sci-Fi `laserSmall_004.ogg`; full-band reversed whoosh with 100 Hz rumble removal | -12.6 / -12.6 dBFS | -82.0 (-69.5) / -73.2 (-60.6) dBFS | -1.0 / -1.0 dBFS | .221 / .220 s | 4,446 / 4,584 B |
| `mechanical-click` | Interface `click_002.ogg`, `switch_004.ogg`; thin click over a full-band switch | -26.7 / -26.7 dBFS | -31.7 (-5.0) / -31.8 (-5.0) dBFS | -1.0 / -1.0 dBFS | .106 / .105 s | 4,475 / 1,881 B |
| `glass-1` | Impact `impactGlass_heavy_000.ogg`; full-band break, broadband shards, bright resonances | -24.5 / -24.5 dBFS | -32.6 (-8.1) / -31.9 (-7.4) dBFS | -1.0 / -1.0 dBFS | .466 / .465 s | 7,382 / 5,273 B |
| `glass-2` | Impact `impactGlass_heavy_003.ogg`; alternate break, seed, and resonance pitches | -23.6 / -23.4 dBFS | -33.6 (-10.0) / -32.7 (-9.3) dBFS | -1.1 / -1.0 dBFS | .466 / .465 s | 7,145 / 4,682 B |
| `shard-tinkle` | Impact `impactGlass_light_001.ogg`; full-band light glass impact with presence | -20.2 / -20.4 dBFS | -34.2 (-14.0) / -34.3 (-13.9) dBFS | -1.0 / -1.0 dBFS | .208 / .206 s | 5,184 / 4,167 B |
| `respawn-chime` | Sci-Fi `forceField_002.ogg`; full-band 550 ms shaped excerpt | -12.4 / -15.1 dBFS | -49.0 (-36.6) / -51.6 (-36.6) dBFS | -1.0 / -1.0 dBFS | .550 / .550 s | 7,220 / 8,047 B |

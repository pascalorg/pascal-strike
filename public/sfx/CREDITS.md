# Pascal Strike sound credits

The recordings used here are by [Kenney](https://kenney.nl/) and licensed
[Creative Commons Zero (CC0 1.0)](https://creativecommons.org/publicdomain/zero/1.0/):

- [Impact Sounds](https://kenney.nl/assets/impact-sounds), version 1.0, 2019-12-19
- [Interface Sounds](https://kenney.nl/assets/interface-sounds), version 1.0, 2020-02-11
- [Sci-Fi Sounds](https://kenney.nl/assets/sci-fi-sounds), version 1.0, 2020-10-11

Pascal Strike's added generated layers are also dedicated to the public domain under CC0 1.0.
Exact processing and deterministic synthesis seeds are in `scripts/sfx/build-sfx.sh`.

All sources are mixed to 44.1 kHz mono, filtered/faded as described below, normalized with
FFmpeg `loudnorm`, peak-limited near -3 dBFS, then encoded as AAC mono and OGG Vorbis q4. The
installed native Vorbis encoder requires two channels, so OGG files contain identical copies of
the mono master. Metrics are decoded duration, decoded peak, and file size, ordered OGG / M4A.

| Output pair | Exact Kenney source file(s) | Processing | Duration | Peak | Size |
| --- | --- | --- | ---: | ---: | ---: |
| `shot-1` | Impact Sounds `impactPunch_heavy_000.ogg` | 180 ms transient plus generated 8 ms CO2 pop, 120/60 Hz thump and 15 ms hiss | .181 / .180 s | -2.8 / -3.1 dBFS | 5,225 / 3,425 B |
| `shot-2` | Impact Sounds `impactPunch_heavy_002.ogg` | Alternate transient/pop seed using the same CO2 marker recipe | .181 / .180 s | -3.1 / -3.0 dBFS | 5,163 / 3,560 B |
| `pistol-shot` | Impact Sounds `impactPlate_light_001.ogg` | Brighter 125 ms plate transient plus short generated CO2 pop, 145/72 Hz body and hiss | .126 / .125 s | -2.9 / -3.4 dBFS | 6,279 / 2,973 B |
| `splat-1` | Impact Sounds `impactSoft_heavy_000.ogg`, `impactPunch_medium_000.ogg` | Low-pass mix with a quiet generated brown-noise wet layer | .280 / .280 s | -3.0 / -3.0 dBFS | 4,802 / 4,578 B |
| `splat-2` | Impact Sounds `impactSoft_heavy_001.ogg`, `impactPunch_medium_002.ogg` | Alternate low-pass wet mix and timing | .280 / .280 s | -3.0 / -2.8 dBFS | 4,756 / 4,696 B |
| `splat-3` | Impact Sounds `impactSoft_heavy_003.ogg`, `impactPunch_medium_004.ogg` | Darker low-pass wet mix used for heavy/knife impacts | .280 / .280 s | -3.1 / -3.4 dBFS | 4,638 / 4,612 B |
| `soft-hit` | Impact Sounds `impactSoft_medium_001.ogg` | 150 ms high/low-pass impact with short fade | .151 / .150 s | -3.0 / -3.2 dBFS | 4,217 / 3,080 B |
| `reload-start` | Impact Sounds `impactMetal_light_002.ogg` | 160 ms band-limited magazine-release click | .161 / .160 s | -3.0 / -3.0 dBFS | 5,115 / 3,322 B |
| `reload-end` | Impact Sounds `impactMetal_medium_001.ogg`; Interface Sounds `click_003.ogg` | Magazine-seat impact with delayed interface click | .141 / .140 s | -2.8 / -3.1 dBFS | 5,294 / 3,027 B |
| `door-handle` | Impact Sounds `impactWood_light_002.ogg` | Wood latch layered over a generated filtered brown-noise hinge | .361 / .360 s | -2.9 / -3.1 dBFS | 6,330 / 5,761 B |
| `footstep-1` | Impact Sounds `footstep_concrete_000.ogg` | Quiet band-limited concrete step with short fade | .103 / .103 s | -3.0 / -3.1 dBFS | 4,314 / 2,351 B |
| `footstep-2` | Impact Sounds `footstep_concrete_001.ogg` | Alternate quiet concrete step | .106 / .104 s | -3.0 / -3.0 dBFS | 4,400 / 2,366 B |
| `footstep-3` | Impact Sounds `footstep_wood_000.ogg` | Quiet low-passed wood step with 210 ms decay | .210 / .210 s | -3.0 / -2.8 dBFS | 4,598 / 2,951 B |
| `footstep-4` | Impact Sounds `footstep_wood_001.ogg` | Alternate quiet wood step | .210 / .210 s | -3.0 / -2.7 dBFS | 4,611 / 2,909 B |
| `knife-swing` | Sci-Fi Sounds `laserSmall_004.ogg` | Reversed, band-limited and faded into a 220 ms whoosh | .221 / .220 s | -2.9 / -3.0 dBFS | 4,606 / 4,021 B |
| `mechanical-click` | Interface Sounds `click_002.ogg`, `switch_004.ogg` | Short high-passed click layered with the first 105 ms of a switch | .106 / .105 s | -3.1 / -3.1 dBFS | 4,512 / 1,842 B |
| `glass-1` | Impact Sounds `impactGlass_heavy_000.ogg` | Heavy glass transient with three generated staggered sine shard resonances | .466 / .465 s | -3.1 / -3.0 dBFS | 7,066 / 5,046 B |
| `glass-2` | Impact Sounds `impactGlass_heavy_003.ogg` | Alternate heavy transient and shard-resonance pitches | .466 / .465 s | -3.0 / -3.1 dBFS | 7,251 / 4,899 B |
| `shard-tinkle` | Impact Sounds `impactGlass_light_001.ogg` | High-passed light glass impact with 208 ms decay | .208 / .206 s | -3.0 / -3.0 dBFS | 6,133 / 3,660 B |
| `respawn-chime` | Sci-Fi Sounds `forceField_002.ogg` | 550 ms band-limited excerpt with shaped attack and decay | .550 / .550 s | -3.2 / -3.0 dBFS | 8,014 / 7,212 B |

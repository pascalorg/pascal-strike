# Pascal Strike sound credits

Sonniss excerpts: **Sonniss GDC Game Audio Bundle (2026)** — royalty-free; commercial use and modification allowed. Copyright remains with the respective recording creators named in the source paths. These recordings are not CC0.

License supplied with the bundle: `Sonniss.com-GDC2026-GameAudioBundle2of5/License - GDC Game Audio.pdf`. The bundle Readme also permits personal/commercial use without attribution. The license prohibits selling the sounds as standalone recordings and prohibits AI training. These edited excerpts are incorporated into Pascal Strike.

Footsteps, jump/land footstep layers, and wood door layer: [Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds), version 1.0, 2019-12-19, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

Build: `bash scripts/sfx/build-sfx.sh`. Sources are read in place from `SONNISS_DIR` and `KENNEY_DIR`; temporary masters are removed on exit. Only changed pairs are rebuilt. reloadStart, knifeSwing, knifeHit, footsteps, deny, and splat v2 remain byte-identical.

Processing: mono 44.1 kHz; source layers highpassed at 80 Hz (synthesized low thumps bypass this); no lowpass, compression, limiting, or loudness normalization. Layers are peak-matched to -1 dBFS before relative gain and delay. Gain-only master normalization: -1 dBFS; 1 ms attack. OGG libvorbis q4 and mono AAC M4A 128 kbps; decoded peak correction tolerance ±0.15 dB. Legacy footsteps retain their original encodes.

Manifest: hit 0.55, death 0.7, respawn 0.3, jump 0.25, land 0.4; other gains unchanged. Deny plays on team refusal. Jump plays on accepted local jump input; land plays on local ground contact or remote descent stopping above 2.5 m/s, scaled 0.6–1.2 over 2.5–8 m/s. Remote land is culled at 22 m.

## Selection evidence

```json
{
  "lock": {
    "peak_time": 0.17294784580498868,
    "isolation_db": 39.68078195544226
  },
  "body_drop": {
    "peak_time": 42.20956916099773,
    "rms_300ms_dbfs": -14.648676105729152,
    "knife_rms_300ms_dbfs": -12.86664711378338
  },
  "glass": {
    "peak_times": [
      1.490998,
      1.0110430839002267
    ]
  },
  "hinge": {
    "primary_active_seconds_pitched": 3.5375,
    "selected": "mouse",
    "reason": "Primary active region exceeds 650 ms at -20% pitch; use shorter mouse squeak."
  },
  "pistol_full_rms_above_marker_db": {
    "master": 1.497,
    "ogg": 1.624,
    "m4a": 1.481
  },
  "pistol_vs_all_markers_db": {
    "ogg": [
      1.624,
      1.623,
      1.1
    ],
    "m4a": [
      1.481,
      1.869,
      1.009
    ]
  }
}
```

## Exact sources and cuts

Sonniss paths are relative to `SONNISS_DIR`; Kenney paths are relative to `KENNEY_DIR`. Cuts are start / duration before pitch, padding, and fades. Synth layers use a linear frequency sweep (or fixed frequency) and exponential amplitude decay. Accepted splat v2 envelopes are applied before pitch/mixing.

| Sound → output pair | Exact source; cut start / duration | Processing |
| --- | --- | --- |
| shot (1/3) → `shot-1` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Public Spaces - Crowds Walla and Everyday Ambiences/AMBWar_Paintball Match Firefight Shots Walla Nearfield Full 05_ESM_CPS.wav`; **21.692506 / 0.220000 s**; +0 dB; ×1 pitch; `equalizer=f=3000:t=q:w=1:g=1.5`<br>Synthesized: `Sine 100→60 Hz; exponential decay exp(-4t/d), 1 ms attack, 3 ms release`; **0.000000 / 0.035000 s**; -8 dB; ×1 pitch | Accepted v1 cut; +1.5 dB at 3 kHz; 100→60 Hz weight. Tail duration varies ±20 ms. Fade-out 60 ms. Master 220 ms. |
| shot (2/3) → `shot-2` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Public Spaces - Crowds Walla and Everyday Ambiences/AMBWar_Paintball Match Firefight Shots Walla Nearfield Full 05_ESM_CPS.wav`; **21.692506 / 0.220000 s**; +0 dB; ×0.975 pitch; `equalizer=f=3000:t=q:w=1:g=1.5`<br>Synthesized: `Sine 100→60 Hz; exponential decay exp(-4t/d), 1 ms attack, 3 ms release`; **0.000000 / 0.035000 s**; -8 dB; ×1 pitch | Accepted v1 cut; +1.5 dB at 3 kHz; 100→60 Hz weight. Tail duration varies ±20 ms. Fade-out 60 ms. Master 240 ms. |
| shot (3/3) → `shot-3` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Public Spaces - Crowds Walla and Everyday Ambiences/AMBWar_Paintball Match Firefight Shots Walla Nearfield Full 05_ESM_CPS.wav`; **21.692506 / 0.220000 s**; +0 dB; ×1.025 pitch; `equalizer=f=3000:t=q:w=1:g=1.5`<br>Synthesized: `Sine 100→60 Hz; exponential decay exp(-4t/d), 1 ms attack, 3 ms release`; **0.000000 / 0.035000 s**; -8 dB; ×1 pitch | Accepted v1 cut; +1.5 dB at 3 kHz; 100→60 Hz weight. Tail duration varies ±20 ms. Fade-out 60 ms. Master 200 ms. |
| pistolShot → `pistol-shot` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Public Spaces - Crowds Walla and Everyday Ambiences/AMBWar_Paintball Match Firefight Shots Walla Nearfield Full 05_ESM_CPS.wav`; **21.692506 / 0.220000 s**; +0 dB; ×1.1 pitch; `equalizer=f=4000:t=q:w=1:g=3`<br>Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/David Dumais Audio - Melee Weapons Sound Effects Pack 2/WEAPWhip_WHIP Snap Crack 05_DDUMAIS_MWP2.wav`; **0.563934 / 0.080000 s**; -8 dB; ×1 pitch<br>Synthesized: `Sine 90→90 Hz; exponential decay exp(-2.24t/d), 1 ms attack, 3 ms release`; **0.000000 / 0.040000 s**; -5 dB; ×1 pitch | Accepted marker +10% pitch, +3 dB at 4 kHz; whip transient -8 dB; 90 Hz weight -5 dB. AAC gain-only encode trim +0.015 dB. Fade-out 40 ms. Master 170 ms. |
| splat variant 1 → `splat-1` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Tower Defense Game/WOODImpt_Hit Blood Spill Splat Wood Impact Light Hit Squelch Small Thump 03_ESM_TDG.wav`; **0.127431 / 0.120000 s**; +0 dB; ×0.96 pitch | Accepted v2 envelope at -4% pitch; old v1 removed. Fade-out 25 ms. Master 120 ms. |
| splat variant 2 → `splat-2` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Tower Defense Game/WOODImpt_Hit Blood Spill Splat Wood Impact Light Hit Squelch Small Thump 03_ESM_TDG.wav`; **0.127431 / 0.120000 s**; +0 dB; ×1 pitch | Separate detected wall-splat hit. Fade-out 25 ms. Master 120 ms. |
| splat variant 3 → `splat-3` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Tower Defense Game/WOODImpt_Hit Blood Spill Splat Wood Impact Light Hit Squelch Small Thump 03_ESM_TDG.wav`; **0.127431 / 0.120000 s**; +0 dB; ×1.04 pitch<br>Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Tower Defense Game/WOODImpt_Hit Blood Spill Splat Wood Impact Light Hit Squelch Small Thump 03_ESM_TDG.wav`; **0.253984 / 0.078215 s**; -8 dB; ×1 pitch | Accepted v2 envelope at +4% pitch; old v3 transient -8 dB. Fade-out 25 ms. Master 120 ms. |
| hit → `body-hit` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Tower Defense Game/WOODImpt_Hit Blood Spill Splat Wood Impact Light Hit Squelch Small Thump 03_ESM_TDG.wav`; **0.127431 / 0.120000 s**; -4 dB; ×1 pitch<br>Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle1of5/344 Audio - Elemental Palette Designed Vol. 1/WATRMisc_Water, Liquid Impact, Bubble, Sci Fi, Hit 04_344 Audio_Elemental Palette Designed Vol 1.wav`; **0.248333 / 0.160000 s**; -3 dB; ×1 pitch | Accepted splat v2 -4 dB plus liquid -3 dB; no gore. Playback gain 0.55. Fade-out 40 ms. Master 160 ms. |
| death → `death` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/David Dumais Audio - Melee Weapons Sound Effects Pack 2/SWSH_SWING IMPACTS Quick Heavy Weapon Swing To Thud Impact Var 01_DDUMAIS_MWP2.wav`; **42.204569 / 0.450000 s**; +0 dB; ×1 pitch<br>Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle3of5/InMotionAudio - Foley T-Shirt/FOLYClth_ClothMovement24_InMotionAudio_FoleyT-Shirt.wav`; **0.150000 / 0.300000 s**; -6 dB; ×1 pitch<br>Synthesized: `Sine 70→70 Hz; exponential decay exp(-4t/d), 1 ms attack, 3 ms release`; **0.000000 / 0.060000 s**; -6 dB; ×1 pitch | Lower-energy separate body thud, cloth -6 dB, 70 Hz whump -6 dB. Playback gain 0.7. Fade-out 100 ms. Master 450 ms. |
| hitConfirm → `hit-confirm` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Cinematic Sound Design - Interface & Infographics/Interface Percussion Snap.wav`; **0.000000 / 0.100000 s**; +0 dB; ×1 pitch; `afade=t=out:st=0.08:d=0.02`<br>Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Cinematic Sound Design - UI Interaction Elements/Ting Coins.wav`; **0.107567 / 0.120000 s**; -12 dB; ×1 pitch; `highpass=f=2000` | Percussion snap plus first coin transient, highpass 2 kHz at -12 dB. Fade-out 20 ms. Master 120 ms. |
| reloadStart → `reload-start` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - HD Lock And Mechanism Sound Design Kit/MACHMech_Mechanism Counting Machine Interact Loose Container Short 01_ESM_HDLM.wav`; **0.066376 / 0.180000 s**; +0 dB; ×1 pitch |  Fade-out 40 ms. Master 180 ms. |
| reload / reloadEnd → `reload-end` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - HD Lock And Mechanism Sound Design Kit/MECHLtch_Click Deep Mechanism Latch Button Nearfield Thunk 02_ESM_HDLM.wav`; **0.010578 / 0.160000 s**; +0 dB; ×1 pitch; `equalizer=f=2500:t=q:w=1:g=2`<br>Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle3of5/InMotionAudio - USA Hotel/MECHClik_USALightSwitch_On05_InMotionAudio_USAHotel.wav`; **0.018383 / 0.070000 s**; +0 dB; ×1 pitch; delay 25 ms; `equalizer=f=2500:t=q:w=1:g=2` | Latch plus 0 dB light-switch click delayed 25 ms; +2 dB at 2.5 kHz on both layers. reload alias shares this pair. Fade-out 40 ms. Master 160 ms. |
| weaponSwitch → `weapon-switch` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle1of5/344 Audio - Antique Small Metals/METLMvmt_  Tinkering Antique Lock_344 Audio_Antique Small Metals.wav`; **0.169948 / 0.120000 s**; +0 dB; ×1 pitch<br>Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - HD Lock And Mechanism Sound Design Kit/MECHLtch_Click Deep Mechanism Latch Button Nearfield Thunk 02_ESM_HDLM.wav`; **0.010578 / 0.120000 s**; -8 dB; ×1 pitch | Lock transient selected by maximum preceding 100 ms isolation; latch -8 dB. Fade-out 25 ms. Master 120 ms. |
| dryFire → `dry-fire` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle3of5/InMotionAudio - USA Hotel/MECHClik_USALightSwitch_On05_InMotionAudio_USAHotel.wav`; **0.018383 / 0.070000 s**; +0 dB; ×1 pitch |  Fade-out 15 ms. Master 70 ms. |
| knifeSwing → `knife-swing` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/David Dumais Audio - Melee Weapons Sound Effects Pack 2/METLFric_SWING SCRAPE Swift Melee Weapon Swing With A Long Blade 14_DDUMAIS_MWP2.wav`; **0.030091 / 0.200000 s**; +0 dB; ×1 pitch |  Fade-out 40 ms. Master 200 ms. |
| knifeHit → `knife-hit` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/David Dumais Audio - Melee Weapons Sound Effects Pack 2/SWSH_SWING IMPACTS Quick Heavy Weapon Swing To Thud Impact Var 01_DDUMAIS_MWP2.wav`; **39.210624 / 0.220000 s**; +0 dB; ×1 pitch<br>Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Halloween Game - Haunted House and Horror Audio Scare Kit/GORESplt_Gore Designed Transient Heavy Impact Smash 01_ESM_HALG.wav`; **0.011599 / 0.220000 s**; -6 dB; ×1 pitch |  Fade-out 50 ms. Master 220 ms. |
| glassBreak (1/2) → `glass-1` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Elemental Mutation Whooshes and Impacts/GLASMvmt_Whoosh Glass Crystal Fragments Sharp Shards Dry 05_ESM_EMWI.wav`; **1.480998 / 0.900000 s**; +0 dB; ×1 pitch | Glass shards crash; extended natural tail. ICEBrk source removed. Fade-out 400 ms. Master 900 ms. |
| glassBreak (2/2) → `glass-2` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Elemental Mutation Whooshes and Impacts/GLASMvmt_Whoosh Glass Crystal Fragments Sharp Shards Dry 05_ESM_EMWI.wav`; **1.001043 / 0.900000 s**; +0 dB; ×1 pitch | Glass shards crash; extended natural tail. ICEBrk source removed. Fade-out 400 ms. Master 900 ms. |
| shardTinkle → `shard-tinkle` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Elemental Mutation Whooshes and Impacts/GLASMvmt_Whoosh Glass Crystal Fragments Sharp Shards Dry 05_ESM_EMWI.wav`; **1.670998 / 0.400000 s**; +0 dB; ×1 pitch |  Fade-out 200 ms. Master 400 ms. |
| door → `door-handle` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - HD Game Materials/ICEFric_Dry Ice Squeak Metal Animal Mouse Imitation Short 07_ESM_HDGM.wav`; **0.295964 / 0.256000 s**; -10 dB; ×0.8 pitch; `afade=t=out:st=0.24:d=0.08`<br>Kenney Impact Sounds: `impact-sounds/Audio/impactWood_light_002.ogg`; **0.000000 / 0.300000 s**; +0 dB; ×1 pitch; delay 40 ms<br>Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - HD Lock And Mechanism Sound Design Kit/MECHLtch_Click Deep Mechanism Latch Button Nearfield Thunk 02_ESM_HDLM.wav`; **0.010578 / 0.160000 s**; -6 dB; ×1 pitch; delay 40 ms | Hinge -20% pitch, 320 ms after pitch at -10 dB; wood/latch start 40 ms later. Prior door playback gain retained. Fade-out 40 ms. Master 420 ms. |
| respawn → `respawn-chime` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/CB_Sounddesign - Applicable Sounds - Organic UI and Building Games SFX/UIMisc_Kalimba 3 Up_CB Sounddesign_APPlicable Sounds.wav`; **0.000000 / 0.650000 s**; +0 dB; ×1 pitch | Real three-note kalimba; source ends naturally at 553 ms, padded to 650 ms. Playback gain 0.3. Fade-out 250 ms. Master 650 ms. |
| deny → `deny` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Cinematic Sound Design - UI Interaction Elements/Deny Muted.wav`; **0.000000 / 0.220000 s**; +0 dB; ×1 pitch |  Fade-out 40 ms. Master 220 ms. |
| footstep variant 1 → `footstep-1` | Kenney Impact Sounds: `impact-sounds/Audio/footstep_concrete_000.ogg`; **0.000000 / 0.120000 s**; +0 dB; ×1 pitch | Unchanged legacy encode; 100 Hz highpass and original fade. |
| footstep variant 2 → `footstep-2` | Kenney Impact Sounds: `impact-sounds/Audio/footstep_concrete_001.ogg`; **0.000000 / 0.120000 s**; +0 dB; ×1 pitch | Unchanged legacy encode; 100 Hz highpass and original fade. |
| footstep variant 3 → `footstep-3` | Kenney Impact Sounds: `impact-sounds/Audio/footstep_wood_000.ogg`; **0.000000 / 0.210000 s**; +0 dB; ×1 pitch | Unchanged legacy encode; 100 Hz highpass and original fade. |
| footstep variant 4 → `footstep-4` | Kenney Impact Sounds: `impact-sounds/Audio/footstep_wood_001.ogg`; **0.000000 / 0.210000 s**; +0 dB; ×1 pitch | Unchanged legacy encode; 100 Hz highpass and original fade. |
| jump → `jump` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle3of5/InMotionAudio - Foley T-Shirt/FOLYClth_SinglePats04_InMotionAudio_FoleyT-Shirt.wav`; **0.109535 / 0.120000 s**; +0 dB; ×1 pitch<br>Kenney Impact Sounds: `impact-sounds/Audio/footstep_concrete_000.ogg`; **0.000000 / 0.150000 s**; -6 dB; ×1 pitch | Cloth pat 0 dB with soft concrete push-off -6 dB. Playback gain 0.25. Fade-out 30 ms. Master 150 ms. |
| land (1/2) → `land-1` | Kenney Impact Sounds: `impact-sounds/Audio/footstep_concrete_001.ogg`; **0.000000 / 0.220000 s**; +0 dB; ×1 pitch<br>Synthesized: `Sine 70→70 Hz; exponential decay exp(-4t/d), 1 ms attack, 3 ms release`; **0.000000 / 0.050000 s**; -4 dB; ×1 pitch<br>Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle3of5/InMotionAudio - Foley T-Shirt/FOLYClth_SinglePats04_InMotionAudio_FoleyT-Shirt.wav`; **0.109535 / 0.120000 s**; -8 dB; ×1 pitch | Footstep 0 dB, 50 ms 70 Hz thump -4 dB, cloth pat -8 dB. Playback gain 0.4; fall-speed multiplier 0.6–1.2. Fade-out 40 ms. Master 220 ms. |
| land (2/2) → `land-2` | Kenney Impact Sounds: `impact-sounds/Audio/footstep_wood_001.ogg`; **0.000000 / 0.220000 s**; +0 dB; ×1 pitch<br>Synthesized: `Sine 70→70 Hz; exponential decay exp(-4t/d), 1 ms attack, 3 ms release`; **0.000000 / 0.050000 s**; -4 dB; ×1 pitch<br>Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle3of5/InMotionAudio - Foley T-Shirt/FOLYClth_SinglePats04_InMotionAudio_FoleyT-Shirt.wav`; **0.109535 / 0.120000 s**; -8 dB; ×1 pitch | Footstep 0 dB, 50 ms 70 Hz thump -4 dB, cloth pat -8 dB. Playback gain 0.4; fall-speed multiplier 0.6–1.2. Fade-out 40 ms. Master 220 ms. |

## Output measurements

Decoded OGG / M4A, dBFS. High RMS uses `highpass=f=3000` twice for analysis only; delta = high − full. Duration is decoded sample count / 44100, including codec padding. Masters have exact requested durations; legacy footsteps are measured per channel. `measurements.json` includes master metrics and output hashes.

| Pair | Peak | Duration s | Full RMS | 3 kHz-highpassed RMS (delta) | Bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| `shot-1` | -0.96 / -0.95 | 0.217098 / 0.232200 | -21.44 / -21.47 | -38.58 (-17.14) / -38.44 (-16.98) | 5784 / 4612 |
| `shot-2` | -0.97 / -1.02 | 0.237098 / 0.255420 | -21.44 / -21.86 | -38.56 (-17.12) / -38.86 (-17.01) | 5818 / 4649 |
| `shot-3` | -0.99 / -0.95 | 0.197098 / 0.208980 | -20.91 / -21.00 | -37.90 (-16.98) / -38.05 (-17.05) | 5629 / 4316 |
| `pistol-shot` | -1.03 / -0.97 | 0.167098 / 0.185760 | -19.81 / -19.99 | -31.32 (-11.51) / -31.91 (-11.92) | 5426 / 3936 |
| `splat-1` | -0.98 / -1.05 | 0.117098 / 0.139320 | -24.33 / -25.90 | -29.34 (-5.02) / -30.91 (-5.01) | 5047 / 3136 |
| `splat-2` | -0.94 / -1.02 | 0.117098 / 0.139320 | -25.72 / -26.23 | -30.36 (-4.65) / -31.03 (-4.80) | 5062 / 3291 |
| `splat-3` | -0.94 / -1.01 | 0.117098 / 0.139320 | -25.34 / -26.84 | -29.46 (-4.12) / -31.05 (-4.20) | 4930 / 2946 |
| `body-hit` | -1.02 / -0.96 | 0.172698 / 0.162540 | -13.04 / -13.33 | -25.73 (-12.70) / -26.02 (-12.69) | 5387 / 3592 |
| `death` | -1.10 / -0.92 | 0.447098 / 0.464399 | -18.20 / -18.12 | -27.97 (-9.76) / -28.02 (-9.90) | 7909 / 8044 |
| `hit-confirm` | -0.98 / -1.01 | 0.117098 / 0.139320 | -20.37 / -21.49 | -30.00 (-9.64) / -30.91 (-9.42) | 5314 / 3037 |
| `reload-start` | -0.98 / -0.97 | 0.177098 / 0.185760 | -17.70 / -18.45 | -20.62 (-2.92) / -21.28 (-2.83) | 5715 / 3923 |
| `reload-end` | -0.97 / -0.95 | 0.157098 / 0.162540 | -21.83 / -21.63 | -29.11 (-7.28) / -28.92 (-7.29) | 5347 / 3605 |
| `weapon-switch` | -1.07 / -0.98 | 0.117098 / 0.139320 | -21.06 / -22.30 | -26.76 (-5.70) / -28.08 (-5.79) | 4945 / 3230 |
| `dry-fire` | -1.14 / -1.04 | 0.067098 / 0.092880 | -21.89 / -22.68 | -30.82 (-8.93) / -31.64 (-8.96) | 4534 / 2249 |
| `knife-swing` | -1.03 / -1.05 | 0.200272 / 0.208980 | -12.31 / -13.87 | -18.20 (-5.88) / -19.75 (-5.89) | 5754 / 4261 |
| `knife-hit` | -1.00 / -1.03 | 0.217098 / 0.232200 | -16.76 / -17.27 | -28.49 (-11.73) / -28.70 (-11.43) | 6297 / 4637 |
| `glass-1` | -0.97 / -1.03 | 0.897098 / 0.905578 | -18.40 / -18.82 | -19.30 (-0.90) / -19.77 (-0.95) | 12261 / 15094 |
| `glass-2` | -0.94 / -0.97 | 0.897098 / 0.905578 | -15.63 / -15.76 | -16.30 (-0.67) / -16.45 (-0.69) | 12538 / 14739 |
| `shard-tinkle` | -0.95 / -1.07 | 0.397098 / 0.417959 | -19.63 / -20.65 | -20.50 (-0.87) / -21.55 (-0.90) | 7670 / 7264 |
| `door-handle` | -0.98 / -1.05 | 0.417098 / 0.441179 | -24.32 / -24.09 | -36.63 (-12.31) / -36.25 (-12.16) | 6412 / 5861 |
| `respawn-chime` | -1.03 / -0.92 | 0.647098 / 0.650159 | -21.76 / -22.45 | -28.59 (-6.83) / -29.01 (-6.56) | 7629 / 8266 |
| `deny` | -1.02 / -0.99 | 0.242358 / 0.232200 | -7.72 / -7.62 | -51.53 (-43.81) / -51.20 (-43.58) | 5568 / 4626 |
| `footstep-1` | -0.96 / -1.01 | 0.116100 / 0.116100 | -19.08 / -19.18 | -62.98 (-43.90) / -60.86 (-41.68) | 4586 / 2697 |
| `footstep-2` | -0.99 / -0.97 | 0.116100 / 0.116100 | -20.94 / -20.94 | -44.13 (-23.19) / -44.30 (-23.36) | 4894 / 2694 |
| `footstep-3` | -1.04 / -1.00 | 0.232200 / 0.232200 | -19.69 / -19.66 | -84.94 (-65.26) / -77.73 (-58.08) | 4313 / 3014 |
| `footstep-4` | -0.95 / -1.01 | 0.232200 / 0.232200 | -19.81 / -19.85 | -83.02 (-63.20) / -75.74 (-55.89) | 4272 / 2984 |
| `jump` | -1.09 / -1.05 | 0.147098 / 0.162540 | -20.22 / -20.56 | -37.02 (-16.80) / -37.14 (-16.58) | 4920 / 3270 |
| `land-1` | -1.03 / -1.02 | 0.217098 / 0.232200 | -22.42 / -22.71 | -46.53 (-24.11) / -46.28 (-23.57) | 4895 / 3290 |
| `land-2` | -0.93 / -0.98 | 0.217098 / 0.232200 | -19.79 / -20.11 | -46.70 (-26.91) / -46.57 (-26.47) | 4932 / 3493 |

Total: 29 pairs; largest file 15,094 bytes. Limit: 150,000 bytes per file.

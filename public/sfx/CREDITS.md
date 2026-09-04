# Pascal Strike sound credits

Sonniss excerpts: **Sonniss GDC Game Audio Bundle (2026)** — royalty-free; commercial use and modification allowed. Copyright remains with the respective recording creators named in the source paths. These recordings are not CC0.

License supplied with the bundle: `Sonniss.com-GDC2026-GameAudioBundle2of5/License - GDC Game Audio.pdf`. The bundle Readme also permits personal/commercial use without attribution. The license prohibits selling the sounds as standalone recordings and prohibits AI training. These edited excerpts are incorporated into Pascal Strike.

Preserved footsteps (and wood door layer if used): [Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds), version 1.0, 2019-12-19, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

Build: `bash scripts/sfx/build-sfx.sh`. `SONNISS_DIR` defaults to `/Users/wawa/Documents/Projects/assets/Sonniss2026`; `KENNEY_DIR` retains the previous recipe defaults. Sources are read in place; temporary PCM and masters are removed on exit. No bundle files are copied into the repository. Only edited OGG/M4A outputs and their reports are distributed here.

Processing: 44.1 kHz mono float PCM, 80 Hz highpass for rumble, 1 ms fade-in; no lowpass, compression, limiting, or loudness normalization. Masters use gain-only normalization to -1 dBFS. Layer gains are relative to peak-matched layers before the final master normalization. OGG uses libvorbis q4; M4A uses mono AAC 128 kbps. Gain-only encode/decode correction targets -1 dBFS (±0.15 dB codec tolerance). All new encodes are mono. The eight existing footstep files remain byte-identical, including their dual-mono stereo OGG files and original 100 Hz highpass/fades.

Manifest mix: shots 0.9, splats/body/knife/death 0.8, deny 0.6, announcers 0.7. Announcer gain 0.7 provides −3.10 dB attenuation; door gain is the previous 0.39 multiplied by −6 dB (0.501187). These attenuations are applied at playback so the file peaks remain normalized. Footstep gain/variants/pitch jitter are unchanged. Deny and announcer entries are prepared in the manifest; the existing SoundName API and gameplay triggers are unchanged. Optional entries have no added synth fallback.

## Selection evidence

Marker detection found 343 distinct peaks above −12 dBFS and 29 candidates passing isolation. Peaks use 1 ms amplitude envelopes, with 40 ms nonmaximum suppression to treat one ringing transient as one event. The preceding 120 ms is measured by its maximum amplitude and ends 5 ms before the peak (the cut/attack boundary). It must be ≥18 dB quieter; no second detected peak may occur in the following 150 ms. Candidates are ranked by that isolation margin.

No marker fallback needed. Four cleanest candidates were selected; the brightest candidate (double-highpassed/full RMS ratio; shortest 90% energy time breaks ties) supplies the 140 ms pistol. The other three retain their isolation order as 220 ms marker shots with 60 ms fade-out.

Optional whip layer omitted to retain the natural marker transient and character.

| Candidate peak time | Source peak | Preceding isolation | High/full RMS delta | 90% energy time |
| ---: | ---: | ---: | ---: | ---: |
| 21.697506 s | -4.01 dBFS | 31.71 dB | -15.42 dB | 0.025533 s |
| 30.768617 s | -3.38 dBFS | 27.41 dB | -13.79 dB | 0.027370 s |
| 39.715850 s | -6.40 dBFS | 27.16 dB | -14.00 dB | 0.145624 s |
| 69.437982 s | -5.90 dBFS | 26.74 dB | -6.40 dB | 0.077438 s |

Wall-splat peak times: 0.002290, 0.130431, 0.256984 s. Separate hits are used when available; otherwise the recipe makes ±3% pitch variants.

Door first-movement peak: 0.260091 s. The RMS of the 400–750 ms late tail is -15.34 dB relative to the first 150 ms after that peak. A tail above −18 dB triggers the wood/latch fallback. Fallback used.

## Exact sources and cuts

Sonniss paths below are relative to `SONNISS_DIR`; Kenney paths are relative to `KENNEY_DIR`. Each source cut is `start / duration` in seconds before pitch changes, padding, mixing, and fades. Footstep cut limits are from the original recipe (shorter sources end naturally).

| Sound → output pair | Exact source file; cut start / duration | Processing |
| --- | --- | --- |
| shot (1/3) → `shot-1` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Public Spaces - Crowds Walla and Everyday Ambiences/AMBWar_Paintball Match Firefight Shots Walla Nearfield Full 05_ESM_CPS.wav`; **21.692506 / 0.220000 s**; +0 dB layer; ×1 pitch | Isolated marker; no whip layer. Fade-out 60 ms. |
| shot (2/3) → `shot-2` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Public Spaces - Crowds Walla and Everyday Ambiences/AMBWar_Paintball Match Firefight Shots Walla Nearfield Full 05_ESM_CPS.wav`; **30.763617 / 0.220000 s**; +0 dB layer; ×1 pitch | Isolated marker; no whip layer. Fade-out 60 ms. |
| shot (3/3) → `shot-3` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Public Spaces - Crowds Walla and Everyday Ambiences/AMBWar_Paintball Match Firefight Shots Walla Nearfield Full 05_ESM_CPS.wav`; **39.710850 / 0.220000 s**; +0 dB layer; ×1 pitch | Isolated marker; no whip layer. Fade-out 60 ms. |
| pistolShot → `pistol-shot` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Public Spaces - Crowds Walla and Everyday Ambiences/AMBWar_Paintball Match Firefight Shots Walla Nearfield Full 05_ESM_CPS.wav`; **69.432982 / 0.140000 s**; +0 dB layer; ×1 pitch | Brightest of the four; +3 dB presence bell at 4 kHz. Fade-out 40 ms. |
| splat variant 1 → `splat-1` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Tower Defense Game/WOODImpt_Hit Blood Spill Splat Wood Impact Light Hit Squelch Small Thump 03_ESM_TDG.wav`; **0.000000 / 0.120000 s**; +0 dB layer; ×1 pitch | Separate detected wall-splat hit. Fade-out 25 ms. |
| splat variant 2 → `splat-2` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Tower Defense Game/WOODImpt_Hit Blood Spill Splat Wood Impact Light Hit Squelch Small Thump 03_ESM_TDG.wav`; **0.127431 / 0.120000 s**; +0 dB layer; ×1 pitch | Separate detected wall-splat hit. Fade-out 25 ms. |
| splat variant 3 → `splat-3` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Tower Defense Game/WOODImpt_Hit Blood Spill Splat Wood Impact Light Hit Squelch Small Thump 03_ESM_TDG.wav`; **0.253984 / 0.078215 s**; +0 dB layer; ×1 pitch | Separate detected wall-splat hit. Fade-out 25 ms. |
| hit → `body-hit` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Halloween Game - Haunted House and Horror Audio Scare Kit/GORESplt_Gore Designed Transient Heavy Impact Smash 01_ESM_HALG.wav`; **0.011599 / 0.180000 s**; +0 dB layer; ×1 pitch<br>Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle1of5/344 Audio - Elemental Palette Designed Vol. 1/WATRMisc_Water, Liquid Impact, Bubble, Sci Fi, Hit 04_344 Audio_Elemental Palette Designed Vol 1.wav`; **0.248333 / 0.180000 s**; -6 dB layer; ×1 pitch |  Fade-out 40 ms. |
| death → `death` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Halloween Game - Haunted House and Horror Audio Scare Kit/GORESplt_Gore Designed Transient Heavy Impact Smash 01_ESM_HALG.wav`; **0.011599 / 0.360000 s**; +0 dB layer; ×1 pitch<br>Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle1of5/344 Audio - Elemental Palette Designed Vol. 1/WATRMisc_Water, Liquid Impact, Bubble, Sci Fi, Hit 04_344 Audio_Elemental Palette Designed Vol 1.wav`; **0.248333 / 0.360000 s**; -3 dB layer; ×1 pitch |  Fade-out 60 ms. |
| hitConfirm → `hit-confirm` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Cinematic Sound Design - Interface & Infographics/Interface Percussion Snap.wav`; **0.000000 / 0.100000 s**; +0 dB layer; ×1 pitch |  Fade-out 20 ms. |
| reloadStart → `reload-start` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - HD Lock And Mechanism Sound Design Kit/MACHMech_Mechanism Counting Machine Interact Loose Container Short 01_ESM_HDLM.wav`; **0.066376 / 0.180000 s**; +0 dB layer; ×1 pitch |  Fade-out 40 ms. |
| reload / reloadEnd → `reload-end` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - HD Lock And Mechanism Sound Design Kit/MECHLtch_Click Deep Mechanism Latch Button Nearfield Thunk 02_ESM_HDLM.wav`; **0.010578 / 0.160000 s**; +0 dB layer; ×1 pitch |  Fade-out 40 ms. |
| weaponSwitch → `weapon-switch` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - HD Lock And Mechanism Sound Design Kit/METLTonl_Item Spring Wire Impact Flick Top Clatter Light Tap Roll Handling Short 01_ESM_HDLM.wav`; **7.332329 / 0.110000 s**; +0 dB layer; ×1 pitch |  Fade-out 25 ms. |
| dryFire → `dry-fire` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - HD Lock And Mechanism Sound Design Kit/METLTonl_Item Spring Wire Impact Flick Top Clatter Light Tap Roll Handling Short 01_ESM_HDLM.wav`; **3.479993 / 0.080000 s**; +0 dB layer; ×1 pitch |  Fade-out 25 ms. |
| knifeSwing → `knife-swing` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/David Dumais Audio - Melee Weapons Sound Effects Pack 2/METLFric_SWING SCRAPE Swift Melee Weapon Swing With A Long Blade 14_DDUMAIS_MWP2.wav`; **0.030091 / 0.200000 s**; +0 dB layer; ×1 pitch |  Fade-out 40 ms. |
| knifeHit → `knife-hit` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/David Dumais Audio - Melee Weapons Sound Effects Pack 2/SWSH_SWING IMPACTS Quick Heavy Weapon Swing To Thud Impact Var 01_DDUMAIS_MWP2.wav`; **39.210624 / 0.220000 s**; +0 dB layer; ×1 pitch<br>Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Halloween Game - Haunted House and Horror Audio Scare Kit/GORESplt_Gore Designed Transient Heavy Impact Smash 01_ESM_HALG.wav`; **0.011599 / 0.220000 s**; -6 dB layer; ×1 pitch |  Fade-out 50 ms. |
| glassBreak (1/2) → `glass-1` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Tower Defense Game/ICEBrk_Skill Freeze Whoosh Break Impact Layered Movement Shatter 03_ESM_TDG.wav`; **0.452132 / 0.450000 s**; +0 dB layer; ×1 pitch | Impact peak minus 10 ms; whoosh onset skipped. Fade-out 60 ms. |
| glassBreak (2/2) → `glass-2` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Elemental Mutation Whooshes and Impacts/GLASMvmt_Whoosh Glass Crystal Fragments Sharp Shards Dry 05_ESM_EMWI.wav`; **1.480998 / 0.450000 s**; +0 dB layer; ×1 pitch |  Fade-out 60 ms. |
| shardTinkle → `shard-tinkle` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Elemental Mutation Whooshes and Impacts/GLASMvmt_Whoosh Glass Crystal Fragments Sharp Shards Dry 05_ESM_EMWI.wav`; **1.670998 / 0.200000 s**; +0 dB layer; ×1 pitch | 200 ms slice after the main shard transient. Fade-out 40 ms. |
| door → `door-handle` | Kenney Impact Sounds: `impact-sounds/Audio/impactWood_light_002.ogg`; **0.000000 / 0.300000 s**; +0 dB layer; ×1 pitch<br>Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - HD Lock And Mechanism Sound Design Kit/MECHLtch_Click Deep Mechanism Latch Button Nearfield Thunk 02_ESM_HDLM.wav`; **0.010578 / 0.160000 s**; -6 dB layer; ×1 pitch | Long door decay; Kenney wood plus Sonniss latch. Playback attenuated 6 dB. Fade-out 40 ms. |
| respawn → `respawn-chime` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Cinematic Sound Design - Hybrid Game & UI Elements/Game Entry Happy Short.wav`; **0.000000 / 0.314320 s**; +0 dB layer; ×1 pitch |  Fade-out 40 ms. |
| deny → `deny` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Cinematic Sound Design - UI Interaction Elements/Deny Muted.wav`; **0.000000 / 0.220000 s**; +0 dB layer; ×1 pitch |  Fade-out 40 ms. |
| announcerHeadshot → `announcer-headshot` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Shooter Game Announcer Voice/VOXMale_Announcer Vocal Male Dry Special Kill Headshot 01_ESM_SGAV.wav`; **0.004943 / 0.768345 s**; +0 dB layer; ×1 pitch | Whole phrase; manifest gain 0.7 supplies approximately -3 dB playback attenuation. Fade-out 25 ms. |
| announcerTenLeft → `announcer-ten-left` | Sonniss GDC 2026: `Sonniss.com-GDC2026-GameAudioBundle2of5/Epic Stock Media - Shooter Game Announcer Voice/VOXFutz_Announcer Vocal Male Wet Countdown Ten Kills Remaining 03_ESM_SGAV.wav`; **0.000000 / 1.416825 s**; +0 dB layer; ×1 pitch | Whole phrase; manifest gain 0.7 supplies approximately -3 dB playback attenuation. Fade-out 25 ms. |
| footstep variant 1 → `footstep-1` | Kenney Impact Sounds: `impact-sounds/Audio/footstep_concrete_000.ogg`; **0.000000 / 0.120000 s**; +0 dB layer; ×1 pitch | Unchanged legacy encode; 100 Hz highpass and original fade. |
| footstep variant 2 → `footstep-2` | Kenney Impact Sounds: `impact-sounds/Audio/footstep_concrete_001.ogg`; **0.000000 / 0.120000 s**; +0 dB layer; ×1 pitch | Unchanged legacy encode; 100 Hz highpass and original fade. |
| footstep variant 3 → `footstep-3` | Kenney Impact Sounds: `impact-sounds/Audio/footstep_wood_000.ogg`; **0.000000 / 0.210000 s**; +0 dB layer; ×1 pitch | Unchanged legacy encode; 100 Hz highpass and original fade. |
| footstep variant 4 → `footstep-4` | Kenney Impact Sounds: `impact-sounds/Audio/footstep_wood_001.ogg`; **0.000000 / 0.210000 s**; +0 dB layer; ×1 pitch | Unchanged legacy encode; 100 Hz highpass and original fade. |

## Output measurements

Measured after decoding, OGG / M4A order. Legacy dual-mono footsteps are measured per channel, without summing L/R. High RMS applies `highpass=f=3000` twice **for analysis only**; delta is high RMS minus full RMS. Duration is decoded sample count / 44100 (AAC padding may extend it). `measurements.json` also records exact master duration/peak, encoder channels, source selections, and SHA-256 hashes.

| Output pair | Peak dBFS | Duration s | Full RMS dBFS | High RMS dBFS (delta dB) | Bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| `shot-1` | -1.08 / -1.04 | 0.217098 / 0.232200 | -22.89 / -23.34 | -38.68 (-15.79) / -38.85 (-15.51) | 5779 / 4607 |
| `shot-2` | -0.98 / -0.98 | 0.217098 / 0.232200 | -21.75 / -22.28 | -35.68 (-13.93) / -36.04 (-13.76) | 5876 / 4615 |
| `shot-3` | -1.03 / -1.07 | 0.217098 / 0.232200 | -21.84 / -22.07 | -35.68 (-13.84) / -36.21 (-14.14) | 6200 / 4745 |
| `pistol-shot` | -0.99 / -1.07 | 0.137098 / 0.162540 | -26.95 / -28.12 | -33.14 (-6.19) / -33.99 (-5.87) | 5337 / 3352 |
| `splat-1` | -0.99 / -0.95 | 0.121905 / 0.139320 | -13.86 / -14.01 | -21.57 (-7.72) / -21.62 (-7.62) | 5276 / 3050 |
| `splat-2` | -0.94 / -1.02 | 0.117098 / 0.139320 | -25.72 / -26.23 | -30.36 (-4.65) / -31.03 (-4.80) | 5062 / 3291 |
| `splat-3` | -0.92 / -1.02 | 0.075306 / 0.092880 | -28.33 / -29.61 | -29.93 (-1.60) / -31.38 (-1.76) | 4562 / 2689 |
| `body-hit` | -0.98 / -0.98 | 0.193016 / 0.185760 | -14.30 / -14.20 | -20.12 (-5.82) / -20.14 (-5.94) | 5671 / 3913 |
| `death` | -0.94 / -0.93 | 0.372971 / 0.371519 | -15.48 / -15.51 | -21.93 (-6.44) / -21.99 (-6.48) | 7653 / 6690 |
| `hit-confirm` | -0.98 / -0.96 | 0.097098 / 0.116100 | -20.22 / -21.24 | -33.86 (-13.64) / -34.78 (-13.55) | 4833 / 2827 |
| `reload-start` | -0.98 / -0.97 | 0.177098 / 0.185760 | -17.70 / -18.45 | -20.62 (-2.92) / -21.28 (-2.83) | 5715 / 3923 |
| `reload-end` | -0.97 / -1.00 | 0.157098 / 0.162540 | -24.01 / -23.79 | -30.19 (-6.18) / -29.96 (-6.17) | 5346 / 3731 |
| `weapon-switch` | -1.08 / -1.05 | 0.132063 / 0.116100 | -14.53 / -14.02 | -37.06 (-22.54) / -36.51 (-22.49) | 4775 / 2936 |
| `dry-fire` | -0.98 / -0.98 | 0.091429 / 0.092880 | -10.30 / -9.99 | -32.72 (-22.42) / -32.04 (-22.05) | 4776 / 2442 |
| `knife-swing` | -1.03 / -1.05 | 0.200272 / 0.208980 | -12.31 / -13.87 | -18.20 (-5.88) / -19.75 (-5.89) | 5754 / 4261 |
| `knife-hit` | -1.00 / -1.03 | 0.217098 / 0.232200 | -16.76 / -17.27 | -28.49 (-11.73) / -28.70 (-11.43) | 6297 / 4637 |
| `glass-1` | -1.07 / -0.96 | 0.447098 / 0.464399 | -16.24 / -16.97 | -25.49 (-9.25) / -26.09 (-9.12) | 7708 / 8254 |
| `glass-2` | -0.97 / -1.03 | 0.447098 / 0.464399 | -15.58 / -16.12 | -16.48 (-0.90) / -17.07 (-0.95) | 8230 / 8152 |
| `shard-tinkle` | -0.95 / -1.07 | 0.200272 / 0.208980 | -17.16 / -18.15 | -18.04 (-0.87) / -19.05 (-0.90) | 5727 / 4254 |
| `door-handle` | -0.94 / -1.05 | 0.372971 / 0.371519 | -23.83 / -24.14 | -41.79 (-17.96) / -42.38 (-18.24) | 5441 / 4683 |
| `respawn-chime` | -1.00 / -1.07 | 0.597098 / 0.603719 | -16.57 / -17.93 | -32.51 (-15.94) / -33.96 (-16.03) | 6749 / 5917 |
| `deny` | -1.02 / -0.99 | 0.242358 / 0.232200 | -7.72 / -7.62 | -51.53 (-43.81) / -51.20 (-43.58) | 5568 / 4626 |
| `announcer-headshot` | -1.07 / -1.08 | 0.765442 / 0.789478 | -14.69 / -14.57 | -23.13 (-8.44) / -23.00 (-8.43) | 11578 / 13376 |
| `announcer-ten-left` | -0.96 / -1.01 | 1.416825 / 1.439637 | -15.84 / -15.89 | -32.74 (-16.91) / -32.67 (-16.79) | 17133 / 23988 |
| `footstep-1` | -0.96 / -1.01 | 0.116100 / 0.116100 | -19.08 / -19.18 | -62.98 (-43.90) / -60.86 (-41.68) | 4586 / 2697 |
| `footstep-2` | -0.99 / -0.97 | 0.116100 / 0.116100 | -20.94 / -20.94 | -44.13 (-23.19) / -44.30 (-23.36) | 4894 / 2694 |
| `footstep-3` | -1.04 / -1.00 | 0.232200 / 0.232200 | -19.69 / -19.66 | -84.94 (-65.26) / -77.73 (-58.08) | 4313 / 3014 |
| `footstep-4` | -0.95 / -1.01 | 0.232200 / 0.232200 | -19.81 / -19.85 | -83.02 (-63.20) / -75.74 (-55.89) | 4272 / 2984 |

Total: 28 masters / 56 encoded files; largest file 23,988 bytes. Limits: 34 masters, 150,000 bytes per file.

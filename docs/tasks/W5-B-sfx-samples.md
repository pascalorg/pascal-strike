# W5-B — Sample-based SFX with a synth fallback

The synthetic sounds are not good enough. Direction (decided): **paintball-authentic, not
military**. Realistic Counter-Strike gunshots would clash with paint splats and the Pascal
brand; the target is a punchy CO2 "thwop" for the marker, a snappier pop for the pistol, wet
splats, hopper/mag clicks for reloads, soft footsteps, a real glass shatter, and clean UI clicks.

You own `src/engine/audio.ts` (+ test), `src/engine/sfx-manifest.ts` (new), `public/sfx/*`,
`scripts/sfx/*` (new).

1. **Sourcing (CC0 only, record the source of every file in `public/sfx/CREDITS.md`)**: download
   Kenney's CC0 packs with curl (https://kenney.nl/assets/impact-sounds, /interface-sounds,
   /sci-fi-sounds, /ui-audio, /casino-audio; the zip URLs are on the pages, e.g.
   `https://kenney.nl/media/pages/assets/<slug>/<hash>/kenney_<slug>.zip` — find the exact link in
   the page HTML). From them pick/compose: impacts for splats and glass, clicks for reload/UI,
   footsteps. For the **marker shot** compose a layered sample with ffmpeg (available at
   /opt/homebrew/bin/ffmpeg): a short CO2 pop (band-passed noise burst 8 ms + a 120→60 Hz thump
   over 40 ms, generated with ffmpeg's `anoisesrc`/`sine` filters), plus a Kenney impact
   transient for the "thwop", plus a 15 ms hiss tail; pistol = same recipe, brighter and shorter.
   Export everything as **OGG (Vorbis q4) and M4A (AAC)** at 44.1 kHz mono, ≤ 120 kB each, loudness
   normalised (`loudnorm`) so peaks sit around −3 dBFS. Aim for ≤ 25 files total.
2. **Manifest** (`sfx-manifest.ts`): name → { urls: [ogg, m4a], gain, variants?: n, pitchJitter }
   for every existing sound name (`shot`, `pistolShot`, `splat`, `hit`, `hitConfirm`, `reload`,
   `reloadStart`, `reloadEnd`, `respawn`, `door`, `footstep`, `death`, `knifeSwing`, `knifeHit`,
   `weaponSwitch`, `glassBreak`, `shardTinkle`, `dryFire`). Variants (2–4 files) for shot, splat,
   footstep, glass.
3. **Player** (`audio.ts`): on `resume()` fetch + decode the manifest lazily (decode in
   parallel, never block gameplay; play the synth version until the sample is ready), cache
   `AudioBuffer`s, play via `AudioBufferSourceNode` with per-call gain, random variant, ±6 %
   pitch jitter, the existing distance attenuation and panning, a hard cap of 24 simultaneous
   voices (steal the oldest), and keep the synth path as the fallback for missing/failed files.
   Keep the public API identical.
4. **Tests**: manifest names match every `play()` name used in `src` (grep), every referenced
   file exists under `public/sfx`, sizes within limits; a fake-AudioContext test that plays a
   buffered sound and a fallback sound.

You cannot listen. Report per sound: source file(s), processing, duration, peak level. Stage only
your files; commit.

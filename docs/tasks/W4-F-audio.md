# W4-F — Audio set for wave 4 (procedural WebAudio, no files)

You own `src/engine/audio.ts` only. Everything is synthesised (oscillators, noise buffers,
envelopes, biquads), like the existing sounds. Keep the existing API and names; add:

| name | sound |
|---|---|
| `reloadStart` | magazine out: a short mechanical clack (two clicks 60 ms apart, band-passed noise + a 900 Hz tick) |
| `reloadEnd` | magazine in + slide: a heavier clack plus a metallic "shk" (noise 2–5 kHz, 90 ms) |
| `pistolShot` | sharper and shorter than `shot`: 30 ms noise burst, 180 Hz thump, quick 1.2 kHz ping tail |
| `knifeSwing` | whoosh: band-passed noise sweeping 400 → 1200 Hz over 140 ms |
| `knifeHit` | wet slap: low thud (90 Hz, 60 ms) + splat noise |
| `weaponSwitch` | soft double click, 40 ms |
| `glassBreak` | shatter: bright noise burst (3–8 kHz, 250 ms) + 8–12 random short sine "tinkles" (2–6 kHz) over 400 ms, slightly detuned |
| `shardTinkle` | a single tinkle, for shards landing |

Rules: no allocations per call beyond the nodes themselves (reuse noise buffers), distance
attenuation and panning through the existing listener path, master gain unchanged, `play`
must ignore unknown names without throwing (it already does; keep that). Also make sure
`reload` (existing) still works for callers that use it.

Verify headlessly: `bun run typecheck`; a `src/engine/audio.test.ts` that instantiates the
module with a minimal fake `AudioContext` (record created nodes and scheduled envelopes)
and asserts every new name schedules at least one node with a finite duration ≤ 1 s and that
unknown names are ignored. You cannot listen; describe each sound's envelope in the report.

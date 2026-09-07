# Performance and matchmaking verification

Run `bun test` and `bun run build`. Browser scripts use an existing Playwright installation
(`PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs`) and Chrome. Start `bun dev --port 5184`.

```
node scripts/verify-death-performance.mjs
node scripts/verify-graphics.mjs
node scripts/verify-matchmaking.mjs
BASE_URL=http://localhost:5184 node scripts/verify-gameplay.mjs
BASE_URL=http://localhost:5184 node scripts/verify-characters.mjs
```

`BASE_URL` overrides the server for each script. The matchmaking/gameplay scripts create
temporary real Playroom rooms using the configured game ID; browsers disconnect at completion.
Graphics screenshots go to `/tmp/pascal-strike-graphics` (override with `ARTIFACT_DIR`).

## Death hitch

The old avatar fade switched every outfit material from opaque to transparent on death. That
forced new render pipelines to compile when a character first died. It also kept submitting
fully faded corpses until respawn. Avatars now enable alpha hashing before their first draw,
fade only opacity, and hide the body after the fade. Respawn preserves the original material
flags and restores its original opacity. The shield retains its own transparency.

September 7, 2026, local headless Chrome: four real character outfits dying simultaneously,
following warmup frames in the character fixture:

| Backend | First-death render before | After |
|---|---:|---:|
| WebGL2 | 306.3 ms | 2.0 ms |
| WebGPU | 14.8 ms | 2.4 ms |

These are CPU update/render submission timings for this fixture, not GPU execution timings
or a guarantee of match FPS on other hardware. The benchmark logs three death/respawn cycles
and asserts stable material flags/versions, corpse hiding, and respawn visibility. It does
not assert a hardware-dependent millisecond threshold. Animation and painted surfaces are
also exercised by `verify-characters.mjs` and the existing character tests.

## Graphics transitions

`verify-graphics.mjs` checks saved preferences, repeated Medium → Low → High → Medium → Low
transitions, actual allocated shadow sizes, pixel budgets after viewport resizing, WebGL AO
limits, no texture-count growth between Low visits, and browser errors on both backends.

Three r185 can retain stale WebGPU shadow bindings when resizing a live shadow target across
post/direct render contexts. A profile change replaces the directional light with a clone at
the new shadow resolution and disposes the old light. Post rebuilds explicitly dispose their
scene/effect render targets and the AA input texture. Low releases the post chain entirely.

## Multiplayer

`verify-matchmaking.mjs` joins two independent clients through Play online, starting with a
six-participant bot-filled room. It checks that the second client discovers that room without
a hash/code, the room settles at two humans/four bots, and the guest adopts the host's map.
It also checks live graphics settings in the Esc menu. `verify-gameplay.mjs` exercises private
creation and invite joining, actual shooting, damage, armor, death, and respawn across clients.

Playroom's [matchmaking documentation](https://docs.joinplayroom.com/features/games/matchmaking)
describes automatic matching with a custom lobby and URL/local-IP isolation. `roomJoinOptions`
ensures explicit codes and invite hashes bypass matchmaking. The installed SDK gives a hash
precedence over `roomCode`, so the wrapper synchronizes a typed code into the URL before joining.

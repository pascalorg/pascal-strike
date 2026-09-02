# W3-B — Hit zones, damage by body part, paint splats on players, health bar

Player feedback: "when shooting an enemy it would be great to see splat on them too", "instead of
3 bars, a full health bar", "handle if we hit the head vs the belly vs arms/legs for the damage".

You own: `src/player/avatar.ts`, `src/player/hitshapes.ts`, `src/weapons/projectiles.ts` (+ test),
`src/net/host.ts`, `src/ui/hud.ts`, `src/game/remote-players.ts`, `src/game/game.ts` (only the
damage → splat wiring and HUD health calls). Contracts already updated (read them): `src/types.ts`
(`BodyPart`, `HitShape`, `Hittable.shapes`, `HitEvent.part`, `DamageEvent.part/amount`),
`src/config.ts` (`DAMAGE`), `src/player/hitshapes.ts` (`createHitShapes`, `computeHitShapes`).

## Deliverables

1. **Hit shapes everywhere**: `avatar.ts` fills `hittable.shapes` every `set(...)` with
   `computeHitShapes` (crouch aware). `src/game/local-player.ts` is owned by another package
   right now: do NOT edit it; instead make `projectiles.ts` fall back to the coarse capsule with
   `part: 'torso'` when `shapes` is missing (the local player's hittable will gain shapes later).
2. **`projectiles.ts`**: narrow phase — after the coarse capsule test passes, test the segment
   against each shape (segment–capsule distance ≤ radius sum, sphere when start === end) and
   pick the closest; set `HitEvent.part`. Tests: a shot at head height reports `head`, at hip
   height `torso`, 0.3 m to the side at shoulder height `arm`, at knee height `leg`.
3. **`host.ts`**: damage = `DAMAGE[part ?? 'torso']`; include `part` and `amount` in the
   `damage` RPC. Everything else unchanged.
4. **Splats on players**: `avatar.ts` gets `addSplat(worldPoint, worldNormal, colorHex)`:
   converts to the nearest body part's local space and attaches a small flattened splat
   (a `Sprite` or a disc `Mesh` with the existing decal alpha maps from `weapons/decals.ts` —
   export a `getSplatTexture(variant)` from there if needed, that file is free to edit for this)
   sized 0.12–0.2 m, oriented to the normal, max 12 per avatar (recycle oldest), cleared on
   `spawn()`. `remote-players.ts`: on `damage` events, call `addSplat` on the victim's avatar
   with the shooter's team colour. Also a bigger splat on `die()` (already exists) in the killer's
   team colour.
5. **Local player hit feedback**: on `damage` where the victim is me, the HUD shows a paint
   splash overlay in the shooter's team colour from the hit direction (replace the plain
   vignette): 2–3 splat shapes at the screen edge that drip and fade over 1.2 s. `hud.ts` API:
   `paintHit(dirXZ, team, part)`; headshots get a heavier splash.
6. **Health bar**: replace the 3 segments with one continuous bar (team-neutral white, turns
   orange under 40 hp, red under 20; animates with a 200 ms ease; a trailing "ghost" bar shows
   the damage just taken). Keep `hud.setHp(n)`.
7. **Hit marker by part**: `hud.hitMarker(part)` — headshot variant (slightly larger, brief
   team-colour flash). Wire in `game.ts` from the `damage` event where `by` is me.

## Verification
- `bun run typecheck`, `bun test` green with the new projectile tests.
- Headless browser run of the default route (as previous agents did over CDP, two browsers or
  bots): confirm a headshot does 50, torso 34, limb 20 (hp readouts), splats appear on the hit
  avatar and persist until respawn, the health bar animates, the paint splash shows on the victim.
- Stage only your files; commit.

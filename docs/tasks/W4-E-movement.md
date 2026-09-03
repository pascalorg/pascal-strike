# W4-E — Doors block, open windows let you through, and the real stairs

You own `src/player/controller.ts` (+test), `src/dev/test-room.ts`, `src/game/map-session.ts`,
`src/bots/bot.ts` (only the dynamic-collider hookup), `src/dev/fixtures/*` (new). Contract:
`CharacterController.setDynamicColliders(meshes)` in `src/types.ts`.

## 1. Dynamic colliders
Doors are currently walk-through even when closed, and open windows cannot be passed. Give the
controller a list of moving obstacles: `setDynamicColliders(meshes)` where each mesh has a
boundsTree and a live `matrixWorld` (the openables' `leafMeshes` from `MapData.doors`; the map
package is removing them from the movement collider). Each fixed step, after the static pass,
run the same capsule push-out against every dynamic mesh whose world AABB overlaps the capsule
(transform the capsule segment into the mesh's local space with the inverse matrixWorld, run
shapecast, transform the push back). A leaf is solid wherever it is: closed = blocks the
doorway, open = lies against the wall and you pass beside it, mid-swing = pushes you. Ground
detection must also see dynamic meshes (standing on an open sash is fine). Wire it in
`map-session.ts` for the local player and in `bots/bot.ts` for bots (`opts.map.doors`).
Add a test with a rotating box leaf: closed blocks (no penetration > 1 cm), open (90°) lets the
capsule through the same doorway.

## 2. Open windows
Pascal windows: sill ≈ 0.9 m above the floor, opening ≈ 1.2 m tall. Standing height is 1.75 m,
crouched 1.15 m. Verify what actually fits: a crouched capsule should pass through the open
Floor-1 window in pascal-house (climb onto the sill: `stepHeight` is 0.45, the sill may need a
jump). If crouched passage works, the answer to the user is "crouch (Ctrl) to go through";
if the frame geometry blocks even crouched, say exactly which part and by how much. Name tags
are sprites and never collide.

## 3. Stairs on the real map
The user reports walking up the house staircase does not work (jumping does). The synthetic
stair test passes, so the difference is in Pascal's geometry. Extract the real stair collider
triangles once: in the map viewer (or a one-off script driven through the browser), gather the
triangles of the movement collider inside the stair's world box (x 0–1.4, z −0.9–1.9, y 0–3.6)
and write them to `src/dev/fixtures/pascal-stair.json` (positions only). Then a headless test
walks the capsule up that exact geometry at run, walk and crouch speed, from several lateral
offsets, and reports where it stops. Diagnose the cause (nosing overhangs, a stringer face,
sloped risers, a landing lip, the tread depth vs the 0.6 m capsule diameter…) and fix the
controller (step-up sweep that tolerates overhangs, probing from slightly above the foot,
climbing "slopes" made of sub-step lips, etc.). If the geometry is genuinely unclimbable
without a jump (a riser > `stepHeight`), say so with the numbers so the map can be fixed in
Pascal. Then confirm in the browser: `__ps` walk (2.8 m/s) straight up the flight from the
bottom without jumping reaches Floor 1.

## Verify (headless Chrome `--mute-audio`, kill after; http://localhost:5180; no second Vite):
closed door blocks / open door passes (in-game, with the real doors), crouched window passage
or the precise blocker, real-stairs climb at walk speed, bots still path through doors they
open (they now bump into closed ones: `DOORS.botOpenRadius` is 2.4 m and doors open at
timescale 3; report if bots get stuck). `bun run typecheck`, `bun test` green including all
old controller tests. Stage only your files; commit each part.

# W3-C — Stairs: walk up automatically

Player feedback: "when running on stairs we don't automatically climb; jumping works but not
automatically when walking."

The house's staircase (public/maps/pascal-house.glb, "Staircase 1") measures: riser 0.25 m,
tread 0.25 m (45°), flight box x∈[0, 1.4], z∈[−0.9, 1.9], total rise 3.41 m. Treads are flat
boxes; the collider is a merged world-space mesh with a three-mesh-bvh boundsTree.
`PLAYER.stepHeight` is 0.45 and `maxSlopeDeg` 55 (`src/config.ts`).

You own: `src/player/controller.ts`, `src/player/controller.test.ts`, `src/dev/test-room.ts`.

## Work
1. Add a procedural staircase to the headless test room builder (`buildTestRoomGeometry`) with
   exactly that profile (12 steps of 0.25 × 0.25, 1.4 m wide), plus a second, shallower one
   (riser 0.17, tread 0.29) for coverage.
2. Reproduce the bug in `controller.test.ts`: walking straight into the 45° flight (forward = 1,
   no jump) for 4 s must raise the feet by ≥ 3.0 m; currently it does not (report the measured
   value before your fix).
3. Fix step climbing in the controller: a proper step-up pass — when the horizontal move is
   blocked by a contact whose normal is near-horizontal and whose contact point is below feet +
   `stepHeight`, retry the move from `feet + stepHeight` (sweep up, forward, then down onto the
   ground with a shapecast) and accept the result if the landing normal is walkable. It must
   work at run speed (5.5 m/s) and walk speed (2.8 m/s), while crouching, on consecutive steps,
   and must not launch the player into the air (feet stay within 0.05 m of a tread when
   grounded; no "airborne mid-step"). Descending stairs must keep the player grounded (snap down
   up to `stepHeight` when the ground disappears under a walking player), not bouncing.
4. Keep all existing tests green (wall stop, 0.4 m step, crouch under the slab, ramp, random
   input, performance ≤ 200 ms / 1000 steps).

## Verification
- `bun run typecheck`, `bun test` green including the new stair tests with the measured rise.
- Stage only your files; you may be unable to commit in your sandbox — that is fine.

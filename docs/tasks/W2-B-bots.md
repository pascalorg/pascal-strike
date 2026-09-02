# W2-B — Bots package

You own: `src/bots/*`. Read `docs/ARCHITECTURE.md` ("Bots"), `src/types.ts`, `src/config.ts`,
and the delivered W1 modules you will call: `src/player/controller.ts`, `src/weapons/marker.ts`,
`src/map/navmesh.ts`, `src/map/collider.ts` (WorldQuery), `src/map/doors.ts`, `src/net/room.ts`
(`PascalBot`).

## Deliverables

### `src/bots/brain.ts`
`createBotBrain(opts: { self: PlayerEntity; world: WorldQuery; nav: Navigation; rng: () => number;
difficulty?: Partial<typeof BOTS> }) → BotBrain` with
`update(dt, now, enemies: PlayerEntity[], allies: PlayerEntity[], spawns: SpawnLayout) → BotDecision`.

- Perception at `BOTS.decisionHz` (accumulator), movement output every frame.
- Eye = feet + eye height; target point = enemy feet + 1.2 m. LOS via `world.lineOfSight`.
- Reaction delay: an enemy becomes "acquired" `reactionMs` after first being seen continuously.
- States `roam | hunt | engage | retreat` as in ARCHITECTURE.md. Retreat: at hp ≤ 34 with an
  enemy in view, path to the nearest point on the navmesh that has no LOS to the enemy (sample
  8 random points within 6 m, pick the first hidden one), then return to roam after 3 s.
- Aim: desired yaw/pitch toward the predicted target (lead by 0.15 s of the enemy's XZ velocity)
  plus gaussian error (`aimErrorDeg`) resampled every 250 ms, smoothed turn rate ≤ 540°/s.
- Fire only in `engage`, in bursts (`burstShots`, `burstPauseMs`), only when the aim error is
  below 6° and LOS is clear, never at allies (also check no ally within 1.5° of the aim line and
  closer than the target).
- Strafe: in `engage`, pick a strafe direction every 0.8–1.6 s (perpendicular to the target),
  and keep distance in the 4–9 m band (approach if farther, back up if closer). Crouch 20% of
  the time when the target is farther than 8 m.
- Roaming target selection: 60% random navmesh point in the half of the map away from the
  bot's own team spawn anchor, 40% near a random enemy-spawn point. Re-pick on arrival (< 0.6 m)
  or after 12 s.

### `src/bots/navigation.ts`
`createPathFollower(nav: Navigation) → PathFollower`: `setGoal(p)`, `update(feet, dt) →
{ move: MoveInput; yaw: number; arrived: boolean; stuck: boolean }`. Advance the corner index
when within 0.35 m (XZ). Replan every 1.5 s or when stuck (moved < 0.3 m in 1 s while wanting
to move) — when stuck, request a jump for 0.2 s then replan. `move.forward` is expressed in
the frame of the returned `yaw` so the caller can hand it to `CharacterController.update(dt,
move, yaw)`; the brain may override yaw for aiming while still moving toward the path
(compute forward/right by rotating the desired world-space velocity into the aim frame).

### `src/bots/bot.ts`
`createBotRunner(opts: BotRunnerOptions) → BotRunner` (both types in `src/types.ts`; read them).
The runner never imports from `src/net`, `src/weapons/projectiles.ts` or `src/game`: it only
uses the callbacks in `BotRunnerOptions`. For each bot entity (host only): a
`CharacterController` (`src/player/controller.ts`, built on `opts.map.collider`), a `Marker`
(`src/weapons/marker.ts`), a `BotBrain`, a `PathFollower`. Each `update(dt)`: brain → decision →
`controller.update(dt, move, yaw)` → write `entity.position/yaw/pitch/crouching/speed` →
`marker.update(...)` → for each `ShotEvent` call `opts.onShot(entity, shot)` → at
`NET.botSnapshotHz` call `opts.onSnapshot(entity, snapshot)`. Dead bots (`entity.alive ===
false`) do nothing until `respawn(id, position, yaw)` teleports their controller. Bot decisions
must be deterministic for a given seed (mulberry32 keyed by `opts.seed` + bot id hash).
Enemies = `opts.entities()` filtered by other team and alive; allies likewise.

## Verification
- `bun run typecheck` clean; `bun test` still green.
- A headless test `src/bots/brain.test.ts`: with the test room collider + a straight-line
  `Navigation` stub, a bot placed 8 m from a visible enemy enters `engage` after `reactionMs`,
  fires within 1 s, and never fires when the enemy is behind a wall.
- In the game (`bun dev`, default route, once W2 integration exists), alone in a room: bots
  fill both teams, move through doorways (doors open for them), find and shoot you, and respawn.
  Verify with claude-in-chrome tools if available, else describe what you could not verify.
- Commit only your own files.

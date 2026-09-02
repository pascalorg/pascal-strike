# W1-B — Player + Weapons package

You own: `src/engine/input.ts`, `src/engine/audio.ts`, `src/player/*`, `src/weapons/*`,
`src/dev/test-room.ts`, `src/dev/sandbox.ts`. Nothing else (except reading).
Read `docs/ARCHITECTURE.md`, `src/types.ts`, `src/config.ts`, `CLAUDE.md` first.

You work in parallel with two other packages. `src/engine/renderer.ts`, `src/map/*` (collider,
doors, world query) are being written by someone else right now and may not exist yet; do NOT
import them. Your sandbox builds its own tiny renderer + test room so it runs standalone.

## Deliverables

### `src/engine/input.ts`
`createInput(canvas) → Input`:
```ts
interface Input {
  readonly move: MoveInput            // updated every frame from keys (WASD/arrows, Space, Ctrl/C)
  readonly fire: boolean              // left mouse held
  readonly reload: boolean            // R pressed this frame (edge)
  readonly scoreboard: boolean        // Tab held
  consumeLook(): { dx: number; dy: number }   // accumulated mouse deltas since last call (pointer lock)
  readonly locked: boolean
  requestLock(): void; onLockChange(cb: (locked: boolean) => void): () => void
  dispose(): void
}
```
Pointer lock on click of the canvas; `Tab` must `preventDefault`. Edge-triggered keys reset at
the end of `update()` (expose `update()` to be called once per frame by the caller).

### `src/player/controller.ts`
`createCharacterController(collider: StaticCollider, opts?: Partial<typeof PLAYER>) → CharacterController`
per ARCHITECTURE.md "Player controller". Use `three-mesh-bvh` `shapecast` against
`collider.geometry.boundsTree` exactly like the library's `characterMovement` example (capsule
segment vs triangle closest points, iterate push-out). Implement step climbing (`stepHeight`),
slopes (`maxSlopeDeg`), crouch with stand-up clearance check (upward shapecast), coyote-free
jump (grounded only), `airControl`. Deterministic given `(dt, input, yaw)`.
The controller needs BVH prototypes patched: do it in your own `src/player/bvh-setup.ts`
(idempotent: only patch if `BufferGeometry.prototype.computeBoundsTree` is undefined).

### `src/player/camera.ts`
`createFpsCamera(camera: PerspectiveCamera) → FpsCamera` with `update(dt, feet: Vector3,
eyeHeight, yaw, pitch, speed, grounded)`, `kick(pitchRad, yawRad)` (recoil impulse + spring
recovery), `landing(vy)` (dip), view bob (small, speed-scaled, grounded only). Also exposes
`getLookDirection(out)` and `getEyePosition(out)`.

### `src/player/viewmodel.ts`
`createViewModel(camera) → ViewModel`: a procedural first-person paintball marker (body,
hopper on top, barrel, grip, gloved hands) built from primitives with `MeshStandardMaterial`
(dark grey body, team-colour accent stripe), parented to the camera (lower-right). `update(dt,
speed, grounded, aiming?)` sway/bob; `fire()` kick back; `reload(progress 0..1)` tilt down;
`setTeam(TeamId)`. Render on top: `renderOrder` high, materials `depthTest: false` is fine.

### `src/player/avatar.ts`
`createAvatar(team, name) → Avatar` per ARCHITECTURE.md "Avatars". API: `object: Group`,
`set(position, yaw, pitch, crouching, speed)`, `flashHit()`, `die()`, `spawn()`,
`setInvincible(bool)`, `setTeam`, `setName`, `hittable(): Hittable` (capsule from the current
pose), `dispose()`. Bounding: total height 1.75 m, radius 0.3.

### `src/weapons/marker.ts`
`createMarker(opts) → Marker`: `update(dt, firing: boolean, reloadPressed: boolean, origin,
dir) → ShotEvent[]` (0 or 1 per frame, honours fire rate with accumulator so 9 Hz is exact
regardless of frame rate), `hopper`, `reserve = Infinity`, `reloading`, `reloadProgress`,
spread (gaussian via Box-Muller from a seeded RNG), `seed` per shot from a counter. Shot ids
`${ownerId}:${n}`.

### `src/weapons/projectiles.ts`
`createProjectiles(scene, world: WorldQuery, decals, effects, audio) → Projectiles`:
`spawn(shot: ShotEvent, opts: { detectPlayers: boolean })`, `update(dt, hittables: Hittable[])`,
`onPlayerHit(cb: (hit: HitEvent) => void)`. Instanced spheres tinted per team (two
`InstancedMesh`es or one with instance colour). Sub-step long frames so bullets never tunnel
(max 0.5 m per raycast step). Player capsule test only when `detectPlayers` and only against
enemy team + alive + not the shooter. First hit wins (compare distances vs the static hit).

### `src/weapons/decals.ts`
`createDecals(scene) → Decals` with `add(target: Object3D & { geometry }, point, normal, team,
seed)` per ARCHITECTURE.md "Weapons/decals". Procedural splat alpha maps (4 canvas variants,
512 px). If the target is a door leaf (has a parent that is not the scene), attach the decal to
that leaf (convert the projection into leaf space) so it moves with the door.

### `src/weapons/effects.ts`
Muzzle puff, splat burst, tracer-less. Simple `Points` or a few `Sprite`s pooled; no
allocations per shot after warm-up. `update(dt)`.

### `src/engine/audio.ts`
`createAudio() → Audio` with `resume()` (on first user gesture), `play(name, at?: Vector3,
listener?: { position, forward })` for: `shot`, `splat`, `hit`, `hitConfirm`, `reload`,
`respawn`, `door`, `footstep`, `death`. All synthesised with WebAudio (oscillators + noise
buffers + envelopes + biquad). Distance attenuation (1/d, floor 0.05) and stereo pan from the
listener basis.

### `src/dev/test-room.ts`
`buildTestRoom(scene) → { collider: StaticCollider; world: WorldQuery; bounds: Box3; doors: [] }`:
a 16×12 m room, 3 m high, textured with a procedural checker `CanvasTexture`; inside: two
boxes (1.2 m), a 0.4 m step block, a slab at 1.3 m height you can crouch under, a 20° ramp,
a pillar. Build the collider by merging geometries (position + normal) and `computeBoundsTree`.
Implement a minimal `WorldQuery` (static only) here — the real one lives elsewhere.

### `src/dev/sandbox.ts`
`start()`: `WebGPURenderer` (init, WebGL fallback is automatic), `Scene`, lights (hemisphere +
directional with shadows), test room, local player (controller + FPS camera + input + view
model + marker + projectiles + decals + effects + audio), and **three target dummies** using
`avatar.ts` (two enemies walking a slow patrol, one ally standing) with `hittable()` feeding
`projectiles.update`. On player hit: `flashHit()`, decrement a fake hp, `die()` at 0 then
respawn after 2 s. Minimal DOM overlay: hp, hopper, reloading, fps, "click to play". Keys as in
`input.ts`. Every gameplay constant from `config.ts`.

## Verification (do all, report exactly what you saw)
1. `bun run typecheck` clean.
2. `bun dev` (background) → open `http://localhost:5173/?sandbox=1` with the `claude-in-chrome`
   MCP tools (load via ToolSearch `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_console_messages,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__javascript_tool`).
   Pointer lock cannot be granted by automation, so expose `window.__ps = { input, controller,
   marker, ... }` and a `?autopilot=1` flag that drives the player with a scripted route (walk to
   the step and over it, under the low slab crouching, up the ramp, shoot the wall 10 times and
   an enemy dummy 3 times) while you screenshot and read the console. Confirm: no console
   errors, decals appear where bullets land, the dummy dies after 3 hits, the step is climbed
   without jumping, the low slab is impassable standing and passable crouching, sliding along
   walls has no jitter, frame time stays < 4 ms at 1080p.
3. Commit your work on completion with a clear message (git user is already configured).
   `main.ts` already routes `?sandbox=1` to `src/dev/sandbox.ts` (`export async function start()`).

Report: what works, what you could not verify, any contract gaps you found in `types.ts`.

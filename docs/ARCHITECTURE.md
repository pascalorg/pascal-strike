# Pascal Strike — Architecture

3v3 paintball deathmatch in maps built with **Pascal** (our 3D home editor), exported as GLB.
The game is a showcase: *build a house in Pascal → export → play in it with friends*.

Decisions already made (do not re-litigate):

- Vite 8 + TypeScript, **no framework**. DOM UI written in plain TS + CSS.
- three.js **0.185** with `WebGPURenderer` (automatic WebGL2 fallback).
- Collision & raycasts: **three-mesh-bvh**. Bot pathfinding: **recast-navigation**.
- Multiplayer: **Playroom Kit** (`playroomkit`) with `skipLobby: true` and our own lobby.
  3v3 from the first second: empty slots are filled with **host-simulated bots**.
- Custom maps: a dropped GLB is uploaded to a public Supabase Storage bucket (`maps`) and its URL
  is shared through Playroom state.
- Mode v1: **Team deathmatch**, 3 hits to die (100 hp, 34 dmg), instant respawn at team spawn
  after 2.5 s with 3 s invincibility. First team to 30 kills or 5 min.
- Doors and openable windows toggle with **E** (state synced to every client). Doors are for
  passage (leaves never block players, closed leaves block paintballs); windows are for paint
  (sashes never let players through; a closed sash blocks paintballs, an open one does not).
- Movement: running is the default, **Shift walks** (slow, precise). Accuracy depends on
  motion (standing 0.12° → running 1.6° → airborne 2.8°). Damage by body part: head 50,
  torso 34, arms/legs 20.
- Desktop only (pointer lock + WASD). Mobile gets a "play on desktop" screen.
- Branding: Pascal's palette (zinc dark theme), fonts Barlow (display) / Inter (UI) / JetBrains
  Mono (numbers), logo in `public/brand/`. Team colours: Orange `#f97316` vs Teal `#14b8a6`.

## Commands

```
bun install
bun dev                 # http://localhost:5180
bun run typecheck       # tsc --noEmit — must pass before you report done
bun run build
bun run inspect-glb public/maps/pascal-house.glb   # dump a Pascal GLB's node tree / extras
```

## Conventions

- Import core classes from `'three'` (`Vector3`, `Mesh`, …). Import the renderer and node
  materials from `'three/webgpu'`, TSL from `'three/tsl'`. Both share `three.core.js`, so
  there is no double-copy problem. Never import `WebGLRenderer`.
- Do **not** add dependencies. Everything needed is in `package.json`. If you truly need
  something, stop and say so in your report.
- All gameplay numbers live in `src/config.ts`. All cross-module interfaces live in
  `src/types.ts`. Read both before writing code.
- Reuse `Vector3` instances (module-level scratch vectors) in per-frame code. No allocations
  in hot loops.
- Every module exposes a small explicit API (a class or a factory function). No globals
  except `window.__ps` for debugging (optional).
- `Date.now()` is the shared clock for network timestamps; `performance.now()` for frame timing.
- Keep files under ~400 lines; split when bigger.
- Comments explain *why*, not *what*.

## Folder layout and ownership

```
src/
  main.ts                 boot: platform check → lobby → game
  config.ts               tuning + env               (shared, owned by the architect)
  types.ts                shared contracts           (shared, owned by the architect)
  engine/
    renderer.ts           WebGPURenderer, scene, camera, resize, frame loop, stats     [W1-A]
    loaders.ts            GLTFLoader + MeshoptDecoder + KTX2Loader (WebGPU)           [W1-A]
    environment.ts        lights, sky/env map, fog                                    [W1-A]
    input.ts              pointer lock, keyboard, mouse → MoveInput + look deltas     [W1-B]
    audio.ts              procedural WebAudio SFX                                     [W1-B]
    events.ts             typed EventBus implementation                               [W1-A]
  map/
    map-loader.ts         load GLB (url or File) → MapData                            [W1-A]
    map-parse.ts          walk Pascal extras → levels/zones/spawns/doors              [W1-A]
    collider.ts           merged static collider + BVH + WorldQuery                   [W1-A]
    doors.ts              DoorSystem (auto-open, mixer, leaf colliders)               [W1-A]
    spawns.ts             resolveSpawns(map, nav?) → SpawnLayout                      [W1-A]
    navmesh.ts            recast navmesh → Navigation                                 [W1-A]
  player/
    controller.ts         capsule kinematic controller vs BVH (CharacterController)   [W1-B]
    camera.ts             FPS camera rig: eye, recoil, view bob, landing dip          [W1-B]
    viewmodel.ts          first-person marker + hands (procedural)                    [W1-B]
    avatar.ts             third-person avatar (procedural), name tag, hit/death FX    [W1-B]
  weapons/
    marker.ts             fire logic: rate, spread, hopper, reload → ShotEvent        [W1-B]
    projectiles.ts        projectile sim (all shots incl. remote), static/door/capsule [W1-B]
    decals.ts             paint splat decals (DecalGeometry, pooled)                  [W1-B]
    effects.ts            muzzle puff, splat particles, hit marker, tracers           [W1-B]
  net/
    room.ts               Playroom wrapper: insertCoin, players, host, bots           [W1-C]
    protocol.ts           state keys, RPC names, payload types                        [W1-C]
    sync.ts               snapshot send + interpolation buffers for remotes           [W1-C]
    host.ts               host authority: damage, kills, respawn, scores, team fill   [W1-C]
  game/
    match.ts              match state machine (warmup → live → ended → …)             [W1-C]
    teams.ts              balance, names, colours                                     [W1-C]
    entities.ts           PlayerEntity registry (local, remotes, bots)                [W1-C]
    game.ts               orchestrator: wires map, player, weapons, net, bots, HUD    [W2]
  bots/
    bot.ts                Playroom Bot subclass + lifecycle                           [W2-B]
    brain.ts              perception + state machine → BotDecision                    [W2-B]
    navigation.ts         path following, door awareness                             [W2-B]
  ui/
    styles.css            design tokens + components                                 [W1-C]
    lobby.ts              landing/lobby: name, map picker, drop zone, room code       [W1-C]
    hud.ts                crosshair, hp as paint meter, hopper, score, timer, feed    [W1-C]
    scoreboard.ts         Tab scoreboard + end-of-match screen                        [W1-C]
    unsupported.ts        mobile / no-WebGPU-no-WebGL2 screen                         [W1-C]
  storage/
    maps-upload.ts        sha256 → upload to Supabase bucket → public URL              [W1-C]
  dev/
    test-room.ts          procedural box room + obstacles as a MapData stand-in       [W1-B]
    sandbox.ts            `?sandbox=1` page: local player + weapons in the test room  [W1-B]
```

Ownership tags are the work packages below. Do not edit files owned by another package;
if you need something from them, code against `types.ts` and note the gap in your report.

## The Pascal GLB contract (input)

Produced by Pascal's exporter (glTF-Transform, meshopt + KHR_mesh_quantization + KTX2/basisu).
Node tree: `site > building > level* > (wall | slab | ceiling | roof | fence | stair | item |
zone | spawn | column …)`, doors and windows are children of walls.

Every registry node has `name = pascalId` and `userData` (glTF `extras`):

| key        | on              | meaning |
|------------|-----------------|---------|
| `pascalId` | all             | `<kind>_<16 chars>` |
| `kind`     | all             | `level`, `wall`, `door`, `window`, `slab`, `ceiling`, `roof`, `stair`, `fence`, `item`, `zone`, `spawn`, … |
| `label`    | all             | display name ("Door 4", "Living Room", "Floor 1") |
| `openable` | door/window     | `true` only when an open clip was baked |
| `clips`    | door/window/item| clip names, e.g. `["door_kr3p…: open"]` |
| `polygon`  | zone            | `[[x,z],…]` in the zone node's local space (zone = room) |
| `color`    | zone            | hex |
| `rotation` | spawn           | yaw radians |

- Levels are stacked: level node translation Y = floor elevation (0, 2.5, 5 …). Slab top ≈ +0.05.
- Zones and spawns are **empty transform nodes** (no mesh) — keep them, do not prune.
- Door/window open clips: 1 s, `LoopOnce`, rest pose = closed, reverse `timeScale` to close.
  The animated nodes are the *leaves* (`clip.tracks[i].name` = `"<nodeName>.quaternion"` etc.);
  frames/jambs are static siblings.
- Windows: fixed glass is a `BLEND` material mesh; treat as solid for bullets (paint on glass!).
- The two ground meshes at the site root (scale 15) are the terrain plane.
- Test map `public/maps/pascal-house.glb` (v5 export): 3 levels with a staircase, 7 doors and
  2 openable windows with baked clips, zones "Spawn A" (on the lawn north of the house) and
  "Spawn B" (east room). Pascal's `spawn` node is a single walkthrough marker, not a team spawn.

Use `bun run inspect-glb <file>` to see any file's tree.

## Rendering (W1-A)

- `WebGPURenderer({ antialias: true })`, `await renderer.init()`, `setPixelRatio(min(dpr, 2))`.
  If WebGPU is unavailable, the renderer falls back to WebGL2 by itself; if neither works, show
  `ui/unsupported`.
- Tone mapping ACES, sRGB output. `scene.environment` from `RoomEnvironment` + `PMREMGenerator`
  (works with WebGPU in r185) so PBR materials read well indoors.
- Lights: `HemisphereLight` (sky/ground) + `DirectionalLight` sun with a shadow map (2048,
  orthographic frustum fitted to `map.bounds`). Shadows on the map meshes and avatars.
- Loaders: `GLTFLoader` with `MeshoptDecoder` (`three/examples/jsm/libs/meshopt_decoder.module.js`)
  and `KTX2Loader` (`setTranscoderPath('/decoders/')`, `detectSupport(renderer)` after init).
- Frame loop with fixed-step physics (`1/120` s accumulator, max 5 sub-steps) and variable
  render. Expose `onUpdate(dt)` and `onRender()` hooks.

## Map loading (W1-A)

`loadMap(source: string | File, ctx) → Promise<MapData>`:

1. Load GLB (URL or `File` → `ArrayBuffer` → `loader.parse`).
2. Walk the tree, build `levels`, `zones` (polygon → world via `node.localToWorld`), `spawnNodes`
   (world position + yaw from `extras.rotation`, composed with the node's world yaw), `doors`
   (match `extras.openable && clips`, find the clip in `gltf.animations` by name, collect the
   animated nodes from the clip's track names → their descendant meshes = `leafMeshes`).
3. Build the **static collider**: for every visible `Mesh` not under a zone/spawn and not inside
   an animated door/window subtree, bake `matrixWorld` into a world-space copy of its geometry
   (position + normal only, indexed → non-indexed OK), merge with
   `BufferGeometryUtils.mergeGeometries`, `computeBoundsTree({ maxLeafSize: 12 })`, wrap in a
   `Mesh` (invisible, `matrixAutoUpdate = false`). `zone floorY`: raycast down from centroid +1 m.
4. Materials: leave as loaded (`MeshStandardMaterial`), enable `castShadow`/`receiveShadow`
   on meshes, set `side = FrontSide` unless the material is transparent.
5. `bounds` = collider bounding box. `navMeshSource = [collider.mesh]`.

`WorldQuery` (collider.ts) raycasts the static BVH plus every door's `leafMeshes` (each leaf
mesh gets its own `computeBoundsTree()` once; they move with their door, so use
`mesh.matrixWorld` at query time) and returns the nearest hit.

## Doors and windows (openables)

`map-parse.ts` turns every `openable && clips` node of kind `door` or `window` into a
`DoorInfo` (with `kind`). `createDoorSystem(map)`:
- One `AnimationAction` per openable from its clip: `LoopOnce`, `clampWhenFinished`,
  `timeScale = ±DOORS.openTimeScale`; reversing mid-swing continues from the current pose.
- `toggle(id)`, `setOpen(id, open, instant)`, `isOpen`, `openness`, `openStates()`, `onToggle`,
  `findInteractable(origin, dir, range)` (ray vs moving leaf AABBs + closed-pose bbox).
- Interaction: `input.interact` (E edge) → `findInteractable` from the camera within
  `DOORS.interactRange` → RPC `door { id, open, by }` (mode ALL). The host mirrors the state into
  global `doors` so late joiners and map changes apply it instantly (no tween).
- Bots (host only, `game/host-side.ts`): a shut **door** within `DOORS.botOpenRadius` of a bot's
  feet on its floor is toggled through the same RPC (one toggle per door per 1.5 s). Never windows.
- `ui/prompt.ts` shows "E · Open door" / "E · Close window" under the crosshair while in range.
- Colliders: the movement collider excludes door leaves and includes window sashes at their
  closed pose (windows are never passable); the bullet collider excludes all animated leaves,
  which `WorldQuery` tests dynamically via their own BVHs and current `matrixWorld`.

## Spawns (W1-A)

`resolveSpawns(map, nav?) → SpawnLayout`, first rule that yields both teams wins:

1. **Zones** whose `label` matches `SPAWN.zonePattern`. Team by `teamAPattern` / `teamBPattern`
   on the label; if labels carry no team, the first matching zone is A, the second B.
   Sample `pointsPerZone` points inside the polygon (rejection sampling on the bbox,
   point-in-polygon), y = zone `floorY`. Yaw = facing the map centre.
2. **Auto**: candidate points = zone centroids on the lowest level that has zones, else random
   navmesh points (if `nav` given), else a grid of raycast-validated floor points inside
   `bounds` (raycast down, hit normal.y > 0.7, and a 1.8 m clear capsule above). Pick the two
   candidates farthest apart as anchors; A = points within 2.5 m of anchor A, B likewise (ensure
   at least one each). Yaw faces the other anchor. If the map has a `kind: 'spawn'` node, use it
   as anchor A (it is Pascal's single walkthrough start marker, not a team spawn).

Pascal's `spawn` node is a single walkthrough start point, so it is never a team spawn source.
`SpawnLayout.source` is `'zones' | 'auto'` (the `'spawn-nodes'` value in `types.ts` is unused).

## Player controller (W1-B)

`createCharacterController(collider: StaticCollider, opts) → CharacterController`, modelled on
three-mesh-bvh's `characterMovement` example and Pascal's floating capsule controller:

- Capsule of `PLAYER.radius`, height `PLAYER.height` (crouch: `crouchHeight`, only stand up
  if a `shapecast` upward finds clearance).
- Integrate velocity: horizontal acceleration toward the wished direction (`accel`/`decel`,
  `airControl` in the air), gravity, jump when grounded. Target speed: `runSpeed` by default,
  `walkSpeed` while `MoveInput.walk` (Shift), `crouchSpeed` when crouching.
- Stairs: a step-up sweep (up ≤ `stepHeight`, forward, down onto the tread) climbs 0.25 m
  risers at 45° at run, walk and crouch speed without leaving the ground; descending snaps down
  so the player never bounces.
- Collision: move, then iterate 3–5 push-out passes with `geometry.boundsTree.shapecast`
  (capsule segment vs triangles, `closestPointToSegment`) exactly like the example. A contact
  whose normal.y > cos(maxSlope) counts as ground; resolve steps by allowing the capsule to be
  lifted up to `stepHeight` when the blocking contact is below that height.
- Fall below `bounds.min.y - 10` → report via `onFellOut` (game respawns).
- Must be fully deterministic given inputs (used for bots on the host too).
- Unit-test-ish sanity: in `dev/sandbox.ts` you can walk, jump on a 0.4 m step, crouch under a
  1.3 m gap, slide along walls without jitter.

`camera.ts` owns the `PerspectiveCamera` (`fov` from config) and applies: eye height (lerped
when crouching), look yaw/pitch from `input.ts`, recoil (impulse + spring recovery), subtle
view bob while moving and grounded, landing dip.

## Weapons

- `weapon-model.ts`: procedural blaster (white chamfered polymer body, charcoal receiver/grip/
  stock, top rail with sights, angled foregrip, squared muzzle; team-colour accent strip, muzzle
  ring and translucent hopper whose paint level follows the hopper count). `'first'` quality for
  the view model, `'third'` (~60 % of the parts) mounted in avatars' hands.
- `marker.ts`: hold-to-fire at `WEAPON.fireRate`, hopper of 40, reload (`R` or auto). Accuracy
  model: gaussian sigma by motion state (`setMotion(speedXZ, grounded, crouching, walking)`):
  crouched still < standing (`spreadStandingDeg`) < walking (`spreadWalkingDeg`, Shift caps
  here) < running (`spreadRunningDeg`, blended by speed) < airborne (`spreadAirDeg`), plus a
  per-shot bloom (`spreadPerShotDeg`, recovering at `spreadRecoveryPerSec`, capped at
  `spreadBloomMaxDeg`). Recovery outpaces the fire rate so standing fire stays precise.
  `currentSpreadDeg` drives the HUD crosshair. Shots carry a deterministic `seed`.
- `projectiles.ts`: simulates **all** shots (local and remote) at `WEAPON.projectileSpeed` with
  gravity, sub-stepped raycasts against `WorldQuery`. Static/door hit → decal + splat burst +
  SFX. Hits on players are detected only by the shot's owner (local player on its client, bots
  on the host): broad phase = coarse capsule, narrow phase = `Hittable.shapes` (head / torso /
  arms / legs from `player/hitshapes.ts`) → `HitEvent.part`; the host applies `DAMAGE[part]`.
- `decals.ts`: `DecalGeometry` splats with procedural alpha maps (4 variants, shared with
  avatars via `getSplatTexture`), pooled (`DECALS.maxCount`), parented to door leaves when hit.
- `effects.ts`: muzzle flash, one-frame tracer, splat bursts. `audio.ts`: everything procedural
  (shot with a low thump, dry fire, splat, hit, reload, respawn, door, footsteps).
- Feedback: camera recoil with a random yaw component and a short screen shake; victims get a
  paint splash overlay in the shooter's colour (`hud.paintHit`), heavier for headshots; shooters
  get a hit marker (`hud.hitMarker(part)`); avatars receive `addSplat` in the shooter's colour
  (max 12, cleared on respawn) and a big splat on death.

## Avatars (W1-B)

`avatar.ts` builds a procedural low-poly mannequin (no assets): capsule torso in team colour,
sphere head with a dark visor band, two arm boxes holding a marker, two leg capsules. Animation
is procedural: leg swing by `speed`, torso lean into movement, crouch pose, head pitch follows
`pitch`. Name tag: a `Sprite` with a canvas text (team colour). `flashHit()` (white flash 80 ms),
`die()` (topple + fade 1 s, big splat sprite), `spawn(invincible)` (shield: translucent
additive sphere while `invincibleUntil > now`). Frame update: `set(position, yaw, pitch,
crouching, speed)`.

## Networking (W1-C)

Playroom Kit (`playroomkit`, ESM). Host-authoritative for **rules**, client-authoritative for
**own movement**, shooter-authoritative for **hits** (validated by host).

`insertCoin({ gameId: ENV.playroomGameId, skipLobby: true, maxPlayersPerRoom: 6,
  enableBots: true, botOptions: { botClass: PascalBot }, roomCode?, defaultPlayerStates,
  defaultStates })`. Join by URL hash `#r=CODE` (Playroom reads it); we show the link in the UI.

Player state keys (`player.setState(key, value, reliable)`):

| key      | reliable | value |
|----------|----------|-------|
| `name`   | yes      | string |
| `team`   | yes      | `'a' \| 'b'` (host assigns) |
| `hp`     | yes      | number (host writes) |
| `alive`  | yes      | boolean (host writes) |
| `inv`    | yes      | invincibleUntil ms (host writes) |
| `kills`  | yes      | number (host) |
| `deaths` | yes      | number (host) |
| `p`      | **no**   | `PlayerSnapshot` at `NET.snapshotHz` (owner writes; host writes for bots) |

Global state (`setState`, host only): `map: MapSelection`, `match: MatchState`, `hostNow`
(host `Date.now()`, refreshed every 5 s so clients estimate a clock offset).

RPCs (`RPC.register` / `RPC.call`):

| name      | mode    | payload |
|-----------|---------|---------|
| `shot`    | OTHERS  | `ShotEvent` — receivers feed `projectiles.spawn()` (paint only) |
| `hit`     | HOST    | `HitEvent` — host validates (target alive, not invincible, shooter alive, distance sane, shotId unseen) then applies damage |
| `damage`  | ALL     | `DamageEvent` — HUD feedback (victim: vignette, shooter: hit marker) |
| `kill`    | ALL     | `KillEvent` — kill feed, avatar death, SFX |
| `respawn` | ALL     | `RespawnEvent` — victim teleports; everyone shows the shield |

`sync.ts`: for each remote entity keep a ring of snapshots; render at `now - interpDelayMs`
with linear interpolation (hermite not needed at 20 Hz for a 12 m house). Extrapolate at most
100 ms. Yaw interpolation must take the short way around.

`host.ts` (runs only where `isHost()`; must survive host migration — re-init on `isHost()`
becoming true): team assignment on join (smaller team, kick a bot from that team if it would
exceed 3), bot fill (`addBot()` until 6 participants; `bot.kick()` when a human joins), damage,
death → `respawn` after `PLAYER.respawnDelayMs` at a random team spawn point (least-crowded of
the team's points), scores, match phases (`match.ts`), map change.

Bots are Playroom `Bot`s (`class PascalBot extends Bot`), i.e. real participants with state —
the host runs their brain (W2-B) and writes their `p` snapshots at `NET.botSnapshotHz`.

## Match (W1-C)

`warmup` (5 s, everyone spawns, no damage) → `live` (5 min or 30 kills) → `ended` (10 s
scoreboard) → next `round` (respawn all, reset scores). Host owns `match`; clients render from
state + clock offset.

## Lobby / UI (W1-C)

Pascal dark theme tokens (from the Pascal app):

```
--bg: #0d0d0f  --fg: #fafafa  --muted: #9f9faa  --card: #18181b  --border: #27272a
--accent: #e4e4e7  --team-a: #f97316  --team-b: #14b8a6  --radius: 10px
font-display: 'Barlow'  font-ui: 'Inter'  font-mono: 'JetBrains Mono'
```

Landing (`lobby.ts`), one screen, centred card, Pascal logo top-left:
1. Title "PASCAL STRIKE" (Barlow 800, uppercase), tagline "Build it in Pascal. Paint it here."
2. Name input (remembered in `localStorage`).
3. Map picker: built-in cards (`BUILTIN_MAPS`) + a **drop zone** ("Drop a Pascal GLB"). A dropped
   file → `storage/maps-upload.ts` (progress) → becomes a selectable card "Custom · filename".
   Only the host's choice matters; joiners (URL has `#r=`) see "Joining room ABCD" and the map
   name once known.
4. Primary button "Play" → `insertCoin` → game. Secondary: "Join with code" input.
5. After joining: a small "Invite" chip with the room link (copy on click) shown in the HUD.

`hud.ts`: crosshair (expands with spread/recoil, hit marker flash), health as a **paint meter**
(3 segments), hopper count `40` in mono, team scores centre-top with the timer, kill feed
top-right (last 5, fade), respawn overlay ("Respawning in 2.5 s"), invincibility indicator,
damage vignette (team colour of the shooter), room-code chip, FPS (dev). `scoreboard.ts`: hold
Tab → table by team (name, K, D, ping n/a), bots marked with a small 🤖; end screen with winner
and "Next round in 10 s".

`unsupported.ts`: for touch devices / no WebGPU & no WebGL2.

## Storage (W1-C)

`uploadMap(file: File, onProgress) → Promise<MapSelection>`: `sha256` (Web Crypto) of the
bytes → object path `${hash}.glb` → `supabase.storage.from(bucket).upload(path, file,
{ contentType: 'model/gltf-binary', upsert: false })` (409 on duplicate = fine, reuse) → public
URL via `getPublicUrl`. Reject files > 50 MB or not `.glb`. No auth (public bucket, anon insert
policy, immutable names).

## Bots (W2-B)

Host-only. Each bot owns a `CharacterController` (same physics as players) and a `BotBrain`:

- Perception at `BOTS.decisionHz`: enemies within `viewDistance` and `fovDeg`, `lineOfSight`
  from bot eye to enemy chest (`WorldQuery`). Remember last seen position for `memoryMs`.
- States: `roam` (path to a random navmesh point, prefer far rooms / enemy spawn side),
  `hunt` (path to last seen), `engage` (face target with gaussian aim error, strafe
  perpendicular, fire in bursts, keep 4–9 m if possible, retreat behind cover at hp ≤ 34).
- Path following via `Navigation.findPath`, replan every 1.5 s or when blocked (progress check).
  Jump if stuck against a step for > 0.5 s.
- Output a `BotDecision` each frame (interpolated turn rate ≤ 540°/s) → controller + marker.
  Shots go through the same `marker.ts` → `projectiles.ts` path as humans; the host's
  projectile sim runs hit detection for bots (local-player rule generalised: "simulated here by
  its owner").

## Verification expected from each package

- `bun run typecheck` passes.
- The package's dev entry (W1-A: `?dev=map`, W1-B: `?sandbox=1`, W1-C: `?dev=ui`) renders
  without console errors. Describe exactly what you verified and how in your report.
- No new dependencies, no edits outside your owned files (except adding your dev entry to
  `main.ts` behind a query flag).

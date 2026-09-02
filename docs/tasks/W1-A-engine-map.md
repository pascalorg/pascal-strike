# W1-A — Engine + Map package

You own: `src/engine/renderer.ts`, `src/engine/loaders.ts`, `src/engine/environment.ts`,
`src/engine/events.ts`, `src/map/*`, `src/dev/map-viewer.ts`. Nothing else (except reading).
Read `docs/ARCHITECTURE.md`, `src/types.ts`, `src/config.ts`, `CLAUDE.md` first.

## Deliverables

### `src/engine/renderer.ts`
`createRenderer(container: HTMLElement) → Promise<Engine>` where
```ts
interface Engine {
  renderer: WebGPURenderer; scene: Scene; camera: PerspectiveCamera; clock
  backend: 'webgpu' | 'webgl2'
  onUpdate(fn: (dt: number, now: number) => void): () => void   // fixed 1/120 s steps, max 5 per frame
  onRender(fn: (alpha: number, dt: number) => void): () => void // once per frame before render
  start(): void; stop(): void; dispose(): void
  setCamera(cam: PerspectiveCamera): void
}
```
- `new WebGPURenderer({ antialias: true })`, `await renderer.init()`, then read
  `renderer.backend.isWebGPUBackend` to fill `backend`. Throw a typed error if init fails so
  `main.ts` can show the unsupported screen.
- `setPixelRatio(Math.min(devicePixelRatio, 2))`, ACES tone mapping, `shadowMap.enabled = true`,
  resize via `ResizeObserver` on the container.
- Camera: `PerspectiveCamera(PLAYER.fov, aspect, 0.05, 200)`.

### `src/engine/loaders.ts`
`createLoaders(renderer) → { gltf: GLTFLoader; ktx2: KTX2Loader; dispose() }` with
`MeshoptDecoder` (`three/examples/jsm/libs/meshopt_decoder.module.js`) and `KTX2Loader`
(`setTranscoderPath('/decoders/')`, `detectSupport(renderer)` — the renderer is already
initialised). Export `loadGltf(loaders, source: string | ArrayBuffer) → Promise<GLTF>` that
handles both URLs and `File` bytes (`loader.parse(buffer, '')`).

### `src/engine/environment.ts`
`createEnvironment(engine, bounds: Box3) → { sun: DirectionalLight; update(playerPos) }`:
`HemisphereLight(0xdfe8ff, 0x8a7a66, 0.9)`, `DirectionalLight` sun (warm, intensity ~2.2,
`castShadow`, `shadow.mapSize 2048`, ortho frustum fitted to `bounds` with margin, bias
-0.0005, normalBias 0.02), `scene.environment` from `RoomEnvironment` via `PMREMGenerator`
(import from `three/webgpu`), `scene.background` a soft sky colour, light fog matching it.
`update(playerPos)` re-centres the shadow frustum on the player every frame (keep the target in
sync: `sun.target.position`).

### `src/engine/events.ts`
`createEventBus(): EventBus` (typed, from `types.ts`). Handlers may unsubscribe during emit.

### `src/map/map-parse.ts`
`parsePascalScene(gltf: GLTF) → { levels, zones, spawnNodes, doors }` following the GLB
contract in ARCHITECTURE.md. Notes:
- Zone polygon points are in the zone node's local space: `node.localToWorld(new Vector3(x, 0, z))`
  then take `(x, z)`. Compute the centroid (polygon area-weighted). `floorY` is resolved later by
  the loader with the collider (raycast down from centroid + 1.0), fallback `level.y + 0.05`.
- Spawn yaw: `extras.rotation` composed with the node's world yaw (extract from world quaternion).
- Doors: `extras.openable === true && extras.clips?.length`, clip found by name in
  `gltf.animations`. Animated nodes: for each track, `PropertyBinding.parseTrackName(track.name).nodeName`
  → resolve with `PropertyBinding.findNode(gltf.scene, nodeName)` (GLTFLoader uses `node.name`
  or `node.uuid` for unnamed nodes; both resolve through `findNode`). `leafMeshes` = all `Mesh`
  descendants of those nodes. `center` = door node world position; `halfWidth` = half the XZ
  extent of the door node's world bbox (min 0.45).
- Only `kind === 'door'` become doors. Openable windows are ignored (they stay closed).
- Levels: `kind === 'level'`, `y` = world position y.

### `src/map/collider.ts`
- `buildStaticCollider(root: Object3D, excluded: Set<Object3D>) → StaticCollider`: collect every
  visible `Mesh` (also `SkinnedMesh`/`InstancedMesh` ignored — none in Pascal exports) whose
  ancestors include none of `excluded` (door/window animated nodes, zone and spawn nodes); clone
  geometry → `toNonIndexed()` if needed → keep only `position` + `normal` (compute normals if
  missing) → `applyMatrix4(matrixWorld)`; merge with `mergeGeometries`, `computeBoundsTree({
  maxLeafSize: 12 })`. Return the mesh (`visible = false`, `matrixAutoUpdate = false`).
- Patch prototypes once (`BufferGeometry.prototype.computeBoundsTree`, `disposeBoundsTree`,
  `Mesh.prototype.raycast = acceleratedRaycast`) in a `bvh-setup.ts` side-effect import.
- `createWorldQuery(collider, doors: DoorInfo[]) → WorldQuery`: `raycast` tests the static BVH
  (`boundsTree.raycastFirst` with the ray in geometry space = world space) and each door's
  `leafMeshes` (each leaf geometry gets its own `computeBoundsTree()`; transform the ray into leaf
  local space with the inverse `matrixWorld`, transform the hit back). `firstHitOnly`, nearest
  wins, `kind` = `'static' | 'door'`. `lineOfSight(a, b)` = no hit closer than `|b - a|`.
  Zero allocations per call (scratch objects).

### `src/map/doors.ts`
`createDoorSystem(map: MapData) → DoorSystem`:
```ts
interface DoorSystem {
  update(dt: number, actors: ArrayLike<Vector3>): void   // feet positions of all players/bots
  isOpen(id: string): boolean; openness(id: string): number
  onToggle(cb: (door: DoorInfo, open: boolean) => void): () => void
  mixer: AnimationMixer
}
```
Rules in ARCHITECTURE.md "Doors". Distance test: XZ distance from actor to `door.center` and
`|actor.y - (center.y - 1)| < 2` (door centre sits ~1 m above the floor). A door mid-animation
reverses smoothly (`action.timeScale` sign flip, keep `action.time`, `paused = false`).

### `src/map/spawns.ts`
`resolveSpawns(map: MapData, world: WorldQuery, nav?: Navigation) → SpawnLayout` per
ARCHITECTURE.md "Spawns". Point validation: raycast down from `+1.5 m` hits within 3 m with
normal.y > 0.7, and an upward raycast from the point + 0.2 finds nothing within 1.8 m.

### `src/map/navmesh.ts`
`buildNavigation(map: MapData) → Promise<Navigation>` with `recast-navigation`:
`await init()` (once), `threeToSoloNavMesh(map.navMeshSource, { cs, ch, walkableRadius: ceil(r/cs),
walkableHeight: ceil(h/ch), walkableClimb: ceil(climb/ch), walkableSlopeAngle })` (config units:
recast wants voxel counts for radius/height/climb — convert from metres). `NavMeshQuery` for
`findPath` (`computePath`, return `Vector3[]`), `randomPoint` (`findRandomPoint`),
`randomPointAround` (`findRandomPointAroundCircle`), `closestPoint` (`findClosestPoint`). Also
export `createNavMeshHelper(nav)` (from `@recast-navigation/three`) for the debug viewer. If
generation fails, resolve a `Navigation` with `ready: false` and safe fallbacks (straight-line
path) and `console.warn`.

### `src/map/map-loader.ts`
`loadMap(source: string | File, loaders, opts?: { name?: string }) → Promise<MapData>`:
load → `gltf.scene` into a `Group` (`root.name = 'map'`), parse, exclusions = zone/spawn nodes +
door/window animated nodes, collider, zone floorY, bounds, `navMeshSource = [collider.mesh]`,
set `castShadow/receiveShadow` on all meshes, `material.side = FrontSide` unless transparent,
`frustumCulled = true`. Must also work for GLBs with **no Pascal extras** at all (plain GLB from
anywhere: no zones, no doors, everything static).

### `src/dev/map-viewer.ts`
`start()`: engine + loaders + `loadMap('/maps/pascal-house.glb')` (or `?map=<url>`) +
environment + door system + spawns + navmesh. Fly camera (WASD + mouse drag or pointer lock, Q/E
up/down, Shift fast). The camera position acts as a door "actor" so doors open when you fly close.
Debug overlays toggled by keys, listed in a small DOM panel (top-left, mono font):
`Z` zone polygons (line loops on the floor, zone colour, label sprites), `S` spawn points
(team-coloured cones with yaw arrows, `source` printed), `D` door centres (spheres, green when
open), `C` collider wireframe, `N` navmesh helper, `R` raycast probe (draws the `WorldQuery`
hit from the camera centre). Also print: backend, tris, levels/zones/doors counts, load time.

## Verification (do all, report exactly what you saw)
1. `bun run typecheck` clean.
2. Run `bun dev` (background) and open `http://localhost:5173/?dev=map` in Chrome using the
   `claude-in-chrome` MCP tools (load them via ToolSearch with
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_console_messages,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__read_page`).
   Screenshot the house, toggle every overlay, fly through a door and confirm it opens, confirm
   the navmesh covers Level 0 floors and goes through the doorways, confirm `raycast` hits a
   closed door leaf and NOT an open one. Read the console: no errors, no WebGPU warnings.
3. Note the spawn `source` and the two anchors chosen on this map.
4. Commit your work on completion with a clear message (git user is already configured).
   Do not touch files outside your ownership; `main.ts` already routes `?dev=map` to you.

Report: what works, what you could not verify, any contract gaps you found in `types.ts`.

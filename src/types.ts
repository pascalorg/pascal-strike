/**
 * Shared contracts for Pascal Strike.
 *
 * Every work package codes against these interfaces so that modules developed in
 * parallel plug together. Change this file only with a note in docs/ARCHITECTURE.md.
 *
 * Coordinate conventions
 * - World units are metres, Y up (glTF / three.js default).
 * - "position" of a player/bot is the FEET point (bottom of the capsule on the floor).
 * - yaw: radians around +Y, 0 = looking toward -Z (three.js camera default), increases turning left.
 * - pitch: radians, positive = looking up, clamped to ±(PI/2 - 0.05).
 */
import type {
  AnimationClip,
  Box3,
  BufferGeometry,
  Group,
  Mesh,
  Object3D,
  Vector2,
  Vector3,
} from 'three'

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export type TeamId = 'a' | 'b'

export interface TeamInfo {
  id: TeamId
  /** Display name, e.g. "Orange" */
  name: string
  /** CSS colour, e.g. "#f97316" */
  color: string
  /** Same colour as a 24-bit int for three.js */
  colorHex: number
}

// ---------------------------------------------------------------------------
// Map (parsed from a Pascal baked GLB)
// ---------------------------------------------------------------------------

/** Pascal identity extras written by the exporter on every registry node. */
export interface PascalExtras {
  pascalId: string
  kind: string // 'site' | 'building' | 'level' | 'zone' | 'wall' | 'door' | 'window' | 'slab' | 'ceiling' | 'roof' | 'stair' | 'fence' | 'item' | 'spawn' | ...
  label?: string
  openable?: boolean
  clips?: string[]
  /** zones only, [x, z] pairs in the zone node's local space */
  polygon?: [number, number][]
  /** zones only */
  color?: string
  /** spawn nodes only, yaw in radians */
  rotation?: number
  camera?: unknown
}

export interface LevelInfo {
  id: string
  label: string
  node: Object3D
  /** World Y of the level origin (floor slab sits ~0.05 above it). */
  y: number
}

export interface ZoneInfo {
  id: string
  label: string
  color: string
  levelId: string | null
  node: Object3D
  /** Polygon in WORLD space (x, z), CCW or CW, >= 3 points. */
  polygon: Vector2[]
  /** World-space centroid on the floor (y = floorY). */
  centroid: Vector3
  /** World Y of the walkable floor inside the zone (raycast result, falls back to level y + 0.05). */
  floorY: number
}

export interface SpawnNodeInfo {
  id: string
  label: string
  levelId: string | null
  /** World position (feet). */
  position: Vector3
  /** World yaw in radians (see conventions). */
  yaw: number
}

export interface DoorInfo {
  id: string
  label: string
  /** 'door' (walk-through opening) or 'window' (openable sash). Missing = door. */
  kind?: 'door' | 'window'
  node: Object3D
  /** The baked "<id>: open" clip (1 s, rest pose = closed). */
  clip: AnimationClip
  /** World position of the door (identity node origin, roughly the centre of the opening at floor+1). */
  center: Vector3
  /** Meshes that move when the door opens (children of the clip's target nodes). Bullets collide with these. */
  leafMeshes: Mesh[]
  /** Approximate half-width of the opening in metres. */
  halfWidth: number
}

/**
 * Merged static collision mesh. `geometry` has position + normal attributes and a
 * three-mesh-bvh boundsTree; `mesh.matrixWorld` is identity (geometry is already in world space).
 * Always excludes zone and spawn markers; which openable leaves it excludes depends on which of
 * the two colliders it is — see `MapData.collider` and `MapData.bulletCollider`. Includes frames,
 * glass, furniture, ceilings, roofs, fences.
 */
export interface StaticCollider {
  mesh: Mesh
  geometry: BufferGeometry
}

/**
 * A glass pane paintballs can shatter. Excluded from the bullet collider and tested dynamically
 * by WorldQuery until `broken`; stays in the movement collider (windows never let players
 * through unless their sash is open).
 */
export interface GlassPane {
  /** Deterministic across clients: `glass:<index in traversal order>`. */
  id: string
  mesh: Mesh
  broken: boolean
}

export interface MapData {
  name: string
  /** Root group of the loaded GLB, already added to the scene by the loader caller. */
  root: Group
  levels: LevelInfo[]
  zones: ZoneInfo[]
  spawnNodes: SpawnNodeInfo[]
  doors: DoorInfo[]
  /**
   * MOVEMENT collider (also the navmesh source). Excludes the animated leaves of *doors*, so a
   * doorway is walk-through whatever the door state, but keeps window sashes in their closed
   * rest pose: doors are for passage, windows are for paint, so a window is never passable.
   */
  collider: StaticCollider
  /**
   * BULLET collider: `collider` minus the animated leaves of openable *windows* too, so a
   * paintball flies through an open sash. A closed sash still stops it, dynamically, through the
   * per-leaf BVHs `createWorldQuery` walks. Undefined on hand-built maps with no openables —
   * callers fall back to `collider` (identical when the map has no openable window).
   */
  bulletCollider?: StaticCollider
  /** World-space bounds of the collider. */
  bounds: Box3
  /** Meshes to feed the navmesh generator (walkable + obstacles). Usually [collider.mesh]. */
  navMeshSource: Mesh[]
  /** Breakable glass panes (see GlassPane). Missing = none. */
  breakables?: GlassPane[]
}

export interface SpawnPoint {
  /** Feet position on the floor. */
  position: Vector3
  yaw: number
}

export interface SpawnLayout {
  a: SpawnPoint[]
  b: SpawnPoint[]
  /** How the spawns were derived, for the debug HUD. */
  source: 'zones' | 'spawn-nodes' | 'auto'
}

// ---------------------------------------------------------------------------
// World queries (bullets, line of sight)
// ---------------------------------------------------------------------------

export interface HitResult {
  point: Vector3
  normal: Vector3
  distance: number
  object: Object3D
  /**
   * What was hit: baked world geometry, an openable's moving leaf, or a breakable `GlassPane`
   * (`object` is then the pane's mesh, and its id is in `MapData.breakables`).
   */
  kind: 'static' | 'door' | 'glass'
}

export interface WorldQuery {
  /** Nearest hit against static collider + door leaves. Returns null if nothing within maxDistance. */
  raycast(origin: Vector3, direction: Vector3, maxDistance: number): HitResult | null
  /** True if the segment a→b is unobstructed by static geometry or door leaves. */
  lineOfSight(a: Vector3, b: Vector3): boolean
}

export type BodyPart = 'head' | 'torso' | 'arm' | 'leg'

/** A capsule (start === end for a sphere) tagged with the body part it represents. World space. */
export interface HitShape {
  part: BodyPart
  start: Vector3
  end: Vector3
  radius: number
}

/**
 * Something paintballs can hit (players and bots). The coarse capsule is the broad phase;
 * `shapes` (head / torso / arms / legs, see player/hitshapes.ts) is the narrow phase that
 * decides the body part. When `shapes` is empty or missing the hit counts as 'torso'.
 */
export interface Hittable {
  id: string
  team: TeamId
  alive: boolean
  /** World-space capsule: start = feet + radius, end = head - radius. */
  capsuleStart: Vector3
  capsuleEnd: Vector3
  capsuleRadius: number
  shapes?: HitShape[]
}

// ---------------------------------------------------------------------------
// Character controller
// ---------------------------------------------------------------------------

export interface MoveInput {
  /** -1..1, +1 = forward (toward look direction projected on XZ) */
  forward: number
  /** -1..1, +1 = strafe right */
  right: number
  jump: boolean
  crouch: boolean
  /** Shift held: slow, precise walk (default movement is running). */
  walk?: boolean
}

export interface CharacterState {
  /** Feet position. */
  position: Vector3
  velocity: Vector3
  grounded: boolean
  crouching: boolean
}

export interface CharacterController {
  readonly state: CharacterState
  readonly radius: number
  /** Current eye height above feet (changes when crouching). */
  readonly eyeHeight: number
  /** Current capsule height (feet to top). */
  readonly height: number
  /**
   * Step the simulation. `yaw` is the facing used to interpret forward/right. `speedScale`
   * multiplies the target ground speed (weapon `moveSpeedScale`); missing = 1.
   */
  update(dt: number, input: MoveInput, yaw: number, speedScale?: number): void
  /** Teleport (respawn). Clears velocity. */
  setPosition(position: Vector3): void
  /**
   * Moving obstacles (door leaves, window sashes) that block the capsule wherever they
   * currently are: each mesh has its own boundsTree and is tested with its live matrixWorld.
   */
  setDynamicColliders?(meshes: Mesh[]): void
}

// ---------------------------------------------------------------------------
// Entities (what the game and the net layer agree on)
// ---------------------------------------------------------------------------

export interface PlayerSnapshot {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  /** 1 when crouching */
  c: number
  /** sender wall-clock ms (Date.now()) */
  t: number
}

export interface PlayerEntity {
  id: string
  name: string
  team: TeamId
  isBot: boolean
  isLocal: boolean
  hp: number
  alive: boolean
  /** Date.now() ms until which the player cannot take damage (0 = none). */
  invincibleUntil: number
  kills: number
  deaths: number
  /** Feet position, world. Interpolated for remotes, simulated for local/bots(host). */
  position: Vector3
  yaw: number
  pitch: number
  crouching: boolean
  /** Speed on XZ in m/s, for animation. */
  speed: number
  /** Currently held weapon (player state key `w`); missing = rifle. */
  weapon?: WeaponKind
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

/** Slot 1 = rifle (the marker), 2 = pistol, 3 = knife. Per-weapon numbers live in config WEAPONS. */
export type WeaponKind = 'rifle' | 'pistol' | 'knife'

export interface ShotEvent {
  /** Unique per shot: `${playerId}:${counter}` */
  id: string
  /** Shooter player id */
  by: string
  team: TeamId
  origin: [number, number, number]
  /** Unit direction */
  dir: [number, number, number]
  /** m/s */
  speed: number
  /** Sender Date.now() */
  t: number
  /** Deterministic seed for splat shape/rotation */
  seed: number
  /** Missing = rifle. */
  weapon?: WeaponKind
}

export interface HitEvent {
  shotId: string
  by: string
  target: string
  point: [number, number, number]
  normal: [number, number, number]
  /** Body part hit; missing = torso (host uses DAMAGE[part]). */
  part?: BodyPart
  /** Weapon that scored the hit; missing = rifle (host scales DAMAGE[part] by WEAPONS[weapon].damageScale). */
  weapon?: WeaponKind
}

export interface KillEvent {
  killer: string
  victim: string
  killerTeam: TeamId
  victimTeam: TeamId
}

export interface RespawnEvent {
  player: string
  position: [number, number, number]
  yaw: number
  /** Date.now() ms until which the player is invincible */
  invincibleUntil: number
}

export interface DamageEvent {
  target: string
  by: string
  hp: number
  point: [number, number, number]
  /** Body part hit (host fills it from the HitEvent). */
  part?: BodyPart
  /** Damage applied. */
  amount?: number
}

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

export type MatchPhase = 'warmup' | 'live' | 'ended'

export interface MatchState {
  phase: MatchPhase
  round: number
  /** Date.now() (host clock) when the phase started */
  startedAt: number
  /** Date.now() (host clock) when the phase ends */
  endsAt: number
  scores: { a: number; b: number }
  winner: TeamId | null
}

export interface MapSelection {
  /** Absolute URL or path under /maps */
  url: string
  name: string
  /** sha256 hex of the file when uploaded by a player, else the built-in id */
  id: string
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

export interface BotDecision {
  move: MoveInput
  yaw: number
  pitch: number
  fire: boolean
}

export interface NavPath {
  points: Vector3[]
}

export interface Navigation {
  ready: boolean
  /** Path from a to b on the navmesh (feet positions). Empty array if unreachable. */
  findPath(from: Vector3, to: Vector3): Vector3[]
  /** Random reachable point on the navmesh. */
  randomPoint(): Vector3
  /** Random point on the navmesh within radius of center. */
  randomPointAround(center: Vector3, radius: number): Vector3
  /** Nearest navmesh point (snap). */
  closestPoint(p: Vector3): Vector3
}

// ---------------------------------------------------------------------------
// Events (typed emitter used across modules)
// ---------------------------------------------------------------------------

export type GameEventMap = {
  shot: ShotEvent
  hit: HitEvent
  damage: DamageEvent
  kill: KillEvent
  respawn: RespawnEvent
  match: MatchState
  'player-joined': PlayerEntity
  'player-left': { id: string }
  'map-changed': MapSelection
  'local-damaged': { hp: number; from: [number, number, number] }
}

export type EventKey = keyof GameEventMap

export interface EventBus {
  on<K extends EventKey>(key: K, handler: (payload: GameEventMap[K]) => void): () => void
  emit<K extends EventKey>(key: K, payload: GameEventMap[K]): void
}

// ---------------------------------------------------------------------------
// Bot runner (host-only). Bots never touch the network or projectiles directly:
// the game supplies callbacks so the bots package stays free of net/weapons imports.
// ---------------------------------------------------------------------------

export interface BotRunnerOptions {
  map: MapData
  world: WorldQuery
  nav: Navigation
  /** All entities (humans + bots) for perception. */
  entities: () => PlayerEntity[]
  /** Current spawn layout (for roaming targets). */
  spawns: () => SpawnLayout
  /** Called when a bot fires: the game spawns the projectile (detectPlayers: true) and broadcasts the shot. */
  onShot: (bot: PlayerEntity, shot: ShotEvent) => void
  /** Called at NET.botSnapshotHz per bot with its current pose: the game writes it to the bot's PlayerState. */
  onSnapshot: (bot: PlayerEntity, snapshot: PlayerSnapshot) => void
  /** Host clock in ms. */
  now: () => number
  /** Per-map seed so behaviour is reproducible. */
  seed?: number
}

/** One bot's live state, for `?debug=1` and the headless playtests. Read-only snapshot. */
export interface BotDebugInfo {
  id: string
  name: string
  state: string
  alive: boolean
  /** Feet position. */
  position: [number, number, number]
  /** Where the brain is sending it, or null when it has no goal. */
  goal: [number, number, number] | null
  /** The path corner it is walking at right now, or null when it has no path. */
  corner: [number, number, number] | null
  /** Monotonic count of "made no progress for a second" events. */
  stuck: number
  /** Monotonic count of goals given up on and blacklisted. */
  abandoned: number
}

export interface BotRunner {
  /**
   * What every bot is doing, for the debug HUD and the playtests. Allocates: call it from a
   * debug path, never from the simulation.
   */
  debug(): BotDebugInfo[]
  /** Step every simulated bot (call from the fixed update). */
  update(dt: number): void
  /** Start simulating an entity (isBot must be true). Places it at `entity.position`. */
  addBot(entity: PlayerEntity): void
  removeBot(id: string): void
  /** The host respawned this bot: teleport its controller. */
  respawn(id: string, position: Vector3, yaw: number): void
  dispose(): void
}

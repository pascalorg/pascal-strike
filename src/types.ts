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
 * Excludes: zones, spawns, and the ANIMATED subtrees of doors/windows (leaves), so players walk
 * through doorways whatever the door state. Includes frames, glass, furniture, ceilings, roofs, fences.
 */
export interface StaticCollider {
  mesh: Mesh
  geometry: BufferGeometry
}

export interface MapData {
  name: string
  /** Root group of the loaded GLB, already added to the scene by the loader caller. */
  root: Group
  levels: LevelInfo[]
  zones: ZoneInfo[]
  spawnNodes: SpawnNodeInfo[]
  doors: DoorInfo[]
  collider: StaticCollider
  /** World-space bounds of the collider. */
  bounds: Box3
  /** Meshes to feed the navmesh generator (walkable + obstacles). Usually [collider.mesh]. */
  navMeshSource: Mesh[]
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
  kind: 'static' | 'door'
}

export interface WorldQuery {
  /** Nearest hit against static collider + door leaves. Returns null if nothing within maxDistance. */
  raycast(origin: Vector3, direction: Vector3, maxDistance: number): HitResult | null
  /** True if the segment a→b is unobstructed by static geometry or door leaves. */
  lineOfSight(a: Vector3, b: Vector3): boolean
}

/** A capsule that paintballs can hit (players and bots). */
export interface Hittable {
  id: string
  team: TeamId
  alive: boolean
  /** World-space capsule: start = feet + radius, end = head - radius. */
  capsuleStart: Vector3
  capsuleEnd: Vector3
  capsuleRadius: number
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
  /** Step the simulation. `yaw` is the facing used to interpret forward/right. */
  update(dt: number, input: MoveInput, yaw: number): void
  /** Teleport (respawn). Clears velocity. */
  setPosition(position: Vector3): void
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
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

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
}

export interface HitEvent {
  shotId: string
  by: string
  target: string
  point: [number, number, number]
  normal: [number, number, number]
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

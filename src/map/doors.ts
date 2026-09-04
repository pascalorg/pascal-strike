/**
 * Openables — doors and windows (W1-A, reworked by W3-D).
 *
 * Nothing in here decides anything on its own any more: the auto-open-on-approach of W1-A is
 * gone. A player presses E (`findInteractable` picks what the crosshair is on), the game
 * broadcasts a `door` RPC and every client — the caller included — lands in `setOpen`, so all
 * six views agree without any local heuristics.
 *
 * The baked clip's rest pose is "closed", so playing it forward opens and playing it backward
 * closes; an openable that reverses mid-swing just flips `timeScale` and continues from where
 * the leaf currently is.
 */
import {
  AnimationMixer,
  Box3,
  BoxGeometry,
  LoopOnce,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Ray,
  Sphere,
  Vector3,
  type AnimationAction,
  type BufferGeometry,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { DOORS } from '../config'
import type { DoorInfo, MapData } from '../types'

export interface DoorSystem {
  /** Advance the animations. Nothing opens or closes by itself. */
  update(dt: number): void
  /** Flip the logical state. Returns the new state, or null when `id` is unknown. */
  toggle(id: string): boolean | null
  /**
   * Force a state. `instant` jumps the animation to its end pose and skips the `onToggle`
   * listeners — that is how a late joiner adopts the room state without watching (and hearing)
   * seven doors swing open at once.
   */
  setOpen(id: string, open: boolean, instant?: boolean): void
  /** Logical state: true while the openable wants to be open. */
  isOpen(id: string): boolean
  /** Animation progress, 0 = fully closed, 1 = fully open. */
  openness(id: string): number
  /** `{ [id]: open }` for every openable in the map — the shape of the `doors` room state. */
  openStates(): Record<string, boolean>
  /**
   * Nearest openable the ray crosses within `range`: its moving leaves (so an open door can be
   * closed from the side it swung to) or its closed-pose bounding box (so the frame and the
   * empty doorway count too).
   */
  findInteractable(origin: Vector3, direction: Vector3, range: number): DoorInfo | null
  get(id: string): DoorInfo | null
  /** Fires when the logical state flips — hook for the door "whoosh" SFX. */
  onToggle(cb: (door: DoorInfo, open: boolean) => void): () => void
  mixer: AnimationMixer
  dispose(): void
}

interface LeafEntry {
  mesh: Mesh
  /** Geometry-space AABB; transformed by `mesh.matrixWorld` at query time (the leaf moves). */
  localBox: Box3
}

interface DoorRuntime {
  info: DoorInfo
  action: AnimationAction
  duration: number
  open: boolean
  /** World AABB of the whole node in its closed rest pose: frame, glass and leaves. */
  closedBox: Box3
  /** Broad-phase sphere that contains the node in every animation state. */
  center: Vector3
  radius: number
  leaves: LeafEntry[]
}

const _ray = /*@__PURE__*/ new Ray()
const _sphere = /*@__PURE__*/ new Sphere()
const _box = /*@__PURE__*/ new Box3()
const _point = /*@__PURE__*/ new Vector3()
const _size = /*@__PURE__*/ new Vector3()
const _toCenter = /*@__PURE__*/ new Vector3()

export function createDoorSystem(map: MapData): DoorSystem {
  const mixer = new AnimationMixer(map.root)
  const runtimes: DoorRuntime[] = []
  const byId = new Map<string, DoorRuntime>()
  const listeners = new Set<(door: DoorInfo, open: boolean) => void>()

  for (const door of map.doors) {
    const action = mixer.clipAction(door.clip)
    action.setLoop(LoopOnce, 1)
    action.clampWhenFinished = true
    action.enabled = true
    action.weight = 1
    action.timeScale = DOORS.openTimeScale
    action.play()
    // Hold the rest pose (closed) until somebody interacts.
    action.time = 0
    action.paused = true

    door.node.updateWorldMatrix(true, true)
    const closedBox = new Box3().setFromObject(door.node)
    const center = closedBox.isEmpty() ? door.center.clone() : closedBox.getCenter(new Vector3())
    // Leaves swing about a hinge offset by ~halfWidth, so the closed box alone is too tight.
    const closedRadius = closedBox.isEmpty() ? 1.5 : closedBox.getSize(_size).length() * 0.5
    const radius = Math.max(closedRadius, door.halfWidth * 2 + 0.5)

    const leaves: LeafEntry[] = []
    for (const mesh of door.leafMeshes) {
      const geometry = mesh.geometry
      if (!geometry?.getAttribute('position')) continue
      if (!geometry.boundingBox) geometry.computeBoundingBox()
      const localBox = geometry.boundingBox
      if (!localBox) continue
      leaves.push({ mesh, localBox: localBox.clone() })
    }

    const runtime: DoorRuntime = {
      info: door,
      action,
      duration: Math.max(door.clip.duration, 1e-3),
      open: false,
      closedBox,
      center,
      radius,
      leaves,
    }
    runtimes.push(runtime)
    byId.set(door.id, runtime)
  }

  function apply(runtime: DoorRuntime, open: boolean, instant: boolean): void {
    if (runtime.open === open && !instant) return
    runtime.open = open
    runtime.action.timeScale = open ? DOORS.openTimeScale : -DOORS.openTimeScale
    runtime.action.enabled = true
    if (instant) {
      // Jump to the end pose. `mixer.update(0)` writes it into the bones right away, so a
      // client that just loaded the map never renders a frame with the door in the wrong state.
      runtime.action.time = open ? runtime.duration : 0
      runtime.action.paused = true
      mixer.update(0)
      return
    }
    // Un-pausing keeps `action.time` where it is, so a half-open door reverses from there.
    runtime.action.paused = false
    for (const cb of listeners) cb(runtime.info, open)
  }

  /** Distance along the ray to `box`, or null when it is missed or farther than `max`. */
  function rayBoxDistance(box: Box3, max: number): number | null {
    if (box.isEmpty()) return null
    if (box.containsPoint(_ray.origin)) return 0
    if (!_ray.intersectBox(box, _point)) return null
    const distance = _ray.origin.distanceTo(_point)
    return distance <= max ? distance : null
  }

  /** True if the ray passes through the sphere within `max` (origin inside counts). */
  function raySphereWithin(max: number): boolean {
    const r = _sphere.radius
    _toCenter.copy(_sphere.center).sub(_ray.origin)
    if (_toCenter.lengthSq() <= r * r) return true
    const along = _ray.direction.dot(_toCenter)
    if (along < 0 || along > max + r) return false
    return _ray.distanceSqToPoint(_sphere.center) <= r * r
  }

  return {
    update(dt) {
      mixer.update(dt)
    },

    toggle(id) {
      const runtime = byId.get(id)
      if (!runtime) return null
      apply(runtime, !runtime.open, false)
      return runtime.open
    },

    setOpen(id, open, instant = false) {
      const runtime = byId.get(id)
      if (runtime) apply(runtime, open, instant)
    },

    isOpen(id) {
      return byId.get(id)?.open ?? false
    },

    openness(id) {
      const runtime = byId.get(id)
      if (!runtime) return 0
      return clamp01(runtime.action.time / runtime.duration)
    },

    openStates() {
      const states: Record<string, boolean> = {}
      for (const runtime of runtimes) states[runtime.info.id] = runtime.open
      return states
    },

    findInteractable(origin, direction, range) {
      _ray.origin.copy(origin)
      _ray.direction.copy(direction).normalize()

      let best = range
      let bestDoor: DoorInfo | null = null

      for (let i = 0; i < runtimes.length; i++) {
        const runtime = runtimes[i]
        _sphere.center.copy(runtime.center)
        _sphere.radius = runtime.radius
        if (!raySphereWithin(best)) continue

        let distance = rayBoxDistance(runtime.closedBox, best)
        for (let l = 0; l < runtime.leaves.length; l++) {
          const leaf = runtime.leaves[l]
          _box.copy(leaf.localBox).applyMatrix4(leaf.mesh.matrixWorld)
          const leafDistance = rayBoxDistance(_box, distance ?? best)
          if (leafDistance !== null) distance = leafDistance
        }
        if (distance === null || distance >= best) continue
        best = distance
        bestDoor = runtime.info
      }
      return bestDoor
    },

    get(id) {
      return byId.get(id)?.info ?? null
    },

    onToggle(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },

    mixer,

    dispose() {
      listeners.clear()
      mixer.stopAllAction()
      mixer.uncacheRoot(map.root)
    },
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * How far the open-leaf strips are grown before recast eats them.
 *
 * `walkableRadius` is 0.22 m, deliberately under the 0.3 m capsule so that recast does not sever
 * the 0.25 m curved stair treads. Everywhere else that shortfall is harmless; at a door leaf it
 * is not, because a path corner planned 0.22 m off the panel puts a 0.3 m capsule 0.08 m inside
 * it. Padding the obstacle instead of the whole world buys the missing clearance exactly where
 * it is needed and leaves the treads alone.
 */
const LEAF_PAD = 0.12
/** The strips only have to be tall enough that no storey leaves `walkableHeight` above them. */
const MIN_LEAF_HEIGHT = 2
/** How far short of the clip's end the open pose is sampled (see `buildOpenDoorObstacles`). */
const OPEN_POSE_EPSILON = 1e-3

const _leafBox = new Box3()
const _leafSize = new Vector3()
const _leafCenter = new Vector3()

interface NodePose {
  node: Object3D
  position: Vector3
  quaternion: Quaternion
  scale: Vector3
}

/**
 * Thin obstacle boxes where each door's leaves come to rest when they are OPEN.
 *
 * A door that is open is a hole you can walk through, and recast is told so — the leaves are out
 * of the navmesh source in their closed pose because bots open what is in their way. But the leaf
 * does not vanish when it swings: it parks along the wall beside the opening, sticking a quarter
 * of a metre into the room, and it is still solid to everybody. Recast, knowing nothing about it,
 * runs the corridor straight through the panel's corner, so a bot walking that corner wedges
 * against a wall it cannot see and pushes into it for as long as the goal stands (39 s, in one
 * traced case: 36 stalls, always the same corner).
 *
 * So the OPEN pose is baked in as geometry. Each leaf is driven to the end of its clip, its world
 * box read off, padded, and dropped back to the floor; the boxes cover the strip along the wall
 * and nothing else, so the doorway itself stays walkable and the path simply routes around the
 * leaf. Everything is restored to the closed pose before this returns — the collider was baked
 * from that pose and the door system animates from it.
 *
 * Doors only: a window sash swings into a room a metre and a half up, where nobody walks.
 */
export function buildOpenDoorObstacles(root: Object3D, doors: readonly DoorInfo[]): Mesh | null {
  const geometries: BufferGeometry[] = []

  for (const door of doors) {
    if ((door.kind ?? 'door') !== 'door' || !door.clip || door.leafMeshes.length === 0) continue

    const poses = capturePoses(root, door)
    const mixer = new AnimationMixer(root)
    const action = mixer.clipAction(door.clip)
    try {
      // LoopOnce + clamp, and a hair short of the end: a repeating clip sampled at exactly its
      // duration wraps back to frame 0, which is the CLOSED pose — the one thing this must not
      // read. The clip's last frame is the fully open pose (its rest pose is the closed one).
      action.loop = LoopOnce
      action.clampWhenFinished = true
      action.play()
      mixer.setTime(Math.max(0, door.clip.duration - OPEN_POSE_EPSILON))
      root.updateMatrixWorld(true)
      for (const leaf of door.leafMeshes) {
        const box = _leafBox.setFromObject(leaf, true)
        if (box.isEmpty()) continue
        // Stand it on the floor: the leaf reaches it anyway, and a strip that floats leaves a
        // walkable sliver underneath for recast to thread a path through.
        const floorY = Math.min(box.min.y, door.center.y - 1)
        box.min.y = floorY
        box.max.y = Math.max(box.max.y, floorY + MIN_LEAF_HEIGHT)
        box.expandByVector(_leafSize.set(LEAF_PAD, 0, LEAF_PAD))
        box.getSize(_leafSize)
        box.getCenter(_leafCenter)
        const geometry = new BoxGeometry(_leafSize.x, _leafSize.y, _leafSize.z)
        geometry.translate(_leafCenter.x, _leafCenter.y, _leafCenter.z)
        geometries.push(geometry)
      }
    } finally {
      action.stop()
      mixer.stopAllAction()
      mixer.uncacheClip(door.clip)
      restorePoses(poses)
      root.updateMatrixWorld(true)
    }
  }

  if (geometries.length === 0) return null
  const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false)
  for (const geometry of geometries) if (geometry !== merged) geometry.dispose()
  if (!merged) return null
  // Never rendered and never collided with: recast is the only thing that ever reads it.
  const mesh = new Mesh(merged, new MeshBasicMaterial())
  mesh.name = 'navmesh-open-leaves'
  mesh.visible = false
  mesh.matrixAutoUpdate = false
  mesh.updateMatrixWorld(true)
  return mesh
}

/** Local transforms of every node the clip writes to, so the closed pose can be put back. */
function capturePoses(root: Object3D, door: DoorInfo): NodePose[] {
  const poses: NodePose[] = []
  const seen = new Set<Object3D>()
  for (const track of door.clip.tracks) {
    const name = track.name.slice(0, track.name.lastIndexOf('.'))
    const node = name ? root.getObjectByName(name) : null
    if (!node || seen.has(node)) continue
    seen.add(node)
    poses.push({
      node,
      position: node.position.clone(),
      quaternion: node.quaternion.clone(),
      scale: node.scale.clone(),
    })
  }
  return poses
}

function restorePoses(poses: readonly NodePose[]): void {
  for (const pose of poses) {
    pose.node.position.copy(pose.position)
    pose.node.quaternion.copy(pose.quaternion)
    pose.node.scale.copy(pose.scale)
  }
}

/**
 * Moving obstacles for the capsule controller (W4-E).
 *
 * The static collider is baked once into world space; door leaves and window sashes are not in
 * it, because they swing. Each one keeps its own local-space BVH and a live `matrixWorld`, so
 * the controller works against them the other way round: the capsule (and the ground probe ray)
 * is pushed into the mesh's local space, the query runs there, and the answer comes back out.
 *
 * Pascal's leaves are uniformly scaled, so one scalar (`scale`) converts lengths between the two
 * spaces exactly: a local vector of length d is d * scale metres in the world.
 */
import { Box3, DoubleSide, Matrix3, Matrix4, Ray, Vector3, type Line3, type Mesh } from 'three'
import type { MeshBVH } from 'three-mesh-bvh'
import './bvh-setup'

const _localRay = /*@__PURE__*/ new Ray()

/** One moving mesh, with everything the per-step queries need cached. */
export class DynamicCollider {
  readonly mesh: Mesh
  readonly bvh: MeshBVH
  /** World AABB of the mesh in its current pose — the broad phase. */
  readonly worldBox = new Box3()
  /** Local → world lengths. `inverseScale` is the other way. */
  scale = 1
  inverseScale = 1

  private readonly localBox = new Box3()
  private readonly inverse = new Matrix4()
  /** Rotation + scale of `matrixWorld`, for turning local directions into world ones. */
  private readonly linear = new Matrix3()

  constructor(mesh: Mesh, bvh: MeshBVH, localBox: Box3) {
    this.mesh = mesh
    this.bvh = bvh
    this.localBox.copy(localBox)
    this.refresh()
  }

  /** Re-read `matrixWorld` (once per fixed step: the leaf may have swung since the last one). */
  refresh(): void {
    // The animation mixer writes the node transforms, but `matrixWorld` is only refreshed when
    // the renderer walks the scene — which happens after this fixed step. Pull it up ourselves
    // so the collider is never a frame behind the visible leaf.
    this.mesh.updateWorldMatrix(true, false)
    const matrix = this.mesh.matrixWorld
    this.inverse.copy(matrix).invert()
    this.linear.setFromMatrix4(matrix)
    const e = matrix.elements
    const scale = Math.sqrt(Math.max(
      e[0] * e[0] + e[1] * e[1] + e[2] * e[2],
      e[4] * e[4] + e[5] * e[5] + e[6] * e[6],
      e[8] * e[8] + e[9] * e[9] + e[10] * e[10],
    ))
    this.scale = scale > 1e-6 ? scale : 1
    this.inverseScale = 1 / this.scale
    this.worldBox.copy(this.localBox).applyMatrix4(matrix)
  }

  /** World capsule segment → this mesh's local space. */
  toLocalSegment(start: Vector3, end: Vector3, out: Line3): void {
    out.start.copy(start).applyMatrix4(this.inverse)
    out.end.copy(end).applyMatrix4(this.inverse)
  }

  /** Local direction (or push-out vector) → world, keeping its length in metres. */
  toWorldVector(local: Vector3, out: Vector3): Vector3 {
    return out.copy(local).applyMatrix3(this.linear)
  }

  toWorldPoint(local: Vector3, out: Vector3): Vector3 {
    return out.copy(local).applyMatrix4(this.mesh.matrixWorld)
  }

  /** Nearest hit of a world-space ray within `far` metres, reported in world space. */
  raycast(ray: Ray, far: number, outPoint: Vector3, outNormal: Vector3): boolean {
    _localRay.copy(ray).applyMatrix4(this.inverse)
    const hit = this.bvh.raycastFirst(_localRay, DoubleSide, 0, far * this.inverseScale)
    if (!hit?.face) return false
    this.toWorldPoint(hit.point, outPoint)
    this.toWorldVector(hit.face.normal, outNormal).normalize()
    return true
  }
}

/**
 * Wrap the meshes that can collide (skips anything without triangles) and build the bounds trees
 * they are missing. `MapData.doors` hands over leaves that already have one.
 */
export function buildDynamicColliders(meshes: readonly Mesh[]): DynamicCollider[] {
  const colliders: DynamicCollider[] = []
  for (const mesh of meshes) {
    const geometry = mesh.geometry
    const position = geometry?.getAttribute('position')
    if (!position || position.count < 3) continue
    if (!geometry.boundsTree) geometry.computeBoundsTree({ targetLeafSize: 12 })
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    const localBox = geometry.boundingBox
    const bvh = geometry.boundsTree as MeshBVH | undefined
    if (!localBox || !bvh) continue
    colliders.push(new DynamicCollider(mesh, bvh, localBox))
  }
  return colliders
}

/**
 * Dynamic colliders every controller built on a given static collider should see.
 *
 * `local-player.ts` (owned by another package) builds its controller straight from
 * `session.map.collider`, so there is no seam to hand it the leaves through; the map session
 * registers them against the collider instead and `createCharacterController` picks them up.
 * The array is kept live, so a session can add to it later without re-registering.
 */
const registry = new WeakMap<object, Mesh[]>()

export function registerDynamicColliders(key: object, meshes: Mesh[]): void {
  registry.set(key, meshes)
}

export function registeredDynamicColliders(key: object): Mesh[] | undefined {
  return registry.get(key)
}

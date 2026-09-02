/**
 * Merged static collider + BVH + WorldQuery (W1-A).
 *
 * Everything static is baked into ONE world-space geometry with a bounds tree: one BVH walk
 * answers a bullet raycast. The leaves of an openable (door panels and, since W3-D, window
 * sashes) stay separate because they move; they get their own (local-space) bounds tree and
 * the ray is transformed into their space at query time.
 */
import './bvh-setup'
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  InstancedMesh,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Ray,
  SkinnedMesh,
  Sphere,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { MeshBVH } from 'three-mesh-bvh'
import type { DoorInfo, HitResult, StaticCollider, WorldQuery } from '../types'

/** Triangles per BVH leaf. (`targetLeafSize` is the non-deprecated name of `maxLeafSize`.) */
const LEAF_SIZE = 12

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

const _v = new Vector3()
const _normalMatrix = new Matrix3()

/**
 * Bake every visible static mesh under `root` into one world-space geometry with a BVH.
 * `excluded` holds subtree roots to skip (zone/spawn markers, the animated leaves of doors
 * and openable windows).
 */
export function buildStaticCollider(root: Object3D, excluded: Set<Object3D>): StaticCollider {
  root.updateMatrixWorld(true)

  // Flatten the excluded subtrees once so the per-mesh test is a single Set lookup.
  const skip = new Set<Object3D>()
  for (const node of excluded) node.traverse((o) => skip.add(o))

  const geometries: BufferGeometry[] = []
  root.traverse((obj) => {
    if (skip.has(obj)) return
    if (!(obj as Mesh).isMesh) return
    // Pascal exports contain neither skinned nor instanced meshes; ignore them if they appear.
    if ((obj as SkinnedMesh).isSkinnedMesh || (obj as InstancedMesh).isInstancedMesh) return
    const mesh = obj as Mesh
    if (!isVisibleInHierarchy(mesh, root)) return
    const geo = toWorldGeometry(mesh)
    if (geo) geometries.push(geo)
  })

  let merged = geometries.length > 0 ? mergeGeometries(geometries, false) : null
  for (const g of geometries) g.dispose()

  if (!merged || merged.getAttribute('position').count === 0) {
    // Degenerate fallback so callers always get a valid BVH (empty / extras-only GLB).
    merged = new BufferGeometry()
    merged.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, -1000, 0, 0, -1000, 0, 0, -1000, 0]), 3),
    )
    merged.setAttribute(
      'normal',
      new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3),
    )
  }

  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  merged.computeBoundsTree({ targetLeafSize: LEAF_SIZE })

  const mesh = new Mesh(merged, new MeshBasicMaterial({ wireframe: true, color: 0x00ff88 }))
  mesh.name = 'static-collider'
  mesh.visible = false
  mesh.matrixAutoUpdate = false
  mesh.matrixWorldAutoUpdate = false
  mesh.frustumCulled = false
  mesh.updateMatrix()

  return { mesh, geometry: merged }
}

function isVisibleInHierarchy(obj: Object3D, root: Object3D): boolean {
  let node: Object3D | null = obj
  while (node) {
    if (!node.visible) return false
    if (node === root) break
    node = node.parent
  }
  return true
}

/**
 * Copy a mesh's triangles into a fresh world-space geometry that only carries position + normal.
 * Written by hand rather than `clone().applyMatrix4()` because Pascal GLBs use
 * KHR_mesh_quantization: the source attributes are normalized integers and writing floats back
 * into them would truncate, and mergeGeometries needs identical attribute types anyway.
 */
function toWorldGeometry(mesh: Mesh): BufferGeometry | null {
  const src = mesh.geometry
  const position = src.getAttribute('position')
  if (!position || position.itemSize < 3) return null

  const index = src.getIndex()
  const count = index ? index.count : position.count
  if (count === 0) return null

  const matrixWorld = mesh.matrixWorld
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const vi = index ? index.getX(i) : i
    _v.fromBufferAttribute(position, vi).applyMatrix4(matrixWorld)
    positions[i * 3] = _v.x
    positions[i * 3 + 1] = _v.y
    positions[i * 3 + 2] = _v.z
  }

  const out = new BufferGeometry()
  out.setAttribute('position', new BufferAttribute(positions, 3))

  const normal = src.getAttribute('normal')
  if (normal && normal.itemSize >= 3) {
    _normalMatrix.getNormalMatrix(matrixWorld)
    const normals = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const vi = index ? index.getX(i) : i
      _v.fromBufferAttribute(normal, vi).applyMatrix3(_normalMatrix).normalize()
      normals[i * 3] = _v.x
      normals[i * 3 + 1] = _v.y
      normals[i * 3 + 2] = _v.z
    }
    out.setAttribute('normal', new BufferAttribute(normals, 3))
  } else {
    out.computeVertexNormals()
  }

  return out
}

/** Triangle count of a built collider (debug HUD). */
export function colliderTriangleCount(collider: StaticCollider): number {
  const pos = collider.geometry.getAttribute('position')
  return pos ? Math.floor(pos.count / 3) : 0
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const _ray = new Ray()
const _localRay = new Ray()
const _inverse = new Matrix4()
const _point = new Vector3()
const _bestPoint = new Vector3()
const _bestNormal = new Vector3()
const _sphere = new Sphere()
const _box = new Box3()
const _dir = new Vector3()
const _leafNormalMatrix = new Matrix3()

interface LeafEntry {
  mesh: Mesh
  bvh: MeshBVH
  /** Local-space bounding sphere, transformed to world per query. */
  localCenter: Vector3
  localRadius: number
}

interface DoorEntry {
  door: DoorInfo
  leaves: LeafEntry[]
  /** Generous world sphere around the door that contains it in every animation state. */
  center: Vector3
  radius: number
}

/**
 * Raycasts against the static BVH plus the leaves of every openable, nearest hit wins.
 * A closed window sash stops a paintball exactly like a closed door leaf does; an open one
 * has swung out of the way, so the ray goes through the hole it left in the static collider.
 *
 * A miss allocates nothing. A hit allocates one `HitResult` (two `Vector3`s) — deliberately not
 * a shared scratch object, so callers in other packages can hold on to it safely.
 */
export function createWorldQuery(collider: StaticCollider, doors: DoorInfo[]): WorldQuery {
  const staticBvh = collider.geometry.boundsTree as MeshBVH | undefined

  const doorEntries: DoorEntry[] = []
  for (const door of doors) {
    const leaves: LeafEntry[] = []
    for (const leaf of door.leafMeshes) {
      const geo = leaf.geometry
      if (!geo.getAttribute('position')) continue
      if (!geo.boundsTree) geo.computeBoundsTree({ targetLeafSize: LEAF_SIZE })
      if (!geo.boundingSphere) geo.computeBoundingSphere()
      const bs = geo.boundingSphere
      if (!bs) continue
      leaves.push({
        mesh: leaf,
        bvh: geo.boundsTree as MeshBVH,
        localCenter: bs.center.clone(),
        localRadius: bs.radius,
      })
    }
    if (leaves.length === 0) continue

    // Closed-pose bbox + swing margin: leaves rotate about hinges offset by ~halfWidth.
    // (`door` here is any openable — DoorInfo covers windows too.)
    _box.makeEmpty()
    _box.setFromObject(door.node)
    const closedRadius = _box.isEmpty() ? 1.5 : _box.getSize(_v).length() * 0.5
    doorEntries.push({
      door,
      leaves,
      center: door.center.clone(),
      radius: Math.max(closedRadius, door.halfWidth * 2 + 0.5),
    })
  }

  function raycast(origin: Vector3, direction: Vector3, maxDistance: number): HitResult | null {
    _ray.origin.copy(origin)
    _ray.direction.copy(direction).normalize()

    let bestDistance = maxDistance
    let bestObject: Object3D | null = null
    let bestKind: 'static' | 'door' = 'static'

    if (staticBvh) {
      const hit = staticBvh.raycastFirst(_ray, DoubleSide, 0, maxDistance)
      if (hit && hit.distance <= bestDistance) {
        bestDistance = hit.distance
        bestObject = collider.mesh
        bestKind = 'static'
        _bestPoint.copy(hit.point)
        // Collider geometry is already world space, so the face normal needs no transform.
        if (hit.face) _bestNormal.copy(hit.face.normal)
        else _bestNormal.set(0, 1, 0)
      }
    }

    for (let d = 0; d < doorEntries.length; d++) {
      const entry = doorEntries[d]
      _sphere.center.copy(entry.center)
      _sphere.radius = entry.radius
      if (!rayHitsSphereWithin(_ray, _sphere, bestDistance)) continue

      for (let l = 0; l < entry.leaves.length; l++) {
        const leaf = entry.leaves[l]
        const mw = leaf.mesh.matrixWorld
        _sphere.center.copy(leaf.localCenter).applyMatrix4(mw)
        _sphere.radius = leaf.localRadius * maxScale(mw)
        if (!rayHitsSphereWithin(_ray, _sphere, bestDistance)) continue

        _inverse.copy(mw).invert()
        _localRay.copy(_ray).applyMatrix4(_inverse)
        const hit = leaf.bvh.raycastFirst(_localRay, DoubleSide, 0, Infinity)
        if (!hit) continue

        _point.copy(hit.point).applyMatrix4(mw)
        const worldDistance = origin.distanceTo(_point)
        if (worldDistance > bestDistance) continue

        bestDistance = worldDistance
        bestObject = leaf.mesh
        bestKind = 'door'
        _bestPoint.copy(_point)
        if (hit.face) {
          _leafNormalMatrix.getNormalMatrix(mw)
          _bestNormal.copy(hit.face.normal).applyMatrix3(_leafNormalMatrix).normalize()
        } else {
          _bestNormal.set(0, 1, 0)
        }
      }
    }

    if (!bestObject) return null
    return {
      point: _bestPoint.clone(),
      normal: _bestNormal.clone(),
      distance: bestDistance,
      object: bestObject,
      kind: bestKind,
    }
  }

  function lineOfSight(a: Vector3, b: Vector3): boolean {
    _dir.copy(b).sub(a)
    const distance = _dir.length()
    if (distance < 1e-4) return true
    _dir.multiplyScalar(1 / distance)
    return raycast(a, _dir, distance - 0.01) === null
  }

  return { raycast, lineOfSight }
}

/** True if the ray's closest approach to the sphere is inside it, within `maxDistance`. */
function rayHitsSphereWithin(ray: Ray, sphere: Sphere, maxDistance: number): boolean {
  const r = sphere.radius
  if (ray.origin.distanceToSquared(sphere.center) <= r * r) return true
  const t = ray.direction.dot(_v.copy(sphere.center).sub(ray.origin))
  if (t < 0 || t > maxDistance + r) return false
  return ray.distanceSqToPoint(sphere.center) <= r * r
}

/** Largest axis scale of a matrix (for scaling a local bounding radius into world space). */
function maxScale(m: Matrix4): number {
  const e = m.elements
  const sx = e[0] * e[0] + e[1] * e[1] + e[2] * e[2]
  const sy = e[4] * e[4] + e[5] * e[5] + e[6] * e[6]
  const sz = e[8] * e[8] + e[9] * e[9] + e[10] * e[10]
  return Math.sqrt(Math.max(sx, sy, sz))
}

/** Shared unit axes for the down/up probes map-loader and spawns.ts do. */
export const DOWN = /*@__PURE__*/ new Vector3(0, -1, 0)
export const UP = /*@__PURE__*/ new Vector3(0, 1, 0)

/**
 * Static batching (W3-D follow-up).
 *
 * Pascal exports one node per building element: pascal-house is 125 glTF meshes but ~1,700
 * geometries once multi-primitive meshes are expanded, i.e. thousands of ~30-triangle draw
 * calls. They share a handful of materials, so merging them by material collapses the frame to
 * one draw call per material with the exact same pixels.
 *
 * Geometry is baked into WORLD space and the batches are parented to the map root, so no
 * transform is lost. What stays out:
 *
 * - the animated leaves of doors and windows (they move) and zone/spawn markers (never drawn);
 * - meshes with children — hiding those would hide the children too, and Pascal only puts
 *   meshes on leaf nodes anyway;
 * - skinned / instanced / morph-target meshes, which cannot be baked into a static merge.
 *
 * Transparent materials are batched among themselves and drawn after every opaque one, so the
 * glass still reads correctly. Identity nodes (anything with Pascal `extras`) stay in the tree
 * and are merely hidden — `doors.ts` and the level/zone registries resolve objects through them.
 */
import {
  BufferAttribute,
  BufferGeometry,
  InstancedMesh,
  Material,
  Matrix3,
  Matrix4,
  Mesh,
  Object3D,
  SkinnedMesh,
  Texture,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { DoorInfo, PascalExtras } from '../types'

/** Every texture slot we might have to keep a UV set alive for. */
const MAP_KEYS = [
  'map',
  'alphaMap',
  'aoMap',
  'bumpMap',
  'displacementMap',
  'emissiveMap',
  'lightMap',
  'metalnessMap',
  'normalMap',
  'roughnessMap',
  'clearcoatMap',
  'iridescenceMap',
  'sheenColorMap',
  'specularMap',
  'transmissionMap',
  'thicknessMap',
] as const

export interface BatchStats {
  /** Drawable meshes before and after. */
  before: number
  after: number
  /** Merged meshes created (one per material that had something to merge). */
  batches: number
  /** Left alone: excluded, childful, skinned, or missing an attribute the material needs. */
  skipped: number
  ms: number
}

const _v = new Vector3()
const _normalMatrix = new Matrix3()

export function batchStaticMeshes(root: Object3D, excluded: Set<Object3D>[]): BatchStats {
  const t0 = performance.now()
  root.updateMatrixWorld(true)

  const skip = new Set<Object3D>()
  for (const set of excluded) for (const node of set) node.traverse((o) => skip.add(o))

  // Group by material identity: same instance → same draw call after the merge.
  const groups = new Map<string, { material: Material; meshes: Mesh[] }>()
  let before = 0
  let skipped = 0

  root.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh) return
    before++
    if (skip.has(obj)) return skipCount()
    if (mesh.children.length > 0) return skipCount()
    if ((mesh as SkinnedMesh).isSkinnedMesh || (mesh as InstancedMesh).isInstancedMesh) {
      return skipCount()
    }
    if (!isVisibleInHierarchy(mesh, root)) return skipCount()
    const material = mesh.material
    if (Array.isArray(material) || !material) return skipCount()
    const geometry = mesh.geometry
    if (!geometry?.getAttribute('position')) return skipCount()
    if (geometry.morphAttributes && Object.keys(geometry.morphAttributes).length > 0) {
      return skipCount()
    }
    let group = groups.get(material.uuid)
    if (!group) groups.set(material.uuid, (group = { material, meshes: [] }))
    group.meshes.push(mesh)

    function skipCount(): void {
      skipped++
    }
  })

  let batches = 0
  for (const group of groups.values()) {
    // A lone mesh is already one draw call; re-baking it would only cost memory.
    if (group.meshes.length < 2) {
      skipped += group.meshes.length
      continue
    }
    const wanted = wantedAttributes(group.material)
    const baked: BufferGeometry[] = []
    const merged: Mesh[] = []
    for (const mesh of group.meshes) {
      const geometry = bakeVisualGeometry(mesh, wanted, mesh.matrixWorld)
      if (!geometry) {
        skipped++
        continue
      }
      baked.push(geometry)
      merged.push(mesh)
    }
    if (baked.length < 2) {
      for (const g of baked) g.dispose()
      skipped += merged.length
      continue
    }

    const geometry = mergeGeometries(baked, false)
    for (const g of baked) g.dispose()
    if (!geometry) {
      skipped += merged.length
      continue
    }
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()

    const batch = new Mesh(geometry, group.material)
    batch.name = `batch-${group.material.name || group.material.type}-${batches}`
    batch.castShadow = true
    batch.receiveShadow = true
    batch.matrixAutoUpdate = false
    batch.matrixWorldAutoUpdate = false
    batch.updateMatrix()
    // Transparent batches draw after every opaque one, as the originals did.
    if (group.material.transparent) batch.renderOrder = 1
    root.add(batch)
    batches++

    for (const mesh of merged) {
      // Identity nodes carry the Pascal registry; other modules look objects up through them.
      if (typeof (mesh.userData as Partial<PascalExtras> | undefined)?.kind === 'string') {
        mesh.visible = false
      } else {
        mesh.removeFromParent()
      }
    }
  }

  let after = 0
  root.traverse((obj) => {
    const mesh = obj as Mesh
    if (mesh.isMesh && isVisibleInHierarchy(mesh, root)) after++
  })

  return { before, after, batches, skipped, ms: performance.now() - t0 }
}

/** Vertex attributes this material actually samples — everything else is dead weight. */
function wantedAttributes(material: Material): string[] {
  const out = ['position', 'normal']
  const record = material as unknown as Record<string, unknown>
  // glTF TEXCOORD_n maps to three's `uv`, `uv1`, `uv2`, `uv3`. Pascal bakes ambient occlusion
  // into TEXCOORD_2, so dropping anything past uv1 loses the AO and makes every batched mesh
  // warn "Vertex attribute uv2 not found".
  const channels = new Set<number>()
  for (const key of MAP_KEYS) {
    const texture = record[key] as Texture | null | undefined
    if (!texture?.isTexture) continue
    channels.add(Math.min(3, Math.max(0, texture.channel ?? 0)))
  }
  for (const channel of [0, 1, 2, 3]) if (channels.has(channel)) out.push(UV_NAMES[channel])
  if ((material as { vertexColors?: boolean }).vertexColors) out.push('color')
  return out
}

const UV_NAMES = ['uv', 'uv1', 'uv2', 'uv3'] as const

/**
 * A plain-Float32, indexed copy of `mesh`'s geometry carrying exactly `wanted`, baked through
 * `matrix` — world space for a static batch, the animated node's local space for a door leaf.
 *
 * Everything goes through `fromBufferAttribute`/`getX`, which dequantises: Pascal GLBs use
 * KHR_mesh_quantization + meshopt, so the sources are normalised Int16/Int8 inside interleaved
 * buffers and `mergeGeometries` needs identical plain Float32 attributes. Returns null when the
 * mesh cannot provide something the material samples — the caller then leaves it unbatched.
 */
function bakeVisualGeometry(mesh: Mesh, wanted: string[], matrix: Matrix4): BufferGeometry | null {
  const src = mesh.geometry
  const position = src.getAttribute('position')
  if (!position) return null
  const count = position.count
  if (count === 0) return null
  // A mesh missing a secondary UV set the material samples (a few Pascal primitives have no
  // TEXCOORD_2) borrows channel 0 so it can still join the batch; it rendered without that
  // attribute before batching anyway.
  const sourceFor = (name: string) => {
    const attribute = src.getAttribute(name)
    if (attribute) return attribute
    if (name.startsWith('uv')) return src.getAttribute('uv') ?? null
    return null
  }
  for (const name of wanted) if (!sourceFor(name)) return null

  const out = new BufferGeometry()

  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    _v.fromBufferAttribute(position, i).applyMatrix4(matrix)
    positions[i * 3] = _v.x
    positions[i * 3 + 1] = _v.y
    positions[i * 3 + 2] = _v.z
  }
  out.setAttribute('position', new BufferAttribute(positions, 3))

  if (wanted.includes('normal')) {
    const normal = src.getAttribute('normal')
    _normalMatrix.getNormalMatrix(matrix)
    const normals = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      _v.fromBufferAttribute(normal, i).applyMatrix3(_normalMatrix).normalize()
      normals[i * 3] = _v.x
      normals[i * 3 + 1] = _v.y
      normals[i * 3 + 2] = _v.z
    }
    out.setAttribute('normal', new BufferAttribute(normals, 3))
  }

  for (const name of wanted) {
    if (name === 'position' || name === 'normal') continue
    const attribute = sourceFor(name)!
    const itemSize = attribute.itemSize
    const values = new Float32Array(count * itemSize)
    for (let i = 0; i < count; i++) {
      values[i * itemSize] = attribute.getX(i)
      if (itemSize > 1) values[i * itemSize + 1] = attribute.getY(i)
      if (itemSize > 2) values[i * itemSize + 2] = attribute.getZ(i)
      if (itemSize > 3) values[i * itemSize + 3] = attribute.getW(i)
    }
    out.setAttribute(name, new BufferAttribute(values, itemSize))
  }

  // Always indexed, so `mergeGeometries` never sees a mixed batch and the winding fix is uniform.
  const srcIndex = src.getIndex()
  const indexCount = srcIndex ? srcIndex.count : count
  const index = new Uint32Array(indexCount)
  for (let i = 0; i < indexCount; i++) index[i] = srcIndex ? srcIndex.getX(i) : i
  // A mirrored node (negative determinant) reverses triangle winding once its vertices are baked
  // into world space, which would turn it inside out under the FrontSide materials we set.
  if (matrix.determinant() < 0) {
    for (let i = 0; i + 2 < indexCount; i += 3) {
      const swap = index[i + 1]
      index[i + 1] = index[i + 2]
      index[i + 2] = swap
    }
  }
  out.setIndex(new BufferAttribute(index, 1))

  return out
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

// ---------------------------------------------------------------------------
// Openable leaves
// ---------------------------------------------------------------------------

const _inverse = /*@__PURE__*/ new Matrix4()
const _relative = /*@__PURE__*/ new Matrix4()

/**
 * The static batch leaves door panels and window sashes alone, because they move — but the
 * meshes *inside one animated node* all move together, so they can be merged among themselves.
 * pascal-house is 128 leaf meshes across 9 openables and only 30 (animated node × material)
 * pairs, which is most of what is left of the frame once the walls are batched.
 *
 * Geometry is baked into the animated node's LOCAL space and the merge is parented to it, so the
 * clip drives it exactly as it drove the originals. `DoorInfo.leafMeshes` is rewritten to the
 * merged meshes, so bullet BVHs and paint decals follow them without any other module noticing.
 */
export function batchOpenableLeaves(doors: DoorInfo[], animatedNodes: Set<Object3D>[]): number {
  const animated = new Set<Object3D>()
  for (const set of animatedNodes) for (const node of set) animated.add(node)

  let created = 0
  for (const door of doors) {
    const groups = new Map<string, { node: Object3D; material: Material; meshes: Mesh[] }>()
    const keep: Mesh[] = []

    for (const leaf of door.leafMeshes) {
      const owner = animatedAncestor(leaf, animated)
      const material = leaf.material
      if (
        !owner ||
        owner === leaf ||
        leaf.children.length > 0 ||
        Array.isArray(material) ||
        !material ||
        (leaf as SkinnedMesh).isSkinnedMesh ||
        !leaf.geometry?.getAttribute('position')
      ) {
        keep.push(leaf)
        continue
      }
      const key = `${owner.uuid}|${material.uuid}`
      let group = groups.get(key)
      if (!group) groups.set(key, (group = { node: owner, material, meshes: [] }))
      group.meshes.push(leaf)
    }

    for (const group of groups.values()) {
      if (group.meshes.length < 2) {
        for (const mesh of group.meshes) keep.push(mesh)
        continue
      }
      group.node.updateWorldMatrix(true, false)
      _inverse.copy(group.node.matrixWorld).invert()
      const wanted = wantedAttributes(group.material)
      const baked: BufferGeometry[] = []
      const merged: Mesh[] = []
      for (const mesh of group.meshes) {
        _relative.multiplyMatrices(_inverse, mesh.matrixWorld)
        const geometry = bakeVisualGeometry(mesh, wanted, _relative)
        if (!geometry) {
          keep.push(mesh)
          continue
        }
        baked.push(geometry)
        merged.push(mesh)
      }
      if (baked.length < 2) {
        for (const g of baked) g.dispose()
        for (const mesh of merged) keep.push(mesh)
        continue
      }

      const geometry = mergeGeometries(baked, false)
      for (const g of baked) g.dispose()
      if (!geometry) {
        for (const mesh of merged) keep.push(mesh)
        continue
      }
      geometry.computeBoundingBox()
      geometry.computeBoundingSphere()

      const batch = new Mesh(geometry, group.material)
      batch.name = `leaf-batch-${door.id}-${created}`
      batch.castShadow = true
      batch.receiveShadow = true
      // Local transform is identity and never changes; the parent's animation still propagates.
      batch.matrixAutoUpdate = false
      batch.updateMatrix()
      if (group.material.transparent) batch.renderOrder = 1
      group.node.add(batch)
      for (const mesh of merged) mesh.removeFromParent()
      keep.push(batch)
      created++
    }

    door.leafMeshes = keep
  }
  return created
}

/** Nearest ancestor that a clip drives, so everything under it shares one transform. */
function animatedAncestor(mesh: Object3D, animated: Set<Object3D>): Object3D | null {
  let node: Object3D | null = mesh.parent
  while (node) {
    if (animated.has(node)) return node
    node = node.parent
  }
  return null
}

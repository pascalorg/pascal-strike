import { Box3, BufferGeometry, Float32BufferAttribute, Matrix3, Matrix4, MeshStandardMaterial, Ray, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three'
import type { CharacterInstance } from './assets'

interface Cluster { triangles: number[]; bounds: Map<number, Box3> }
const clusterCache = new WeakMap<BufferGeometry, Cluster[]>()

/** Conservative bounds for small sets of triangles, following every bone that influences them. */
function clustersFor(mesh: SkinnedMesh): Cluster[] {
  const geometry = mesh.geometry, cached = clusterCache.get(geometry)
  if (cached) return cached
  const clusters = new Map<number, Cluster>()
  const position = geometry.getAttribute('position'), joints = geometry.getAttribute('skinIndex'), weights = geometry.getAttribute('skinWeight')
  const point = new Vector3(), bonePoint = new Vector3()
  const count = geometry.index?.count ?? position.count
  for (let offset = 0; offset < count; offset += 3) {
    const vertices = [0, 1, 2].map(c => geometry.index?.getX(offset + c) ?? offset + c)
    const totals = new Map<number, number>()
    for (const vertex of vertices) for (let c = 0; c < 4; c++) {
      const bone = joints.getComponent(vertex, c)
      totals.set(bone, (totals.get(bone) ?? 0) + weights.getComponent(vertex, c))
    }
    const dominant = [...totals].sort((a, b) => b[1] - a[1])[0][0]
    let cluster = clusters.get(dominant)
    if (!cluster) { cluster = { triangles: [], bounds: new Map() }; clusters.set(dominant, cluster) }
    cluster.triangles.push(offset)
    for (const vertex of vertices) {
      point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix)
      for (let c = 0; c < 4; c++) {
        if (weights.getComponent(vertex, c) <= 0) continue
        const bone = joints.getComponent(vertex, c)
        let box = cluster.bounds.get(bone)
        if (!box) { box = new Box3(); cluster.bounds.set(bone, box) }
        box.expandByPoint(bonePoint.copy(point).applyMatrix4(mesh.skeleton.boneInverses[bone]))
      }
    }
  }
  const result = [...clusters.values()]
  clusterCache.set(geometry, result)
  return result
}

/** Paint uses the outfit's own triangles and skin weights, so it cannot float off a moving limb. */
export function createCharacterPaint(character: Pick<CharacterInstance, 'model'>) {
  const surfaces: { mesh: SkinnedMesh; clusters: Cluster[] }[] = []
  character.model.traverse(node => {
    if (node instanceof SkinnedMesh && node.visible) surfaces.push({ mesh: node, clusters: clustersFor(node) })
  })
  const ray = new Ray(), bound = new Box3(), transformed = new Box3(), transform = new Matrix4(), skinToWorld = new Matrix4()
  const hit = new Vector3(), normal = new Vector3(), edge = new Vector3(), center = new Vector3()
  const tangent = new Vector3(), bitangent = new Vector3(), delta = new Vector3(), projected = new Vector3()
  const normalMatrix = new Matrix3()

  function clusterBounds(mesh: SkinnedMesh, cluster: Cluster): Box3 {
    bound.makeEmpty()
    skinToWorld.multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse)
    for (const [bone, box] of cluster.bounds) {
      transform.multiplyMatrices(skinToWorld, mesh.skeleton.bones[bone].matrixWorld)
      bound.union(transformed.copy(box).applyMatrix4(transform))
    }
    return bound
  }

  return {
    project(origin: Vector3, direction: Vector3, maxDistance: number, size: number, angle: number, material: MeshStandardMaterial): SkinnedMesh | undefined {
      ray.set(origin, direction)
      let closest = maxDistance, target: typeof surfaces[number] | undefined
      const caches = new Map<SkinnedMesh, Map<number, Vector3>>()
      const vertex = (mesh: SkinnedMesh, index: number) => {
        let cache = caches.get(mesh)
        if (!cache) { cache = new Map(); caches.set(mesh, cache) }
        let point = cache.get(index)
        if (!point) { point = mesh.getVertexPosition(index, new Vector3()).applyMatrix4(mesh.matrixWorld); cache.set(index, point) }
        return point
      }
      const indices = (mesh: SkinnedMesh, offset: number) => [0, 1, 2].map(c => mesh.geometry.index?.getX(offset + c) ?? offset + c)
      for (const surface of surfaces) {
        const mesh = surface.mesh
        for (const cluster of surface.clusters) {
          if (!ray.intersectsBox(clusterBounds(mesh, cluster))) continue
          for (const offset of cluster.triangles) {
            const [a, b, c] = indices(mesh, offset).map(i => vertex(mesh, i))
            if (!ray.intersectTriangle(a, b, c, true, hit)) continue
            const distance = origin.distanceTo(hit)
            if (distance >= closest) continue
            closest = distance; target = surface; center.copy(hit)
            normal.subVectors(b, a).cross(edge.subVectors(c, a)).normalize()
          }
        }
      }
      // A stale network point can miss a moving limb. Never invent an off-body fallback plane.
      if (!target) return undefined
      tangent.set(0, 1, 0).cross(normal)
      if (tangent.lengthSq() < .001) tangent.set(1, 0, 0).cross(normal)
      tangent.normalize().applyAxisAngle(normal, angle)
      bitangent.crossVectors(normal, tangent)
      const mesh = target.mesh, source = mesh.geometry
      const positions: number[] = [], normals: number[] = [], joints: number[] = [], weights: number[] = [], uvs: number[] = []
      const position = source.getAttribute('position'), sourceNormal = source.getAttribute('normal')
      const skinIndex = source.getAttribute('skinIndex'), skinWeight = source.getAttribute('skinWeight')
      const patchBounds = new Box3().setFromCenterAndSize(center, new Vector3().setScalar(size * 1.8))
      for (const cluster of target.clusters) {
        if (!clusterBounds(mesh, cluster).intersectsBox(patchBounds)) continue
        for (const offset of cluster.triangles) {
          const ids = indices(mesh, offset), points = ids.map(i => vertex(mesh, i))
          edge.subVectors(points[1], points[0]); delta.subVectors(points[2], points[0]).cross(edge)
          if (delta.dot(normal) >= 0) continue
          const uv = points.map(p => { delta.subVectors(p, center); return [delta.dot(tangent) / size + .5, delta.dot(bitangent) / size + .5, delta.dot(normal)] })
          if ([0, 1].some(axis => uv.every(p => p[axis] < 0) || uv.every(p => p[axis] > 1))) continue
          if (uv.every(p => p[2] < -size * .3) || uv.every(p => p[2] > size * .3)) continue
          // Entire original triangles: the alpha texture clips the footprint. Keeping the original
          // vertices/weights makes deformation exactly match the outfit, even across a joint.
          for (let c = 0; c < 3; c++) {
            const i = ids[c]
            projected.fromBufferAttribute(position, i); positions.push(projected.x, projected.y, projected.z)
            if (sourceNormal) projected.fromBufferAttribute(sourceNormal, i)
            else { normalMatrix.getNormalMatrix(mesh.matrixWorld).invert(); projected.copy(normal).applyMatrix3(normalMatrix).normalize() }
            normals.push(projected.x, projected.y, projected.z)
            for (let j = 0; j < 4; j++) { joints.push(skinIndex.getComponent(i, j)); weights.push(skinWeight.getComponent(i, j)) }
            uvs.push(uv[c][0], uv[c][1])
          }
        }
      }
      if (!positions.length) return undefined
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
      geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
      geometry.setAttribute('skinIndex', new Uint16BufferAttribute(joints, 4))
      geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4))
      geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
      const paint = new SkinnedMesh(geometry, material)
      paint.name = 'character-paint'
      paint.bindMode = mesh.bindMode; paint.skeleton = mesh.skeleton
      paint.bindMatrix.copy(mesh.bindMatrix); paint.bindMatrixInverse.copy(mesh.bindMatrixInverse)
      paint.frustumCulled = false; paint.renderOrder = 12
      mesh.add(paint)
      return paint
    },
  }
}

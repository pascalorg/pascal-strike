import {
  Box3,
  BufferGeometry,
  Float32BufferAttribute,
  CanvasTexture,
  Euler,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Scene,
  Vector3,
} from 'three'
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js'
import { DECALS, TEAMS } from '../config'
import type { TeamId } from '../types'

export interface Decals {
  add(
    target: Object3D & { geometry: Mesh['geometry'] },
    point: Vector3,
    normal: Vector3,
    team: TeamId,
    seed: number,
  ): void
  clear(): void
  readonly count: number
  dispose(): void
}

interface DecalSlot {
  mesh: Mesh
  used: boolean
}

const forward = new Vector3(0, 0, 1)
const projectorPoint = new Vector3()
const size = new Vector3()
const orientation = new Euler()
const rotation = new Quaternion()
const inverse = new Matrix4()
const localBounds = new Box3()
const localPoint = new Vector3()
const worldScale = new Vector3()
const patchMesh = new Mesh()

export function createDecals(scene: Scene): Decals {
  const alphaMaps = SPLAT_VARIANTS.map((_, index) => getSplatTexture(index))
  const materials: Record<TeamId, MeshStandardMaterial[]> = {
    a: makeMaterials('a'),
    b: makeMaterials('b'),
  }
  const slots: DecalSlot[] = Array.from({ length: DECALS.maxCount }, () => {
    const mesh = new Mesh(undefined, materials.a[0])
    mesh.visible = false
    mesh.renderOrder = 20
    return { mesh, used: false }
  })
  let cursor = 0
  let count = 0

  function makeMaterials(team: TeamId): MeshStandardMaterial[] {
    return alphaMaps.map((alphaMap) => new MeshStandardMaterial({
      color: TEAMS[team].colorHex,
      alphaMap,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      roughness: 0.72,
    }))
  }

  function clearSlot(slot: DecalSlot): void {
    if (!slot.used) return
    slot.mesh.removeFromParent()
    slot.mesh.geometry.dispose()
    slot.mesh.visible = false
    slot.used = false
  }

  return {
    add(target, point, normal, team, seed) {
      const slot = slots[cursor]
      cursor = (cursor + 1) % slots.length
      if (slot.used) clearSlot(slot)
      else count++

      const random = seededRandom(seed)
      const diameter = DECALS.minSize + (DECALS.maxSize - DECALS.minSize) * random()
      projectorPoint.copy(point).addScaledVector(normal, DECALS.offset)
      rotation.setFromUnitVectors(forward, normal)
      orientation.setFromQuaternion(rotation)
      orientation.z += random() * Math.PI * 2
      size.set(diameter, diameter * (0.8 + random() * 0.35), diameter * 0.35)
      target.updateWorldMatrix(true, false)
      const geometry = createSurfaceDecal(target as Mesh, projectorPoint, orientation, size)

      const followsTarget = target.parent !== null && target.parent !== scene
      if (followsTarget) {
        inverse.copy(target.matrixWorld).invert()
        geometry.applyMatrix4(inverse)
        target.add(slot.mesh)
      } else {
        scene.add(slot.mesh)
      }
      slot.mesh.geometry = geometry
      slot.mesh.material = materials[team][seed & 3]
      slot.mesh.visible = true
      slot.mesh.position.set(0, 0, 0)
      slot.mesh.rotation.set(0, 0, 0)
      slot.mesh.scale.set(1, 1, 1)
      slot.used = true
    },
    clear() {
      for (const slot of slots) clearSlot(slot)
      count = 0
      cursor = 0
    },
    get count() { return count },
    dispose() {
      for (const slot of slots) clearSlot(slot)
      for (const teamMaterials of Object.values(materials)) {
        for (const material of teamMaterials) material.dispose()
      }
      // `alphaMaps` are the shared module-level splat textures (avatars paint with the same
      // ones), so a session teardown must not dispose them.
      count = 0
    },
  }
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = Math.imul(value ^ value >>> 15, value | 1)
    return ((value ^ value >>> 13) >>> 0) / 4294967296
  }
}

/** The four procedural splat shapes, built once and shared by decals and avatar paint. */
export const SPLAT_VARIANTS = [0, 1, 2, 3] as const

const splatTextures: (CanvasTexture | null)[] = [null, null, null, null]

/**
 * Alpha map for one splat variant. Lazy so importing this module outside a DOM (tests) is safe,
 * and shared so a wall decal and the paint on a player use the very same blob.
 */
export function getSplatTexture(variant: number): CanvasTexture {
  const index = ((variant % SPLAT_VARIANTS.length) + SPLAT_VARIANTS.length) % SPLAT_VARIANTS.length
  const existing = splatTextures[index]
  if (existing) return existing
  const texture = makeSplatTexture(index)
  splatTextures[index] = texture
  return texture
}

function makeSplatTexture(variant: number): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 512
  const context = canvas.getContext('2d')!
  const random = seededRandom(0x51f15e + variant * 997)
  context.fillStyle = '#fff'
  context.beginPath()
  const points = 22
  for (let index = 0; index < points; index++) {
    const angle = index / points * Math.PI * 2
    const radius = 138 + random() * 54
    const x = 256 + Math.cos(angle) * radius
    const y = 240 + Math.sin(angle) * radius
    if (index === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  }
  context.closePath()
  context.fill()
  const drips = 2 + (variant % 3)
  for (let index = 0; index < drips; index++) {
    const x = 175 + random() * 170
    const length = 45 + random() * 95
    context.beginPath()
    context.ellipse(x, 365 + length / 2, 10 + random() * 12, length / 2, 0, 0, Math.PI * 2)
    context.fill()
    context.beginPath()
    context.arc(x, 365 + length, 13 + random() * 8, 0, Math.PI * 2)
    context.fill()
  }
  const texture = new CanvasTexture(canvas)
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  return texture
}

/** Limit projection to nearby BVH triangles; a wall hit must not scan the entire merged house. */
export function createSurfaceDecal(target: Mesh, point: Vector3, orientation: Euler, size: Vector3): BufferGeometry {
  const source = target.geometry
  const tree = source.boundsTree
  if (!tree) return new DecalGeometry(target, point, orientation, size)
  target.updateWorldMatrix(true, false)
  inverse.copy(target.matrixWorld).invert()
  localPoint.copy(point).applyMatrix4(inverse)
  target.getWorldScale(worldScale)
  const radius = size.length() * .5 / Math.max(.0001, Math.min(Math.abs(worldScale.x), Math.abs(worldScale.y), Math.abs(worldScale.z)))
  localBounds.setFromCenterAndSize(localPoint, worldScale.setScalar(radius * 2))
  const positions: number[] = [], normals: number[] = []
  const position = source.getAttribute('position'), normal = source.getAttribute('normal'), index = source.index
  tree.shapecast({
    intersectsBounds: bounds => bounds.intersectsBox(localBounds),
    intersectsTriangle: (triangle, triangleIndex) => {
      triangle.getNormal(worldScale)
      for (let corner = 0; corner < 3; corner++) {
        const vertex = index ? index.getX(triangleIndex * 3 + corner) : triangleIndex * 3 + corner
        positions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex))
        normals.push(normal ? normal.getX(vertex) : worldScale.x, normal ? normal.getY(vertex) : worldScale.y, normal ? normal.getZ(vertex) : worldScale.z)
      }
      return false
    },
  })
  const patch = new BufferGeometry()
  patch.setAttribute('position', new Float32BufferAttribute(positions, 3))
  patch.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  patchMesh.geometry = patch; patchMesh.matrixWorld.copy(target.matrixWorld)
  const decal = new DecalGeometry(patchMesh, point, orientation, size)
  patch.dispose()
  return decal
}

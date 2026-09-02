import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Ray,
  RepeatWrapping,
  Scene,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { MeshBVH } from 'three-mesh-bvh'
import type { HitResult, StaticCollider, WorldQuery } from '../types'
import '../player/bvh-setup'

export interface TestRoom {
  collider: StaticCollider
  world: WorldQuery
  bounds: Box3
  doors: []
  root: Group
}

const ray = new Ray()
const rayDirection = new Vector3()

/** Geometry-only builder used by Bun tests; it does not require a DOM or Scene. */
export function createTestRoom(): TestRoom {
  const root = new Group()
  root.name = 'test-room'
  const collisionParts: BufferGeometry[] = []

  addBox(root, collisionParts, 'floor', [16, 0.2, 12], [0, -0.1, 0])
  addBox(root, collisionParts, 'ceiling', [16, 0.2, 12], [0, 3.1, 0])
  addBox(root, collisionParts, 'wall', [0.2, 3, 12], [-8.1, 1.5, 0])
  addBox(root, collisionParts, 'wall', [0.2, 3, 12], [8.1, 1.5, 0])
  addBox(root, collisionParts, 'wall', [16, 3, 0.2], [0, 1.5, -6.1])
  addBox(root, collisionParts, 'wall', [16, 3, 0.2], [0, 1.5, 6.1])

  addBox(root, collisionParts, 'obstacle', [1.2, 1.2, 1.2], [-5.8, 0.6, 3.8])
  addBox(root, collisionParts, 'obstacle', [1.2, 1.2, 1.2], [5.8, 0.6, 3.8])
  addBox(root, collisionParts, 'step', [2.2, 0.4, 1.6], [-4.2, 0.2, 0])
  // The underside is exactly 1.3 m: standing blocks, a 1.15 m crouch clears.
  addBox(root, collisionParts, 'low-slab', [2.4, 0.5, 2.2], [-0.5, 1.55, 0])
  addRamp(root, collisionParts, [2.5, 0, 1.8], 1.15, 20)
  addBox(root, collisionParts, 'pillar', [0.8, 3, 0.8], [5.9, 1.5, -3.8])

  const colliderGeometry = mergeGeometries(collisionParts, false)
  if (!colliderGeometry) throw new Error('Could not merge test room collider')
  colliderGeometry.computeBoundingBox()
  colliderGeometry.computeBoundsTree({ targetLeafSize: 12 })
  const colliderMesh = new Mesh(colliderGeometry)
  colliderMesh.name = 'test-room-collider'
  colliderMesh.visible = false
  colliderMesh.matrixAutoUpdate = false
  colliderMesh.updateMatrixWorld(true)
  const collider: StaticCollider = { mesh: colliderMesh, geometry: colliderGeometry }
  const bounds = colliderGeometry.boundingBox!.clone()
  const bvh = colliderGeometry.boundsTree as MeshBVH

  const world: WorldQuery = {
    raycast(origin, direction, maxDistance) {
      ray.origin.copy(origin)
      rayDirection.copy(direction)
      const length = rayDirection.length()
      if (length < 1e-10 || maxDistance <= 0) return null
      ray.direction.copy(rayDirection).multiplyScalar(1 / length)
      const hit = bvh.raycastFirst(ray, DoubleSide, 0, maxDistance)
      if (!hit?.face) return null
      const result: HitResult = {
        point: hit.point.clone(),
        normal: hit.face.normal.clone(),
        distance: hit.distance,
        object: colliderMesh,
        kind: 'static',
      }
      return result
    },
    lineOfSight(a, b) {
      rayDirection.subVectors(b, a)
      const distance = rayDirection.length()
      if (distance < 1e-10) return true
      return this.raycast(a, rayDirection, distance - 1e-4) === null
    },
  }

  return { collider, world, bounds, doors: [], root }
}

/** Add the already-built visual room to a Scene and apply its browser-only checker texture. */
export function addTestRoomToScene(scene: Scene, room: TestRoom): TestRoom {
  const checker = createCheckerTexture()
  room.root.traverse((object) => {
    if (!(object instanceof Mesh)) return
    const role = object.userData.role as string
    object.castShadow = role !== 'floor'
    object.receiveShadow = true
    object.material = new MeshStandardMaterial({
      color: role === 'step' ? 0xd97706 : role === 'low-slab' ? 0x0f766e : 0x71717a,
      map: role === 'floor' || role === 'wall' ? checker : null,
      roughness: 0.85,
    })
  })
  scene.add(room.root)
  return room
}

export function buildTestRoom(scene: Scene): TestRoom {
  return addTestRoomToScene(scene, createTestRoom())
}

function collisionGeometry(geometry: BufferGeometry, matrix: Matrix4): BufferGeometry {
  const result = geometry.clone().applyMatrix4(matrix)
  for (const name of Object.keys(result.attributes)) {
    if (name !== 'position' && name !== 'normal') result.deleteAttribute(name)
  }
  return result.index ? result.toNonIndexed() : result
}

function addBox(
  root: Group,
  colliders: BufferGeometry[],
  role: string,
  size: [number, number, number],
  position: [number, number, number],
): void {
  const geometry = new BoxGeometry(...size)
  const mesh = new Mesh(geometry)
  mesh.position.fromArray(position)
  mesh.userData.role = role
  mesh.updateMatrix()
  root.add(mesh)
  colliders.push(collisionGeometry(geometry, mesh.matrix))
}

function addRamp(
  root: Group,
  colliders: BufferGeometry[],
  position: [number, number, number],
  rise: number,
  degrees: number,
): void {
  const width = 2.2
  const run = rise / Math.tan(degrees * Math.PI / 180)
  const x0 = -width / 2
  const x1 = width / 2
  const z0 = -run / 2
  const z1 = run / 2
  const vertices = [
    // top
    x0, 0, z1, x1, 0, z1, x1, rise, z0,
    x0, 0, z1, x1, rise, z0, x0, rise, z0,
    // bottom
    x0, 0, z0, x1, 0, z0, x1, 0, z1,
    x0, 0, z0, x1, 0, z1, x0, 0, z1,
    // sides
    x0, 0, z1, x0, rise, z0, x0, 0, z0,
    x1, 0, z1, x1, 0, z0, x1, rise, z0,
    // back
    x0, 0, z0, x0, rise, z0, x1, rise, z0,
    x0, 0, z0, x1, rise, z0, x1, 0, z0,
  ]
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3))
  geometry.computeVertexNormals()
  const mesh = new Mesh(geometry)
  mesh.position.fromArray(position)
  mesh.userData.role = 'ramp'
  mesh.updateMatrix()
  root.add(mesh)
  colliders.push(collisionGeometry(geometry, mesh.matrix))
}

function createCheckerTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const context = canvas.getContext('2d')!
  context.fillStyle = '#5b5b64'
  context.fillRect(0, 0, 128, 128)
  context.fillStyle = '#70707a'
  context.fillRect(0, 0, 64, 64)
  context.fillRect(64, 64, 64, 64)
  const texture = new CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.repeat.set(8, 8)
  return texture
}

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
  Object3D,
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
  /**
   * A door leaf that is NOT in the static collider — the stand-in for a Pascal openable, which
   * the controller collides with through `setDynamicColliders`. Rotate `doorHinge.rotation.y`
   * (0 = closed across the doorway at z = 0, ±π/2 = swung out of it) and the collider follows.
   */
  doorLeaf: Mesh
  doorHinge: Object3D
}

const ray = new Ray()
const rayDirection = new Vector3()

/** Geometry-only builder used by Bun tests; it does not require a DOM or Scene. */
export function buildTestRoomGeometry(): TestRoom {
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

  // Keep the stair fixtures outside the original room so tests which depend on
  // its obstacle layout and sight lines remain unchanged.
  addStaircase(root, collisionParts, 'stair-45', 10, 3, 12, 0.25, 0.25)
  addStaircase(root, collisionParts, 'stair-shallow', 13, 3.48, 12, 0.17, 0.29)

  // Doorway with a swinging leaf, also outside the room (see TestRoom.doorLeaf).
  addBox(root, collisionParts, 'floor', [4.4, 0.2, 4.4], [16, -0.1, 0])
  addBox(root, collisionParts, 'wall', [1.5, 2.5, 0.2], [14.75, 1.25, 0])
  addBox(root, collisionParts, 'wall', [1.5, 2.5, 0.2], [17.25, 1.25, 0])
  const { leaf: doorLeaf, hinge: doorHinge } = addDoorLeaf(root, [15.5, 0, 0])

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

  return { collider, world, bounds, doors: [], root, doorLeaf, doorHinge }
}

/** Backwards-compatible headless entry point used by existing tests. */
export function createTestRoom(): TestRoom {
  return buildTestRoomGeometry()
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
      color: role === 'step' || role.startsWith('stair-')
        ? 0xd97706
        : role === 'low-slab' ? 0x0f766e : role === 'door-leaf' ? 0x9f1239 : 0x71717a,
      map: role === 'floor' || role === 'wall' ? checker : null,
      roughness: 0.85,
    })
  })
  scene.add(room.root)
  return room
}

export function buildTestRoom(scene: Scene): TestRoom {
  return addTestRoomToScene(scene, buildTestRoomGeometry())
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

/**
 * A 1 m × 2 m leaf on a hinge, deliberately left out of the merged collider: it is the fixture
 * for `CharacterController.setDynamicColliders`, so it has to move after the BVH is built.
 */
function addDoorLeaf(
  root: Group,
  hingePosition: [number, number, number],
): { leaf: Mesh; hinge: Object3D } {
  const hinge = new Object3D()
  hinge.name = 'door-hinge'
  hinge.position.fromArray(hingePosition)
  const leaf = new Mesh(new BoxGeometry(1, 2, 0.06))
  leaf.name = 'door-leaf'
  leaf.userData.role = 'door-leaf'
  // Hinged at its edge, so rotating the parent swings it out of the doorway.
  leaf.position.set(0.5, 1, 0)
  hinge.add(leaf)
  root.add(hinge)
  hinge.updateMatrixWorld(true)
  return { leaf, hinge }
}

function addStaircase(
  root: Group,
  colliders: BufferGeometry[],
  role: string,
  centerX: number,
  startZ: number,
  stepCount: number,
  riser: number,
  tread: number,
): void {
  const width = 1.4
  const rise = stepCount * riser
  const run = stepCount * tread

  addBox(root, colliders, `${role}-approach`, [width, 0.2, 3], [centerX, -0.1, startZ + 1.5])
  for (let index = 0; index < stepCount; index++) {
    const height = (index + 1) * riser
    addBox(
      root,
      colliders,
      role,
      [width, height, tread],
      [centerX, height / 2, startZ - (index + 0.5) * tread],
    )
  }
  addBox(root, colliders, `${role}-landing`, [width, rise, 3], [centerX, rise / 2, startZ - run - 1.5])
  addBox(root, colliders, `${role}-stop`, [width, 2, 0.2], [centerX, rise + 1, startZ - run - 3.1])
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

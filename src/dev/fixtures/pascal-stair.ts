/**
 * The real staircase of `pascal-house.glb`, frozen into a fixture so headless tests can walk the
 * geometry the game actually builds (see `extract-stair.ts` for how it was pulled out).
 *
 * Pascal's "Staircase 1" is a CURVED flight: ten 0.25 m risers sweeping ~150° of an arc centred
 * on `PASCAL_STAIR.center`, treads that are wedges (narrow at the newel, wide at the outer
 * string), a newel post at r ≈ 0.24 m and a railing at r ≈ 1.34 m — plus the surrounding floor
 * and the Floor-1 slab it lands on, because they are part of the same box of triangles.
 */
import { BufferAttribute, BufferGeometry, Mesh } from 'three'
import type { StaticCollider } from '../../types'
import '../../player/bvh-setup'
import fixture from './pascal-stair.json'

/** Everything a test needs to walk the flight, measured from the extracted triangles. */
export const PASCAL_STAIR = {
  /** Centre of the arc in world XZ (the newel post). */
  center: { x: 0, z: 0.5 },
  /** Radius of the tread centres. The walkable band is roughly 0.55 m … 1.05 m. */
  walkRadius: 0.85,
  /** Angle (radians, measured from +X in the XZ plane) of the first and last tread. */
  startAngle: -74.6 * Math.PI / 180,
  endAngle: 74.6 * Math.PI / 180,
  /** Tread tops, bottom to top. */
  treadY: [0.3, 0.55, 0.8, 1.05, 1.3, 1.55, 1.8, 2.05, 2.3, 2.55],
  riser: 0.25,
  /** Floor at the bottom of the flight, and the Floor-1 slab at the top. */
  floorY: 0.05,
  landingY: 2.55,
} as const

/** Builds the collider once per call (tests mutate nothing, but each gets its own BVH). */
export function buildPascalStairCollider(): StaticCollider {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(fixture.positions), 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundsTree({ targetLeafSize: 12 })
  const mesh = new Mesh(geometry)
  mesh.name = 'pascal-stair-fixture'
  mesh.matrixAutoUpdate = false
  mesh.updateMatrixWorld(true)
  return { mesh, geometry }
}

/** World position on the walk line at `angle`, at the given radius. */
export function stairPoint(angle: number, radius: number = PASCAL_STAIR.walkRadius): [number, number] {
  return [
    PASCAL_STAIR.center.x + Math.cos(angle) * radius,
    PASCAL_STAIR.center.z + Math.sin(angle) * radius,
  ]
}

/**
 * Yaw that walks *up* the flight at `angle` (the controller's forward is
 * `(-sin yaw, 0, -cos yaw)`, the arc's tangent is `(-sin angle, 0, cos angle)`).
 */
export function stairYaw(angle: number): number {
  return Math.PI - angle
}

/** How far round the arc the autopilot aims. A player looks up the flight, not at their feet. */
const LOOK_AHEAD = 0.45

/**
 * What a player does on a curved stair: aim at a point further round the arc, on the walk line
 * at `radius`. Returns the yaw to feed `CharacterController.update`.
 */
export function stairAutopilotYaw(x: number, z: number, radius: number): number {
  const angle = Math.atan2(z - PASCAL_STAIR.center.z, x - PASCAL_STAIR.center.x)
  const [targetX, targetZ] = stairPoint(
    Math.min(angle + LOOK_AHEAD, PASCAL_STAIR.endAngle + 0.5),
    radius,
  )
  return Math.atan2(-(targetX - x), -(targetZ - z))
}

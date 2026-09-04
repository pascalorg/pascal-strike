/**
 * The real staircase of `pascal-house.glb`, frozen into fixtures so headless tests can walk the
 * geometry the game actually builds (see `extract-stair.ts` for how it was pulled out).
 *
 * Pascal's "Staircase 1" is a CURVED flight: ten 0.25 m risers sweeping 180° of an arc centred
 * on the newel, treads that are wedges (narrow at the newel, wide at the outer string), a newel
 * post at r ≈ 0.24 m and a railing at r ≈ 1.34 m — plus the surrounding floor and the slab it
 * lands on, because they are part of the same box of triangles.
 *
 * Two versions, because the storey height changed under the same flight:
 * - v5 landed straight onto Floor 1 at 2.55 m, under a 2.48 m soffit that made the foot of the
 *   flight tight for a standing player;
 * - v7 raised the storey to 3 m, so the same ten treads stop at 2.55 and one **0.50 m** step
 *   remains onto the Floor-1 slab at 3.05 — the reason `PLAYER.stepHeight` is 0.52.
 */
import { BufferAttribute, BufferGeometry, Mesh } from 'three'
import type { StaticCollider } from '../../types'
import '../../player/bvh-setup'
import fixtureV5 from './pascal-stair.json'
import fixtureV7 from './pascal-stair-v7.json'

export interface StairFixture {
  /** Centre of the arc in world XZ (the newel post). */
  center: { x: number; z: number }
  /** Radius of the tread centres. The walkable band is roughly 0.55 m … 1.05 m. */
  walkRadius: number
  /** Angle (radians, measured from +X in the XZ plane) of the first and last tread. */
  startAngle: number
  endAngle: number
  /** Tread tops, bottom to top. */
  treadY: number[]
  riser: number
  /** Floor at the bottom of the flight, and the storey slab at the top. */
  floorY: number
  landingY: number
  /** The last step: from the top tread onto the slab (0.50 m in v7, nothing in v5). */
  finalRiser: number
}

const ARC = {
  center: { x: 0, z: 0.5 },
  walkRadius: 0.85,
  startAngle: -74.6 * Math.PI / 180,
  endAngle: 74.6 * Math.PI / 180,
  treadY: [0.3, 0.55, 0.8, 1.05, 1.3, 1.55, 1.8, 2.05, 2.3, 2.55],
  riser: 0.25,
  floorY: 0.05,
}

/** pascal-house v5: the flight ends level with Floor 1. */
export const PASCAL_STAIR: StairFixture = { ...ARC, landingY: 2.55, finalRiser: 0 }

/** pascal-house v7: 3 m storeys, so the top tread is 0.50 m below the Floor-1 slab. */
export const PASCAL_STAIR_V7: StairFixture = { ...ARC, landingY: 3.05, finalRiser: 0.5 }

/** Builds the collider once per call (tests mutate nothing, but each gets its own BVH). */
export function buildPascalStairCollider(): StaticCollider {
  return buildCollider(fixtureV5.positions, 'pascal-stair-v5-fixture')
}

export function buildPascalStairColliderV7(): StaticCollider {
  return buildCollider(fixtureV7.positions, 'pascal-stair-v7-fixture')
}

function buildCollider(positions: number[], name: string): StaticCollider {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundsTree({ targetLeafSize: 12 })
  const mesh = new Mesh(geometry)
  mesh.name = name
  mesh.matrixAutoUpdate = false
  mesh.updateMatrixWorld(true)
  return { mesh, geometry }
}

/** World position on the walk line at `angle`, at the given radius. */
export function stairPoint(
  angle: number,
  radius: number = ARC.walkRadius,
  stair: StairFixture = PASCAL_STAIR,
): [number, number] {
  return [
    stair.center.x + Math.cos(angle) * radius,
    stair.center.z + Math.sin(angle) * radius,
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
 * at `radius`. `direction` is +1 going up, -1 coming back down. Returns the yaw to feed
 * `CharacterController.update`.
 */
export function stairAutopilotYaw(
  x: number,
  z: number,
  radius: number,
  direction: 1 | -1 = 1,
  stair: StairFixture = PASCAL_STAIR,
): number {
  const angle = Math.atan2(z - stair.center.z, x - stair.center.x)
  const aim = direction > 0
    ? Math.min(angle + LOOK_AHEAD, stair.endAngle + 0.5)
    : Math.max(angle - LOOK_AHEAD, stair.startAngle - 0.5)
  const [targetX, targetZ] = stairPoint(aim, radius, stair)
  return Math.atan2(-(targetX - x), -(targetZ - z))
}

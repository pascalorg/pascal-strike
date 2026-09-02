// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { Box3, BufferGeometry, Group, Mesh, Vector3 } from 'three'
import type { HitResult, MapData, Navigation, WorldQuery } from '../types'
import { createRoamTargetSet } from './roam'

const INDOOR_MIN = -5
const INDOOR_MAX = 5
const CEILING_Y = 3

test('fixed-seed roaming chooses indoor targets at least 80% of the time', () => {
  const { map, world, nav } = fixture()
  const targets = createRoamTargetSet(map, world, nav)
  const first = sampleTargets(targets, mulberry32(0x5eed), 200)
  const second = sampleTargets(targets, mulberry32(0x5eed), 200)
  const indoorCount = first.filter(([x, y, z]) => isIndoor(new Vector3(x, y, z))).length

  expect(targets.indoorSize).toBeGreaterThan(0)
  expect(indoorCount).toBeGreaterThanOrEqual(160)
  expect(second).toEqual(first)
})

function fixture(): { map: MapData; world: WorldQuery; nav: Navigation } {
  const object = new Group()
  const bounds = new Box3(new Vector3(-10, 0, -10), new Vector3(10, 4, 10))
  const world: WorldQuery = {
    raycast(origin, direction, maxDistance) {
      if (direction.y < 0) {
        const distance = origin.y
        if (distance < 0 || distance > maxDistance) return null
        return hit(origin.x, 0, origin.z, distance, 1, object)
      }
      if (!isIndoor(origin)) return null
      const distance = CEILING_Y - origin.y
      if (distance < 0 || distance > maxDistance) return null
      return hit(origin.x, CEILING_Y, origin.z, distance, -1, object)
    },
    lineOfSight: () => true,
  }
  const nav = {
    ready: true,
    findPath: (from: Vector3, to: Vector3) => [from.clone(), to.clone()],
    randomPoint: () => new Vector3(),
    randomPointAround: (center: Vector3) => center.clone(),
    closestPoint: (point: Vector3) => point.clone(),
    snapToNavmesh: (point: Vector3) => point.clone(),
  }
  const colliderMesh = new Mesh(new BufferGeometry())
  const map: MapData = {
    name: 'roam fixture',
    root: new Group(),
    levels: [{ id: 'level-0', label: 'Level 0', node: new Group(), y: 0 }],
    zones: [],
    spawnNodes: [],
    doors: [],
    collider: { mesh: colliderMesh, geometry: colliderMesh.geometry },
    bounds,
    navMeshSource: [colliderMesh],
  }
  return { map, world, nav }
}

function hit(
  x: number,
  y: number,
  z: number,
  distance: number,
  normalY: number,
  object: Group,
): HitResult {
  return {
    point: new Vector3(x, y, z),
    normal: new Vector3(0, normalY, 0),
    distance,
    object,
    kind: 'static',
  }
}

function isIndoor(point: Vector3): boolean {
  return point.x >= INDOOR_MIN && point.x <= INDOOR_MAX
    && point.z >= INDOOR_MIN && point.z <= INDOOR_MAX
}

function sampleTargets(
  targets: ReturnType<typeof createRoamTargetSet>,
  rng: () => number,
  count: number,
): [number, number, number][] {
  const samples: [number, number, number][] = []
  for (let index = 0; index < count; index++) {
    const point = targets.sample(rng)
    if (!point) throw new Error('fixture produced no roam targets')
    samples.push([point.x, point.y, point.z])
  }
  return samples
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let next = value
    next = Math.imul(next ^ next >>> 15, next | 1)
    next ^= next + Math.imul(next ^ next >>> 7, next | 61)
    return ((next ^ next >>> 14) >>> 0) / 4294967296
  }
}

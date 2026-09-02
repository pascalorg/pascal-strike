import { Vector3 } from 'three'
import { validateFloor } from '../map/spawns'
import type { MapData, Navigation, WorldQuery } from '../types'

const GRID_STEP = 0.5
const MAX_GRID_CANDIDATES_PER_LEVEL = 4000
const NAV_SNAP_TOLERANCE = 0.3
const INDOOR_PROBE_HEIGHT = 0.3
const INDOOR_CEILING_RANGE = 4
const INDOOR_TARGET_CHANCE = 0.85
const BUILDING_AREA_RADIUS = 8
// The stricter gameplay bound wins over the broader definition of the building area.
const MAX_DISTANCE_FROM_INDOOR = 4
const UP = new Vector3(0, 1, 0)

interface Candidate {
  point: Vector3
  indoor: boolean
}

export interface RoamTargetSet {
  readonly size: number
  readonly indoorSize: number
  /** 85% indoor; otherwise anywhere in the tightly bounded building area. */
  sample(rng: () => number): Vector3 | null
  sampleIndoor(rng: () => number): Vector3 | null
  isIndoor(point: Vector3): boolean
}

type SnappingNavigation = Navigation & {
  snapToNavmesh?(point: Vector3): Vector3 | null
}

/**
 * Build the shared, deterministic roam pool once for a loaded map. A uniform sample of the
 * indoor grid naturally distributes goals across floors in proportion to walkable indoor area.
 */
export function createRoamTargetSet(
  map: MapData,
  world: WorldQuery,
  nav: Navigation,
): RoamTargetSet {
  const all: Candidate[] = []
  const indoor: Candidate[] = []
  const seen = new Set<string>()
  const probeOrigin = new Vector3()
  const point = new Vector3()
  const levelYs = map.levels.length > 0
    ? map.levels.map((level) => level.y).sort((left, right) => left - right)
    : [map.bounds.min.y]
  const snapToNavmesh = nav.ready
    ? (nav as SnappingNavigation).snapToNavmesh
    : undefined

  const hasCeiling = (candidate: Vector3): boolean => {
    probeOrigin.set(candidate.x, candidate.y + INDOOR_PROBE_HEIGHT, candidate.z)
    return world.raycast(probeOrigin, UP, INDOOR_CEILING_RANGE) !== null
  }

  for (let levelIndex = 0; levelIndex < levelYs.length; levelIndex++) {
    const levelY = levelYs[levelIndex]
    let acceptedOnLevel = 0
    for (
      let x = map.bounds.min.x + GRID_STEP * 0.5;
      x < map.bounds.max.x && acceptedOnLevel < MAX_GRID_CANDIDATES_PER_LEVEL;
      x += GRID_STEP
    ) {
      for (
        let z = map.bounds.min.z + GRID_STEP * 0.5;
        z < map.bounds.max.z && acceptedOnLevel < MAX_GRID_CANDIDATES_PER_LEVEL;
        z += GRID_STEP
      ) {
        const floorY = validateFloor(world, x, levelY, z)
        if (floorY === null) continue
        point.set(x, floorY, z)

        if (typeof snapToNavmesh === 'function') {
          const snapped = snapToNavmesh.call(nav, point)
          if (!snapped || snapped.distanceTo(point) > NAV_SNAP_TOLERANCE) continue
          const snappedFloorY = validateFloor(world, snapped.x, snapped.y, snapped.z)
          if (snappedFloorY === null) continue
          point.set(snapped.x, snappedFloorY, snapped.z)
        }

        // Recast can snap neighbouring grid samples to the same polygon boundary.
        const key = `${point.x.toFixed(3)},${point.y.toFixed(3)},${point.z.toFixed(3)}`
        if (seen.has(key)) continue
        seen.add(key)

        const candidate = { point: point.clone(), indoor: hasCeiling(point) }
        all.push(candidate)
        if (candidate.indoor) indoor.push(candidate)
        acceptedOnLevel++
      }
    }
  }

  const buildingArea = indoor.length > 0
    ? candidatesNearIndoor(all, indoor, Math.min(BUILDING_AREA_RADIUS, MAX_DISTANCE_FROM_INDOOR))
    : all

  return {
    size: buildingArea.length,
    indoorSize: indoor.length,
    sample(rng) {
      if (indoor.length > 0 && rng() < INDOOR_TARGET_CHANCE) return pick(indoor, rng)
      return pick(buildingArea, rng)
    },
    sampleIndoor(rng) {
      return pick(indoor, rng)
    },
    isIndoor: hasCeiling,
  }
}

function pick(candidates: Candidate[], rng: () => number): Vector3 | null {
  if (candidates.length === 0) return null
  const index = Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))
  return candidates[index].point
}

/** Spatial buckets keep the one-time proximity filter linear for lawn-heavy maps. */
function candidatesNearIndoor(
  candidates: Candidate[],
  indoor: Candidate[],
  radius: number,
): Candidate[] {
  const buckets = new Map<string, Candidate[]>()
  for (let index = 0; index < indoor.length; index++) {
    const candidate = indoor[index]
    const bucketX = Math.floor(candidate.point.x / radius)
    const bucketZ = Math.floor(candidate.point.z / radius)
    const key = `${bucketX},${bucketZ}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(candidate)
    else buckets.set(key, [candidate])
  }

  const radiusSq = radius * radius
  return candidates.filter((candidate) => {
    const bucketX = Math.floor(candidate.point.x / radius)
    const bucketZ = Math.floor(candidate.point.z / radius)
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
        const bucket = buckets.get(`${bucketX + offsetX},${bucketZ + offsetZ}`)
        if (!bucket) continue
        for (let index = 0; index < bucket.length; index++) {
          const dx = candidate.point.x - bucket[index].point.x
          const dz = candidate.point.z - bucket[index].point.z
          if (dx * dx + dz * dz <= radiusSq) return true
        }
      }
    }
    return false
  })
}

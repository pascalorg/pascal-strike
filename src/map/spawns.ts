/**
 * Team spawn resolution (W1-A).
 *
 * Two rules, the first that yields points for BOTH teams wins:
 *   1. zones whose label matches SPAWN.zonePattern
 *   2. auto-derive from zone centroids / navmesh / a raycast-validated floor grid
 *
 * Pascal's `kind: 'spawn'` node is the project's single walkthrough start marker, not a team
 * spawn, so it never defines a team. It is still parsed into `MapData.spawnNodes`, and the auto
 * rule uses it (when present) as the tie-break anchor for team A so that team A starts where the
 * author's walkthrough starts.
 *
 * Sampling uses a seeded PRNG so every client that loads the same map derives the same layout.
 */
import { Vector3 } from 'three'
import { SPAWN } from '../config'
import { DOWN, UP } from './collider'
import { pointInPolygon } from './map-parse'
import type {
  MapData,
  Navigation,
  SpawnLayout,
  SpawnPoint,
  TeamId,
  WorldQuery,
  ZoneInfo,
} from '../types'

/** Radius around an anchor that still counts as "that team's spawn area". */
const ANCHOR_RADIUS = 2.5
const MAX_POINTS_PER_TEAM = 12
/** Horizontal spacing of the fallback floor grid. */
const GRID_STEP = 1.5
const MAX_GRID_CANDIDATES = 600
const NAV_SAMPLES = 96

const _origin = new Vector3()
const _mapCenter = new Vector3()

export function resolveSpawns(map: MapData, world: WorldQuery, nav?: Navigation): SpawnLayout {
  map.bounds.getCenter(_mapCenter)
  const center = _mapCenter.clone()

  const fromZones = spawnsFromZones(map, center)
  if (fromZones) return fromZones

  return autoSpawns(map, world, nav)
}

// ---------------------------------------------------------------------------
// Rule 1 — spawn zones
// ---------------------------------------------------------------------------

function spawnsFromZones(map: MapData, center: Vector3): SpawnLayout | null {
  const zones = map.zones.filter((z) => SPAWN.zonePattern.test(z.label))
  if (zones.length < 2) return null

  const teamed = assignTeams(zones.map((z) => z.label))
  const a: SpawnPoint[] = []
  const b: SpawnPoint[] = []

  for (let i = 0; i < zones.length; i++) {
    const bucket = teamed[i] === 'a' ? a : b
    if (bucket.length >= MAX_POINTS_PER_TEAM) continue
    for (const p of samplePolygon(zones[i], SPAWN.pointsPerZone)) {
      bucket.push({ position: p, yaw: yawToward(p, center) })
      if (bucket.length >= MAX_POINTS_PER_TEAM) break
    }
  }

  if (a.length === 0 || b.length === 0) return null
  return { a, b, source: 'zones' }
}

function samplePolygon(zone: ZoneInfo, count: number): Vector3[] {
  const polygon = zone.polygon
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of polygon) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minZ) minZ = p.y
    if (p.y > maxZ) maxZ = p.y
  }

  const rand = mulberry32(hashString(zone.id))
  const out: Vector3[] = []
  const maxTries = count * 40
  for (let i = 0; i < maxTries && out.length < count; i++) {
    const x = minX + rand() * (maxX - minX)
    const z = minZ + rand() * (maxZ - minZ)
    if (!pointInPolygon(polygon, x, z)) continue
    out.push(new Vector3(x, zone.floorY, z))
  }
  if (out.length === 0) out.push(zone.centroid.clone())
  return out
}

// ---------------------------------------------------------------------------
// Rule 2 — auto
// ---------------------------------------------------------------------------

function autoSpawns(map: MapData, world: WorldQuery, nav?: Navigation): SpawnLayout {
  const candidates = autoCandidates(map, world, nav)

  if (candidates.length < 2) {
    // Nothing walkable was found — put both teams either side of the bounds centre so the game
    // can still start. Better than throwing on a broken map.
    const center = map.bounds.getCenter(new Vector3())
    const dx = Math.max(2, map.bounds.getSize(new Vector3()).x * 0.25)
    const pa = new Vector3(center.x - dx, center.y, center.z)
    const pb = new Vector3(center.x + dx, center.y, center.z)
    return {
      a: [{ position: pa, yaw: yawToward(pa, pb) }],
      b: [{ position: pb, yaw: yawToward(pb, pa) }],
      source: 'auto',
    }
  }

  // Anchors: normally the two farthest-apart candidates. If the map carries Pascal's single
  // walkthrough start marker, team A anchors on the candidate closest to it instead and team B
  // takes whatever is farthest from that.
  let anchorA = candidates[0]
  let anchorB = candidates[1]
  let best = -1

  const startMarker = map.spawnNodes[0]
  if (startMarker) {
    let bestToMarker = Infinity
    for (const p of candidates) {
      const d = p.distanceToSquared(startMarker.position)
      if (d < bestToMarker) {
        bestToMarker = d
        anchorA = p
      }
    }
    for (const p of candidates) {
      const d = p.distanceToSquared(anchorA)
      if (d > best) {
        best = d
        anchorB = p
      }
    }
  } else {
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const d = candidates[i].distanceToSquared(candidates[j])
        if (d > best) {
          best = d
          anchorA = candidates[i]
          anchorB = candidates[j]
        }
      }
    }
  }

  const radiusSq = ANCHOR_RADIUS * ANCHOR_RADIUS
  const a: SpawnPoint[] = []
  const b: SpawnPoint[] = []
  for (const p of candidates) {
    const da = p.distanceToSquared(anchorA)
    const db = p.distanceToSquared(anchorB)
    if (da <= radiusSq && da <= db && a.length < MAX_POINTS_PER_TEAM) {
      a.push({ position: p.clone(), yaw: yawToward(p, anchorB) })
    } else if (db <= radiusSq && b.length < MAX_POINTS_PER_TEAM) {
      b.push({ position: p.clone(), yaw: yawToward(p, anchorA) })
    }
  }
  if (a.length === 0) a.push({ position: anchorA.clone(), yaw: yawToward(anchorA, anchorB) })
  if (b.length === 0) b.push({ position: anchorB.clone(), yaw: yawToward(anchorB, anchorA) })

  console.info(
    `[spawns] auto (${startMarker ? 'anchored on walkthrough start marker' : 'two farthest apart'}): ` +
      `${candidates.length} candidates, anchors ` +
      `A(${anchorA.x.toFixed(2)}, ${anchorA.y.toFixed(2)}, ${anchorA.z.toFixed(2)}) ` +
      `B(${anchorB.x.toFixed(2)}, ${anchorB.y.toFixed(2)}, ${anchorB.z.toFixed(2)}) ` +
      `${Math.sqrt(best).toFixed(2)} m apart`,
  )
  return { a, b, source: 'auto' }
}

function autoCandidates(map: MapData, world: WorldQuery, nav?: Navigation): Vector3[] {
  // (a) zone centroids on the lowest level that has zones
  if (map.zones.length > 0) {
    const lowest = [...map.levels]
      .sort((l, r) => l.y - r.y)
      .find((level) => map.zones.some((z) => z.levelId === level.id))
    const zones = lowest
      ? map.zones.filter((z) => z.levelId === lowest.id)
      : map.zones
    if (zones.length >= 2) return zones.map((z) => z.centroid.clone())
  }

  // (b) random navmesh points
  if (nav?.ready) {
    const points: Vector3[] = []
    for (let i = 0; i < NAV_SAMPLES; i++) {
      const p = nav.randomPoint()
      if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) points.push(p)
    }
    if (points.length >= 2) return points
  }

  // (c) raycast-validated floor grid
  return floorGrid(map, world)
}

function floorGrid(map: MapData, world: WorldQuery): Vector3[] {
  const out: Vector3[] = []
  const min = map.bounds.min
  const max = map.bounds.max
  const levelYs = map.levels.length > 0 ? map.levels.map((l) => l.y) : [min.y]

  for (const levelY of levelYs) {
    for (let x = min.x + GRID_STEP * 0.5; x < max.x && out.length < MAX_GRID_CANDIDATES; x += GRID_STEP) {
      for (let z = min.z + GRID_STEP * 0.5; z < max.z && out.length < MAX_GRID_CANDIDATES; z += GRID_STEP) {
        const y = validateFloor(world, x, levelY, z)
        if (y !== null) out.push(new Vector3(x, y, z))
      }
    }
  }
  return out
}

/**
 * A point is a valid spawn if a downward ray from +1.5 m hits walkable floor within 3 m and
 * there is 1.8 m of head room above it.
 */
export function validateFloor(
  world: WorldQuery,
  x: number,
  levelY: number,
  z: number,
): number | null {
  _origin.set(x, levelY + 1.5, z)
  const down = world.raycast(_origin, DOWN, 3)
  if (!down || Math.abs(down.normal.y) <= 0.7) return null
  const floorY = down.point.y

  _origin.set(x, floorY + 0.2, z)
  if (world.raycast(_origin, UP, 1.8)) return null
  return floorY
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Team per label. If the labels carry team hints (`A`/`Orange`/`1`, `B`/`Teal`/`2`) use them,
 * otherwise alternate so the first entry is A and the second is B.
 */
function assignTeams(labels: string[]): TeamId[] {
  const hinted = labels.map((label) => {
    if (SPAWN.teamAPattern.test(label)) return 'a' as TeamId
    if (SPAWN.teamBPattern.test(label)) return 'b' as TeamId
    return null
  })
  const hasA = hinted.includes('a')
  const hasB = hinted.includes('b')
  if (hasA && hasB) {
    // Anything unhinted joins the smaller side.
    let countA = hinted.filter((t) => t === 'a').length
    let countB = hinted.filter((t) => t === 'b').length
    return hinted.map((t) => {
      if (t) return t
      if (countA <= countB) {
        countA++
        return 'a' as TeamId
      }
      countB++
      return 'b' as TeamId
    })
  }
  return labels.map((_, i) => (i % 2 === 0 ? 'a' : 'b') as TeamId)
}

/** Yaw (three convention: 0 = facing -Z) that makes `from` look at `to`. */
export function yawToward(from: Vector3, to: Vector3): number {
  const dx = to.x - from.x
  const dz = to.z - from.z
  if (dx === 0 && dz === 0) return 0
  return Math.atan2(-dx, -dz)
}

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

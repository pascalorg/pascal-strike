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
/** Horizontal spacing of the auto-spawn floor grid. */
const GRID_STEP = 0.5
const MAX_GRID_CANDIDATES = 4000
/** A candidate is "indoor" when a ray up from this height finds a ceiling/slab within range. */
const INDOOR_PROBE_HEIGHT = 0.3
const INDOOR_CEILING_RANGE = 4
/** A candidate must sit this close to the navmesh, otherwise bots could never reach it. */
const NAV_SNAP_TOLERANCE = 0.3
/** Cap on the candidate set the O(n^2) farthest-pair search runs over. */
const MAX_ANCHOR_POOL = 512
const MAX_REACHABILITY_PROBES = 32

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

/** A validated floor point, plus whether it sits under a ceiling. */
interface Candidate {
  p: Vector3
  indoor: boolean
}

function autoSpawns(map: MapData, world: WorldQuery, nav?: Navigation): SpawnLayout {
  const all = autoCandidates(map, world, nav)
  const indoor = all.filter((c) => c.indoor)
  // Spawning both teams inside the building is what makes the match play; the open terrain
  // around a Pascal house is only a fallback for maps that have no enclosed space at all.
  const usingIndoor = indoor.length >= 2
  // Then keep the lowest level that still offers two: upper floors are a separate navmesh island
  // until the map has stairs, and even with stairs the ground floor is the sane default arena.
  const levelled = lowestLevelSubset(usingIndoor ? indoor : all, map)
  const pool = subsample(levelled, MAX_ANCHOR_POOL)

  if (pool.length < 2) {
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

  // The pool is already in deterministic grid order, so a strict `>` keeps the first maximum
  // and equidistant pairs always break the same way on every client.
  const points = pool.map((c) => c.p)
  let anchorA = points[0]
  let anchorB = points[1]
  let best = -1

  const startMarker = map.spawnNodes[0]
  if (startMarker) {
    // Pascal's walkthrough start marker is not a team spawn, but it is a good hint for where
    // the author expects play to begin, so team A anchors on the candidate nearest to it.
    let bestToMarker = Infinity
    for (const p of points) {
      const d = p.distanceToSquared(startMarker.position)
      if (d < bestToMarker) {
        bestToMarker = d
        anchorA = p
      }
    }
    for (const p of points) {
      const d = p.distanceToSquared(anchorA)
      if (d > best) {
        best = d
        anchorB = p
      }
    }
  } else {
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const d = points[i].distanceToSquared(points[j])
        if (d > best) {
          best = d
          anchorA = points[i]
          anchorB = points[j]
        }
      }
    }
  }

  // Teams that cannot path to each other never meet. If the farthest pair is split across
  // disconnected navmesh islands, walk inwards to the farthest anchor B that IS reachable.
  const reachable = reachableFrom(anchorA, points, anchorB, nav)
  if (reachable !== anchorB) {
    anchorB = reachable
    best = anchorA.distanceToSquared(anchorB)
  }

  const radiusSq = ANCHOR_RADIUS * ANCHOR_RADIUS
  const a: SpawnPoint[] = []
  const b: SpawnPoint[] = []
  for (const p of points) {
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
    `[spawns] auto (${usingIndoor ? 'indoor' : 'OUTDOOR fallback — no enclosed space found'}` +
      `${startMarker ? ', anchored on walkthrough start marker' : ''}): ` +
      `${all.length} candidates / ${indoor.length} indoor, anchors ` +
      `A(${fmt(anchorA)}) B(${fmt(anchorB)}) ${Math.sqrt(best).toFixed(2)} m apart, ` +
      `a=${a.length} b=${b.length}`,
  )
  return { a, b, source: 'auto' }
}

/**
 * Deterministic candidate set: a raycast-validated floor grid over `bounds`, one pass per level,
 * classified indoor/outdoor and (when a navmesh exists) restricted to points bots can stand on.
 *
 * Deliberately NOT `nav.randomPoint()`: recast's RNG cannot be seeded, so every client would
 * derive a different spawn layout for the same map.
 */
function autoCandidates(map: MapData, world: WorldQuery, nav?: Navigation): Candidate[] {
  const out: Candidate[] = []
  const min = map.bounds.min
  const max = map.bounds.max
  const levelYs = map.levels.length > 0 ? map.levels.map((l) => l.y).sort((l, r) => l - r) : [min.y]
  const snap = navSnapper(nav)

  for (const levelY of levelYs) {
    // Cap per level, not globally: a big ground floor must never be truncated just because the
    // levels above it were sampled first.
    let onThisLevel = 0
    for (let x = min.x + GRID_STEP * 0.5; x < max.x && onThisLevel < MAX_GRID_CANDIDATES; x += GRID_STEP) {
      for (let z = min.z + GRID_STEP * 0.5; z < max.z && onThisLevel < MAX_GRID_CANDIDATES; z += GRID_STEP) {
        const y = validateFloor(world, x, levelY, z)
        if (y === null) continue

        const p = new Vector3(x, y, z)
        if (snap) {
          const snapped = snap(p)
          // Off the navmesh (rooftop, ledge, sliver behind a wall) — a bot could never spawn or
          // path there, so it is not a spawn point.
          if (!snapped || snapped.distanceTo(p) > NAV_SNAP_TOLERANCE) continue
          p.copy(snapped)
        }

        _origin.set(p.x, p.y + INDOOR_PROBE_HEIGHT, p.z)
        const ceiling = world.raycast(_origin, UP, INDOOR_CEILING_RANGE)
        out.push({ p, indoor: ceiling !== null })
        onThisLevel++
      }
    }
  }
  return out
}

/**
 * Keep only the candidates sitting on the lowest level that offers at least two of them.
 * Candidates are bucketed to their nearest level origin.
 */
function lowestLevelSubset(candidates: Candidate[], map: MapData): Candidate[] {
  if (map.levels.length < 2 || candidates.length < 2) return candidates
  const levels = [...map.levels].sort((l, r) => l.y - r.y)
  const buckets = levels.map<Candidate[]>(() => [])
  for (const c of candidates) {
    let bestIndex = 0
    let bestDistance = Infinity
    for (let i = 0; i < levels.length; i++) {
      const d = Math.abs(c.p.y - levels[i].y)
      if (d < bestDistance) {
        bestDistance = d
        bestIndex = i
      }
    }
    buckets[bestIndex].push(c)
  }
  for (const bucket of buckets) if (bucket.length >= 2) return bucket
  return candidates
}

/** Deterministic stride sample, so the O(n^2) anchor search stays cheap on big open maps. */
function subsample(candidates: Candidate[], limit: number): Candidate[] {
  if (candidates.length <= limit) return candidates
  const stride = Math.ceil(candidates.length / limit)
  const out: Candidate[] = []
  for (let i = 0; i < candidates.length; i += stride) out.push(candidates[i])
  return out
}

/**
 * `preferred` if a path to it exists, otherwise the farthest candidate from `from` that is
 * reachable. Falls back to `preferred` when there is no navmesh to ask.
 */
function reachableFrom(
  from: Vector3,
  points: Vector3[],
  preferred: Vector3,
  nav?: Navigation,
): Vector3 {
  if (!nav?.ready) return preferred
  if (nav.findPath(from, preferred).length > 0) return preferred

  const byDistance = points
    .filter((p) => p !== from)
    .sort((l, r) => from.distanceToSquared(r) - from.distanceToSquared(l))
  for (let i = 0; i < byDistance.length && i < MAX_REACHABILITY_PROBES; i++) {
    if (nav.findPath(from, byDistance[i]).length > 0) return byDistance[i]
  }
  return preferred
}

/**
 * `Navigation` (types.ts) cannot report a failed snap — `closestPoint` returns something either
 * way. `navmesh.ts` adds an optional `snapToNavmesh` that returns null instead; feature-detect it
 * so any other `Navigation` implementation still works (it simply skips the navmesh filter).
 */
type SnappingNavigation = Navigation & {
  snapToNavmesh?(p: Vector3): Vector3 | null
}

function navSnapper(nav?: Navigation): ((p: Vector3) => Vector3 | null) | null {
  if (!nav?.ready) return null
  const snapper = (nav as SnappingNavigation).snapToNavmesh
  if (typeof snapper !== 'function') return null
  return (p) => snapper.call(nav, p)
}

function fmt(v: Vector3): string {
  return `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`
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

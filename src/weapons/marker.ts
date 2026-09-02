import { Vector3 } from 'three'
import { WEAPON } from '../config'
import type { ShotEvent, TeamId } from '../types'

export interface MarkerOptions {
  ownerId: string
  team: TeamId
  now?: () => number
}

export interface Marker {
  readonly hopper: number
  readonly reserve: number
  readonly reloading: boolean
  readonly reloadProgress: number
  update(
    dt: number,
    firing: boolean,
    reloadPressed: boolean,
    origin: Vector3,
    direction: Vector3,
  ): ShotEvent[]
  setTeam(team: TeamId): void
  reset(): void
}

const EMPTY_SHOTS: ShotEvent[] = []
const spreadDirection = new Vector3()
const tangent = new Vector3()
const bitangent = new Vector3()

export function createMarker(options: MarkerOptions): Marker {
  const now = options.now ?? Date.now
  const shotPeriod = 1 / WEAPON.fireRate
  let team = options.team
  let hopper = WEAPON.hopperSize
  let reloading = false
  let reloadElapsed = 0
  let fireAccumulator = shotPeriod
  let wasFiring = false
  let counter = 0
  const output: ShotEvent[] = []

  const beginReload = () => {
    if (!reloading && hopper < WEAPON.hopperSize) {
      reloading = true
      reloadElapsed = 0
    }
  }

  return {
    get hopper() { return hopper },
    get reserve() { return Infinity },
    get reloading() { return reloading },
    get reloadProgress() {
      return reloading ? Math.min(reloadElapsed * 1000 / WEAPON.reloadMs, 1) : 0
    },
    update(dt, firing, reloadPressed, origin, direction) {
      output.length = 0
      if (reloadPressed) beginReload()

      if (reloading) {
        reloadElapsed += dt
        if (reloadElapsed * 1000 >= WEAPON.reloadMs) {
          hopper = WEAPON.hopperSize
          reloading = false
          reloadElapsed = 0
          fireAccumulator = shotPeriod
        }
        wasFiring = firing
        return EMPTY_SHOTS
      }

      if (hopper === 0) {
        beginReload()
        wasFiring = firing
        return EMPTY_SHOTS
      }

      if (!firing) {
        fireAccumulator = Math.min(fireAccumulator + dt, shotPeriod)
        wasFiring = false
        return EMPTY_SHOTS
      }

      if (!wasFiring) fireAccumulator = shotPeriod
      else fireAccumulator += dt
      wasFiring = true
      if (fireAccumulator + 1e-10 < shotPeriod) return EMPTY_SHOTS
      fireAccumulator -= shotPeriod

      counter++
      hopper--
      const seed = hashSeed(options.ownerId, counter)
      applySpread(direction, seed, spreadDirection)
      output.push({
        id: `${options.ownerId}:${counter}`,
        by: options.ownerId,
        team,
        origin: [origin.x, origin.y, origin.z],
        dir: [spreadDirection.x, spreadDirection.y, spreadDirection.z],
        speed: WEAPON.projectileSpeed,
        t: now(),
        seed,
      })
      if (hopper === 0) beginReload()
      return output
    },
    setTeam(value) { team = value },
    reset() {
      hopper = WEAPON.hopperSize
      reloading = false
      reloadElapsed = 0
      fireAccumulator = shotPeriod
      wasFiring = false
      counter = 0
    },
  }
}

function applySpread(direction: Vector3, seed: number, out: Vector3): Vector3 {
  out.copy(direction).normalize()
  const random = seededRandom(seed)
  const u1 = Math.max(random(), 1e-7)
  const u2 = random()
  const gaussianRadius = Math.sqrt(-2 * Math.log(u1))
  const sigma = WEAPON.spreadWalkingDeg /* W3-A replaces with the motion-state model */ * Math.PI / 180
  const x = gaussianRadius * Math.cos(2 * Math.PI * u2) * sigma
  const y = gaussianRadius * Math.sin(2 * Math.PI * u2) * sigma
  tangent.set(0, 1, 0).cross(out)
  if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0)
  else tangent.normalize()
  bitangent.crossVectors(out, tangent).normalize()
  return out.addScaledVector(tangent, x).addScaledVector(bitangent, y).normalize()
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let t = value
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function hashSeed(owner: string, counter: number): number {
  let hash = (0x811c9dc5 ^ counter) >>> 0
  for (let index = 0; index < owner.length; index++) {
    hash ^= owner.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

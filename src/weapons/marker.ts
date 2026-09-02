/**
 * Fire logic for the paintball marker: rate, accuracy, hopper, reload.
 *
 * Accuracy model (W3-A). Players asked to be "precise where we aim, ok to be less precise
 * when running", so the spread has two independent terms:
 *
 * - a *base* sigma decided by the motion state (`setMotion`): standing ~0.12°, crouched
 *   standing 0.7x that, blending up through walking to running and worst of all airborne;
 * - a *bloom* that grows `WEAPON.spreadPerShotDeg` per shot and bleeds off at
 *   `WEAPON.spreadRecoveryPerSec`, capped at `MAX_BLOOM_DEG`.
 *
 * The first shot of a burst therefore lands exactly on the crosshair while held fire walks
 * out, so tapping is rewarded without making the marker useless in a fight.
 */
import { Vector3 } from 'three'
import { PLAYER, WEAPON } from '../config'
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
  /** Gaussian sigma in degrees the next shot would use (base motion tier + bloom). */
  readonly currentSpreadDeg: number
  /** True for the update in which the trigger was pulled on an empty hopper. */
  readonly dryFire: boolean
  update(
    dt: number,
    firing: boolean,
    reloadPressed: boolean,
    origin: Vector3,
    direction: Vector3,
  ): ShotEvent[]
  /** Motion state of the shooter this frame; drives the base spread tier. */
  setMotion(speedXZ: number, grounded: boolean, crouching: boolean, walking?: boolean): void
  setTeam(team: TeamId): void
  reset(): void
}

/** Sustained fire converges here instead of growing without bound. */
const MAX_BLOOM_DEG = WEAPON.spreadPerShotDeg * 4
/** Crouching multiplier — crouched and still is `spreadStandingDeg * 0.7`. */
const CROUCH_FACTOR = 0.7

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
  let bloomDeg = 0
  let dryFire = false
  let motionSpeed = 0
  let motionGrounded = true
  let motionCrouching = false
  let motionWalking = false
  const output: ShotEvent[] = []

  const baseSpreadDeg = (): number => {
    if (!motionGrounded) return WEAPON.spreadAirDeg
    let sigma: number
    if (motionSpeed <= PLAYER.walkSpeed) {
      sigma = lerp(WEAPON.spreadStandingDeg, WEAPON.spreadWalkingDeg, motionSpeed / PLAYER.walkSpeed)
    } else {
      const t = (motionSpeed - PLAYER.walkSpeed) / Math.max(1e-6, PLAYER.runSpeed - PLAYER.walkSpeed)
      sigma = lerp(WEAPON.spreadWalkingDeg, WEAPON.spreadRunningDeg, t)
    }
    // Shift is a deliberate, precise walk: it caps the tier even on a downhill sprint.
    if (motionWalking) sigma = Math.min(sigma, WEAPON.spreadWalkingDeg)
    if (motionCrouching) sigma *= CROUCH_FACTOR
    return sigma
  }

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
    get currentSpreadDeg() { return baseSpreadDeg() + bloomDeg },
    get dryFire() { return dryFire },
    setMotion(speedXZ, grounded, crouching, walking = false) {
      motionSpeed = Math.max(0, speedXZ)
      motionGrounded = grounded
      motionCrouching = crouching
      motionWalking = walking
    },
    update(dt, firing, reloadPressed, origin, direction) {
      output.length = 0
      dryFire = false
      bloomDeg = Math.max(0, bloomDeg - WEAPON.spreadRecoveryPerSec * dt)
      if (reloadPressed) beginReload()

      if (reloading) {
        if (firing && !wasFiring) dryFire = true
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
        if (firing && !wasFiring) dryFire = true
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
      applySpread(direction, seed, baseSpreadDeg() + bloomDeg, spreadDirection)
      bloomDeg = Math.min(MAX_BLOOM_DEG, bloomDeg + WEAPON.spreadPerShotDeg)
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
      bloomDeg = 0
      dryFire = false
    },
  }
}

function lerp(a: number, b: number, t: number): number {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t
  return a + (b - a) * clamped
}

function applySpread(direction: Vector3, seed: number, sigmaDeg: number, out: Vector3): Vector3 {
  out.copy(direction).normalize()
  if (sigmaDeg <= 0) return out
  const random = seededRandom(seed)
  const u1 = Math.max(random(), 1e-7)
  const u2 = random()
  const gaussianRadius = Math.sqrt(-2 * Math.log(u1))
  const sigma = sigmaDeg * Math.PI / 180
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

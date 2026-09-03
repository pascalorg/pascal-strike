/**
 * Fire logic for the three weapons: rate, accuracy, magazine, reload, weapon switching.
 *
 * One marker object owns all three slots. Each weapon keeps its own ammo, reload and trigger
 * state, so switching away mid-magazine and coming back finds the gun exactly as it was left;
 * `setWeapon` costs `SWITCH_MS` during which nothing fires (`switching`).
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
 * out, so tapping is rewarded without making the marker useless in a fight. Both terms are
 * scaled by the weapon's `spreadScale` (the pistol is half the rifle's cone in every state).
 *
 * The knife is a slot like any other here — it just never produces a `ShotEvent`; the swing
 * itself lives in `melee.ts`, which asks this module whether the switch has finished.
 */
import { Vector3 } from 'three'
import { PLAYER, WEAPON, WEAPONS } from '../config'
import type { ShotEvent, TeamId, WeaponKind } from '../types'

/**
 * One row of the `WEAPONS` table, widened: the knife carries melee-only fields the firearms
 * do not, and `WEAPONS[kind]` on a union key would otherwise lose them.
 */
export interface WeaponSpec {
  slot: number
  label: string
  auto: boolean
  fireRate: number
  /** Rounds per magazine. `Infinity` = no ammo (the knife). */
  ammo: number
  reloadMs: number
  projectileSpeed: number
  damageScale: number
  spreadScale: number
  moveSpeedScale: number
  /** Melee only: reach in metres from the eye. */
  range?: number
  /** Melee only: half-angle of the hit cone in degrees. */
  coneDeg?: number
  /** Melee only: flat damage per swing. */
  damage?: number
  /** Melee only: multiplier the host applies when the victim is struck from behind. */
  backstabScale?: number
}

export interface MarkerOptions {
  ownerId: string
  team: TeamId
  now?: () => number
  /** Slot to start on; missing = rifle. */
  weapon?: WeaponKind
}

export interface Marker {
  /** The weapon in hand. */
  readonly weapon: WeaponKind
  /** Its row of the `WEAPONS` table. */
  readonly spec: WeaponSpec
  /** Rounds left in the current weapon (`Infinity` for the knife). */
  readonly hopper: number
  /** Magazine size of the current weapon. */
  readonly magazine: number
  readonly reserve: number
  readonly reloading: boolean
  readonly reloadProgress: number
  /** True while a weapon switch is still in progress — nothing fires, nothing swings. */
  readonly switching: boolean
  /** Movement multiplier the current weapon asks for (1 = rifle). */
  readonly moveSpeedScale: number
  /** Gaussian sigma in degrees the next shot would use (base motion tier + bloom). */
  readonly currentSpreadDeg: number
  /** True for the update in which the trigger was pulled on an empty magazine. */
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
  /** Start a switch to `kind`. Returns false when it is already the weapon in hand. */
  setWeapon(kind: WeaponKind): boolean
  setTeam(team: TeamId): void
  reset(): void
}

/** Slot number (1/2/3) → weapon, for the number keys and the wheel. */
export const WEAPON_BY_SLOT: readonly WeaponKind[] = ['rifle', 'pistol', 'knife']

/** Time in seconds a weapon switch takes; the trigger is dead for its whole length. */
export const SWITCH_SECONDS = 0.35

/** Sustained fire converges here instead of growing without bound. */
const MAX_BLOOM_DEG = WEAPON.spreadBloomMaxDeg
/** Crouching multiplier — crouched and still is `spreadStandingDeg * 0.7`. */
const CROUCH_FACTOR = 0.7

const EMPTY_SHOTS: ShotEvent[] = []
const spreadDirection = new Vector3()
const tangent = new Vector3()
const bitangent = new Vector3()

/** The `WEAPONS` row for `kind`, widened to `WeaponSpec`. */
export function weaponSpec(kind: WeaponKind): WeaponSpec {
  return WEAPONS[kind]
}

/** Per-weapon magazine and trigger state. Switching never touches the slot it left. */
interface SlotState {
  hopper: number
  reloading: boolean
  reloadElapsed: number
  fireAccumulator: number
}

export function createMarker(options: MarkerOptions): Marker {
  const now = options.now ?? Date.now
  let team = options.team
  let kind: WeaponKind = options.weapon ?? 'rifle'
  let spec = weaponSpec(kind)
  const slots: Record<WeaponKind, SlotState> = {
    rifle: freshSlot('rifle'),
    pistol: freshSlot('pistol'),
    knife: freshSlot('knife'),
  }
  let state = slots[kind]
  let switchRemaining = 0
  let wasFiring = false
  let counter = 0
  let bloomDeg = 0
  let dryFire = false
  let motionSpeed = 0
  let motionGrounded = true
  let motionCrouching = false
  let motionWalking = false
  const output: ShotEvent[] = []

  function freshSlot(forKind: WeaponKind): SlotState {
    const entry = weaponSpec(forKind)
    return {
      hopper: entry.ammo,
      reloading: false,
      reloadElapsed: 0,
      fireAccumulator: 1 / entry.fireRate,
    }
  }

  const shotPeriod = (): number => 1 / spec.fireRate

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
    if (!state.reloading && state.hopper < spec.ammo && spec.reloadMs > 0) {
      state.reloading = true
      state.reloadElapsed = 0
    }
  }

  return {
    get weapon() { return kind },
    get spec() { return spec },
    get hopper() { return state.hopper },
    get magazine() { return spec.ammo },
    get reserve() { return Infinity },
    get reloading() { return state.reloading },
    get reloadProgress() {
      return state.reloading ? Math.min(state.reloadElapsed * 1000 / spec.reloadMs, 1) : 0
    },
    get switching() { return switchRemaining > 0 },
    get moveSpeedScale() { return spec.moveSpeedScale },
    get currentSpreadDeg() { return (baseSpreadDeg() + bloomDeg) * spec.spreadScale },
    get dryFire() { return dryFire },
    setMotion(speedXZ, grounded, crouching, walking = false) {
      motionSpeed = Math.max(0, speedXZ)
      motionGrounded = grounded
      motionCrouching = crouching
      motionWalking = walking
    },
    setWeapon(next) {
      if (next === kind) return false
      // A switch cancels the reload it interrupts: coming back to a half-loaded gun and
      // finding it magically full is the kind of thing that decides a duel.
      state.reloading = false
      state.reloadElapsed = 0
      kind = next
      spec = weaponSpec(next)
      state = slots[next]
      state.fireAccumulator = shotPeriod()
      switchRemaining = SWITCH_SECONDS
      dryFire = false
      return true
    },
    update(dt, firing, reloadPressed, origin, direction) {
      output.length = 0
      dryFire = false
      bloomDeg = Math.max(0, bloomDeg - WEAPON.spreadRecoveryPerSec * dt)

      if (switchRemaining > 0) {
        switchRemaining -= dt
        // Holding the trigger through a switch must not fire the instant the gun comes up
        // on a semi-auto, so the trigger state keeps tracking through the lockout.
        wasFiring = firing
        return EMPTY_SHOTS
      }

      if (reloadPressed) beginReload()

      if (state.reloading) {
        if (firing && !wasFiring) dryFire = true
        state.reloadElapsed += dt
        if (state.reloadElapsed * 1000 >= spec.reloadMs) {
          state.hopper = spec.ammo
          state.reloading = false
          state.reloadElapsed = 0
          state.fireAccumulator = shotPeriod()
        }
        wasFiring = firing
        return EMPTY_SHOTS
      }

      // Melee: the swing lives in `melee.ts`, this slot only keeps the timers ticking.
      if (spec.projectileSpeed <= 0) {
        wasFiring = firing
        return EMPTY_SHOTS
      }

      if (state.hopper === 0) {
        if (firing && !wasFiring) dryFire = true
        beginReload()
        wasFiring = firing
        return EMPTY_SHOTS
      }

      const period = shotPeriod()
      if (!firing) {
        state.fireAccumulator = Math.min(state.fireAccumulator + dt, period)
        wasFiring = false
        return EMPTY_SHOTS
      }

      // Semi-auto: one shot per trigger pull, however long the button is held.
      if (!spec.auto && wasFiring) {
        state.fireAccumulator = Math.min(state.fireAccumulator + dt, period)
        return EMPTY_SHOTS
      }

      if (!wasFiring) state.fireAccumulator = Math.min(state.fireAccumulator + dt, period)
      else state.fireAccumulator += dt
      wasFiring = true
      if (state.fireAccumulator + 1e-10 < period) return EMPTY_SHOTS
      state.fireAccumulator -= period

      counter++
      state.hopper--
      const seed = hashSeed(options.ownerId, counter)
      applySpread(direction, seed, (baseSpreadDeg() + bloomDeg) * spec.spreadScale, spreadDirection)
      bloomDeg = Math.min(MAX_BLOOM_DEG, bloomDeg + WEAPON.spreadPerShotDeg)
      output.push({
        id: `${options.ownerId}:${counter}`,
        by: options.ownerId,
        team,
        origin: [origin.x, origin.y, origin.z],
        dir: [spreadDirection.x, spreadDirection.y, spreadDirection.z],
        speed: spec.projectileSpeed,
        t: now(),
        seed,
        weapon: kind,
      })
      if (state.hopper === 0) beginReload()
      return output
    },
    setTeam(value) { team = value },
    reset() {
      for (const slotKind of WEAPON_BY_SLOT) {
        const slot = slots[slotKind]
        const entry = weaponSpec(slotKind)
        slot.hopper = entry.ammo
        slot.reloading = false
        slot.reloadElapsed = 0
        slot.fireAccumulator = 1 / entry.fireRate
      }
      switchRemaining = 0
      wasFiring = false
      // Keep `counter` monotonic across lives: shot ids must never repeat, or the host's
      // duplicate-shot filter silently drops hits after a respawn.

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

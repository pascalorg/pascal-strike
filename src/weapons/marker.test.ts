// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { PLAYER, WEAPON, WEAPONS } from '../config'
import type { ShotEvent } from '../types'
import { createMarker, SWITCH_SECONDS, type Marker } from './marker'

const DT = 1 / 120
const ORIGIN = new Vector3(0, 1.6, 0)
const FORWARD = new Vector3(0, 0, -1)

/**
 * Angular deviation of a fired direction from the aim, in degrees. Both the spread model and
 * this measurement work on the unit sphere, so the sample sigma is directly comparable to
 * `WEAPON.spread*Deg`.
 */
function deviationDeg(dir: [number, number, number]): number {
  const dot = Math.max(-1, Math.min(1, dir[0] * FORWARD.x + dir[1] * FORWARD.y + dir[2] * FORWARD.z))
  return Math.acos(dot) * 180 / Math.PI
}

/**
 * The spread is a 2-D gaussian around the aim, so |deviation| is Rayleigh distributed with
 * the same sigma: sigma = sqrt(mean(dev^2) / 2).
 */
function sigmaOf(deviations: number[]): number {
  let sum = 0
  for (const value of deviations) sum += value * value
  return Math.sqrt(sum / deviations.length / 2)
}

/** Tap-fires `count` shots with `gapSeconds` of released trigger between them. */
function tapFire(marker: Marker, count: number, gapSeconds: number): number[] {
  const deviations: number[] = []
  let guard = 0
  while (deviations.length < count && guard++ < 400_000) {
    for (const shot of marker.update(DT, true, false, ORIGIN, FORWARD)) deviations.push(deviationDeg(shot.dir))
    for (let i = 0; i < Math.round(gapSeconds / DT); i++) marker.update(DT, false, false, ORIGIN, FORWARD)
  }
  return deviations
}

/** Holds the trigger down until `count` shots came out (reloads included). */
function holdFire(marker: Marker, count: number): number[] {
  const deviations: number[] = []
  let guard = 0
  while (deviations.length < count && guard++ < 400_000) {
    for (const shot of marker.update(DT, true, false, ORIGIN, FORWARD)) deviations.push(deviationDeg(shot.dir))
  }
  return deviations
}

test('200 tapped shots standing still stay inside 0.2 degrees', () => {
  const marker = createMarker({ ownerId: 'test-still', team: 'a', now: () => 0 })
  marker.setMotion(0, true, false, false)
  const sigma = sigmaOf(tapFire(marker, 200, 0.18))
  expect(sigma).toBeLessThanOrEqual(0.2)
})

test('200 shots at a full run spread by at least 1.2 degrees', () => {
  const marker = createMarker({ ownerId: 'test-run', team: 'a', now: () => 0 })
  marker.setMotion(PLAYER.runSpeed, true, false, false)
  const sigma = sigmaOf(holdFire(marker, 200))
  expect(sigma).toBeGreaterThanOrEqual(1.2)
})

test('the motion tiers are ordered: crouched < standing < walking < running < airborne', () => {
  const marker = createMarker({ ownerId: 'test-tiers', team: 'a', now: () => 0 })
  const at = (speed: number, grounded: boolean, crouching: boolean, walking = false): number => {
    marker.setMotion(speed, grounded, crouching, walking)
    return marker.currentSpreadDeg
  }
  const crouched = at(0, true, true)
  const standing = at(0, true, false)
  const walking = at(PLAYER.walkSpeed, true, false)
  const running = at(PLAYER.runSpeed, true, false)
  const airborne = at(PLAYER.runSpeed, false, false)
  expect(crouched).toBeCloseTo(WEAPON.spreadStandingDeg * 0.7, 6)
  expect(standing).toBeCloseTo(WEAPON.spreadStandingDeg, 6)
  expect(walking).toBeCloseTo(WEAPON.spreadWalkingDeg, 6)
  expect(running).toBeCloseTo(WEAPON.spreadRunningDeg, 6)
  expect(airborne).toBeCloseTo(WEAPON.spreadAirDeg, 6)
  // Shift at running speed is the deliberate, precise walk.
  expect(at(PLAYER.runSpeed, true, false, true)).toBeCloseTo(WEAPON.spreadWalkingDeg, 6)
})

test('per-shot bloom kicks in right after a shot, stays bounded while held, and decays back within a second', () => {
  const marker = createMarker({ ownerId: 'test-bloom', team: 'a', now: () => 0 })
  marker.setMotion(0, true, false, false)
  const base = marker.currentSpreadDeg
  holdFire(marker, 12)
  const bloomed = marker.currentSpreadDeg
  // Recovery outpaces the fire rate by design (standing fire stays precise), so held fire
  // never accumulates past one shot's bloom, but the last shot's bloom is still present.
  expect(bloomed).toBeGreaterThan(base)
  expect(bloomed).toBeLessThanOrEqual(base + WEAPON.spreadBloomMaxDeg + 1e-9)

  for (let i = 0; i < Math.round(1 / DT); i++) marker.update(DT, false, false, ORIGIN, FORWARD)
  expect(marker.currentSpreadDeg).toBeCloseTo(base, 6)
})

test('an empty hopper reports a dry fire once per trigger pull, not every frame', () => {
  const marker = createMarker({ ownerId: 'test-dry', team: 'a', now: () => 0 })
  marker.setMotion(0, true, false, false)
  holdFire(marker, WEAPON.hopperSize)
  expect(marker.hopper).toBe(0)
  expect(marker.reloading).toBe(true)

  marker.update(DT, false, false, ORIGIN, FORWARD)
  marker.update(DT, true, false, ORIGIN, FORWARD)
  expect(marker.dryFire).toBe(true)
  marker.update(DT, true, false, ORIGIN, FORWARD)
  expect(marker.dryFire).toBe(false)
})

test('the same shot counter always produces the same direction', () => {
  const a = createMarker({ ownerId: 'seeded', team: 'a', now: () => 0 })
  const b = createMarker({ ownerId: 'seeded', team: 'a', now: () => 0 })
  a.setMotion(PLAYER.runSpeed, true, false, false)
  b.setMotion(PLAYER.runSpeed, true, false, false)
  expect(holdFire(a, 20)).toEqual(holdFire(b, 20))
})

// ---------------------------------------------------------------------------
// W4-B: three weapons in one marker
// ---------------------------------------------------------------------------

/** Holds the trigger for `seconds` and returns every shot that came out. */
function holdFor(marker: Marker, seconds: number, firing = true): ShotEvent[] {
  const shots: ShotEvent[] = []
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    for (const shot of marker.update(DT, firing, false, ORIGIN, FORWARD)) shots.push(shot)
  }
  return shots
}

/** Steps past the 0.35 s switch lockout without touching the trigger. */
function settle(marker: Marker): void {
  for (let i = 0; i < Math.round((SWITCH_SECONDS + 0.02) / DT); i++) {
    marker.update(DT, false, false, ORIGIN, FORWARD)
  }
}

test('the pistol is semi-auto: one shot per trigger pull, however long it is held', () => {
  const marker = createMarker({ ownerId: 'semi', team: 'a', now: () => 0, weapon: 'pistol' })
  marker.setMotion(0, true, false, false)
  expect(holdFor(marker, 2)).toHaveLength(1)
  // Releasing and pulling again fires the second round.
  holdFor(marker, 0.3, false)
  expect(holdFor(marker, 0.5)).toHaveLength(1)
  expect(marker.hopper).toBe(WEAPONS.pistol.ammo - 2)
})

test('the pistol still obeys its fire rate when the trigger is spammed', () => {
  const marker = createMarker({ ownerId: 'spam', team: 'a', now: () => 0, weapon: 'pistol' })
  marker.setMotion(0, true, false, false)
  let shots = 0
  // Twelve pull/release cycles inside a second: the 5 Hz rate has to cap it.
  for (let i = 0; i < 12; i++) {
    shots += holdFor(marker, 1 / 24).length
    shots += holdFor(marker, 1 / 24, false).length
  }
  expect(shots).toBeLessThanOrEqual(6)
  expect(shots).toBeGreaterThanOrEqual(4)
})

test('the rifle is automatic and empties its 30 rounds while held', () => {
  const marker = createMarker({ ownerId: 'auto', team: 'a', now: () => 0 })
  marker.setMotion(0, true, false, false)
  const shots = holdFor(marker, WEAPONS.rifle.ammo / WEAPONS.rifle.fireRate + 0.05)
  expect(shots).toHaveLength(WEAPONS.rifle.ammo)
  expect(shots[0].weapon).toBe('rifle')
  expect(shots[0].speed).toBe(WEAPONS.rifle.projectileSpeed)
  expect(marker.reloading).toBe(true)
  // The reload puts the whole magazine back.
  for (let i = 0; i < Math.round((WEAPONS.rifle.reloadMs / 1000 + 0.02) / DT); i++) {
    marker.update(DT, false, false, ORIGIN, FORWARD)
  }
  expect(marker.hopper).toBe(WEAPONS.rifle.ammo)
})

test('a weapon switch locks the trigger for 0.35 s and leaves the other magazine alone', () => {
  const marker = createMarker({ ownerId: 'switch', team: 'a', now: () => 0 })
  marker.setMotion(0, true, false, false)
  holdFor(marker, 5 / WEAPONS.rifle.fireRate)
  const rifleLeft = marker.hopper
  expect(rifleLeft).toBeLessThan(WEAPONS.rifle.ammo)

  expect(marker.setWeapon('pistol')).toBe(true)
  expect(marker.switching).toBe(true)
  expect(marker.weapon).toBe('pistol')
  expect(marker.magazine).toBe(WEAPONS.pistol.ammo)
  // Nothing comes out while the gun is coming up.
  expect(holdFor(marker, SWITCH_SECONDS - 0.02)).toHaveLength(0)
  expect(marker.hopper).toBe(WEAPONS.pistol.ammo)

  // Trigger held across the lockout: the semi-auto still needs a fresh pull.
  expect(holdFor(marker, 0.2)).toHaveLength(0)
  holdFor(marker, 0.1, false)
  const pistolShots = holdFor(marker, 0.1)
  expect(pistolShots).toHaveLength(1)
  expect(pistolShots[0].weapon).toBe('pistol')
  expect(pistolShots[0].speed).toBe(WEAPONS.pistol.projectileSpeed)

  marker.setWeapon('rifle')
  settle(marker)
  expect(marker.hopper).toBe(rifleLeft)
})

test('the knife holds no ammo and never fires a shot', () => {
  const marker = createMarker({ ownerId: 'blade', team: 'a', now: () => 0, weapon: 'knife' })
  marker.setMotion(0, true, false, false)
  expect(marker.hopper).toBe(Infinity)
  expect(marker.magazine).toBe(Infinity)
  expect(holdFor(marker, 2)).toHaveLength(0)
  expect(marker.reloading).toBe(false)
})

test('the pistol shoots a tighter cone than the rifle in every motion state', () => {
  const rifle = createMarker({ ownerId: 'cone', team: 'a', now: () => 0 })
  const pistol = createMarker({ ownerId: 'cone', team: 'a', now: () => 0, weapon: 'pistol' })
  for (const [speed, grounded] of [[0, true], [PLAYER.walkSpeed, true], [PLAYER.runSpeed, true], [PLAYER.runSpeed, false]] as const) {
    rifle.setMotion(speed, grounded, false, false)
    pistol.setMotion(speed, grounded, false, false)
    expect(pistol.currentSpreadDeg).toBeCloseTo(rifle.currentSpreadDeg * WEAPONS.pistol.spreadScale, 6)
  }
})

test('each weapon carries its movement multiplier', () => {
  const marker = createMarker({ ownerId: 'speed', team: 'a', now: () => 0 })
  expect(marker.moveSpeedScale).toBe(WEAPONS.rifle.moveSpeedScale)
  marker.setWeapon('knife')
  expect(marker.moveSpeedScale).toBe(WEAPONS.knife.moveSpeedScale)
})

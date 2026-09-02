// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { PLAYER, WEAPON } from '../config'
import { createMarker, type Marker } from './marker'

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

test('per-shot bloom grows while held and decays back within a second', () => {
  const marker = createMarker({ ownerId: 'test-bloom', team: 'a', now: () => 0 })
  marker.setMotion(0, true, false, false)
  const base = marker.currentSpreadDeg
  holdFire(marker, 12)
  const bloomed = marker.currentSpreadDeg
  expect(bloomed).toBeGreaterThan(base + WEAPON.spreadPerShotDeg)

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

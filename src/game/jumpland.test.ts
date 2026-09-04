// @ts-ignore Bun provides this runtime module; the project has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { didStartJump, landingGain, localLandingGain, remoteLandingGain } from './footsteps'

test('jump sounds require grounded input that actually starts upward flight', () => {
  expect(didStartJump(true, false, true, 5)).toBe(true)
  expect(didStartJump(true, false, false, -0.2)).toBe(false) // Walk off an edge.
  expect(didStartJump(false, false, true, 4)).toBe(false) // Held input in flight.
  expect(didStartJump(true, true, true, 0)).toBe(false) // Crouch or blocked jump.
  expect(didStartJump(true, false, true, -0.2)).toBe(false) // Rejected input at an edge.
  expect(didStartJump(false, true, true, 0)).toBe(false) // Land with input held.
})

test('local land sounds require ground contact after a fall faster than 2.5 m/s', () => {
  expect(localLandingGain(false, true, -4)).toBeGreaterThan(0)
  expect(localLandingGain(false, true, -2.5)).toBe(0)
  expect(localLandingGain(false, true, -1)).toBe(0) // Spawn settling or small step.
  expect(localLandingGain(false, true, 4)).toBe(0)
  expect(localLandingGain(true, true, -4)).toBe(0) // No repeated contact sound.
  expect(localLandingGain(false, false, -4)).toBe(0)
  expect(localLandingGain(true, false, -4)).toBe(0)
})

test('landing volume scales linearly from 0.6 to 1.2 and clamps heavy falls', () => {
  expect(landingGain(2.5)).toBe(0.6)
  expect(landingGain(5.25)).toBeCloseTo(0.9)
  expect(landingGain(8)).toBe(1.2)
  expect(localLandingGain(false, true, -30)).toBe(1.2)
})

test('sampled remote descent must stop before land plays, and cannot repeat at rest', () => {
  const speeds = [0, -1, -4, -6, 0, 0, 0]
  let landings = 0
  for (let i = 1; i < speeds.length; i++) {
    if (remoteLandingGain(speeds[i - 1]!, speeds[i]!) > 0) landings++
  }
  expect(landings).toBe(1)
  expect(remoteLandingGain(-2.5, 0)).toBe(0)
  expect(remoteLandingGain(-4, -0.6)).toBe(0)
  expect(remoteLandingGain(-4, 2)).toBe(0)
  expect(remoteLandingGain(4, 0)).toBe(0) // Jump apex is silent.
  expect(remoteLandingGain(-4, -0.1)).toBeGreaterThan(0) // Interpolation tolerance.
})

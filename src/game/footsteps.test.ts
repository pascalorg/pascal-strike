// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import {
  createFootstepCadence,
  FOOTSTEP_DISTANCE,
  LOCAL_RUN_THRESHOLD,
  REMOTE_GROUNDED_VERTICAL_SPEED,
  REMOTE_RUN_THRESHOLD,
} from './footsteps'

test('a runner at 5.5 m/s steps on the distance cadence', () => {
  const cadence = createFootstepCadence(LOCAL_RUN_THRESHOLD)
  const speed = 5.5
  const dt = 1 / 60
  let elapsed = 0

  while (!cadence.update(dt, speed, true, false)) elapsed += dt
  elapsed += dt

  expect(elapsed).toBeGreaterThan(FOOTSTEP_DISTANCE / speed)
  expect(elapsed).toBeLessThanOrEqual(FOOTSTEP_DISTANCE / speed + dt)
})

test('a walker at 2.8 m/s never emits a footstep', () => {
  const cadence = createFootstepCadence(LOCAL_RUN_THRESHOLD)
  for (let frame = 0; frame < 600; frame++) {
    expect(cadence.update(1 / 60, 2.8, true, false)).toBe(false)
  }
})

test('a stopped entity never emits a footstep', () => {
  const cadence = createFootstepCadence(LOCAL_RUN_THRESHOLD)
  for (let frame = 0; frame < 600; frame++) {
    expect(cadence.update(1 / 60, 0, true, false)).toBe(false)
  }
})

test('a grounded remote sampled at 20 Hz emits running footsteps', () => {
  const cadence = createFootstepCadence(REMOTE_RUN_THRESHOLD)
  const dt = 1 / 20
  const speed = 5.5
  let previousX = 0
  let previousY = 0
  let steps = 0

  for (let sample = 1; sample <= 40; sample++) {
    const x = speed * sample * dt
    const y = 0
    const sampledSpeed = Math.abs(x - previousX) / dt
    const grounded = Math.abs(y - previousY) / dt <= REMOTE_GROUNDED_VERTICAL_SPEED
    if (cadence.update(dt, sampledSpeed, grounded, false)) steps++
    previousX = x
    previousY = y
  }

  expect(steps).toBe(4)
})

// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { Vector3 } from 'three'
import type { Navigation } from '../types'
import { createPathFollower } from './navigation'

function navigationWithPath(
  pathFactory: (from: Vector3, to: Vector3) => Vector3[],
  onFind?: () => void,
): Navigation {
  return {
    ready: true,
    findPath(from, to) {
      onFind?.()
      return pathFactory(from, to)
    },
    randomPoint: () => new Vector3(),
    randomPointAround: (center) => center.clone(),
    closestPoint: (point) => point.clone(),
  }
}

test('advances to the next corner inside the 0.35 metre threshold', () => {
  const nav = navigationWithPath((from, to) => [
    from.clone(),
    new Vector3(1, 0, 0),
    to.clone(),
  ])
  const follower = createPathFollower(nav)
  const feet = new Vector3(0, 0, 0)
  follower.setGoal(new Vector3(1, 0, -2))

  const towardFirstCorner = follower.update(feet, 1 / 60)
  expect(towardFirstCorner.yaw).toBeCloseTo(-Math.PI / 2, 5)

  feet.set(0.7, 0, 0)
  const towardSecondCorner = follower.update(feet, 1 / 60)
  expect(towardSecondCorner.yaw).toBeGreaterThan(-0.2)
  expect(towardSecondCorner.yaw).toBeLessThan(0.2)
  expect(towardSecondCorner.move.forward).toBe(1)
})

test('detects no progress, replans, and requests a 0.2 second jump', () => {
  let pathRequests = 0
  const nav = navigationWithPath(
    (from, to) => [from.clone(), to.clone()],
    () => { pathRequests++ },
  )
  const follower = createPathFollower(nav)
  const feet = new Vector3(0, 0, 0)
  follower.setGoal(new Vector3(0, 0, -4))

  let detected = false
  let jumpFrames = 0
  for (let frame = 0; frame < 80; frame++) {
    const output = follower.update(feet, 1 / 60)
    detected ||= output.stuck
    if (output.move.jump) jumpFrames++
  }

  expect(detected).toBe(true)
  expect(pathRequests).toBeGreaterThanOrEqual(2)
  expect(jumpFrames).toBeGreaterThanOrEqual(11)
  expect(jumpFrames).toBeLessThanOrEqual(13)
})

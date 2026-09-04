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

test('pushes and jumps toward a higher corner for 0.4 seconds before replanning', () => {
  let pathRequests = 0
  const nav = navigationWithPath(
    (from, to) => [from.clone(), new Vector3(0, 0.8, -2), to.clone()],
    () => { pathRequests++ },
  )
  const follower = createPathFollower(nav)
  const feet = new Vector3(0, 0, 0)
  follower.setGoal(new Vector3(0, 1, -4))

  let stuckFrame = -1
  let requestsWhenStuck = -1
  let jumpFramesAfterStuck = 0
  for (let frame = 0; frame < 100; frame++) {
    const output = follower.update(feet, 1 / 60)
    if (output.stuck && stuckFrame < 0) {
      stuckFrame = frame
      requestsWhenStuck = pathRequests
    }
    if (stuckFrame >= 0 && output.move.jump) jumpFramesAfterStuck++
    if (stuckFrame >= 0 && frame - stuckFrame < 24) {
      expect(output.move.forward).toBe(1)
      expect(pathRequests).toBe(requestsWhenStuck)
    }
  }

  expect(stuckFrame).toBeGreaterThanOrEqual(0)
  expect(jumpFramesAfterStuck).toBeGreaterThanOrEqual(23)
  expect(pathRequests).toBeGreaterThan(requestsWhenStuck)
})

// ---------------------------------------------------------------------------
// Giving up. A bot wedged against an open door leaf replans onto the very same corner, because
// the leaf is not on the navmesh — so the follower has to say "not from here" and let the brain
// choose elsewhere. Traced on the v7 front door: 39 s in one spot, 36 stalls, one corner.
// ---------------------------------------------------------------------------

/** Holds `feet` still and pumps the follower, returning the update that gave up (or null). */
function stallFor(follower: ReturnType<typeof createPathFollower>, feet: Vector3, seconds: number) {
  const DT = 1 / 60
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    const out = follower.update(feet, DT)
    if (out.abandoned) return { at: step * DT, stuck: follower.debug.stuckCount }
  }
  return null
}

test('a bot stuck twice in the same spot abandons the goal instead of pushing forever', () => {
  const corner = new Vector3(0.5, 0, 3.3)
  const nav = navigationWithPath((from) => [from.clone(), corner.clone()])
  const follower = createPathFollower(nav)
  const feet = new Vector3(1.03, 0, 3.35)
  follower.setGoal(new Vector3(-3.75, 0, 1))

  const gaveUp = stallFor(follower, feet, 6)
  expect(gaveUp).not.toBeNull()
  // One second to notice the first stall, then the second one inside the four-second window.
  expect(gaveUp!.at).toBeGreaterThan(1)
  expect(gaveUp!.at).toBeLessThan(5)
  expect(follower.debug.abandonedCount).toBe(1)
  // It let go of the goal rather than sitting on it.
  expect(follower.debug.goal).toBeNull()
  expect(follower.update(feet, 1 / 60).move.forward).toBe(0)
})

/** Pumps until the follower registers one more stall (or gives up). */
function nextStall(follower: ReturnType<typeof createPathFollower>, feet: Vector3) {
  const DT = 1 / 60
  const target = follower.debug.stuckCount + 1
  for (let step = 0; step < Math.round(6 / DT); step++) {
    const out = follower.update(feet, DT)
    if (out.abandoned) return 'abandoned'
    if (follower.debug.stuckCount >= target) return 'stuck'
  }
  return 'nothing'
}

test('two unrelated stalls far apart are not a dead end, and it keeps walking', () => {
  const nav = navigationWithPath((from) => [from.clone(), new Vector3(from.x, 0, from.z - 4)])
  const follower = createPathFollower(nav)
  const feet = new Vector3(0, 0, 0)
  follower.setGoal(new Vector3(0, 0, -40))

  expect(nextStall(follower, feet)).toBe('stuck')
  // Ten metres away: a stall here says nothing about the one back there.
  feet.set(10, 0, 10)
  expect(nextStall(follower, feet)).toBe('stuck')
  expect(follower.debug.abandonedCount).toBe(0)
  expect(follower.debug.goal).not.toBeNull()
  // ...but a second one in *this* spot is the pair that counts.
  expect(nextStall(follower, feet)).toBe('abandoned')
  expect(follower.debug.abandonedCount).toBe(1)
})

test('a new goal forgets the last stall, so the next one starts the count again', () => {
  const nav = navigationWithPath((from) => [from.clone(), new Vector3(from.x + 1, 0, from.z)])
  const follower = createPathFollower(nav)
  const feet = new Vector3(0, 0, 0)
  follower.setGoal(new Vector3(8, 0, 0))
  expect(stallFor(follower, feet, 1.4)).toBeNull()

  follower.setGoal(new Vector3(-8, 0, 0))
  // Same spot, but the first stall against a *new* goal is not evidence that goal is bad.
  expect(stallFor(follower, feet, 1.4)).toBeNull()
  expect(follower.debug.abandonedCount).toBe(0)
  // The second one against it is.
  expect(stallFor(follower, feet, 1.4)).not.toBeNull()
  expect(follower.debug.abandonedCount).toBe(1)
})

// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { AnimationClip, Vector3 } from 'three'
import { createTestRoom } from '../dev/test-room'
import { createCharacterController } from '../player/controller'
import type { DoorInfo, Navigation } from '../types'
import { createPathFollower } from './navigation'

const DT = 1 / 60
const IDLE = { forward: 0, right: 0, jump: false, crouch: false }

function straightNavigation(): Navigation {
  return {
    ready: true,
    findPath: (from, to) => [from.clone(), to.clone()],
    randomPoint: () => new Vector3(),
    randomPointAround: (center) => center.clone(),
    closestPoint: (point) => point.clone(),
  }
}

function runDoorApproach(angleDegrees: number, useFunnel: boolean): {
  crossedAt: number
  crossingX: number
} {
  const room = createTestRoom()
  room.doorHinge.rotation.y = Math.PI / 2
  room.doorHinge.updateMatrixWorld(true)

  const door: DoorInfo = {
    id: 'test-door',
    label: 'Test door',
    kind: 'door',
    // The Pascal door node is the static opening transform; the animated hinge is below it.
    node: room.root,
    clip: new AnimationClip('test-door: open', 1, []),
    center: new Vector3(16, 1, 0),
    leafMeshes: [room.doorLeaf],
    halfWidth: 0.5,
  }
  const controller = createCharacterController(room.collider)
  controller.setDynamicColliders?.([room.doorLeaf])

  const angle = angleDegrees * Math.PI / 180
  const directionX = Math.sin(angle)
  const directionZ = -Math.cos(angle)
  // Without a funnel this line meets the door plane 0.35 m from the x=15.5 hinge.
  const crossing = new Vector3(15.85, 0.01, 0)
  const start = crossing.clone().addScaledVector(new Vector3(directionX, 0, directionZ), -1.35)
  const goal = crossing.clone().addScaledVector(new Vector3(directionX, 0, directionZ), 1.35)
  controller.setPosition(start)
  for (let frame = 0; frame < 15; frame++) controller.update(DT, IDLE, 0)

  const follower = createPathFollower(
    straightNavigation(),
    useFunnel ? { doors: [door] } : undefined,
  )
  follower.setGoal(goal)
  let crossedAt = Infinity
  let crossingX = Infinity
  let previousX = controller.state.position.x
  let previousZ = controller.state.position.z
  for (let frame = 0; frame < 3 / DT; frame++) {
    const output = follower.update(controller.state.position, DT)
    controller.update(DT, output.move, output.yaw)
    const position = controller.state.position
    if (previousZ > 0 && position.z <= 0 && crossedAt === Infinity) {
      const alpha = previousZ / (previousZ - position.z)
      crossingX = previousX + (position.x - previousX) * alpha
      crossedAt = (frame + alpha) * DT
    }
    previousX = position.x
    previousZ = position.z
  }
  return { crossedAt, crossingX }
}

// Baseline regression fixture: with no door metadata, this path keeps driving into the acute
// hinge/leaf angle and never crosses. Kept skipped because the desired behavior is the funnel.
test.skip('baseline: an unfunnelled hinge-side route wedges against the open leaf', () => {
  expect(runDoorApproach(0, false).crossedAt).toBe(Infinity)
})

for (const angle of [0, 30, 45]) {
  test(`funnels a ${angle} degree approach through the open doorway within three seconds`, () => {
    const result = runDoorApproach(angle, true)
    expect(result.crossedAt).toBeLessThan(3)
    // Single-door steering is 0.25 m off centre, away from the x=15.5 hinge.
    expect(result.crossingX).toBeGreaterThan(16.1)
    expect(result.crossingX).toBeLessThan(16.4)
  })
}

test('escalates repeated blockage through back-off, sidestep, and goal abandonment', () => {
  const room = createTestRoom()
  const controller = createCharacterController(room.collider)
  controller.setPosition(new Vector3(0, 0.01, 5))
  for (let frame = 0; frame < 15; frame++) controller.update(DT, IDLE, 0)

  const follower = createPathFollower(straightNavigation())
  // The test room's north wall is an immovable box spanning the route at z=6.
  follower.setGoal(new Vector3(0, 0.01, 7))
  let stuckEvents = 0
  let sawBackoff = false
  let sawSidestep = false
  let abandonedAt = Infinity
  let secondStuckX = Infinity
  let secondStuckZ = Infinity
  let farthestSideDistance = 0
  let farthestBackDistance = 0

  for (let frame = 0; frame < 10 / DT; frame++) {
    const output = follower.update(controller.state.position, DT)
    if (output.stuck) {
      stuckEvents++
      if (stuckEvents === 2) {
        secondStuckX = controller.state.position.x
        secondStuckZ = controller.state.position.z
      }
    }
    const worldX = -Math.sin(output.yaw) * output.move.forward
      + Math.cos(output.yaw) * output.move.right
    const worldZ = -Math.cos(output.yaw) * output.move.forward
      - Math.sin(output.yaw) * output.move.right
    if (stuckEvents >= 2 && worldZ < -0.8) sawBackoff = true
    if (stuckEvents >= 2 && Math.abs(worldX) > 0.8) sawSidestep = true
    controller.update(DT, output.move, output.yaw)
    if (stuckEvents >= 2) {
      farthestBackDistance = Math.max(farthestBackDistance, secondStuckZ - controller.state.position.z)
      farthestSideDistance = Math.max(
        farthestSideDistance,
        Math.abs(controller.state.position.x - secondStuckX),
      )
    }
    if (output.abandoned) {
      abandonedAt = frame * DT
      break
    }
  }

  expect(stuckEvents).toBe(3)
  expect(sawBackoff).toBe(true)
  expect(sawSidestep).toBe(true)
  expect(farthestBackDistance).toBeGreaterThan(0.25)
  expect(farthestSideDistance).toBeGreaterThan(0.2)
  expect(abandonedAt).toBeLessThan(10)
  expect(follower.giveUp).toBe(1)
})

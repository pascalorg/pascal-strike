// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { Vector3 } from 'three'
import type { MoveInput } from '../types'
import { buildTestRoomGeometry, createTestRoom } from '../dev/test-room'
import {
  buildPascalStairCollider,
  PASCAL_STAIR,
  stairAutopilotYaw,
  stairPoint,
} from '../dev/fixtures/pascal-stair'
import { createCharacterController } from './controller'

const DT = 1 / 120
const idle: MoveInput = { forward: 0, right: 0, jump: false, crouch: false }

function run(
  controller: ReturnType<typeof createCharacterController>,
  seconds: number,
  input: MoveInput,
  yaw = 0,
): void {
  for (let index = 0; index < Math.ceil(seconds / DT); index++) controller.update(DT, input, yaw)
}

function spawnAt(x: number, z: number) {
  const room = createTestRoom()
  const controller = createCharacterController(room.collider)
  controller.setPosition(new Vector3(x, 0.01, z))
  run(controller, 0.25, idle)
  return controller
}

function climbStairs(input: MoveInput, x = 10, z = 4.5, seconds = 4) {
  const room = buildTestRoomGeometry()
  const controller = createCharacterController(room.collider)
  controller.setPosition(new Vector3(x, 0.01, z))
  run(controller, 0.25, idle)
  const startY = controller.state.position.y
  let airborneFrames = 0
  let maxTreadGap = 0
  for (let index = 0; index < Math.ceil(seconds / DT); index++) {
    controller.update(DT, input, 0)
    if (!controller.state.grounded) airborneFrames++
    if (controller.state.grounded && controller.state.position.y > 0.05 && controller.state.position.y < 2.95) {
      const nearestTread = Math.round(controller.state.position.y / 0.25) * 0.25
      maxTreadGap = Math.max(maxTreadGap, Math.abs(controller.state.position.y - nearestTread))
    }
  }
  return { controller, rise: controller.state.position.y - startY, airborneFrames, maxTreadGap }
}

/**
 * Walks up the real staircase of pascal-house.glb (see `dev/fixtures`): a curved flight of ten
 * 0.25 m risers sweeping 180°, with a newel at r = 0.24 m and a railing at r = 1.34 m, under the
 * 2.48 m ceiling of the storey. `radius` is the distance from the newel the player holds.
 */
function climbPascalStairs(input: MoveInput, radius: number, seconds = 6) {
  const controller = createCharacterController(buildPascalStairCollider())
  const [startX, startZ] = stairPoint(PASCAL_STAIR.startAngle - 0.5, radius)
  controller.setPosition(new Vector3(startX, PASCAL_STAIR.floorY + 0.02, startZ))
  run(controller, 0.33, idle)

  let airborne = 0
  let maxY = controller.state.position.y
  let reachedAt = -1
  for (let index = 0; index < Math.ceil(seconds / DT); index++) {
    const p = controller.state.position
    controller.update(DT, input, stairAutopilotYaw(p.x, p.z, radius))
    if (!controller.state.grounded) airborne++
    maxY = Math.max(maxY, controller.state.position.y)
    if (reachedAt < 0 && maxY >= PASCAL_STAIR.landingY - 0.05) reachedAt = index * DT
  }
  return { controller, maxY, airborne, reachedAt }
}

/**
 * The doorway fixture at x = 16: 1 m gap in a wall at z = 0, with a leaf that is NOT part of the
 * static collider. `openYaw` is the hinge angle (0 = shut across the gap, π/2 = swung aside).
 */
function doorway(openYaw: number, attach = true) {
  const room = buildTestRoomGeometry()
  const controller = createCharacterController(room.collider)
  if (attach) controller.setDynamicColliders?.([room.doorLeaf])
  room.doorHinge.rotation.y = openYaw
  room.doorHinge.updateMatrixWorld(true)
  controller.setPosition(new Vector3(16, 0.01, 1.2))
  run(controller, 0.25, idle)
  return { room, controller }
}

test('a closed door leaf blocks the doorway although it is not in the static collider', () => {
  const { controller } = doorway(0)
  run(controller, 1.5, { ...idle, forward: 1 })
  // Leaf face at z = 0.03 + the 0.3 m capsule radius = 0.33; allow 1 cm of penetration.
  expect(controller.state.position.z).toBeGreaterThan(0.32)
  expect(controller.state.position.z).toBeLessThan(0.36)
})

test('the same doorway lets the capsule through once the leaf swings open', () => {
  const { controller } = doorway(Math.PI / 2)
  // Walk, not run: the fixture's floor slab ends 2.2 m past the doorway.
  run(controller, 1, { ...idle, forward: 1, walk: true })
  expect(controller.state.position.z).toBeLessThan(-1)
  expect(controller.state.grounded).toBe(true)
})

test('an unregistered leaf is invisible to the controller (nothing is baked in)', () => {
  const { controller } = doorway(0, false)
  run(controller, 1, { ...idle, forward: 1, walk: true })
  expect(controller.state.position.z).toBeLessThan(-1)
})

test('a leaf swinging shut pushes the capsule out of the doorway', () => {
  const { room, controller } = doorway(Math.PI / 2)
  controller.setPosition(new Vector3(16, 0.01, 0.12))
  run(controller, 0.25, idle)
  for (let step = 0; step <= 24; step++) {
    room.doorHinge.rotation.y = Math.PI / 2 * (1 - step / 24)
    room.doorHinge.updateMatrixWorld(true)
    controller.update(DT, idle, 0)
  }
  expect(controller.state.position.z).toBeGreaterThan(0.32)
})

test('an open leaf is ground: the capsule steps onto it', () => {
  const room = buildTestRoomGeometry()
  const controller = createCharacterController(room.collider)
  controller.setDynamicColliders?.([room.doorLeaf])
  // Lay the leaf flat, 0.4 m up: a 2 m × 1 m shelf (z −0.5…1.5) in front of the doorway.
  room.doorHinge.position.set(15.5, 0.4, 1.5)
  room.doorHinge.rotation.x = -Math.PI / 2
  room.doorHinge.updateMatrixWorld(true)
  controller.setPosition(new Vector3(16, 0.01, 1.95))
  run(controller, 0.25, idle)
  run(controller, 0.6, { ...idle, forward: 1, walk: true })
  expect(controller.state.grounded).toBe(true)
  expect(controller.state.position.y).toBeGreaterThan(0.42)
  expect(controller.state.position.y).toBeLessThan(0.45)
  expect(controller.state.position.z).toBeLessThan(1.5)
})

test('walks up the two steps under a 2.48 m ceiling (the Pascal storey height)', () => {
  // From the 0.30 m step a standing capsule has 2.48 − 0.30 − 1.75 = 0.43 m of headroom, less
  // than the 0.46 m the step lift used to demand in one piece. It refused every further step.
  const controller = spawnAt(19, 1.5)
  run(controller, 1.2, { ...idle, forward: 1, walk: true })
  expect(controller.state.position.y).toBeGreaterThan(0.54)
  expect(controller.state.position.z).toBeLessThan(-1.5)
  expect(controller.state.grounded).toBe(true)
})

test('walks up the real Pascal staircase to Floor 1, from any lateral offset', () => {
  for (const radius of [0.6, 0.7, 0.85, 1.0]) {
    const result = climbPascalStairs({ ...idle, forward: 1, walk: true }, radius)
    expect(result.maxY).toBeGreaterThanOrEqual(PASCAL_STAIR.landingY - 0.05)
    expect(result.reachedAt).toBeGreaterThan(0)
  }
})

test('runs and crouches up the real Pascal staircase too', () => {
  for (const radius of [0.6, 0.7, 0.85]) {
    const running = climbPascalStairs({ ...idle, forward: 1 }, radius)
    expect(running.maxY).toBeGreaterThanOrEqual(PASCAL_STAIR.landingY - 0.05)
    const crouching = climbPascalStairs({ ...idle, forward: 1, crouch: true }, radius)
    expect(crouching.maxY).toBeGreaterThanOrEqual(PASCAL_STAIR.landingY - 0.05)
    expect(crouching.airborne).toBe(0)
  }
})

test('walking into a wall stops without penetrating by more than 1 cm', () => {
  const controller = spawnAt(0, -4)
  run(controller, 1, { ...idle, forward: 1 })
  expect(controller.state.position.z).toBeGreaterThanOrEqual(-5.71)
  expect(controller.state.position.z).toBeLessThan(-5.65)
})

test('walks up the 0.4 m step without jumping', () => {
  const controller = spawnAt(-4.2, 2)
  run(controller, 0.38, { ...idle, forward: 1 })
  expect(controller.state.position.y).toBeGreaterThan(0.38)
  expect(controller.state.position.y).toBeLessThan(0.43)
  expect(controller.state.position.z).toBeLessThan(0.75)
})

test('standing is blocked by the 1.3 m slab and crouching passes underneath', () => {
  const standing = spawnAt(-0.5, 2.2)
  run(standing, 0.75, { ...idle, forward: 1 })
  expect(standing.state.position.z).toBeGreaterThan(1.37)

  const crouching = spawnAt(-0.5, 2.2)
  run(crouching, 1.4, { ...idle, forward: 1, crouch: true })
  expect(crouching.state.crouching).toBe(true)
  expect(crouching.state.position.z).toBeLessThan(-0.9)
})

test('climbs the 20 degree ramp', () => {
  const controller = spawnAt(2.5, 4.1)
  // 0.75 s, not the 0.95 s this test used to take: a partial step lift (see `availableLift`)
  // climbs the ramp ~15 % faster, and by 0.95 s the capsule has run off the top of it.
  run(controller, 0.75, { ...idle, forward: 1 })
  expect(controller.state.position.y).toBeGreaterThan(1.05)
  expect(controller.state.position.z).toBeLessThan(0.7)
})

test('automatically climbs consecutive 0.25 m stairs when running, walking, or crouching', () => {
  const cases: MoveInput[] = [
    { ...idle, forward: 1 },
    { ...idle, forward: 1, walk: true },
    { ...idle, forward: 1, crouch: true },
  ]
  for (const input of cases) {
    const result = climbStairs(input)
    expect(result.controller.state.position.y).toBeGreaterThanOrEqual(3)
    expect(result.rise).toBeCloseTo(3, 5)
    expect(result.airborneFrames).toBe(0)
    expect(result.maxTreadGap).toBeLessThanOrEqual(0.05)
  }
})

test('automatically climbs the shallow staircase', () => {
  const result = climbStairs({ ...idle, forward: 1 }, 13, 5, 3)
  expect(result.controller.state.position.y).toBeGreaterThanOrEqual(2.04)
  expect(result.airborneFrames).toBe(0)
})

test('descends the 0.25 m staircase without bouncing or losing ground', () => {
  const room = buildTestRoomGeometry()
  const controller = createCharacterController(room.collider)
  controller.setPosition(new Vector3(10, 3.01, -1))
  run(controller, 0.25, idle)
  let airborneFrames = 0
  let highestFeet = controller.state.position.y
  let maxUpwardMove = 0
  let maxTreadGap = 0
  let previousFeet = controller.state.position.y
  for (let index = 0; index < 1 / DT; index++) {
    controller.update(DT, { ...idle, forward: 1 }, Math.PI)
    if (!controller.state.grounded) airborneFrames++
    highestFeet = Math.max(highestFeet, controller.state.position.y)
    maxUpwardMove = Math.max(maxUpwardMove, controller.state.position.y - previousFeet)
    const nearestTread = Math.round(controller.state.position.y / 0.25) * 0.25
    maxTreadGap = Math.max(maxTreadGap, Math.abs(controller.state.position.y - nearestTread))
    previousFeet = controller.state.position.y
  }
  expect(controller.state.position.y).toBeLessThan(0.05)
  expect(airborneFrames).toBe(0)
  expect(highestFeet).toBeLessThan(3.02)
  expect(maxUpwardMove).toBeLessThan(0.001)
  expect(maxTreadGap).toBeLessThanOrEqual(0.05)
})

test('the weapon speed scale multiplies the steady-state run speed', () => {
  function topSpeed(scale?: number): number {
    // Down the empty lane at x = 7.2, so nothing is hit before the speed settles.
    const controller = spawnAt(7.2, 5)
    const input: MoveInput = { ...idle, forward: 1 }
    for (let index = 0; index < Math.ceil(0.8 / DT); index++) controller.update(DT, input, 0, scale)
    return Math.hypot(controller.state.velocity.x, controller.state.velocity.z)
  }
  const base = topSpeed()
  expect(base).toBeCloseTo(5.5, 3)
  expect(topSpeed(1)).toBeCloseTo(base, 6)
  expect(topSpeed(1.12)).toBeCloseTo(base * 1.12, 3)
  expect(topSpeed(0.8)).toBeCloseTo(base * 0.8, 3)
})

test('never falls through the floor over 20 seconds of deterministic random input', () => {
  const controller = spawnAt(0, 4)
  let seed = 0x12345678
  for (let index = 0; index < 20 / DT; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const x = seed / 4294967296
    controller.update(DT, {
      forward: x < 0.33 ? -1 : x > 0.66 ? 1 : 0,
      right: x < 0.2 ? 1 : x > 0.8 ? -1 : 0,
      jump: (seed & 127) === 0,
      crouch: (seed & 31) < 3,
    }, (seed & 0xffff) / 0xffff * Math.PI * 2)
    expect(controller.state.position.y).toBeGreaterThan(-0.02)
  }
})

test('1000 controller updates complete in under 200 ms', () => {
  const controller = spawnAt(0, 4)
  const input: MoveInput = { forward: 1, right: 0.35, jump: false, crouch: false }
  const started = performance.now()
  for (let index = 0; index < 1000; index++) controller.update(DT, input, index * 0.003)
  const elapsed = performance.now() - started
  expect(elapsed).toBeLessThan(200)
})

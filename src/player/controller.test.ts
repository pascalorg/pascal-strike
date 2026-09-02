// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { Vector3 } from 'three'
import type { MoveInput } from '../types'
import { buildTestRoomGeometry, createTestRoom } from '../dev/test-room'
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
  run(controller, 0.95, { ...idle, forward: 1 })
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

// @ts-ignore Bun test runtime.
import { expect, test } from 'bun:test'
import { BoxGeometry, Mesh, Vector3 } from 'three'
import { PLAYER } from '../config'
import { createEntityRegistry } from '../game/entities'
import { buildTestRoomGeometry } from '../dev/test-room'
import type { MoveInput, PlayerEntity, StaticCollider } from '../types'
import { createCharacterController } from './controller'

const dt = 1 / 120
const idle: MoveInput = { forward: 0, right: 0, jump: false, crouch: false }
const forward = { ...idle, forward: 1 }
const floorGeometry = new BoxGeometry(20, .2, 20).translate(0, -.1, 0)
const floor: StaticCollider = { geometry: floorGeometry, mesh: new Mesh(floorGeometry) }
const entity = (id: string, x = 0, y = 0, z = 0) => createEntityRegistry().upsert({ id, position: { x, y, z } })

function setup(players: () => readonly PlayerEntity[], collider = floor) {
  const controller = createCharacterController(collider, { playerCollisions: { id: 'me', players } })
  controller.setPosition(new Vector3(0, .01, 2))
  return controller
}
function run(controller: ReturnType<typeof setup>, seconds: number, move = idle) {
  for (let i = 0; i < Math.ceil(seconds / dt); i++) controller.update(dt, move, 0)
}

test('living teammates, enemies and bots block movement without being stepped over or pushed', () => {
  for (const team of ['a', 'b'] as const) for (const isBot of [false, true]) {
    const other = entity('other'); other.team = team; other.isBot = isBot
    const controller = setup(() => [other])
    run(controller, 2, forward)
    expect(controller.state.position.z).toBeCloseTo(PLAYER.radius * 2, 3)
    expect(controller.state.position.y).toBeLessThan(.01)
    expect(other.position.toArray()).toEqual([0, 0, 0])
  }
})

test('death removes blocking on the next physics step, and respawn restores it', () => {
  const other = entity('other'), players = [other]
  const controller = setup(() => players)
  run(controller, 1, forward)
  const before = controller.state.position.z
  other.alive = false
  controller.update(dt, forward, 0)
  expect(controller.state.position.z).toBeLessThan(before)
  run(controller, 1, forward)
  expect(controller.state.position.z).toBeLessThan(-1)
  other.alive = true
  controller.setPosition(new Vector3(0, .01, 2))
  run(controller, 1, forward)
  expect(controller.state.position.z).toBeCloseTo(.6, 3)
})

test('self, spectators and disconnected players do not leave invisible blockers', () => {
  const self = entity('me'), spectator = entity('spectator'); spectator.spectating = true
  let players = [self, spectator]
  const controller = setup(() => players)
  run(controller, 1, forward)
  expect(controller.state.position.z).toBeLessThan(-1)
  const other = entity('other'); players = [other]
  controller.setPosition(new Vector3(0, .01, 2))
  run(controller, 1, forward)
  expect(controller.state.position.z).toBeCloseTo(.6, 3)
  players = []
  run(controller, 1, forward)
  expect(controller.state.position.z).toBeLessThan(-1)
})

test('glancing contact slides past the player while maintaining separation', () => {
  const other = entity('other'), players = [other]
  const controller = setup(() => players)
  controller.setPosition(new Vector3(.3, .01, 1))
  for (let i = 0; i < 120; i++) {
    controller.update(dt, forward, 0)
    expect(Math.hypot(controller.state.position.x, controller.state.position.z)).toBeGreaterThanOrEqual(.599)
  }
  expect(controller.state.position.z).toBeLessThan(-1)
})

test('player height supports landing on a head, and the support disappears on death', () => {
  for (const crouching of [false, true]) {
    const other = entity('other'); other.crouching = crouching
    const players = [other], controller = setup(() => players)
    controller.setPosition(new Vector3(0, 3, 0))
    run(controller, 1)
    expect(controller.state.position.y).toBeCloseTo(crouching ? PLAYER.crouchHeight : PLAYER.height, 3)
    expect(controller.state.grounded).toBe(true)
    other.alive = false
    run(controller, 1)
    expect(controller.state.position.y).toBeLessThan(.01)
  }
})

test('an overhead player prevents uncrouching until they die', () => {
  const other = entity('other', 0, 1.4, 0), players = [other]
  const controller = setup(() => players)
  controller.setPosition(new Vector3(0, .01, 0))
  run(controller, .2, { ...idle, crouch: true })
  run(controller, .2)
  expect(controller.state.crouching).toBe(true)
  other.alive = false
  run(controller, .2)
  expect(controller.state.crouching).toBe(false)
})

test('a living player blocks a doorway, including its moving door collider', () => {
  const room = buildTestRoomGeometry(), other = entity('other', 16, 0, 0), players = [other]
  const controller = setup(() => players, room.collider)
  controller.setDynamicColliders?.([room.doorLeaf])
  room.doorHinge.rotation.y = Math.PI / 2
  controller.setPosition(new Vector3(16, .01, 1.6))
  run(controller, 1, forward)
  expect(controller.state.position.z).toBeCloseTo(.6, 3)
  expect(controller.state.position.x).toBeCloseTo(16, 3)
  other.alive = false
  run(controller, .5, forward)
  expect(controller.state.position.z).toBeLessThan(-.3)
})

test('coincident bodies separate deterministically and never generate NaNs', () => {
  const other = entity('other'), players = [other], controller = setup(() => players)
  controller.setPosition(new Vector3(0, .0001, 0))
  run(controller, .1)
  expect(controller.state.position.x).toBeCloseTo(-.6, 3)
  expect(controller.state.position.toArray().every(Number.isFinite)).toBe(true)
})

test('two moving controllers cannot pass through each other, even at the maximum timestep', () => {
  for (const step of [dt, .05]) {
    const a = entity('a', -1), b = entity('b', 1), players = [a, b]
    const controllers = players.map(player => {
      const controller = createCharacterController(floor, { playerCollisions: { id: player.id, players: () => players } })
      controller.setPosition(player.position)
      return controller
    })
    for (let frame = 0; frame < Math.ceil(2 / step); frame++) {
      for (let i = 0; i < controllers.length; i++) {
        controllers[i].update(step, forward, i === 0 ? -Math.PI / 2 : Math.PI / 2)
        players[i].position.copy(controllers[i].state.position)
      }
      expect(Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z)).toBeGreaterThanOrEqual(.599)
      expect(Math.max(a.position.y, b.position.y)).toBeLessThan(.01)
    }
  }
})

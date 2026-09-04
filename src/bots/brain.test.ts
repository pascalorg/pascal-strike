// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { BOTS } from '../config'
import { createTestRoom } from '../dev/test-room'
import { createCharacterController } from '../player/controller'
import type { Navigation, PlayerEntity, SpawnLayout } from '../types'
import { createBotBrain } from './brain'
import { createPathFollower } from './navigation'

const DT = 1 / 60
const EMPTY_SPAWNS: SpawnLayout = { a: [], b: [], source: 'auto' }

function entity(
  id: string,
  team: PlayerEntity['team'],
  x: number,
  z: number,
  yaw = 0,
): PlayerEntity {
  return {
    id,
    name: id,
    team,
    isBot: id === 'bot',
    isLocal: false,
    hp: 100,
    alive: true,
    invincibleUntil: 0,
    kills: 0,
    deaths: 0,
    position: new Vector3(x, 0.01, z),
    yaw,
    pitch: 0,
    crouching: false,
    speed: 0,
  }
}

function straightNavigation(): Navigation {
  return {
    ready: true,
    findPath: (from, to) => [from.clone(), to.clone()],
    randomPoint: () => new Vector3(4, 0.01, -2),
    randomPointAround: (center) => center.clone(),
    closestPoint: (point) => point.clone(),
  }
}

test('a visible enemy is acquired after reaction delay and fired on within one second', () => {
  const room = createTestRoom()
  const self = entity('bot', 'a', 4, 4)
  const enemy = entity('enemy', 'b', 4, -4)
  const brain = createBotBrain({
    self,
    world: room.world,
    nav: straightNavigation(),
    rng: () => 0.5,
  })

  let engagedAt = Infinity
  let firedAt = Infinity
  for (let frame = 0; frame < 60; frame++) {
    const now = frame * DT * 1000
    const decision = brain.update(DT, now, [enemy], [], EMPTY_SPAWNS)
    if (brain.state === 'engage' && engagedAt === Infinity) engagedAt = now
    if (decision.fire && firedAt === Infinity) firedAt = now
  }

  expect(engagedAt).toBeGreaterThanOrEqual(BOTS.reactionMs)
  expect(engagedAt).toBeLessThan(BOTS.reactionMs + 1000 / BOTS.decisionHz + DT * 1000)
  expect(firedAt).toBeGreaterThanOrEqual(engagedAt)
  expect(firedAt).toBeLessThan(1000)
})

test('never fires at an enemy behind a wall', () => {
  const room = createTestRoom()
  const self = entity('bot', 'a', 0, 2, Math.PI)
  const enemy = entity('enemy', 'b', 0, 10, Math.PI)
  const brain = createBotBrain({
    self,
    world: room.world,
    nav: straightNavigation(),
    rng: () => 0.5,
  })

  let fired = false
  for (let frame = 0; frame < 120; frame++) {
    fired ||= brain.update(DT, frame * DT * 1000, [enemy], [], EMPTY_SPAWNS).fire
  }

  expect(fired).toBe(false)
  expect(brain.state).not.toBe('engage')
})

test('a path follower drives the character controller to a goal six metres away', () => {
  const room = createTestRoom()
  const controller = createCharacterController(room.collider)
  const follower = createPathFollower(straightNavigation())
  const start = new Vector3(4, 0.01, 4)
  const goal = new Vector3(4, 0.01, -2)
  controller.setPosition(start)

  const idle = { forward: 0, right: 0, jump: false, crouch: false }
  for (let frame = 0; frame < 15; frame++) controller.update(DT, idle, 0)
  follower.setGoal(goal)
  for (let frame = 0; frame < 5 / DT; frame++) {
    const output = follower.update(controller.state.position, DT)
    controller.update(DT, output.move, output.yaw)
  }

  const dx = controller.state.position.x - goal.x
  const dz = controller.state.position.z - goal.z
  expect(Math.hypot(dx, dz)).toBeLessThan(0.6)
})

test('never fires through an ally standing between the bot and its enemy', () => {
  const room = createTestRoom()
  const self = entity('bot', 'a', 4, 4)
  const ally = entity('ally', 'a', 4, 0)
  const enemy = entity('enemy', 'b', 4, -4)
  const brain = createBotBrain({
    self,
    world: room.world,
    nav: straightNavigation(),
    rng: () => 0.5,
  })

  let fired = false
  for (let frame = 0; frame < 90; frame++) {
    fired ||= brain.update(DT, frame * DT * 1000, [enemy], [ally], EMPTY_SPAWNS).fire
  }

  expect(brain.state).toBe('engage')
  expect(fired).toBe(false)
})

test('a goal the follower gives up on is not chosen again while it is blacklisted', () => {
  const self = entity('bot', 'a', 0, 0)
  // The navmesh offers the same dead end twice and somewhere else afterwards. Without the
  // blacklist the brain takes the second draw and walks straight back into the door leaf.
  const deadEnd = new Vector3(4, 0.01, -2)
  const escape = new Vector3(-9, 0.01, 9)
  let draws = 0
  const nav: Navigation = {
    ready: true,
    findPath: (from, to) => [from.clone(), to.clone()],
    randomPoint: () => (draws++ < 2 ? deadEnd.clone() : escape.clone()),
    randomPointAround: (center) => center.clone(),
    closestPoint: (point) => point.clone(),
  }
  const follower = createPathFollower(nav)
  const brain = createBotBrain({
    self,
    world: createTestRoom().world,
    nav,
    rng: () => 0.5,
    pathFollower: follower,
  })

  // The bot never moves: the follower stalls twice in the same spot and gives up on the goal.
  for (let step = 0; step < Math.round(8 / DT); step++) {
    brain.update(DT, step * DT * 1000, [], [], EMPTY_SPAWNS)
    if (follower.debug.abandonedCount > 0) break
  }
  expect(follower.debug.abandonedCount).toBeGreaterThan(0)

  // Whatever it picks next, it must not be the spot it just failed to reach.
  for (let step = 0; step < 30; step++) brain.update(DT, 9000 + step * DT * 1000, [], [], EMPTY_SPAWNS)
  const goal = follower.debug.goal
  expect(goal).not.toBeNull()
  expect(goal!.distanceTo(deadEnd)).toBeGreaterThan(1.5)
  expect(goal!.distanceTo(escape)).toBeLessThan(0.01)
  // It refused a draw, rather than simply running out of dead ends to be offered.
  expect(draws).toBeGreaterThan(2)
})

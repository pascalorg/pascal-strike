// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { PLAYER, WEAPONS } from '../config'
import { computeHitShapes, createHitShapes } from '../player/hitshapes'
import type { Hittable, TeamId, WorldQuery } from '../types'
import { createMelee, HIT_FRAME_SECONDS } from './melee'

const DT = 1 / 120
const EYE = new Vector3(0, PLAYER.eyeHeight, 0)
const FORWARD = new Vector3(0, 0, -1)
const OPEN: Pick<WorldQuery, 'raycast' | 'lineOfSight'> = {
  raycast: () => null,
  lineOfSight: () => true,
}
const BLOCKED: Pick<WorldQuery, 'raycast' | 'lineOfSight'> = {
  raycast: () => null,
  lineOfSight: () => false,
}

/** A standing target with real hit shapes, feet at (x, 0, z). */
function target(id: string, team: TeamId, x: number, z: number): Hittable {
  const feet = new Vector3(x, 0, z)
  const shapes = createHitShapes()
  computeHitShapes(shapes, feet, 0, false)
  return {
    id,
    team,
    alive: true,
    capsuleStart: new Vector3(x, PLAYER.radius, z),
    capsuleEnd: new Vector3(x, PLAYER.height - PLAYER.radius, z),
    capsuleRadius: PLAYER.radius,
    shapes,
  }
}

/** Holds the button for `seconds` and collects every hit and swing. */
function swingFor(
  melee: ReturnType<typeof createMelee>,
  seconds: number,
  targets: Hittable[],
  world: Pick<WorldQuery, 'raycast' | 'lineOfSight'> = OPEN,
) {
  const hits: string[] = []
  let swings = 0
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const update = melee.update(DT, true, EYE, FORWARD, targets, world)
    if (update.started) swings++
    for (const hit of update.hits) hits.push(`${hit.target}:${hit.part}`)
  }
  return { hits, swings }
}

test('an enemy inside the cone and the reach is cut', () => {
  const melee = createMelee({ ownerId: 'me', team: 'a' })
  const { hits } = swingFor(melee, 0.2, [target('enemy', 'b', 0, -1.2)])
  expect(hits).toHaveLength(1)
  expect(hits[0].startsWith('enemy:')).toBe(true)
})

test('the cone rejects what is out of reach, off to the side, friendly or behind a wall', () => {
  const range = WEAPONS.knife.range
  const far = target('far', 'b', 0, -(range + 1))
  const beside = target('beside', 'b', 1.0, -0.6) // ~59 degrees off the look direction
  const friend = target('friend', 'a', 0, -1.2)
  const behind = target('behind', 'b', 0, 1.2)
  for (const list of [[far], [beside], [friend], [behind]]) {
    const melee = createMelee({ ownerId: 'me', team: 'a' })
    expect(swingFor(melee, 0.2, list).hits).toHaveLength(0)
  }
  // Line of sight is the last gate: the same reachable enemy through a wall is a miss.
  const walled = createMelee({ ownerId: 'me', team: 'a' })
  expect(swingFor(walled, 0.2, [target('enemy', 'b', 0, -1.2)], BLOCKED).hits).toHaveLength(0)
})

test('a swing only connects on its hit frame, 120 ms in', () => {
  const melee = createMelee({ ownerId: 'me', team: 'a' })
  const enemy = [target('enemy', 'b', 0, -1.2)]
  let elapsed = 0
  let hitAt = -1
  for (let i = 0; i < Math.round(0.3 / DT); i++) {
    const update = melee.update(DT, true, EYE, FORWARD, enemy, OPEN)
    elapsed += DT
    if (update.hits.length > 0 && hitAt < 0) hitAt = elapsed
  }
  expect(hitAt).toBeGreaterThanOrEqual(HIT_FRAME_SECONDS)
  expect(hitAt).toBeLessThan(HIT_FRAME_SECONDS + 2 * DT)
})

test('holding the button swings at the knife fire rate', () => {
  const melee = createMelee({ ownerId: 'me', team: 'a' })
  const seconds = 2
  const { swings } = swingFor(melee, seconds, [])
  // One at t = 0, then one every 1 / fireRate.
  expect(swings).toBe(1 + Math.floor(seconds * WEAPONS.knife.fireRate - 1e-9))
})

test('two swings from the front take a 100 hp player down (60 + 60)', () => {
  const melee = createMelee({ ownerId: 'me', team: 'a' })
  const { hits } = swingFor(melee, 1 / WEAPONS.knife.fireRate + 0.2, [target('enemy', 'b', 0, -1.2)])
  expect(hits).toHaveLength(2)
  expect(WEAPONS.knife.damage * 2).toBeGreaterThanOrEqual(PLAYER.maxHp)
})

test('a swing that hits nothing reports the wall it landed on, for the smear', () => {
  const wall = {
    raycast: (_origin: Vector3, _direction: Vector3, maxDistance: number) => ({
      point: new Vector3(0, PLAYER.eyeHeight, -1),
      normal: new Vector3(0, 0, 1),
      distance: Math.min(1, maxDistance),
      object: { name: 'wall' } as never,
      kind: 'static' as const,
    }),
    lineOfSight: () => true,
  }
  const melee = createMelee({ ownerId: 'me', team: 'a' })
  let surfaces = 0
  for (let i = 0; i < Math.round(0.2 / DT); i++) {
    if (melee.update(DT, true, EYE, FORWARD, [], wall).surface) surfaces++
  }
  expect(surfaces).toBe(1)
})

test('the hit carries the knife, a body part and an impact point in front of the eye', () => {
  const melee = createMelee({ ownerId: 'me', team: 'a' })
  const enemy = [target('enemy', 'b', 0, -1.0)]
  let hit = null
  for (let i = 0; i < Math.round(0.2 / DT); i++) {
    const update = melee.update(DT, true, EYE, FORWARD, enemy, OPEN)
    if (update.hits.length > 0) hit = update.hits[0]
  }
  expect(hit).not.toBeNull()
  expect(hit!.weapon).toBe('knife')
  expect(hit!.by).toBe('me')
  expect(['head', 'torso', 'arm', 'leg']).toContain(hit!.part)
  // In front of the eye and inside the reach.
  const point = new Vector3().fromArray(hit!.point)
  expect(point.z).toBeLessThan(0)
  expect(point.distanceTo(EYE)).toBeLessThanOrEqual(WEAPONS.knife.range)
})

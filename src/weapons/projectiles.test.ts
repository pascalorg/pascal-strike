// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { Scene, Vector3 } from 'three'
import type { BodyPart, HitEvent, Hittable, ShotEvent, WorldQuery } from '../types'
import { createTestRoom } from '../dev/test-room'
import { computeHitShapes, createHitShapes } from '../player/hitshapes'
import { createProjectiles } from './projectiles'

const noDecals = { add() {} }
const noEffects = { splat() {} }
const noAudio = { play() {} }
const emptyWorld: WorldQuery = { raycast: () => null, lineOfSight: () => true }

function shot(id: string, origin: [number, number, number], dir: [number, number, number]): ShotEvent {
  return { id, by: 'local', team: 'a', origin, dir, speed: 70, t: 0, seed: 123 }
}

test('a wall shot from 5 m produces one static hit at the gravity-adjusted point', () => {
  const room = createTestRoom()
  const scene = new Scene()
  const staticHits: Vector3[] = []
  const projectiles = createProjectiles(
    scene,
    room.world,
    { add(_target, point) { staticHits.push(point.clone()) } },
    noEffects,
    noAudio,
  )
  projectiles.spawn(shot('local:1', [4, 1.5, -1], [0, 0, -1]), { detectPlayers: true })
  for (let index = 0; index < 30 && projectiles.liveCount; index++) projectiles.update(1 / 120, [])
  expect(staticHits).toHaveLength(1)
  const flightTime = 5 / 70
  const expected = new Vector3(4, 1.5 - 0.5 * 9.8 * flightTime ** 2, -6)
  expect(staticHits[0].distanceTo(expected)).toBeLessThan(0.05)
  projectiles.dispose()
})

test('capsule hits respect detectPlayers', () => {
  const target: Hittable = {
    id: 'enemy',
    team: 'b',
    alive: true,
    capsuleStart: new Vector3(0, 0.3, -5),
    capsuleEnd: new Vector3(0, 1.45, -5),
    capsuleRadius: 0.3,
  }

  const detected: HitEvent[] = []
  const detecting = createProjectiles(new Scene(), emptyWorld, noDecals, noEffects, noAudio)
  detecting.onPlayerHit((hit) => detected.push(hit))
  detecting.spawn(shot('local:2', [0, 1, 0], [0, 0, -1]), { detectPlayers: true })
  detecting.update(0.1, [target])
  expect(detected).toHaveLength(1)
  expect(detected[0].target).toBe('enemy')
  // No `shapes` on this hittable (the local player still has none) — the coarse capsule decides.
  expect(detected[0].part).toBe('torso')
  detecting.dispose()

  const ignored: HitEvent[] = []
  const paintingOnly = createProjectiles(new Scene(), emptyWorld, noDecals, noEffects, noAudio)
  paintingOnly.onPlayerHit((hit) => ignored.push(hit))
  paintingOnly.spawn(shot('remote:1', [0, 1, 0], [0, 0, -1]), { detectPlayers: false })
  paintingOnly.update(0.1, [target])
  expect(ignored).toHaveLength(0)
  expect(paintingOnly.liveCount).toBe(1)
  paintingOnly.dispose()
})

/** An enemy standing at z = -5, facing +Z (towards the shooter at the origin). */
function standingTarget(crouching = false): Hittable {
  const feet = new Vector3(0, 0, -5)
  const shapes = computeHitShapes(createHitShapes(), feet, 0, crouching)
  const height = crouching ? 1.15 : 1.75
  return {
    id: 'enemy',
    team: 'b',
    alive: true,
    capsuleStart: new Vector3(0, 0.3, -5),
    capsuleEnd: new Vector3(0, height - 0.3, -5),
    capsuleRadius: 0.3,
    shapes,
  }
}

/** Fires one flat shot from `origin` at the target and returns the body part it reported. */
function partHitFrom(origin: [number, number, number], target: Hittable): BodyPart | undefined {
  const hits: HitEvent[] = []
  const projectiles = createProjectiles(new Scene(), emptyWorld, noDecals, noEffects, noAudio)
  projectiles.onPlayerHit((hit) => hits.push(hit))
  projectiles.spawn(shot(`local:${origin.join(',')}`, origin, [0, 0, -1]), { detectPlayers: true })
  for (let index = 0; index < 20 && projectiles.liveCount; index++) projectiles.update(1 / 120, [target])
  projectiles.dispose()
  expect(hits).toHaveLength(1)
  return hits[0].part
}

test('the narrow phase names the body part that was hit', () => {
  const target = standingTarget()
  expect(partHitFrom([0, 1.66, 0], target)).toBe('head')
  expect(partHitFrom([0, 0.95, 0], target)).toBe('torso')
  expect(partHitFrom([0.3, 1.2, 0], target)).toBe('arm')
  expect(partHitFrom([0.12, 0.5, 0], target)).toBe('leg')
})

test('crouching lowers the head into what would be chest height', () => {
  const standing = standingTarget()
  const crouched = standingTarget(true)
  // 1.08 m: the head of a crouching player, the chest of a standing one.
  expect(partHitFrom([0, 1.08, 0], standing)).toBe('torso')
  expect(partHitFrom([0, 1.08, 0], crouched)).toBe('head')
})

test('a shot that clips the capsule but no shape still counts as a torso hit', () => {
  const target = standingTarget()
  // 1.5 m up, between the shoulders and the head: inside the coarse capsule, outside every shape.
  expect(partHitFrom([0.28, 1.5, 0], target)).toBe('torso')
})

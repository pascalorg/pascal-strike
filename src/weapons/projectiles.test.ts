// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { Scene, Vector3 } from 'three'
import type { HitEvent, Hittable, ShotEvent, WorldQuery } from '../types'
import { createTestRoom } from '../dev/test-room'
import { createProjectiles } from './projectiles'

const noDecals = { add() {} }
const noEffects = { splat() {} }
const noAudio = { play() {} }

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
  const emptyWorld: WorldQuery = {
    raycast: () => null,
    lineOfSight: () => true,
  }
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

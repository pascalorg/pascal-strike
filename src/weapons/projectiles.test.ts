// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { InstancedMesh, Matrix4, Scene, Vector3 } from 'three'
import type { BodyPart, HitEvent, Hittable, ShotEvent, WorldQuery } from '../types'
import { createTestRoom } from '../dev/test-room'
import { computeHitShapes, createHitShapes } from '../player/hitshapes'
import { createProjectiles } from './projectiles'

// Avatars draw their name tag on a canvas. Same stand-in as `player/avatar.test.ts`: the drawing
// calls are no-ops, so the real avatar can be built (and posed) with no DOM.
if (typeof document === 'undefined') {
  const context = {
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() {}, strokeText() {}, fillText() {}, ellipse() {}, arc() {},
  }
  ;(globalThis as unknown as { document: Document }).document = {
    createElement() {
      return { width: 0, height: 0, getContext: () => context }
    },
  } as unknown as Document
}
const { createAvatar: createRenderedAvatar } = await import('../player/avatar')
const createAvatar = (team: 'a' | 'b', name: string, id?: string) => createRenderedAvatar(team, name, id, null)

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

/** Fires one flat shot from `origin` at the target and returns every hit it reported. */
function hitsFrom(origin: [number, number, number], target: Hittable, id = origin.join(',')): HitEvent[] {
  const hits: HitEvent[] = []
  const projectiles = createProjectiles(new Scene(), emptyWorld, noDecals, noEffects, noAudio)
  projectiles.onPlayerHit((hit) => hits.push(hit))
  projectiles.spawn(shot(`local:${id}`, origin, [0, 0, -1]), { detectPlayers: true })
  for (let index = 0; index < 20 && projectiles.liveCount; index++) projectiles.update(1 / 120, [target])
  projectiles.dispose()
  return hits
}

/** Fires one flat shot from `origin` at the target and returns the body part it reported. */
function partHitFrom(origin: [number, number, number], target: Hittable): BodyPart | undefined {
  const hits = hitsFrom(origin, target)
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

test('a paintball crosses an unbroken pane: the pane is reported, the paint lands behind it', () => {
  const scene = new Scene()
  const pane = { name: 'pane' } as never
  const wall = { name: 'wall' } as never
  // A pane 2 m out and a wall 6 m out, both square to the shot.
  const world: WorldQuery = {
    raycast(origin, dir, maxDistance) {
      for (const [z, object, kind] of [[-2, pane, 'glass'], [-6, wall, 'static']] as const) {
        const distance = (origin.z - z) / -dir.z
        if (distance >= 0 && distance <= maxDistance) {
          return {
            point: new Vector3(origin.x, origin.y, z),
            normal: new Vector3(0, 0, 1),
            distance,
            object,
            kind,
          }
        }
      }
      return null
    },
    lineOfSight: () => true,
  }
  const decalTargets: unknown[] = []
  const projectiles = createProjectiles(
    scene,
    world,
    { add(target) { decalTargets.push(target) } },
    noEffects,
    noAudio,
  )
  const glassHits: string[] = []
  projectiles.onGlassHit((hit) => glassHits.push((hit.object as { name: string }).name))
  projectiles.spawn(shot('local:glass', [0, 1.5, 0], [0, 0, -1]), { detectPlayers: false })
  for (let index = 0; index < 60 && projectiles.liveCount; index++) projectiles.update(1 / 120, [])
  expect(glassHits).toEqual(['pane'])
  expect(decalTargets).toHaveLength(1)
  expect((decalTargets[0] as { name: string }).name).toBe('wall')
  projectiles.dispose()
})

// ---------------------------------------------------------------------------
// The real thing: a remote player is only ever hittable through `Avatar.hittable()`, and the
// game feeds the sim exactly what `remote-players.ts` collects from the avatars in the scene.
// The hand-built `Hittable`s above cannot catch an avatar that stops updating its capsule (a
// batching or pivot change is all it takes), so one test drives the actual class.
// ---------------------------------------------------------------------------

test('an avatar posed by set() is hittable where it stands, part by part', () => {
  const avatar = createAvatar('b', 'Enemy', 'enemy')
  avatar.set(new Vector3(0, 0, -5), 0, 0, false, 0)
  const target = avatar.hittable()

  expect(target.id).toBe('enemy')
  expect(target.team).toBe('b')
  expect(target.alive).toBe(true)
  expect(target.shapes).toHaveLength(6)
  expect(partHitFrom([0, 1.66, 0], target)).toBe('head')
  expect(partHitFrom([0, 0.95, 0], target)).toBe('torso')
  expect(partHitFrom([0.12, 0.5, 0], target)).toBe('leg')
  avatar.dispose()
})

test('the capsule follows the avatar: it moves, and the old spot stops being a target', () => {
  const avatar = createAvatar('b', 'Enemy', 'enemy')
  avatar.set(new Vector3(0, 0, -5), 0, 0, false, 0)
  expect(hitsFrom([0, 0.95, 0], avatar.hittable(), 'a')).toHaveLength(1)

  // Two metres to the right. `hittable()` is what the game calls every frame, so the capsule
  // and the six shapes have to be where the body now is — and nowhere else.
  avatar.set(new Vector3(2, 0, -5), 0, 0, false, 0)
  expect(hitsFrom([0, 0.95, 0], avatar.hittable(), 'b')).toHaveLength(0)
  expect(hitsFrom([2, 0.95, 0], avatar.hittable(), 'c')).toHaveLength(1)

  // Crouching drops the head into what was chest height, through the same call.
  avatar.set(new Vector3(2, 0, -5), 0, 0, true, 0)
  expect(hitsFrom([2, 1.08, 0], avatar.hittable(), 'd')[0]?.part).toBe('head')

  // Dead bodies are not targets.
  avatar.die()
  expect(hitsFrom([2, 0.95, 0], avatar.hittable(), 'e')).toHaveLength(0)
  avatar.spawn()
  expect(hitsFrom([2, 0.95, 0], avatar.hittable(), 'f')).toHaveLength(1)
  avatar.dispose()
})

test("a shot spawned at somebody's muzzle is drawn there but still resolved from their eye", () => {
  const avatar = createAvatar('b', 'Enemy', 'enemy')
  avatar.set(new Vector3(0, 0, -5), 0, 0, false, 0)
  const target = avatar.hittable()

  const shooterMuzzle = new Vector3()
  const shooter = createAvatar('a', 'Shooter', 'shooter')
  shooter.set(new Vector3(0, 0, 0), 0, 0, false, 0)
  shooter.muzzleWorld(shooterMuzzle)
  // The muzzle is on the gun: about a metre up and a stride in front of the feet, well below
  // the 1.55 m eye the shot was aimed from. That gap is the whole point of `visualOrigin`.
  expect(shooterMuzzle.y).toBeGreaterThan(0.8)
  expect(shooterMuzzle.y).toBeLessThan(1.25)
  expect(shooterMuzzle.z).toBeLessThan(-0.5)

  const scene = new Scene()
  const hits: HitEvent[] = []
  const projectiles = createProjectiles(scene, emptyWorld, noDecals, noEffects, noAudio)
  projectiles.onPlayerHit((hit) => hits.push(hit))
  projectiles.spawn(shot('remote:muzzle', [0, 1.66, 0], [0, 0, -1]), {
    detectPlayers: true,
    visualOrigin: shooterMuzzle,
  })

  // One tick: the ball has barely left the barrel, so that is where it must be drawn.
  projectiles.update(1 / 240, [target])
  const balls = scene.children.find((child): child is InstancedMesh => child instanceof InstancedMesh)!
  const drawn = new Vector3().setFromMatrixPosition(new Matrix4().fromArray(balls.instanceMatrix.array, 0))
  expect(drawn.distanceTo(shooterMuzzle)).toBeLessThan(0.35)

  // ...and the shot still lands where it was aimed: a headshot, not half a metre of drop.
  for (let index = 0; index < 20 && projectiles.liveCount; index++) projectiles.update(1 / 120, [target])
  expect(hits).toHaveLength(1)
  expect(hits[0].part).toBe('head')
  projectiles.dispose()
  shooter.dispose()
  avatar.dispose()
})

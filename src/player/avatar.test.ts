// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { Mesh, MeshStandardMaterial, Vector3 } from 'three'
import { TEAMS } from '../config'
import type { TeamId, WeaponKind } from '../types'
import { createWeaponModel, type WeaponQuality } from '../weapons/weapon-model'
import { createAvatar as createRenderedAvatar } from './avatar'
// Rendering and real GLBs are exercised by scripts/verify-characters.mjs.
const createAvatar = (team: TeamId, name: string, id?: string) => createRenderedAvatar(team, name, id, null)
import { computeHitShapes, createHitShapes } from './hitshapes'

// CanvasTexture only retains the canvas in these headless tests. The drawing methods are no-ops;
// they let the avatar exercise the real name-tag and splat construction paths without a DOM dep.
if (typeof document === 'undefined') {
  const context = {
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
    strokeText() {},
    fillText() {},
    ellipse() {},
    arc() {},
  }
  ;(globalThis as unknown as { document: Document }).document = {
    createElement() {
      return { width: 0, height: 0, getContext: () => context }
    },
  } as unknown as Document
}

function meshCount(root: ReturnType<typeof createAvatar>['object']): number {
  let count = 0
  root.traverse((object) => {
    if (object instanceof Mesh) count++
  })
  return count
}

test('both weapon quality levels batch to three meshes or fewer', () => {
  const expected: Record<WeaponKind, number> = { rifle: 3, pistol: 3, knife: 1 }
  for (const quality of ['first', 'third'] as WeaponQuality[]) {
    for (const kind of Object.keys(expected) as WeaponKind[]) {
      const model = createWeaponModel({ kind, team: 'a', quality })
      expect(meshCount(model.object)).toBe(expected[kind])
      expect(() => {
        model.setTeam('b')
        model.setPaintLevel(0.35)
        model.setFireFlash(1)
        model.muzzle.updateWorldMatrix(true, false)
      }).not.toThrow()
      model.dispose()
    }
  }
})

test('character presentation preserves the shared hit shapes across poses', () => {
  const avatar = createAvatar('a', 'Hit Shapes', 'hit-shape-avatar')
  const reference = createHitShapes()
  const poses = [
    { position: new Vector3(0, 0, 0), yaw: 0, pitch: 0, crouching: false, speed: 0 },
    { position: new Vector3(4, 1.2, -3), yaw: 1.1, pitch: 0.45, crouching: false, speed: 5.5 },
    { position: new Vector3(-2, 0.3, 7), yaw: -0.8, pitch: -0.3, crouching: true, speed: 2.6 },
  ]

  for (const pose of poses) {
    avatar.set(pose.position, pose.yaw, pose.pitch, pose.crouching, pose.speed)
    computeHitShapes(reference, pose.position, pose.yaw, pose.crouching)
    const actual = avatar.hittable().shapes!
    expect(actual.map((shape) => shape.part)).toEqual(reference.map((shape) => shape.part))
    for (let index = 0; index < reference.length; index++) {
      expect(actual[index].start.distanceTo(reference[index].start)).toBeLessThan(1e-10)
      expect(actual[index].end.distanceTo(reference[index].end)).toBeLessThan(1e-10)
      expect(actual[index].radius).toBe(reference[index].radius)
    }
  }
  avatar.dispose()
})

test('team changes update gameplay identity and the spawn shield before a model loads', () => {
  const avatar = createAvatar('a', 'Team Material')
  const shield = avatar.object.getObjectByName('avatar-shield') as Mesh
  avatar.setTeam('b')
  expect(avatar.hittable().team).toBe('b')
  expect((shield.material as MeshStandardMaterial).color.getHex()).toBe(TEAMS.b.colorHex)
  avatar.dispose()
})

test('paint is not left floating while a character is loading', () => {
  const avatar = createAvatar('a', 'Loading')
  const before = meshCount(avatar.object)
  avatar.addSplat(new Vector3(0, 1.53, -0.22), null, TEAMS.b.colorHex)
  expect(meshCount(avatar.object)).toBe(before)
  avatar.dispose()
})

test('death and spawn work before the character finishes loading', () => {
  const avatar = createAvatar('a', 'Lifecycle')
  expect(() => avatar.die(TEAMS.b.colorHex)).not.toThrow()
  expect(avatar.hittable().alive).toBe(false)
  expect(() => avatar.spawn()).not.toThrow()
  expect(avatar.hittable().alive).toBe(true)
  avatar.dispose()
})

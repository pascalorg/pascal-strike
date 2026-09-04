// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import {
  AnimationClip,
  Box3,
  BoxGeometry,
  Group,
  Mesh,
  QuaternionKeyframeTrack,
  Vector3,
} from 'three'
import type { DoorInfo } from '../types'
import { buildOpenDoorObstacles } from './doors'

/**
 * A door at the origin whose single leaf swings 90° about the hinge at x = -0.75, so it ends up
 * lying along -Z beside the opening — the pose the v7 front door's leaves actually rest in.
 */
function makeDoor(kind: 'door' | 'window' = 'door'): { root: Group; door: DoorInfo } {
  const root = new Group()
  const hinge = new Group()
  hinge.name = 'leaf-hinge'
  hinge.position.set(-0.75, 0, 0)
  root.add(hinge)
  // 1.5 m wide, 2 m tall, 5 cm thick, hung off the hinge so it sweeps into +X when shut.
  const leaf = new Mesh(new BoxGeometry(1.5, 2, 0.05))
  leaf.position.set(0.75, 1, 0)
  hinge.add(leaf)

  const clip = new AnimationClip('door: open', 1, [
    new QuaternionKeyframeTrack('leaf-hinge.quaternion', [0, 1], [
      0, 0, 0, 1,
      0, Math.sin(-Math.PI / 4), 0, Math.cos(-Math.PI / 4),
    ]),
  ])
  root.updateMatrixWorld(true)
  return {
    root,
    door: {
      id: 'front',
      label: 'Front',
      kind,
      node: hinge,
      clip,
      center: new Vector3(0, 1.1, 0),
      leafMeshes: [leaf],
      halfWidth: 0.75,
    },
  }
}

test('the carve sits where the leaf rests when open, not across the opening', () => {
  const { root, door } = makeDoor()
  const obstacle = buildOpenDoorObstacles(root, [door])
  expect(obstacle).not.toBeNull()

  const box = new Box3().setFromObject(obstacle!)
  // The open leaf lies along -Z off the hinge at x = -0.75, so the strip is beside the opening.
  expect(box.max.x).toBeLessThan(0)
  // ...and the middle of the doorway, where a path should run, is left alone.
  expect(box.min.x).toBeLessThan(-0.5)
  // It stands on the floor rather than floating, or recast threads a path underneath it.
  expect(box.min.y).toBeLessThanOrEqual(0.11)
  expect(box.max.y).toBeGreaterThanOrEqual(2)
})

test('the strip is padded past the walkable radius so a real capsule clears the panel', () => {
  const { root, door } = makeDoor()
  const box = new Box3().setFromObject(buildOpenDoorObstacles(root, [door])!)
  // A 5 cm panel plus 0.12 m on each side: enough that a 0.3 m capsule planned against the
  // 0.22 m walkable radius still misses it.
  const thickness = box.max.x - box.min.x
  expect(thickness).toBeGreaterThan(0.05 + 0.2)
  expect(thickness).toBeLessThan(0.05 + 0.5)
})

test('sampling the open pose leaves the door closed again', () => {
  const { root, door } = makeDoor()
  const before = door.node.quaternion.clone()
  const leafBefore = new Box3().setFromObject(door.leafMeshes[0])
  buildOpenDoorObstacles(root, [door])
  root.updateMatrixWorld(true)

  expect(door.node.quaternion.angleTo(before)).toBeLessThan(1e-6)
  const leafAfter = new Box3().setFromObject(door.leafMeshes[0])
  expect(leafAfter.min.distanceTo(leafBefore.min)).toBeLessThan(1e-6)
  expect(leafAfter.max.distanceTo(leafBefore.max)).toBeLessThan(1e-6)
})

test('windows are left out: a sash swings where nobody walks', () => {
  const { root, door } = makeDoor('window')
  expect(buildOpenDoorObstacles(root, [door])).toBeNull()
  expect(buildOpenDoorObstacles(root, [])).toBeNull()
})

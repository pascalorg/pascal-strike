// @ts-ignore Bun provides this runtime module; the project has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { Box3, Object3D, Vector2, Vector3 } from 'three'
import type { MapData, WorldQuery, ZoneInfo } from '../types'
import { resolveSpawns } from './spawns'

function zone(team: string, x: number, z: number): ZoneInfo {
  return {
    id: `${team}-${z}`, label: `Spawn ${team}`, color: '#ffffff', levelId: null,
    node: new Object3D(), floorY: 0, centroid: new Vector3(x + 1, 0, z + 1),
    polygon: [[x, z], [x + 2, z], [x + 2, z + 2], [x, z + 2]]
      .map(([px, pz]) => new Vector2(px, pz)),
  }
}

test('multiple spawn areas per team all contribute, with deterministic positions', () => {
  const map = {
    bounds: new Box3(new Vector3(-15, 0, -15), new Vector3(15, 3, 15)),
    zones: [zone('A', 10, 3), zone('A', 10, -5), zone('B', -12, 3), zone('B', -12, -5)],
  } as MapData
  const floor = new Object3D()
  const world: WorldQuery = {
    raycast(origin, direction, maxDistance) {
      if (direction.y >= 0 || origin.y > maxDistance) return null
      return { point: new Vector3(origin.x, 0, origin.z), normal: new Vector3(0, 1, 0),
        distance: origin.y, object: floor, kind: 'static' }
    },
    lineOfSight: () => true,
  }
  const spawns = resolveSpawns(map, world)
  expect(spawns.source).toBe('zones')
  for (const team of ['a', 'b'] as const) {
    expect(spawns[team]).toHaveLength(12)
    expect(spawns[team].filter((s) => s.position.z > 0)).toHaveLength(6)
    expect(spawns[team].filter((s) => s.position.z < 0)).toHaveLength(6)
    expect(spawns[team].every((s) => team === 'a' ? s.position.x > 0 : s.position.x < 0)).toBe(true)
  }
  expect(resolveSpawns(map, world)).toEqual(spawns)
})

// @ts-ignore Bun test runtime.
import { expect, test } from 'bun:test'
import { Bone, Float32BufferAttribute, Group, MeshStandardMaterial, PlaneGeometry, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three'
import { createCharacterPaint } from './paint-surface'

function fixture() {
  const geometry = new PlaneGeometry(2, 2, 16, 16), position = geometry.getAttribute('position')
  const indices: number[] = [], weights: number[] = []
  for (let i = 0; i < position.count; i++) {
    const weight = (position.getY(i) + 1) / 2
    indices.push(0, 1, 0, 0); weights.push(1 - weight, weight, 0, 0)
  }
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(indices, 4))
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4))
  const model = new Group(), mesh = new SkinnedMesh(geometry, new MeshStandardMaterial())
  const lower = new Bone(), upper = new Bone(); lower.add(upper); mesh.add(lower); model.add(mesh)
  mesh.bind(new Skeleton([lower, upper])); model.updateMatrixWorld(true)
  return { model, mesh, upper }
}

test('paint stays exactly on the outfit through joint bending and transformed parents', () => {
  const { model, mesh, upper } = fixture()
  const surface = createCharacterPaint({ model })
  const material = new MeshStandardMaterial()
  const paint = surface.project(new Vector3(0, 0, 1), new Vector3(0, 0, -1), 2, .3, .2, material)!
  expect(paint).toBeDefined()
  expect(paint.geometry.getAttribute('position').count).toBeGreaterThan(0)
  expect(paint.geometry.getAttribute('position').count).toBeLessThan(mesh.geometry.index!.count)
  const patch = paint.geometry.getAttribute('position'), original = mesh.geometry.getAttribute('position')
  for (let frame = 0; frame < 12; frame++) {
    upper.rotation.set(frame * .08, frame * .025, frame * -.02)
    model.rotation.y = frame * .12; model.position.set(2, .3, -1); model.scale.setScalar(.7)
    model.updateMatrixWorld(true)
    for (let i = 0; i < patch.count; i++) {
      const index = Array.from({ length: original.count }, (_, j) => j).find(j =>
        original.getX(j) === patch.getX(i) && original.getY(j) === patch.getY(i) && original.getZ(j) === patch.getZ(i))!
      const expected = mesh.getVertexPosition(index, new Vector3()).applyMatrix4(mesh.matrixWorld)
      const actual = paint.getVertexPosition(i, new Vector3()).applyMatrix4(paint.matrixWorld)
      expect(actual.distanceTo(expected)).toBeLessThan(1e-6)
    }
  }
  paint.geometry.dispose(); mesh.geometry.dispose(); material.dispose()
})

test('posed surface queries find the real mesh and a miss creates no floating fallback', () => {
  const { model, mesh, upper } = fixture(), surface = createCharacterPaint({ model })
  upper.rotation.y = .7; model.position.set(2, 0, 0); model.updateMatrixWorld(true)
  const material = new MeshStandardMaterial()
  const point = mesh.getVertexPosition(8 * 17 + 8, new Vector3()).applyMatrix4(mesh.matrixWorld)
  const paint = surface.project(point.clone().add(new Vector3(0, 0, 2)), new Vector3(0, 0, -1), 3, .25, 0, material)
  expect(paint).toBeDefined()
  expect(surface.project(new Vector3(20, 0, 2), new Vector3(0, 0, -1), 3, .25, 0, material)).toBeUndefined()
  paint?.geometry.dispose(); mesh.geometry.dispose(); material.dispose()
})

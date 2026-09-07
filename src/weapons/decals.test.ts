// @ts-ignore Bun test runtime.
import { expect, test } from 'bun:test'
import { Euler, Mesh, PlaneGeometry, Vector3 } from 'three'
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js'
import '../map/bvh-setup'
import { createSurfaceDecal } from './decals'

function positions(geometry: PlaneGeometry | ReturnType<typeof createSurfaceDecal>) {
  const a = geometry.getAttribute('position'), rows = []
  for (let i=0;i<a.count;i++) rows.push([a.getX(i), a.getY(i), a.getZ(i)].map(v=>v.toFixed(4)).join(','))
  return rows.sort()
}

test('BVH-local decals preserve clipping on a transformed surface', () => {
  const mesh = new Mesh(new PlaneGeometry(20, 20, 80, 80))
  mesh.geometry.computeBoundsTree()
  mesh.position.set(3,2,1); mesh.rotation.set(.3,.6,.2); mesh.scale.set(2,.8,1)
  mesh.updateMatrixWorld(true)
  const point = new Vector3(.3,.2,0).applyMatrix4(mesh.matrixWorld)
  const orientation = mesh.rotation.clone(), size = new Vector3(.25,.3,.15)
  const expected = new DecalGeometry(mesh, point, orientation, size)
  const actual = createSurfaceDecal(mesh, point, orientation, size)
  expect(actual.getAttribute('position').count).toBeGreaterThan(0)
  expect(positions(actual)).toEqual(positions(expected))
  expected.dispose(); actual.dispose(); mesh.geometry.dispose()
})

test('small non-BVH surfaces still receive decals', () => {
  const mesh = new Mesh(new PlaneGeometry(2,2)); mesh.updateMatrixWorld(true)
  const result = createSurfaceDecal(mesh,new Vector3(),new Euler(),new Vector3(.2,.2,.1))
  expect(result.getAttribute('position').count).toBeGreaterThan(0)
  result.dispose();mesh.geometry.dispose()
})

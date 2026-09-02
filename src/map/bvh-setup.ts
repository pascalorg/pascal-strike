/**
 * Side-effect module: patch three's prototypes with three-mesh-bvh once (W1-A).
 *
 * Import it (`import './bvh-setup'`) from anywhere that builds or queries a BVH. It is
 * idempotent, so importing it from several modules is safe.
 */
import { BufferGeometry, Mesh } from 'three'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'

let installed = false

export function installBVH(): void {
  if (installed) return
  installed = true
  BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
  BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
  Mesh.prototype.raycast = acceleratedRaycast
}

installBVH()

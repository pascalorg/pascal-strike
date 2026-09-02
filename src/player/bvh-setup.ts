import { BufferGeometry, Mesh } from 'three'
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh'

/** Install three-mesh-bvh's prototype helpers once for every W1-B entry point. */
export function ensureBvhSetup(): void {
  if (BufferGeometry.prototype.computeBoundsTree === undefined) {
    BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
    BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
    Mesh.prototype.raycast = acceleratedRaycast
  }
}

ensureBvhSetup()

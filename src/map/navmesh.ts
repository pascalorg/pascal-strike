/**
 * Recast navmesh for bot pathfinding (W1-A).
 *
 * `NAVMESH` in config.ts is expressed in metres; recast wants voxel counts for the walkable
 * radius/height/climb, so they are converted against the cell size / cell height here.
 */
import { Object3D, Vector3 } from 'three'
import { init as initRecast, NavMeshQuery, type NavMesh } from '@recast-navigation/core'
import { NavMeshHelper, threeToSoloNavMesh } from '@recast-navigation/three'
import { NAVMESH } from '../config'
import type { MapData, Navigation } from '../types'

/** Navigation plus the raw recast handles the debug helper needs. */
export interface MapNavigation extends Navigation {
  navMesh: NavMesh | null
  query: NavMeshQuery | null
  /**
   * Like `closestPoint`, but returns null when the point is not on the navmesh at all.
   * `Navigation.closestPoint` has to return *something*, which makes it useless for asking
   * "is this point reachable?" — spawns.ts needs that distinction.
   */
  snapToNavmesh(p: Vector3): Vector3 | null
  dispose(): void
}

let recastReady: Promise<void> | null = null

function ensureRecast(): Promise<void> {
  if (!recastReady) recastReady = initRecast()
  return recastReady
}

export async function buildNavigation(map: MapData): Promise<MapNavigation> {
  const fallbackCenter = map.bounds.getCenter(new Vector3())

  try {
    await ensureRecast()
  } catch (err) {
    console.warn('[navmesh] recast-navigation failed to initialise', err)
    return createFallback(fallbackCenter)
  }

  let navMesh: NavMesh | undefined
  try {
    const result = threeToSoloNavMesh(map.navMeshSource, {
      cs: NAVMESH.cs,
      ch: NAVMESH.ch,
      walkableRadius: Math.ceil(NAVMESH.walkableRadius / NAVMESH.cs),
      walkableHeight: Math.ceil(NAVMESH.walkableHeight / NAVMESH.ch),
      walkableClimb: Math.ceil(NAVMESH.walkableClimb / NAVMESH.ch),
      walkableSlopeAngle: NAVMESH.walkableSlopeAngle,
    })
    if (!result.success || !result.navMesh) {
      console.warn('[navmesh] generation failed:', result.success ? 'no navmesh' : result.error)
      return createFallback(fallbackCenter)
    }
    navMesh = result.navMesh
  } catch (err) {
    console.warn('[navmesh] generation threw', err)
    return createFallback(fallbackCenter)
  }

  const query = new NavMeshQuery(navMesh)

  const snapToNavmesh = (p: Vector3): Vector3 | null => {
    const result = query.findClosestPoint(p)
    if (!result.success) return null
    return new Vector3(result.point.x, result.point.y, result.point.z)
  }

  return {
    ready: true,
    navMesh,
    query,

    findPath(from: Vector3, to: Vector3): Vector3[] {
      const result = query.computePath(from, to)
      if (!result.success || result.path.length === 0) return []
      return result.path.map((p) => new Vector3(p.x, p.y, p.z))
    },

    randomPoint(): Vector3 {
      const result = query.findRandomPoint()
      if (!result.success) return fallbackCenter.clone()
      const p = result.randomPoint
      return new Vector3(p.x, p.y, p.z)
    },

    randomPointAround(center: Vector3, radius: number): Vector3 {
      const result = query.findRandomPointAroundCircle(center, radius)
      if (!result.success) return center.clone()
      const p = result.randomPoint
      return new Vector3(p.x, p.y, p.z)
    },

    closestPoint(p: Vector3): Vector3 {
      return snapToNavmesh(p) ?? p.clone()
    },

    snapToNavmesh,

    dispose() {
      query.destroy()
      navMesh?.destroy()
    },
  }
}

/** Straight-line stand-in so bots keep working (badly) when recast is unavailable. */
function createFallback(center: Vector3): MapNavigation {
  return {
    ready: false,
    navMesh: null,
    query: null,
    findPath: (from, to) => [from.clone(), to.clone()],
    randomPoint: () => center.clone(),
    randomPointAround: (c) => c.clone(),
    closestPoint: (p) => p.clone(),
    snapToNavmesh: () => null,
    dispose: () => {},
  }
}

/** Orange translucent overlay of the walkable polygons (debug viewer only). */
export function createNavMeshHelper(nav: MapNavigation): Object3D | null {
  if (!nav.navMesh) return null
  const helper = new NavMeshHelper(nav.navMesh)
  helper.name = 'navmesh-helper'
  helper.position.y += 0.02 // lift off the floor so it does not z-fight
  return helper
}

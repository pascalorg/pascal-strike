/**
 * GLB → MapData (W1-A).
 *
 * Works for Pascal exports (levels/zones/spawns/doors from glTF extras) and for a plain GLB from
 * anywhere — the latter simply produces empty registries and one big static collider.
 */
import { Box3, FrontSide, Group, Material, Mesh, Object3D, Vector3 } from 'three'
import { loadGltf, type Loaders } from '../engine/loaders'
import { buildStaticCollider, createWorldQuery, DOWN } from './collider'
import { parsePascalScene } from './map-parse'
import type { MapData, ZoneInfo } from '../types'

export interface LoadMapOptions {
  name?: string
}

const _origin = new Vector3()

export async function loadMap(
  source: string | File,
  loaders: Loaders,
  opts?: LoadMapOptions,
): Promise<MapData> {
  const bytes = typeof source === 'string' ? source : await source.arrayBuffer()
  const gltf = await loadGltf(loaders, bytes)

  const root = new Group()
  root.name = 'map'
  root.add(gltf.scene)
  root.updateMatrixWorld(true)

  const parsed = parsePascalScene(gltf)

  // Markers must never collide. The animated leaves of doors and openable windows are queried
  // separately (they move), so they are cut out of the merged static collider: players walk
  // through the opening whatever the state, bullets still stop on the leaf's own BVH.
  const excluded = new Set<Object3D>()
  for (const node of parsed.markerNodes) excluded.add(node)
  for (const node of parsed.animatedNodes) excluded.add(node)

  const collider = buildStaticCollider(root, excluded)
  const bounds = new Box3()
  if (collider.geometry.boundingBox) bounds.copy(collider.geometry.boundingBox)

  prepareMaterials(root)

  // Zone floor heights need the collider, so they are resolved here rather than in the parser.
  if (parsed.zones.length > 0) {
    const world = createWorldQuery(collider, parsed.doors)
    for (const zone of parsed.zones) resolveZoneFloor(zone, world)
  }

  return {
    name: opts?.name ?? deriveName(source),
    root,
    levels: parsed.levels,
    zones: parsed.zones,
    spawnNodes: parsed.spawnNodes,
    doors: parsed.doors,
    collider,
    bounds,
    navMeshSource: [collider.mesh],
  }
}

function resolveZoneFloor(zone: ZoneInfo, world: ReturnType<typeof createWorldQuery>): void {
  _origin.set(zone.centroid.x, zone.floorY + 1.0, zone.centroid.z)
  const hit = world.raycast(_origin, DOWN, 4)
  if (hit && Math.abs(hit.normal.y) > 0.5) {
    zone.floorY = hit.point.y
    zone.centroid.y = hit.point.y
  }
}

function prepareMaterials(root: Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh) return
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.frustumCulled = true

    const material = mesh.material
    if (Array.isArray(material)) {
      for (const m of material) applySide(m)
    } else if (material) {
      applySide(material)
    }
  })
}

function applySide(material: Material): void {
  // Transparent surfaces (window glass) keep whatever the exporter chose so they read from both
  // sides; everything else renders single-sided, which is cheaper and shadows better.
  if (!material.transparent) material.side = FrontSide
}

function deriveName(source: string | File): string {
  if (typeof source !== 'string') return stripExtension(source.name)
  try {
    const url = new URL(source, location.href)
    const last = url.pathname.split('/').pop()
    return last ? stripExtension(decodeURIComponent(last)) : 'map'
  } catch {
    const last = source.split('/').pop()
    return last ? stripExtension(last) : 'map'
  }
}

function stripExtension(name: string): string {
  return name.replace(/\.glb$/i, '')
}

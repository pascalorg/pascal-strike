/**
 * GLB → MapData (W1-A).
 *
 * Works for Pascal exports (levels/zones/spawns/doors from glTF extras) and for a plain GLB from
 * anywhere — the latter simply produces empty registries and one big static collider.
 */
import {
  Box3,
  Color,
  FrontSide,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three'
import { loadGltf, type Loaders } from '../engine/loaders'
import { batchOpenableLeaves, batchStaticMeshes } from './batch'
import {
  attachBreakables,
  buildStaticColliders,
  createWorldQuery,
  DOWN,
  ensureBoundsTrees,
} from './collider'
import { parsePascalScene } from './map-parse'
import type { MapData, ZoneInfo } from '../types'

export interface LoadMapOptions {
  name?: string
  /**
   * Merge the visible static meshes by material into one mesh each (default true). Pascal keeps
   * every wall course, tile and roof shingle as its own node — thousands of ~30-triangle draw
   * calls. `?nobatch=1` in the map viewer turns it off to compare.
   */
  batchStatic?: boolean
  /**
   * Give the terrain a grass-like albedo (default true). Pascal exports the lot as a 30 m
   * near-white plane, which under the sky environment reads as a snowfield; any very large, flat
   * mesh (see `isTerrain`) gets its colour multiplied toward `GRASS_TINT`, maps left alone.
   */
  tintTerrain?: boolean
}

const _origin = new Vector3()
const _box = new Box3()
const _size = new Vector3()

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

  // Two colliders, one traversal (see collider.ts): players never pass a window, open or shut,
  // while paintballs go through an open sash and meet a closed one on its own moving BVH.
  const glassMeshes = new Set(parsed.glassPanes.map((pane) => pane.mesh))
  const colliders = buildStaticColliders(root, {
    markers: parsed.markerNodes,
    doorLeaves: parsed.doorLeafNodes,
    windowLeaves: parsed.windowLeafNodes,
    glass: glassMeshes,
    roofs: parsed.roofNodes,
  })
  const collider = colliders.movement
  const bounds = new Box3()
  if (collider.geometry.boundingBox) bounds.copy(collider.geometry.boundingBox)

  prepareMaterials(root, opts?.tintTerrain !== false)

  // Batch after the materials are final (the batches reuse the very same instances) and after
  // the colliders are baked (they read the original meshes' world matrices).
  if (opts?.batchStatic !== false) {
    batchStaticMeshes(root, [
      parsed.markerNodes,
      parsed.doorLeafNodes,
      parsed.windowLeafNodes,
      glassMeshes,
    ])
    // Then the openables, each merge staying inside one animated node so it still swings.
    // This rewrites `leafMeshes`, so it has to run before anything builds their BVHs.
    batchOpenableLeaves(parsed.doors, [parsed.doorLeafNodes, parsed.windowLeafNodes], glassMeshes)
  }

  // Every mesh queried at runtime rather than baked gets its bounds tree now: door leaves and
  // sashes (bullets, and the controller's dynamic colliders) and the panes (the shatter ray).
  const dynamic = new Set<Mesh>(parsed.glassPanes.map((pane) => pane.mesh))
  for (const door of parsed.doors) for (const leaf of door.leafMeshes) dynamic.add(leaf)
  ensureBoundsTrees(dynamic)
  // So a caller holding only the collider (the map session builds its own query) still gets glass.
  attachBreakables(colliders.bullet, parsed.glassPanes)

  // Zone floor heights need the collider, so they are resolved here rather than in the parser.
  if (parsed.zones.length > 0) {
    const world = createWorldQuery(colliders.bullet, parsed.doors, parsed.glassPanes)
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
    bulletCollider: colliders.bullet,
    breakables: parsed.glassPanes,
    bounds,
    // Movement geometry minus roofs: recast cannot cut a path through a window, and cannot
    // hand the bots a roof pitch to roam on either.
    navMeshSource: [colliders.navSource],
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

/**
 * Roughness floor for non-metals (W5-C). Pascal exports textured surfaces at roughness 0.5,
 * which under a sky environment map turns stone and plaster into wet plastic: a broad specular
 * sheen that hides the albedo and crawls as the player walks. Metals (handles, hinges) keep
 * their own roughness — they are supposed to shine.
 */
const MIN_ROUGHNESS = 0.55
const METAL_THRESHOLD = 0.3
/** How much of `scene.environment` a map material takes. 1 = whatever the environment says. */
const ENV_MAP_INTENSITY = 1

/** World extent on X and Z past which a flat mesh is the lot, not a floor slab. */
const TERRAIN_MIN_EXTENT = 20
const TERRAIN_MAX_THICKNESS = 1
/** Dry lawn. Multiplied into the terrain's colour, so a textured lot keeps its map. */
const GRASS_TINT = new Color(0x7f8f5a)

function prepareMaterials(root: Object3D, tintTerrain: boolean): void {
  const grass = new Map<Material, Material>()
  root.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh) return
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.frustumCulled = true

    // The lot gets its own material instance: the export may share the plain one with a slab.
    if (tintTerrain && isTerrain(mesh)) {
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((m) => grassMaterial(m, grass))
        : grassMaterial(mesh.material, grass)
    }

    const material = mesh.material
    if (Array.isArray(material)) {
      for (const m of material) prepareMaterial(m)
    } else if (material) {
      prepareMaterial(material)
    }
  })
}

function prepareMaterial(material: Material): void {
  applySide(material)

  const standard = material as MeshStandardMaterial
  if (!standard.isMeshStandardMaterial) return
  standard.envMapIntensity = ENV_MAP_INTENSITY
  // Glass keeps its mirror finish; everything else gets the matte floor.
  if (!standard.transparent && (standard.metalness ?? 0) < METAL_THRESHOLD) {
    standard.roughness = Math.max(standard.roughness ?? 1, MIN_ROUGHNESS)
  }
}

/** A very large, flat mesh in world space: Pascal's 30 m lot, not a floor slab or a wall. */
function isTerrain(mesh: Mesh): boolean {
  const geometry = mesh.geometry
  if (!geometry.boundingBox) geometry.computeBoundingBox()
  if (!geometry.boundingBox) return false
  _box.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld).getSize(_size)
  return _size.x > TERRAIN_MIN_EXTENT && _size.z > TERRAIN_MIN_EXTENT && _size.y < TERRAIN_MAX_THICKNESS
}

function grassMaterial(source: Material, cache: Map<Material, Material>): Material {
  const cached = cache.get(source)
  if (cached) return cached
  const standard = source as MeshStandardMaterial
  if (!standard.isMeshStandardMaterial) return source
  const tinted = standard.clone()
  tinted.name = `${standard.name || 'terrain'} (grass)`
  tinted.color.multiply(GRASS_TINT)
  tinted.roughness = 1
  tinted.metalness = 0
  cache.set(source, tinted)
  return tinted
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

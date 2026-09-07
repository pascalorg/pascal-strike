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
  Scene,
  Vector3,
} from 'three'
import { loadGltf, type Loaders } from '../engine/loaders'
import { BUILTIN_MAPS } from '../config'
import { batchOpenableLeaves, batchStaticMeshes, isTransparentMaterial } from './batch'
import { buildOpenDoorObstacles } from './doors'

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
   * Give the terrain a grass-like albedo (default true, unless disabled for a built-in map).
   * Pascal exports the lot as a 30 m
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

  const tintTerrain = opts?.tintTerrain
    ?? BUILTIN_MAPS.find((map) => map.url === source)?.tintTerrain
    ?? true
  const matte = prepareMaterials(root, tintTerrain, glassMeshes)

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
  // The batches are the meshes that actually render, so the hook goes on after batching.
  clampEnvironment(root, matte)

  // Every mesh queried at runtime rather than baked gets its bounds tree now: door leaves and
  // sashes (bullets, and the controller's dynamic colliders) and the panes (the shatter ray).
  const dynamic = new Set<Mesh>(parsed.glassPanes.map((pane) => pane.mesh))
  for (const door of parsed.doors) for (const leaf of door.leafMeshes) dynamic.add(leaf)
  ensureBoundsTrees(dynamic)
  // So a caller holding only the collider (the map session builds its own query) still gets glass.
  attachBreakables(colliders.bullet, parsed.glassPanes)

  // After batching (it rewrites `leafMeshes`) and after the colliders are baked: this swings
  // every door open for a moment to read where its leaves land, then puts them back.
  const openLeaves = buildOpenDoorObstacles(root, parsed.doors)

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
    // hand the bots a roof pitch to roam on either. Plus the strips where open door leaves come
    // to rest, so a path never runs through a panel that is solid but not in the collider.
    navMeshSource: openLeaves ? [colliders.navSource, openLeaves] : [colliders.navSource],
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
/**
 * The textured ones — stone, plaster, wood — go further: at 0.55 a wall still carries a chromed
 * sky reflection at grazing angles, and 0.8 is where it starts to read as masonry.
 */
const MIN_ROUGHNESS_TEXTURED = 0.8
const METAL_THRESHOLD = 0.3
/**
 * How much of the scene's environment a textured non-metal takes, relative to
 * `scene.environmentIntensity`. Glass and metal keep the full sky. In three's node materials a
 * per-material `envMapIntensity` only counts once `material.envMap` is set (otherwise the scene
 * intensity wins outright), which is what `clampEnvironment` arranges.
 */
const TEXTURED_ENV_SCALE = 0.6

/** World extent on X and Z past which a flat mesh is the lot, not a floor slab. */
const TERRAIN_MIN_EXTENT = 20
const TERRAIN_MAX_THICKNESS = 1
/** Dry lawn. Multiplied into the terrain's colour, so a textured lot keeps its map. */
const GRASS_TINT = new Color(0x7f8f5a)

/**
 * Shadow flags, sidedness, the roughness floors and the terrain tint, in one traversal. Returns
 * the textured non-metals, which `clampEnvironment` hooks up after batching.
 */
function prepareMaterials(root: Object3D, tintTerrain: boolean, glassMeshes: Set<Mesh>): Set<MeshStandardMaterial> {
  const matte = new Set<MeshStandardMaterial>()
  const grass = new Map<Material, Material>()
  root.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    // Light must pass through glass whether intact or broken, including furniture glazing.
    mesh.castShadow = !glassMeshes.has(mesh) && !materials.some(isTransparentMaterial)
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
      for (const m of material) prepareMaterial(m, matte)
    } else if (material) {
      prepareMaterial(material, matte)
    }
  })
  return matte
}

function prepareMaterial(material: Material, matte: Set<MeshStandardMaterial>): void {
  applySide(material)

  const standard = material as MeshStandardMaterial
  if (!standard.isMeshStandardMaterial) return
  // Glass keeps its mirror finish; everything else gets the matte floor.
  if (!standard.transparent && (standard.metalness ?? 0) < METAL_THRESHOLD) {
    const textured = !!standard.map
    standard.roughness = Math.max(
      standard.roughness ?? 1,
      textured ? MIN_ROUGHNESS_TEXTURED : MIN_ROUGHNESS,
    )
    if (textured) matte.add(standard)
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

/**
 * Give every mesh drawn with a textured non-metal a hook that mirrors `scene.environment` into
 * `material.envMap` — the only way the node materials honour a per-material intensity — at
 * `TEXTURED_ENV_SCALE` of the scene's own. Runs on the batches, not the meshes they replaced.
 * The environment is baked after the map loads (and re-baked once), so this follows the scene
 * rather than capturing a texture.
 */
function clampEnvironment(root: Object3D, matte: Set<MeshStandardMaterial>): void {
  if (matte.size === 0) return
  const sync = (
    _renderer: unknown,
    scene: Scene,
    _camera: unknown,
    _geometry: unknown,
    material: Material,
  ): void => {
    const standard = material as MeshStandardMaterial
    if (!matte.has(standard)) return
    const environment = scene.environment
    if (standard.envMap !== environment) {
      standard.envMap = environment
      standard.needsUpdate = true
    }
    standard.envMapIntensity = scene.environmentIntensity * TEXTURED_ENV_SCALE
  }
  root.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh || !mesh.visible) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    if (!materials.some((m) => matte.has(m as MeshStandardMaterial))) return
    mesh.onBeforeRender = sync
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

/**
 * Everything that belongs to ONE loaded map (W2).
 *
 * The room, the registry and the HUD outlive a map change; this does not. When the host picks
 * a different map every client disposes its session and builds a new one, so all the GPU
 * resources of the old house (geometry, textures, decals, navmesh) go away in one call.
 */
import { Material, Mesh, Object3D, Texture, Vector3 } from 'three'
import type { Audio } from '../engine/audio'
import { createEnvironment, type EnvironmentRig } from '../engine/environment'
import type { Loaders } from '../engine/loaders'
import type { Engine } from '../engine/renderer'
import { createWorldQuery } from '../map/collider'
import { createDoorSystem, type DoorSystem } from '../map/doors'
import { loadMap } from '../map/map-loader'
import { buildNavigation, type MapNavigation } from '../map/navmesh'
import { resolveSpawns } from '../map/spawns'
import type { MapData, MapSelection, SpawnLayout, SpawnPoint, TeamId, WorldQuery } from '../types'
import { registerDynamicColliders } from '../player/dynamic-colliders'
import { createDecals, type Decals } from '../weapons/decals'
import { createEffects, type Effects } from '../weapons/effects'
import { createProjectiles, type Projectiles } from '../weapons/projectiles'

export interface MapSessionOptions {
  engine: Engine
  loaders: Loaders
  selection: MapSelection
  audio: Audio
  /** 0..1 while the GLB downloads, then 1 once the map is parsed. */
  onProgress?: (progress: number, label: string) => void
}

export interface MapSession {
  selection: MapSelection
  map: MapData
  world: WorldQuery
  doors: DoorSystem
  /** Re-derived (better) once the navmesh exists — read it through the session, never cache it. */
  spawns: SpawnLayout
  /** Null until recast has finished; `navReady` resolves with it. */
  nav: MapNavigation | null
  navReady: Promise<MapNavigation | null>
  decals: Decals
  effects: Effects
  projectiles: Projectiles
  environment: EnvironmentRig
  /**
   * Door leaves and window sashes: the moving obstacles a `CharacterController` collides with
   * (`setDynamicColliders`). They are not in `map.collider`, which is baked once.
   */
  dynamicColliders: Mesh[]
  /** A spawn point of `team` as far as possible from everyone currently standing around. */
  leastCrowdedSpawn(team: TeamId, occupied: ArrayLike<Vector3>): SpawnPoint | null
  dispose(): void
}

const _candidate = new Vector3()

export async function createMapSession(opts: MapSessionOptions): Promise<MapSession> {
  const { engine, loaders, selection, audio } = opts
  opts.onProgress?.(0, `Downloading ${selection.name}`)

  const source = await fetchAsFile(selection, (p) =>
    opts.onProgress?.(p * 0.75, `Downloading ${selection.name}`),
  )
  opts.onProgress?.(0.78, 'Building the house')
  // Yield once so the overlay repaints before the (blocking) parse + BVH build.
  await nextFrame()

  const map = await loadMap(source, loaders, { name: selection.name })
  engine.scene.add(map.root)
  opts.onProgress?.(0.9, 'Baking colliders')
  await nextFrame()

  // The BULLET collider: paintballs go through an open window sash, players never do.
  const world = createWorldQuery(map.bulletCollider ?? map.collider, map.doors)
  const doors = createDoorSystem(map)

  // The movement collider has no door leaves and no window sashes in it: they swing, so the
  // controller has to meet them where they currently are. `local-player.ts` builds its
  // controller straight from `session.map.collider` and there is no seam to pass them through,
  // so they are registered against that collider — every controller built on it (the local
  // player's, and the fresh one a map change makes) picks them up.
  const dynamicColliders: Mesh[] = []
  for (const door of map.doors) for (const leaf of door.leafMeshes) dynamicColliders.push(leaf)
  registerDynamicColliders(map.collider.geometry, dynamicColliders)
  const environment = createEnvironment(engine, map.bounds)
  const decals = createDecals(engine.scene)
  const effects = createEffects(engine.scene)
  const projectiles = createProjectiles(engine.scene, world, decals, effects, audio)

  // Spawns are resolved twice on purpose: once now (no navmesh, so the game is playable the
  // moment the map is up) and once when recast is ready, which filters out points bots could
  // never reach. Only the host reads the layout, so swapping it mid-match is harmless.
  let disposed = false
  const session: MapSession = {
    selection,
    map,
    world,
    doors,
    spawns: resolveSpawns(map, world),
    nav: null,
    navReady: Promise.resolve(null),
    decals,
    effects,
    projectiles,
    environment,
    dynamicColliders,
    leastCrowdedSpawn(team, occupied) {
      const points = session.spawns[team]
      if (!points || points.length === 0) return null
      let best: SpawnPoint | null = null
      let bestScore = -Infinity
      for (const point of points) {
        let nearest = Infinity
        for (let i = 0; i < occupied.length; i++) {
          const other = occupied[i]
          if (!other) continue
          _candidate.copy(point.position).sub(other)
          const d2 = _candidate.lengthSq()
          if (d2 < nearest) nearest = d2
        }
        if (nearest > bestScore) {
          bestScore = nearest
          best = point
        }
      }
      return best
    },
    dispose() {
      // Called from `changeMap` and again from `game.dispose()` on the way out; freeing the
      // recast handles twice would take the WASM heap with it.
      if (disposed) return
      disposed = true
      projectiles.dispose()
      decals.dispose()
      effects.dispose()
      doors.dispose()
      environment.dispose()
      engine.scene.remove(map.root)
      disposeTree(map.root)
      map.collider.geometry.dispose()
      ;(map.collider.mesh.material as Material).dispose()
      map.collider.mesh.removeFromParent()
      session.nav?.dispose()
    },
  }

  opts.onProgress?.(1, 'Ready')

  session.navReady = buildNavigation(map)
    .then((nav) => {
      if (disposed) {
        nav.dispose()
        return null
      }
      session.nav = nav
      if (nav.ready) {
        session.spawns = resolveSpawns(map, world, nav)
      }
      return nav
    })
    .catch((err) => {
      console.warn('[map-session] navmesh build failed', err)
      return null
    })

  return session
}

/**
 * Download the GLB ourselves so the loading bar is real. `loadMap` accepts a `File`, so the
 * bytes go straight into `GLTFLoader.parse` — no second request. Any failure (CORS, no
 * streaming body) falls back to letting the loader fetch the URL itself.
 */
async function fetchAsFile(
  selection: MapSelection,
  onProgress: (p: number) => void,
): Promise<string | File> {
  try {
    const response = await fetch(selection.url)
    if (!response.ok || !response.body) return selection.url
    const total = Number(response.headers.get('content-length') ?? 0)
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value)
      received += value.byteLength
      if (total > 0) onProgress(Math.min(1, received / total))
    }
    onProgress(1)
    const blob = new Blob(chunks as BlobPart[], { type: 'model/gltf-binary' })
    return new File([blob], `${selection.id || 'map'}.glb`, { type: 'model/gltf-binary' })
  } catch (err) {
    console.warn('[map-session] streaming download failed, letting the loader fetch it', err)
    return selection.url
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/** Free every GPU resource under a subtree (a map root can hold ~100 MB of KTX2 textures). */
function disposeTree(root: Object3D): void {
  const materials = new Set<Material>()
  root.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose()
    const material = mesh.material
    if (Array.isArray(material)) for (const m of material) materials.add(m)
    else if (material) materials.add(material)
  })
  for (const material of materials) {
    for (const value of Object.values(material as unknown as Record<string, unknown>)) {
      const texture = value as Texture | null
      if (texture && (texture as Texture).isTexture) texture.dispose()
    }
    material.dispose()
  }
  root.removeFromParent()
}

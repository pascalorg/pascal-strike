/**
 * Lighting, sky and image-based environment (W1-A).
 *
 * One hemisphere fill + one shadow-casting sun. The sun's orthographic shadow frustum is fitted
 * to the map bounds but re-centred on the player every frame, so a big terrain plane does not
 * blow the shadow texel budget.
 */
import {
  Box3,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Vector3,
  type Texture,
} from 'three'
import { PMREMGenerator } from 'three/webgpu'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { Engine } from './renderer'

/** Direction from the ground toward the sun (unit). */
const SUN_DIR = new Vector3(0.55, 0.86, 0.42).normalize()
const SKY_COLOR = 0xb9cde2
const SUN_COLOR = 0xfff2e0

/** Cap so a 30 x 30 m terrain does not stretch the 2048 shadow map too thin. */
const MAX_SHADOW_EXTENT = 26

// Module scratch — no per-frame allocation.
const _size = new Vector3()
const _center = new Vector3()
const _clamped = new Vector3()
const _boundsMin = new Vector3()
const _boundsMax = new Vector3()

export interface EnvironmentRig {
  sun: DirectionalLight
  hemi: HemisphereLight
  /** Re-centre the shadow frustum. Call once per frame with the local player's feet position. */
  update(playerPos: Vector3): void
  dispose(): void
}

export function createEnvironment(engine: Engine, bounds: Box3): EnvironmentRig {
  const { scene } = engine

  const box = bounds.isEmpty()
    ? new Box3(new Vector3(-10, 0, -10), new Vector3(10, 5, 10))
    : bounds.clone()
  box.getSize(_size)
  box.getCenter(_center)
  _boundsMin.copy(box.min)
  _boundsMax.copy(box.max)

  const sky = new Color(SKY_COLOR)
  scene.background = sky
  scene.fog = new Fog(sky.getHex(), 30, Math.max(80, Math.max(_size.x, _size.z) * 3 + 40))

  const hemi = new HemisphereLight(0xdfe8ff, 0x8a7a66, 0.9)
  hemi.position.set(0, 1, 0)
  scene.add(hemi)

  const sun = new DirectionalLight(SUN_COLOR, 2.2)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.bias = -0.0005
  sun.shadow.normalBias = 0.02

  const extent = Math.min(Math.max(_size.x, _size.z) * 0.5 + 4, MAX_SHADOW_EXTENT)
  const cam = sun.shadow.camera
  cam.left = -extent
  cam.right = extent
  cam.top = extent
  cam.bottom = -extent
  cam.near = 0.5
  const sunDistance = extent * 2 + _size.y + 10
  cam.far = sunDistance * 2 + _size.y
  cam.updateProjectionMatrix()

  sun.position.copy(_center).addScaledVector(SUN_DIR, sunDistance)
  sun.target.position.copy(_center)
  scene.add(sun)
  scene.add(sun.target)

  // RoomEnvironment gives PBR materials something to reflect indoors. PMREMGenerator from
  // three/webgpu works with WebGPURenderer once `renderer.init()` has resolved.
  const pmrem = new PMREMGenerator(engine.renderer)
  const room = new RoomEnvironment()
  let envTexture: Texture | null = null
  try {
    const target = pmrem.fromScene(room, 0.04)
    envTexture = target.texture
    scene.environment = envTexture
    scene.environmentIntensity = 0.55
  } catch (err) {
    console.warn('[environment] PMREM generation failed, falling back to lights only', err)
  } finally {
    room.dispose()
  }

  function update(playerPos: Vector3) {
    // Keep the frustum centre inside the map so the sun never leaves the world behind.
    _clamped.set(
      clamp(playerPos.x, _boundsMin.x, _boundsMax.x),
      clamp(playerPos.y, _boundsMin.y, _boundsMax.y),
      clamp(playerPos.z, _boundsMin.z, _boundsMax.z),
    )
    sun.target.position.copy(_clamped)
    sun.position.copy(_clamped).addScaledVector(SUN_DIR, sunDistance)
    sun.target.updateMatrixWorld()
    sun.updateMatrixWorld()
  }

  update(_center)

  return {
    sun,
    hemi,
    update,
    dispose() {
      scene.remove(sun)
      scene.remove(sun.target)
      scene.remove(hemi)
      sun.dispose()
      hemi.dispose()
      scene.environment = null
      scene.fog = null
      scene.background = null
      pmrem.dispose()
    },
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

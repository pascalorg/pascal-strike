/**
 * Lighting, sky and image-based environment (W1-A, reworked in W5-C).
 *
 * The look is a warm late afternoon: a Preetham `SkyMesh` at a low sun elevation gives the
 * backdrop, a PMREM of that same sky (plus a ground disc for the bounce) becomes
 * `scene.environment`, and one directional sun casts the shadows. The sky is the only source of
 * blue in the picture, so walls in shade read cool and sunlit walls read warm — which is what
 * makes a Pascal house look like a photograph rather than a clay model.
 *
 * The sun's orthographic shadow frustum is small (a house, not the 30 m lawn) and re-centred on
 * the player every frame, snapped to shadow texels so the edges do not crawl while walking.
 */
import {
  Box3,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Scene,
  Vector3,
  type Texture,
} from 'three'
import { PMREMGenerator } from 'three/webgpu'
import { SkyMesh } from 'three/examples/jsm/objects/SkyMesh.js'
import type { Engine } from './renderer'
import { GRAPHICS_PROFILES } from './graphics'

/**
 * Sun elevation / azimuth in degrees. 28° is late afternoon: long shadows, warm raking light on
 * the facades, and a third less irradiance on the horizontal ground than a midday sun — which
 * matters, because a Pascal lawn is nearly white and blows out first.
 */
const SUN_ELEVATION = 28
const SUN_AZIMUTH = 42
/** Direction from the ground toward the sun (unit) — derived from the two angles above. */
const SUN_DIR = new Vector3(
  Math.cos((SUN_ELEVATION * Math.PI) / 180) * Math.cos((SUN_AZIMUTH * Math.PI) / 180),
  Math.sin((SUN_ELEVATION * Math.PI) / 180),
  Math.cos((SUN_ELEVATION * Math.PI) / 180) * Math.sin((SUN_AZIMUTH * Math.PI) / 180),
).normalize()

const SUN_COLOR = 0xffe9c9
const SUN_INTENSITY = 5.5
/** Horizon tint: the fog and the fallback background match the sky at eye level. */
const HORIZON_COLOR = 0xc3d2e0
/** Warm dry grass / concrete — the lower half of the environment map, i.e. the bounce light. */
const GROUND_BOUNCE = 0xd6ccbc

const SKY = {
  turbidity: 3,
  rayleigh: 2.6,
  mieCoefficient: 0.006,
  mieDirectionalG: 0.86,
  cloudCoverage: 0.35,
  cloudDensity: 0.35,
  cloudScale: 0.00018,
  cloudSpeed: 0.00002,
  cloudElevation: 0.55,
}

/** How much of the sky/ground IBL reaches the materials. */
const ENVIRONMENT_INTENSITY = 0.42
/** Half-extent of the sun's shadow frustum, in metres. A Pascal house fits in 16 m. */
const SHADOW_EXTENT = 16
/** Box half-size of the sky dome. Must stay inside the camera far plane (corner = s·√3). */
const SKY_HALF_SIZE = 90

// Module scratch — no per-frame allocation.
const _size = new Vector3()
const _center = new Vector3()
const _clamped = new Vector3()
const _boundsMin = new Vector3()
const _boundsMax = new Vector3()
const _snap = new Vector3()
/** Light-space basis used to snap the shadow frustum to whole texels. */
const _lightRight = new Vector3()
const _lightUp = new Vector3()

export interface EnvironmentRig {
  sun: DirectionalLight
  hemi: HemisphereLight
  /** The sky dome. Follows the camera; `null` if the sky could not be built. */
  sky: SkyMesh | null
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

  // Fallback background: if the sky mesh fails to build we still get a sky-coloured frame, and
  // it costs one clear either way.
  const horizon = new Color(HORIZON_COLOR)
  scene.background = horizon
  // Just enough haze to separate the far lawn from the sky; the house itself is never fogged.
  scene.fog = new Fog(horizon.getHex(), 34, Math.max(120, Math.max(_size.x, _size.z) * 3 + 60))

  // A hint of blue-from-above / warm-from-below on top of the IBL. Kept low: the environment
  // map does the real ambient work, this only keeps deep interiors off the floor of the curve.
  const hemi = new HemisphereLight(0xd9d2c6, 0x9c8a72, 0.35)
  hemi.position.set(0, 1, 0)
  scene.add(hemi)

  let sun = new DirectionalLight(SUN_COLOR, SUN_INTENSITY)
  sun.castShadow = true
  const shadowSize = GRAPHICS_PROFILES[engine.graphics.quality].shadowSize
  sun.shadow.mapSize.set(shadowSize, shadowSize)
  // -0.0002 with a 4096 map over 32 m (7.8 mm texels): enough to kill acne on the big flat
  // walls, small enough that a door leaf still touches its own shadow.
  sun.shadow.bias = -0.0002
  sun.shadow.normalBias = 0.03
  sun.shadow.intensity = 1

  const extent = Math.min(Math.max(_size.x, _size.z) * 0.5 + 4, SHADOW_EXTENT)
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

  // Light-space basis, matching Object3D.lookAt (z = eye - target, x = up × z, y = z × x).
  _lightRight.set(0, 1, 0).cross(SUN_DIR).normalize()
  _lightUp.copy(SUN_DIR).cross(_lightRight).normalize()
  let texel = (extent * 2) / shadowSize

  // ---- sky + image-based environment ---------------------------------------
  let sky: SkyMesh | null = null
  let envTexture: Texture | null = null
  const pmrem = new PMREMGenerator(engine.renderer)
  try {
    sky = new SkyMesh()
    sky.name = 'sky'
    sky.turbidity.value = SKY.turbidity
    sky.rayleigh.value = SKY.rayleigh
    sky.mieCoefficient.value = SKY.mieCoefficient
    sky.mieDirectionalG.value = SKY.mieDirectionalG
    sky.cloudCoverage.value = SKY.cloudCoverage
    sky.cloudDensity.value = SKY.cloudDensity
    sky.cloudScale.value = SKY.cloudScale
    sky.cloudSpeed.value = SKY.cloudSpeed
    sky.cloudElevation.value = SKY.cloudElevation
    sky.sunPosition.value.copy(SUN_DIR)
    sky.scale.setScalar(SKY_HALF_SIZE * 2)
    sky.material.fog = false
    sky.frustumCulled = false
    sky.matrixAutoUpdate = true
    scene.add(sky)
  } catch (err) {
    console.warn('[environment] sky mesh unavailable, using a flat background', err)
    sky = null
  }

  /**
   * PMREM of the sky itself plus a ground disc, so surfaces facing down pick up a warm bounce
   * instead of the black under-hemisphere of the Preetham model. The sun disc is hidden for the
   * bake (three's own advice): a 19000× hot pixel in a 6×64 cube face is pure aliasing, and the
   * directional light already carries the sun's energy.
   */
  function bakeEnvironment(): void {
    if (!sky) return
    const bakeScene = new Scene()
    const ground = new Mesh(
      new PlaneGeometry(400, 400),
      new MeshBasicMaterial({ color: GROUND_BOUNCE }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -2
    const parent = sky.parent
    const skyScale = sky.scale.x
    const skyVisible = sky.visible
    try {
      sky.visible = true
      sky.showSunDisc.value = 0
      sky.scale.setScalar(60)
      bakeScene.add(sky)
      bakeScene.add(ground)
      const target = pmrem.fromScene(bakeScene, 0.02, 0.1, 200)
      envTexture?.dispose()
      envTexture = target.texture
      scene.environment = envTexture
      scene.environmentIntensity = ENVIRONMENT_INTENSITY
    } catch (err) {
      console.warn('[environment] PMREM from sky failed, materials keep the last env map', err)
    } finally {
      sky.showSunDisc.value = 1
      sky.visible = skyVisible
      sky.scale.setScalar(skyScale)
      if (parent) parent.add(sky)
      else bakeScene.remove(sky)
      ground.geometry.dispose()
      ground.material.dispose()
    }
  }

  bakeEnvironment()
  const applyGraphics = () => {
    const profile = GRAPHICS_PROFILES[engine.graphics.quality]
    if (sun.shadow.mapSize.x !== profile.shadowSize) {
      // Three r185 WebGPU caches shadow bindings across render contexts. Resizing a live
      // attachment can leave the post/direct path using a destroyed texture. A fresh light
      // gives every context a fresh shadow node; this only happens on a quality change.
      const previous = sun
      sun = previous.clone()
      sun.shadow.mapSize.set(profile.shadowSize, profile.shadowSize)
      scene.remove(previous, previous.target)
      scene.add(sun, sun.target)
      previous.dispose()
    }
    texel = (extent * 2) / profile.shadowSize
    if (sky) sky.visible = profile.sky
  }
  applyGraphics()
  const offGraphics = engine.graphics.onChange(applyGraphics)
  // The first bake can run before the sky's node material has finished compiling, which yields a
  // black cube. One more bake after the first real frame is cheap insurance.
  let rebakeFrames = sky ? 2 : 0

  function update(playerPos: Vector3) {
    if (rebakeFrames > 0 && --rebakeFrames === 0) bakeEnvironment()

    // Keep the frustum centre inside the map so the sun never leaves the world behind.
    _clamped.set(
      clamp(playerPos.x, _boundsMin.x, _boundsMax.x),
      clamp(playerPos.y, _boundsMin.y, _boundsMax.y),
      clamp(playerPos.z, _boundsMin.z, _boundsMax.z),
    )
    // Snap the centre to whole shadow texels along the light's own axes: without this the
    // shadow edges shimmer with every step the player takes.
    const x = _clamped.dot(_lightRight)
    const y = _clamped.dot(_lightUp)
    const z = _clamped.dot(SUN_DIR)
    _snap
      .copy(_lightRight)
      .multiplyScalar(Math.round(x / texel) * texel)
      .addScaledVector(_lightUp, Math.round(y / texel) * texel)
      .addScaledVector(SUN_DIR, z)

    sun.target.position.copy(_snap)
    sun.position.copy(_snap).addScaledVector(SUN_DIR, sunDistance)
    sun.target.updateMatrixWorld()
    sun.updateMatrixWorld()

    if (sky) {
      // The dome is smaller than the far plane, so it travels with the viewer.
      sky.position.copy(playerPos)
      sky.updateMatrixWorld()
    }
  }

  update(_center)

  return {
    get sun() { return sun },
    hemi,
    sky,
    update,
    dispose() {
      offGraphics()
      scene.remove(sun)
      scene.remove(sun.target)
      scene.remove(hemi)
      sun.dispose()
      hemi.dispose()
      if (sky) {
        scene.remove(sky)
        sky.geometry.dispose()
        sky.material.dispose()
      }
      envTexture?.dispose()
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

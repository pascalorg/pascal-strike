/**
 * Post-processing chain and the quality settings that drive it (W5-C).
 *
 * One `RenderPipeline` (three's WebGPU post stack — `PostProcessing` is its deprecated name)
 * built from TSL nodes, in this order:
 *
 *   scene pass (MRT: colour + view normals, depth)
 *     → GTAO            ambient occlusion; what actually makes a room read as a room
 *     → grade           contrast around mid grey + saturation, still scene-referred
 *     → bloom           high threshold: sun-lit highlights, muzzle flashes, nothing else
 *     → vignette
 *     → renderOutput    tone mapping + sRGB
 *     → grain           film grain, display-referred so it does not survive the tone curve
 *     → FXAA / SMAA     the pass render target has no MSAA, so AA happens here
 *
 * Every stage is switchable at runtime (`post.set({ ao: { enabled: false } })`) because that is
 * the only honest way to measure what each one costs; `?dev=map` binds `P` to the whole chain.
 *
 * The chain is WebGPU-first. On the WebGL2 fallback the node system still compiles, but the
 * MRT + AO path is not worth the risk on a machine that already lost WebGPU, so AO is dropped
 * and the rest of the chain stays (see `applyBackendLimits`).
 */
import type { Camera, Material, Scene, Texture } from 'three'
import { ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping } from 'three'
import { RenderPipeline, type Node, type Renderer } from 'three/webgpu'
import {
  Fn,
  clamp,
  float,
  hash,
  luminance,
  mix,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
  rtt,
  saturation,
  screenCoordinate,
  screenUV,
  smoothstep,
  time,
  vec3,
  vec4,
} from 'three/tsl'
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js'
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js'
import { fxaa } from 'three/examples/jsm/tsl/display/FXAANode.js'
import { smaa } from 'three/examples/jsm/tsl/display/SMAANode.js'

export type ToneMappingName = 'aces' | 'agx' | 'neutral'
export type AntiAliasName = 'fxaa' | 'smaa' | 'none'

export interface PostSettings {
  /** Master switch for the whole chain. `false` renders the scene straight to the canvas. */
  enabled: boolean
  toneMapping: ToneMappingName
  exposure: number
  ao: {
    enabled: boolean
    /** World-space radius of the occlusion search, in metres. */
    radius: number
    scale: number
    thickness: number
    distanceExponent: number
    samples: number
    /** 1 = full resolution. 0.5 halves the AO pass and costs a quarter as much. */
    resolutionScale: number
    /**
     * Where the AO gets its normals. `depth` reconstructs them in the shader; `mrt` renders a
     * view-normal attachment. MRT is a touch more accurate on curved surfaces but every
     * additively blended sprite (muzzle puffs, tracers) blends into that attachment too, and
     * GTAO then paints a hard-edged dark rectangle wherever a puff was. Depth it is.
     */
    normals: 'depth' | 'mrt'
    /** 0..1 — how much of the occlusion is applied to the beauty pass. */
    intensity: number
    /** Metres. Nothing closer than this is occluded — that is the first-person weapon. */
    nearFade: [number, number]
    /** Metres. AO fades out again in the distance so the sky edge grows no dark rim. */
    farFade: [number, number]
  }
  bloom: {
    enabled: boolean
    strength: number
    radius: number
    /** Scene-referred luminance where the glow starts. High = only real highlights. */
    threshold: number
  }
  grade: { enabled: boolean; contrast: number; saturation: number }
  vignette: { enabled: boolean; amount: number }
  grain: { enabled: boolean; amount: number }
  aa: AntiAliasName
  /**
   * MSAA samples on the scene pass (0 = off). Multisampling the pass target is the best-looking
   * AA there is, but the AO reads that pass's depth buffer and WebGPU cannot resolve a
   * multisampled depth attachment — so it only works with the AO off.
   */
  samples: number
}

/**
 * The look. Tuned against Pascal's viewer render mode: warm afternoon sun, soft contact
 * occlusion, a gentle S-curve, and just enough bloom to feel like air.
 */
export const QUALITY: PostSettings = {
  enabled: true,
  // Khronos PBR Neutral holds saturation where AgX washes a white stone house out, and it does
  // not tint the shadows blue the way ACES does. It is also the cheapest of the three.
  toneMapping: 'neutral',
  exposure: 0.72,
  ao: {
    enabled: true,
    radius: 0.4,
    scale: 1.1,
    thickness: 0.5,
    distanceExponent: 1.6,
    samples: 16,
    resolutionScale: 0.5,
    normals: 'depth',
    intensity: 0.9,
    nearFade: [0.4, 0.9],
    farFade: [35, 90],
  },
  bloom: { enabled: true, strength: 0.1, radius: 0.6, threshold: 1.3 },
  grade: { enabled: true, contrast: 1.15, saturation: 1.12 },
  vignette: { enabled: true, amount: 0.25 },
  grain: { enabled: true, amount: 0.02 },
  aa: 'smaa',
  samples: 0,
}

const TONE_MAPPING = {
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
} as const

export interface PostFx {
  /** False once the chain has thrown: the caller renders the scene directly from then on. */
  readonly usable: boolean
  readonly settings: PostSettings
  /** Draw one frame through the chain. Returns false if the caller must render normally. */
  render(): boolean
  /** The scene pass captures the camera, so a camera swap rebuilds the chain. */
  setCamera(camera: Camera): void
  /** Merge a patch into the settings and rebuild. Handy from the console. */
  set(patch: PostPatch): void
  /** One line for a debug panel. */
  describe(): string
  dispose(): void
}

export type PostPatch = {
  [K in keyof PostSettings]?: PostSettings[K] extends object
    ? Partial<PostSettings[K]>
    : PostSettings[K]
}

export interface PostFxOptions {
  renderer: Renderer
  scene: Scene
  camera: Camera
  /** 'webgl2' drops the effects the fallback backend cannot be trusted with. */
  backend: 'webgpu' | 'webgl2'
  /** Starting point; defaults to a copy of `QUALITY`. */
  settings?: PostSettings
}

export function createPostFx(opts: PostFxOptions): PostFx {
  const { renderer, scene, backend } = opts
  let camera = opts.camera
  const settings = cloneSettings(opts.settings ?? QUALITY)
  applyBackendLimits(settings, backend)

  let pipeline: RenderPipeline | null = null
  let failed = false
  let dirty = true
  const resources: { dispose(): void }[] = []
  const own = <T extends { dispose(): void }>(resource: T): T => { resources.push(resource); return resource }

  function applyToneMapping(): void {
    renderer.toneMapping = TONE_MAPPING[settings.toneMapping]
    renderer.toneMappingExposure = settings.exposure
  }

  function build(): void {
    dispose()
    applyToneMapping()

    // `samples` must be spelled out: PassNode inherits `renderer.samples` when the option is
    // undefined, and the renderer asks for 4x MSAA — which silently breaks the AO, because WGSL
    // cannot read a multisampled depth texture.
    const scenePass = own(pass(scene, camera, { samples: settings.samples }))
    const needsNormalMRT = settings.ao.enabled && settings.ao.normals === 'mrt'
    if (needsNormalMRT) scenePass.setMRT(mrt({ output, normal: normalView }))

    const sceneColor = scenePass.getTextureNode('output')
    let rgb = sceneColor.rgb

    if (settings.ao.enabled) {
      const depth = scenePass.getTextureNode('depth')
      // `ao()` accepts a null normal node (it then reconstructs from depth); the typings do not
      // say so, hence the cast.
      const normal = (needsNormalMRT ? scenePass.getTextureNode('normal') : null) as Node
      const aoPass = own(ao(depth, normal, camera))
      // r185 GTAONode.dispose() omits the per-instance noise texture.
      own((aoPass as unknown as { _noiseNode: { value: Texture } })._noiseNode.value)
      aoPass.radius.value = settings.ao.radius
      aoPass.scale.value = settings.ao.scale
      aoPass.thickness.value = settings.ao.thickness
      aoPass.distanceExponent.value = settings.ao.distanceExponent
      aoPass.samples.value = settings.ao.samples
      aoPass.resolutionScale = settings.ao.resolutionScale

      // The AO is masked in view depth: the view model lives ~0.3 m from the eye and would
      // otherwise be swallowed by its own occlusion, and the sky (depth 1) would grow a dark
      // rim along every roof line.
      // The thresholds are computed on the CPU on purpose: TSL's `cameraNear`/`cameraFar`
      // resolve to whatever camera is rendering, and inside the pipeline that is the
      // fullscreen quad's own orthographic camera — not the scene's.
      const depthValue = depth.sample(screenUV).r
      const near0 = float(depthAtDistance(camera, settings.ao.nearFade[0]))
      const near1 = float(depthAtDistance(camera, settings.ao.nearFade[1]))
      const far0 = float(depthAtDistance(camera, settings.ao.farFade[0]))
      const far1 = float(depthAtDistance(camera, settings.ao.farFade[1]))
      // smoothstep needs edge0 < edge1, so the far end is inverted rather than reversed.
      const gate = smoothstep(near0, near1, depthValue)
        .mul(smoothstep(far0, far1, depthValue).oneMinus())
        .mul(settings.ao.intensity)
      const occlusion = mix(float(1), clamp(aoPass.getTextureNode().r, 0, 1), gate)
      rgb = rgb.mul(occlusion)
    }

    if (settings.grade.enabled) {
      // Contrast about the 18 % mid grey, then a saturation lift — scene-referred, so the tone
      // curve still gets to roll the highlights off. (Same shape as Pascal's viewer grade.)
      rgb = saturation(
        rgb.div(0.18).pow(vec3(settings.grade.contrast)).mul(0.18),
        settings.grade.saturation,
      )
    }

    if (settings.bloom.enabled) {
      // BloomNode's own threshold passes the *whole* colour of every pixel above it, so a bright
      // sky ends up smeared over the entire frame as a milky veil. Feeding it a subtractive
      // high-pass instead (only the energy above the threshold) keeps the glow on the things
      // that are actually hot: the sky right around the sun, a muzzle flash, a specular glint.
      const lum = luminance(rgb)
      const excess = lum.sub(settings.bloom.threshold).max(0).div(lum.max(0.0001))
      const bloomPass = own(bloom(
        vec4(rgb.mul(excess), 1),
        settings.bloom.strength,
        settings.bloom.radius,
        0,
      ))
      rgb = rgb.add(bloomPass.rgb)
    }

    if (settings.vignette.enabled) {
      const offset = screenUV.sub(0.5)
      const falloff = smoothstep(float(0.32), float(0.78), offset.length())
      rgb = rgb.mul(float(1).sub(falloff.mul(settings.vignette.amount)))
    }

    // Tone mapping + sRGB happen here rather than in the pipeline, because grain and FXAA both
    // want display-referred pixels. The transform is spelled out instead of read from the
    // pipeline context: FXAA/SMAA render their input into their own target, and the context
    // does not survive that hop — without this the frame comes out untone-mapped and washed.
    const toneMapped = renderOutput(
      vec4(rgb, 1),
      TONE_MAPPING[settings.toneMapping],
      renderer.outputColorSpace,
    )
    // `hash()` truncates its seed to a uint, so the seed has to change by whole numbers from one
    // pixel to the next: with fractional per-pixel steps every pixel on a ~75 px diagonal band
    // shared one value, and the "grain" was a set of stripes sweeping across the frame. One
    // integer per pixel instead: the column, plus a row key spread over the uint range by a
    // first hash and re-keyed every frame (mod 64 keeps it exact in float32).
    const grain = Fn(() => {
      const frame = time.mul(60).floor().mod(64)
      const row = hash(screenCoordinate.y.floor().add(frame.mul(4096))).mul(65536)
      const seed = screenCoordinate.x.floor().add(row)
      return hash(seed).sub(0.5).mul(settings.grain.amount)
    })
    const display = settings.grain.enabled
      ? vec4(toneMapped.rgb.add(grain()), 1)
      : vec4(toneMapped.rgb, 1)

    const pipe = new RenderPipeline(renderer)
    pipe.outputColorTransform = false
    if (settings.aa === 'none') pipe.outputNode = display
    else {
      // AA normally creates this RTT implicitly. Own it so repeated profile changes release
      // its full-screen texture and material too (r185 RTTNode has no disposal override).
      const input = rtt(display)
      own({ dispose() {
        input.renderTarget?.dispose()
        ;(input as unknown as { _quadMesh: { material: Material } })._quadMesh.material.dispose()
        input.dispose()
      } })
      pipe.outputNode = own(settings.aa === 'fxaa' ? fxaa(input) : smaa(input))
    }
    pipeline = pipe
    dirty = false
  }

  function render(): boolean {
    if (!settings.enabled) { dispose(); return false }
    if (failed) return false
    try {
      if (dirty || !pipeline) build()
      pipeline!.render()
      return true
    } catch (err) {
      console.error('[post] render pipeline failed, falling back to a direct render', err)
      failed = true
      dispose()
      // A failed pass can leave a render target bound.
      ;(renderer as unknown as { setRenderTarget?: (t: null) => void }).setRenderTarget?.(null)
      return false
    }
  }

  function dispose(): void {
    pipeline?.dispose()
    pipeline = null
    for (const resource of resources) resource.dispose()
    resources.length = 0
  }

  return {
    get usable() {
      return !failed
    },
    settings,
    render,
    setCamera(next) {
      if (next === camera) return
      camera = next
      dirty = true
    },
    set(patch) {
      for (const key of Object.keys(patch) as (keyof PostSettings)[]) {
        const value = patch[key]
        const current = settings[key]
        if (value !== undefined && typeof current === 'object' && typeof value === 'object') {
          Object.assign(current as object, value)
        } else if (value !== undefined) {
          ;(settings as unknown as Record<string, unknown>)[key] = value
        }
      }
      applyBackendLimits(settings, backend)
      applyToneMapping()
      failed = false
      dirty = true
    },
    describe() {
      if (!settings.enabled) return 'post off'
      const parts = [
        settings.ao.enabled ? `ao ${settings.ao.radius}m` : 'ao off',
        settings.bloom.enabled ? `bloom ${settings.bloom.threshold}` : 'bloom off',
        settings.aa,
        settings.toneMapping,
        `exp ${settings.exposure}`,
      ]
      return (failed ? 'post FAILED · ' : 'post on · ') + parts.join(' · ')
    },
    dispose,
  }
}

/**
 * Perspective depth (0..1, what the depth attachment holds) of a point `metres` in front of the
 * camera. Used to fade the screen-space effects in and out by distance.
 */
function depthAtDistance(camera: Camera, metres: number): number {
  const { near, far } = camera as Camera & { near?: number; far?: number }
  if (typeof near !== 'number' || typeof far !== 'number') return 0
  const viewZ = -Math.max(metres, 1e-4)
  return ((near + viewZ) * far) / ((far - near) * viewZ)
}

/**
 * Combinations that cannot work, forced back into line before every build:
 * - WebGL2 is the fallback of last resort — keep the grade and the AA, drop the AO (the GTAO
 *   pass is the one piece of this chain that has no business running on a machine that just
 *   lost WebGPU) and the grain.
 * - MSAA on the scene pass and the AO are mutually exclusive: WGSL cannot even call
 *   `textureDimensions` on the multisampled depth texture GTAO wants to read, and the whole
 *   pipeline fails to compile. MSAA wins if it was asked for; SMAA is the default instead.
 */
function applyBackendLimits(settings: PostSettings, backend: 'webgpu' | 'webgl2'): void {
  if (settings.samples > 0) settings.ao.enabled = false
  if (backend === 'webgpu') return
  settings.ao.enabled = false
  settings.grain.enabled = false
  settings.samples = 0
}

function cloneSettings(source: PostSettings): PostSettings {
  return {
    ...source,
    ao: { ...source.ao, nearFade: [...source.ao.nearFade], farFade: [...source.ao.farFade] },
    bloom: { ...source.bloom },
    grade: { ...source.grade },
    vignette: { ...source.vignette },
    grain: { ...source.grain },
  }
}

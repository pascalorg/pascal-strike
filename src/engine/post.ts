/**
 * Post-processing chain and the quality settings that drive it (W5-C).
 *
 * One `RenderPipeline` (three's WebGPU post stack — `PostProcessing` is its deprecated name)
 * built from TSL nodes, in this order:
 *
 *   scene pass
 *     → grade           contrast around mid grey + saturation, still scene-referred
 *     → vignette
 *     → renderOutput    tone mapping + sRGB
 *     → grain           film grain, display-referred so it does not survive the tone curve
 *
 * Every stage is switchable at runtime (`post.set({ grade: { enabled: false } })`) because that
 * is the only honest way to measure what each one costs; `?dev=map` binds `P` to the whole
 * chain and `?nopost=1` starts without it.
 */
import type { Camera, Scene } from 'three'
import { ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping } from 'three'
import { RenderPipeline, type Renderer } from 'three/webgpu'
import {
  Fn,
  float,
  hash,
  pass,
  renderOutput,
  saturation,
  screenCoordinate,
  screenUV,
  smoothstep,
  time,
  vec3,
  vec4,
} from 'three/tsl'

export type ToneMappingName = 'aces' | 'agx' | 'neutral'

export interface PostSettings {
  /** Master switch for the whole chain. `false` renders the scene straight to the canvas. */
  enabled: boolean
  toneMapping: ToneMappingName
  exposure: number
  grade: { enabled: boolean; contrast: number; saturation: number }
  vignette: { enabled: boolean; amount: number }
  grain: { enabled: boolean; amount: number }
}

/**
 * The look. Tuned against Pascal's viewer render mode: warm afternoon sun,
 * a gentle S-curve about mid grey and a quiet vignette.
 */
export const QUALITY: PostSettings = {
  enabled: true,
  // Khronos PBR Neutral holds saturation where AgX washes a white stone house out, and it does
  // not tint the shadows blue the way ACES does. It is also the cheapest of the three.
  toneMapping: 'neutral',
  exposure: 0.72,
  grade: { enabled: true, contrast: 1.15, saturation: 1.12 },
  vignette: { enabled: true, amount: 0.25 },
  grain: { enabled: true, amount: 0.02 },
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

  function applyToneMapping(): void {
    renderer.toneMapping = TONE_MAPPING[settings.toneMapping]
    renderer.toneMappingExposure = settings.exposure
  }

  function build(): void {
    dispose()
    applyToneMapping()

    const scenePass = pass(scene, camera)
    const sceneColor = scenePass.getTextureNode('output')
    let rgb = sceneColor.rgb

    if (settings.grade.enabled) {
      // Contrast about the 18 % mid grey, then a saturation lift — scene-referred, so the tone
      // curve still gets to roll the highlights off. (Same shape as Pascal's viewer grade.)
      rgb = saturation(
        rgb.div(0.18).pow(vec3(settings.grade.contrast)).mul(0.18),
        settings.grade.saturation,
      )
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
    const grain = Fn(() => {
      const seed = screenCoordinate.x
        .mul(0.013)
        .add(screenCoordinate.y.mul(0.0071))
        .add(time.mul(11.3))
      return hash(seed).sub(0.5).mul(settings.grain.amount)
    })
    const display = settings.grain.enabled
      ? vec4(toneMapped.rgb.add(grain()), 1)
      : vec4(toneMapped.rgb, 1)

    const pipe = new RenderPipeline(renderer)
    pipe.outputColorTransform = false
    pipe.outputNode = display
    pipeline = pipe
    dirty = false
  }

  function render(): boolean {
    if (!settings.enabled || failed) return false
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
        settings.grade.enabled ? `grade ${settings.grade.contrast}` : 'grade off',
        settings.vignette.enabled ? 'vignette' : 'no vignette',
        settings.toneMapping,
        `exp ${settings.exposure}`,
      ]
      return (failed ? 'post FAILED · ' : 'post on · ') + parts.join(' · ')
    },
    dispose,
  }
}

/** WebGL2 is the fallback of last resort: keep the grade, drop what is likely to misbehave. */
function applyBackendLimits(settings: PostSettings, backend: 'webgpu' | 'webgl2'): void {
  if (backend === 'webgpu') return
  settings.grain.enabled = false
}

function cloneSettings(source: PostSettings): PostSettings {
  return {
    ...source,
    grade: { ...source.grade },
    vignette: { ...source.vignette },
    grain: { ...source.grain },
  }
}

/**
 * Renderer, scene, camera and the frame loop (W1-A).
 *
 * The loop is split in two: `onUpdate` handlers run on a fixed 1/120 s step (deterministic
 * physics, shared by players and host-simulated bots) and `onRender` handlers run once per
 * frame with the leftover interpolation `alpha`.
 */
import { PCFSoftShadowMap, PerspectiveCamera, Scene, SRGBColorSpace, Timer } from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { PLAYER } from '../config'
import { createPostFx, type PostFx } from './post'
import { createGraphics, GRAPHICS_PROFILES, graphicsPixelRatio, initialAutoQuality, readGraphicsPreference, type Graphics } from './graphics'

/** Fixed physics step. */
export const FIXED_STEP = 1 / 120
const MAX_SUBSTEPS = 5
/** Guard against huge frame deltas (tab was backgrounded). */
const MAX_FRAME_DELTA = 0.25

export type RenderBackend = 'webgpu' | 'webgl2'

/** Thrown when neither WebGPU nor WebGL2 could be initialised — `main.ts` shows ui/unsupported. */
export class RendererInitError extends Error {
  override readonly cause: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'RendererInitError'
    this.cause = cause
  }
}

/**
 * Frame clock. Backed by `THREE.Timer` (r185 deprecated `THREE.Clock`), but it also answers to
 * `getElapsedTime()`/`elapsedTime` so code written against the old `Clock` API keeps working.
 * It is updated once per frame, so reading it several times in one step is consistent.
 */
export interface EngineClock {
  /** Seconds since the previous frame — the same value the update/render hooks receive. */
  getDelta(): number
  /** Seconds since `start()`. */
  getElapsed(): number
  /** Alias of `getElapsed()` (THREE.Clock compatibility). */
  getElapsedTime(): number
  readonly elapsedTime: number
}

export interface Engine {
  renderer: WebGPURenderer
  scene: Scene
  camera: PerspectiveCamera
  clock: EngineClock
  backend: RenderBackend
  /** Tone mapping, AO, bloom, AA. See `post.ts`; `?nopost=1` starts with it switched off. */
  post: PostFx
  graphics: Graphics
  /** Fixed 1/120 s steps, at most 5 per frame. Returns an unsubscribe function. */
  onUpdate(fn: (dt: number, now: number) => void): () => void
  /** Once per frame, just before the draw call. `alpha` is the fixed-step remainder in 0..1. */
  onRender(fn: (alpha: number, dt: number) => void): () => void
  start(): void
  stop(): void
  dispose(): void
  setCamera(cam: PerspectiveCamera): void
  /** Container the canvas lives in (for DOM overlays). */
  container: HTMLElement
}

export async function createRenderer(container: HTMLElement): Promise<Engine> {
  let renderer: WebGPURenderer
  // `?webgl=1` forces the fallback backend so the WebGL2 path can actually be tested.
  const forceWebGL = new URLSearchParams(location.search).get('webgl') === '1'
  try {
    renderer = new WebGPURenderer({ antialias: true, forceWebGL })
    await renderer.init()
  } catch (err) {
    throw new RendererInitError(
      'Could not initialise a WebGPU or WebGL2 renderer on this device.',
      err,
    )
  }

  // `backend.isWebGPUBackend` only exists on the WebGPU backend; WebGL2 fallback is silent.
  const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
  const backend: RenderBackend = isWebGPU ? 'webgpu' : 'webgl2'

  const graphics = createGraphics(readGraphicsPreference(), initialAutoQuality({
    backend, cores: navigator.hardwareConcurrency,
    memory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  }))
  // Tone mapping and exposure belong to the post chain (post.ts sets them from QUALITY).
  renderer.outputColorSpace = SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFSoftShadowMap

  const canvas = renderer.domElement
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  container.appendChild(canvas)

  const scene = new Scene()
  const timer = new Timer()
  timer.connect(document) // Page Visibility API: no giant delta after a background tab
  const clock: EngineClock = {
    getDelta: () => timer.getDelta(),
    getElapsed: () => timer.getElapsed(),
    getElapsedTime: () => timer.getElapsed(),
    get elapsedTime() {
      return timer.getElapsed()
    },
  }

  const initialSize = measure(container)
  renderer.setPixelRatio(graphicsPixelRatio(graphics.quality, window.devicePixelRatio, initialSize.w, initialSize.h))
  let camera = new PerspectiveCamera(PLAYER.fov, initialSize.w / initialSize.h, 0.05, 200)
  camera.position.set(0, 1.7, 6)
  renderer.setSize(initialSize.w, initialSize.h, false)

  const updateHandlers = new Set<(dt: number, now: number) => void>()
  const renderHandlers = new Set<(alpha: number, dt: number) => void>()
  // Snapshot arrays reused every frame — no per-frame allocation.
  let updateList: ((dt: number, now: number) => void)[] = []
  let renderList: ((alpha: number, dt: number) => void)[] = []
  let listsDirty = true

  function refreshLists() {
    if (!listsDirty) return
    updateList = Array.from(updateHandlers)
    renderList = Array.from(renderHandlers)
    listsDirty = false
  }

  let accumulator = 0
  let running = false
  let disposed = false

  function frame() {
    timer.update()
    const dt = Math.min(timer.getDelta(), MAX_FRAME_DELTA)
    refreshLists()

    accumulator += dt
    let steps = 0
    while (accumulator >= FIXED_STEP && steps < MAX_SUBSTEPS) {
      const now = performance.now()
      for (let i = 0; i < updateList.length; i++) updateList[i](FIXED_STEP, now)
      accumulator -= FIXED_STEP
      steps++
    }
    // Do not let the accumulator spiral if we are permanently behind.
    if (steps === MAX_SUBSTEPS && accumulator > FIXED_STEP) accumulator = 0

    const alpha = accumulator / FIXED_STEP
    for (let i = 0; i < renderList.length; i++) renderList[i](alpha, dt)

    // The post chain owns the draw when it is on; `render()` says so, and answers false the
    // moment it is disabled or has thrown, so a broken effect can never black the game out.
    if (!post.render()) renderer.render(scene, camera)
    graphics.sample(timer.getDelta(), !document.hidden)
  }

  function resize() {
    const { w, h } = measure(container)
    renderer.setPixelRatio(graphicsPixelRatio(graphics.quality, window.devicePixelRatio, w, h))
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  const post = createPostFx({ renderer, scene, camera, backend })
  const noPost = new URLSearchParams(location.search).get('nopost') === '1'
  const applyGraphics = () => {
    post.set({ ...GRAPHICS_PROFILES[graphics.quality].post, ...(noPost ? { enabled: false } : {}) })
    resize()
  }
  applyGraphics()
  const offGraphics = graphics.onChange(applyGraphics)

  const observer = new ResizeObserver(resize)
  observer.observe(container)
  window.addEventListener('orientationchange', resize)

  const engine: Engine = {
    renderer,
    scene,
    get camera() {
      return camera
    },
    clock,
    backend,
    post,
    graphics,
    container,
    onUpdate(fn) {
      updateHandlers.add(fn)
      listsDirty = true
      return () => {
        updateHandlers.delete(fn)
        listsDirty = true
      }
    },
    onRender(fn) {
      renderHandlers.add(fn)
      listsDirty = true
      return () => {
        renderHandlers.delete(fn)
        listsDirty = true
      }
    },
    start() {
      if (running || disposed) return
      running = true
      graphics.reset()
      timer.update() // baseline now, so the first frame does not inherit the load time
      renderer.setAnimationLoop(frame)
    },
    stop() {
      if (!running) return
      running = false
      renderer.setAnimationLoop(null)
    },
    dispose() {
      if (disposed) return
      disposed = true
      engine.stop()
      observer.disconnect()
      window.removeEventListener('orientationchange', resize)
      updateHandlers.clear()
      renderHandlers.clear()
      timer.dispose()
      offGraphics()
      post.dispose()
      renderer.dispose()
      canvas.remove()
    },
    setCamera(cam) {
      camera = cam
      post.setCamera(cam)
      resize()
    },
  }

  return engine
}

function measure(container: HTMLElement): { w: number; h: number } {
  const w = Math.max(1, container.clientWidth || window.innerWidth)
  const h = Math.max(1, container.clientHeight || window.innerHeight)
  return { w, h }
}

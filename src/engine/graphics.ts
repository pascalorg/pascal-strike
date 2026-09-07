import type { PostPatch } from './post'

export type GraphicsQuality = 'low' | 'medium' | 'high'
export type GraphicsPreference = 'auto' | GraphicsQuality
export const GRAPHICS_KEY = 'ps.graphics'

export const GRAPHICS_PROFILES = {
  low: { pixelRatio: 1, pixels: 1280 * 720, shadowSize: 1024, sky: false,
    post: { enabled: false, ao: { enabled: false }, bloom: { enabled: false }, grain: { enabled: false }, aa: 'fxaa' } },
  medium: { pixelRatio: 1.25, pixels: 1920 * 1080, shadowSize: 2048, sky: true,
    post: { enabled: true, ao: { enabled: false }, bloom: { enabled: false }, grain: { enabled: false }, aa: 'fxaa' } },
  high: { pixelRatio: 2, pixels: 2560 * 1440, shadowSize: 4096, sky: true,
    post: { enabled: true, ao: { enabled: true }, bloom: { enabled: true }, grain: { enabled: true }, aa: 'smaa' } },
} satisfies Record<GraphicsQuality, { pixelRatio: number; pixels: number; shadowSize: number; sky: boolean; post: PostPatch }>

export function readGraphicsPreference(): GraphicsPreference {
  try {
    const value = localStorage.getItem(GRAPHICS_KEY)
    if (value === 'low' || value === 'medium' || value === 'high') return value
  } catch { /* Storage can be unavailable in private/embedded browsing. */ }
  return 'auto'
}

export function saveGraphicsPreference(value: GraphicsPreference): void {
  try { localStorage.setItem(GRAPHICS_KEY, value) } catch { /* Session setting still works. */ }
}

export function initialAutoQuality(device: { backend: string; cores?: number; memory?: number }): GraphicsQuality {
  return device.backend === 'webgl2' || (device.cores !== undefined && device.cores <= 4) ||
    (device.memory !== undefined && device.memory <= 4) ? 'low' : 'medium'
}

export function graphicsPixelRatio(quality: GraphicsQuality, dpr: number, width: number, height: number): number {
  const profile = GRAPHICS_PROFILES[quality]
  return Math.min(dpr || 1, profile.pixelRatio, Math.sqrt(profile.pixels / Math.max(1, width * height)))
}

export interface Graphics {
  readonly preference: GraphicsPreference
  readonly quality: GraphicsQuality
  set(value: GraphicsPreference): void
  onChange(fn: () => void): () => void
  sample(dt: number, active: boolean): void
  reset(): void
}

/** Auto only steps down: no quality oscillation or expensive rebuilds while FPS recovers. */
export function createGraphics(preference: GraphicsPreference, autoQuality: GraphicsQuality): Graphics {
  let quality = preference === 'auto' ? autoQuality : preference
  let warmup = 10, elapsed = 0, slow = 0
  const listeners = new Set<() => void>()
  const reset = () => { warmup = 10; elapsed = 0; slow = 0 }
  return {
    get preference() { return preference },
    get quality() { return quality },
    set(value) {
      if (value === preference) return
      preference = value
      quality = value === 'auto' ? autoQuality : value
      saveGraphicsPreference(value)
      reset()
      for (const fn of listeners) fn()
    },
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    reset,
    sample(dt, active) {
      if (preference !== 'auto' || quality === 'low') return
      // Loading, tab throttling and isolated stalls are not evidence of a weak GPU.
      if (!active || !Number.isFinite(dt) || dt <= 0 || dt > .25) { reset(); return }
      if (warmup > 0) { warmup -= dt; return }
      elapsed += dt
      if (dt > 1 / 48) slow += dt
      if (elapsed < 6) return
      if (slow / elapsed >= .6) {
        quality = quality === 'high' ? 'medium' : 'low'
        reset()
        for (const fn of listeners) fn()
      } else { elapsed = 0; slow = 0 }
    },
  }
}

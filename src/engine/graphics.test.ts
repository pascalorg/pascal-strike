// @ts-ignore Bun test runtime.
import { expect, test } from 'bun:test'
import { createGraphics, graphicsPixelRatio, initialAutoQuality } from './graphics'

const frames = (graphics: ReturnType<typeof createGraphics>, fps: number, seconds: number, active = true) => {
  for (let i = 0; i < fps * seconds; i++) graphics.sample(1 / fps, active)
}

test('auto starts conservatively, including WebGL and low memory devices', () => {
  expect(initialAutoQuality({ backend: 'webgpu', cores: 16, memory: 16 })).toBe('medium')
  expect(initialAutoQuality({ backend: 'webgl2', cores: 16 })).toBe('low')
  expect(initialAutoQuality({ backend: 'webgpu', memory: 4 })).toBe('low')
  expect(initialAutoQuality({ backend: 'webgpu', cores: 4 })).toBe('low')
})

test('sustained low FPS steps auto down, with a warmup and no oscillation', () => {
  const graphics = createGraphics('auto', 'medium')
  let changes = 0
  const off = graphics.onChange(() => changes++)
  frames(graphics, 30, 12)
  expect(graphics.quality).toBe('medium')
  frames(graphics, 30, 6)
  expect(graphics.quality).toBe('low')
  frames(graphics, 144, 60)
  expect(graphics.quality).toBe('low')
  expect(changes).toBe(1)
  off()
})

test('manual choices, background tabs and isolated stalls do not trigger adaptation', () => {
  const manual = createGraphics('high', 'low')
  frames(manual, 20, 60)
  expect(manual.quality).toBe('high')
  const auto = createGraphics('auto', 'medium')
  frames(auto, 60, 12)
  auto.sample(.2, true)
  frames(auto, 60, 12)
  expect(auto.quality).toBe('medium')
  frames(auto, 10, 30, false)
  frames(auto, 30, 5)
  expect(auto.quality).toBe('medium')
  auto.sample(2, true)
  frames(auto, 30, 12)
  expect(auto.quality).toBe('medium')
  auto.set('high')
  frames(auto, 20, 60)
  expect(auto.quality).toBe('high')
})

test('resolution budgets cap high-DPI and large displays, including resize', () => {
  expect(graphicsPixelRatio('low', 2, 1920, 1080)).toBeCloseTo(2 / 3)
  expect(graphicsPixelRatio('medium', 2, 1920, 1080)).toBe(1)
  expect(graphicsPixelRatio('high', 3, 800, 600)).toBe(2)
  expect(graphicsPixelRatio('low', 1, 3840, 2160)).toBeCloseTo(1 / 3)
})

/** Exercise saved profiles and actual render targets on both supported backends. */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.BASE_URL || 'http://localhost:5184'
const output = process.env.ARTIFACT_DIR || '/tmp/pascal-strike-graphics'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu'] })
try {
  for (const backend of ['webgl', 'webgpu']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    const suffix = backend === 'webgl' ? '&webgl=1' : ''
    await page.goto(`${base}/?${suffix}`)
    await page.getByRole('combobox', { name: 'Graphics quality' }).selectOption('medium')
    await page.reload()
    assert.equal(await page.getByRole('combobox', { name: 'Graphics quality' }).inputValue(), 'medium')
    await page.screenshot({ path: `${output}/lobby-${backend}.png` })
    await page.goto(`${base}/?dev=map${suffix}`)
    await page.waitForFunction(() => window.__ps?.engine, {}, { timeout: 90000 })
    await page.waitForTimeout(1500)
    let lowTextures
    for (const quality of ['medium', 'low', 'high', 'medium', 'low']) {
      await page.evaluate(q => window.__ps.engine.graphics.set(q), quality)
      await page.waitForTimeout(750)
      const state = await page.evaluate(() => {
        const { engine: e, environment } = window.__ps
        return { quality: e.graphics.quality, post: e.post.settings.enabled, usable: e.post.usable,
          ao: e.post.settings.ao.enabled, shadow: environment.sun.shadow.mapSize.x,
          allocatedShadow: environment.sun.shadow.map?.width,
          width: e.renderer.domElement.width, height: e.renderer.domElement.height, sky: environment.sky?.visible }
      })
      assert.equal(state.quality, quality)
      assert.equal(state.post, quality !== 'low')
      assert.equal(state.usable, true)
      assert.equal(state.ao, quality === 'high' && backend === 'webgpu')
      assert.equal(state.shadow, { low: 1024, medium: 2048, high: 4096 }[quality])
      assert.equal(state.allocatedShadow, state.shadow)
      assert.equal(state.sky, quality !== 'low')
      assert(state.width * state.height <= { low: 1280 * 720, medium: 1920 * 1080, high: 2560 * 1440 }[quality])
      if (quality === 'low') {
        const textures = await page.evaluate(() => window.__ps.engine.renderer.info.memory.textures)
        if (lowTextures !== undefined) assert(textures <= lowTextures, `Profile changes leaked textures: ${lowTextures} -> ${textures}`)
        lowTextures = textures
      }
      await page.screenshot({ path: `${output}/${quality}-${backend}.png` })
    }
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.waitForTimeout(200)
    assert(await page.evaluate(() => window.__ps.engine.renderer.domElement.width <= 1280))
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`${backend}: saved lobby preference, live Low/Medium/High, AO limits, shadow resizing, render pixel budgets and viewport resize passed`)
  }
} finally { await browser.close() }

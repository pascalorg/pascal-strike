/** Repeatable first-death benchmark with four real outfits; run against the dev server. */
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.BASE_URL || 'http://localhost:5184'
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu'] })
try {
  for (const backend of ['webgl', 'webgpu']) {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    await page.goto(`${base}/?dev=characters${backend === 'webgl' ? '&webgl=1' : ''}`)
    await page.waitForFunction(() => window.__psCharacters?.avatars.every(a => a.object.userData.characterStatus === 'ready'), {}, { timeout: 90000 })
    const data = await page.evaluate(async () => {
      const g = window.__psCharacters
      g.renderer.setAnimationLoop(null)
      const next = () => new Promise(r => requestAnimationFrame(r))
      const materials = new Set()
      for (const avatar of g.avatars) avatar.object.getObjectByName('studio-character').traverse(node => {
        if (node.isMesh) for (const material of Array.isArray(node.material) ? node.material : [node.material]) materials.add(material)
      })
      const signature = () => [...materials].map(m => `${m.id}:${m.transparent}:${m.alphaHash}:${m.version}`).join('|')
      const before = signature()
      const draw = () => {
        const t = performance.now()
        g.avatars.forEach((a, i) => a.set(g.positions[i], 0, 0, false, 0))
        g.renderer.render(g.scene, g.camera)
        return performance.now() - t
      }
      for (let i = 0; i < 40; i++) { await next(); draw() }
      const baseline = []
      for (let i = 0; i < 30; i++) { await next(); baseline.push(draw()) }
      const rounds = []
      let stableMaterials = true, hiddenBodies = true, restoredBodies = true
      for (let round = 0; round < 3; round++) {
        g.avatars.forEach(a => a.die())
        const times = [], started = performance.now()
        while (performance.now() - started < 1200) {
          await next(); times.push(draw())
          stableMaterials &&= signature() === before
        }
        hiddenBodies &&= g.avatars.every(a => !a.object.getObjectByName('avatar-body').visible)
        rounds.push({ max: Math.max(...times), first: times[0] })
        g.avatars.forEach(a => a.spawn())
        restoredBodies &&= g.avatars.every(a => a.object.getObjectByName('avatar-body').visible && a.hittable().alive)
        stableMaterials &&= signature() === before
        for (let i = 0; i < 10; i++) { await next(); draw() }
      }
      return { baselineMax: Math.max(...baseline), rounds, stableMaterials, hiddenBodies, restoredBodies }
    })
    assert(data.stableMaterials, 'Death/respawn must preserve material pipeline flags and versions')
    assert(data.hiddenBodies && data.restoredBodies, 'Invisible corpses must stop rendering and reappear at respawn')
    assert.deepEqual(errors, [])
    // Report CPU update/render submission time. No hardware-dependent timing assertion.
    console.log(JSON.stringify({ backend, ...data }))
    await page.close()
  }
} finally { await browser.close() }

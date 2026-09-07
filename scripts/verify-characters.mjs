/** Browser checks against bun dev. Uses an existing Playwright installation; no game dependency. */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.BASE_URL || 'http://localhost:5180'
const output = process.env.ARTIFACT_DIR || '/tmp/pascal-strike-characters'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu'] })
try {
  for (const backend of ['webgl', 'webgpu']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    const suffix = backend === 'webgl' ? '&webgl=1' : ''
    await page.goto(`${base}/?dev=characters${suffix}`)
    await page.waitForFunction(() => window.__psCharacters?.avatars.every(a => a.object.userData.characterStatus === 'ready'))
    await page.waitForTimeout(500)
    const initial = await page.evaluate(async () => {
      const { loadCharacterAsset, instantiateCharacter } = await import('/src/characters/assets.ts')
      const { DEFAULT_CHARACTERS } = await import('/src/characters/catalog.ts')
      const result = []
      for (const c of DEFAULT_CHARACTERS) {
        const asset = await loadCharacterAsset(c)
        const a = instantiateCharacter(asset), b = instantiateCharacter(asset)
        const handA = a.model.getObjectByName(asset.sockets.handRight.three)
        const handB = b.model.getObjectByName(asset.sockets.handRight.three)
        const before = handB.quaternion.toArray().join(',')
        handA.rotation.x += .5
        result.push({
          id: c.id, clips: asset.clips.length,
          scaleTracks: asset.clips.flatMap(c => c.tracks).filter(t => t.name.endsWith('.scale')).length,
          independentSkeleton: before === handB.quaternion.toArray().join(','),
          independentMaterials: a.materials.every(m => !b.materials.includes(m)),
          finiteScale: Number.isFinite(a.object.scale.y) && a.object.scale.y > .1 && a.object.scale.y < 10,
        })
        a.dispose(); b.dispose()
      }
      return result
    })
    assert.equal(initial.length, 4)
    for (const c of initial) { assert(c.clips >= 40); assert.equal(c.scaleTracks, 0); assert(c.independentSkeleton && c.independentMaterials && c.finiteScale) }
    const legs = () => page.evaluate(() => window.__psCharacters.avatars.map(a => a.object.getObjectByName('DEF-shinL').quaternion.toArray().join(',')))
    await page.getByRole('button', { name: 'Walk', exact: true }).click()
    await page.waitForTimeout(300); const frameA = await legs()
    await page.waitForTimeout(250); const frameB = await legs()
    assert(frameA.every((pose, i) => pose !== frameB[i]), 'Every Studio skeleton must walk')
    for (const name of ['Run', 'Crouch', 'Jump', 'Fire', 'Reload', 'Hit', 'Death', 'Respawn', 'pistol', 'knife']) {
      await page.getByRole('button', { name, exact: true }).click()
      await page.waitForTimeout(name === 'Death' ? 1200 : 250)
      if (name === 'Death' || name === 'Respawn') {
        assert.deepEqual(await page.evaluate(() => window.__psCharacters.avatars.map(a => a.hittable().alive)), Array(4).fill(name === 'Respawn'))
      }
    }
    await page.getByRole('button', { name: 'Idle', exact: true }).click()
    await page.getByRole('button', { name: 'rifle', exact: true }).click()
    await page.waitForTimeout(400)
    const mounts = await page.evaluate(() => window.__psCharacters.avatars.map(a => {
      const hand = a.object.getObjectByName('DEF-handR'), mount = a.object.getObjectByName('avatar-anchor-weapon')
      const muzzle = a.muzzleWorld(a.object.position.clone())
      return { mounted: mount.parent === hand, muzzle: muzzle.toArray(), origin: a.object.position.toArray(), oldBody: !!a.object.getObjectByName('avatar-body-torso') }
    }))
    for (const m of mounts) { assert(m.mounted && !m.oldBody); assert(m.muzzle.every(Number.isFinite)); assert(m.muzzle[1] > .5 && m.muzzle[1] < 2); assert(m.muzzle[2] < m.origin[2]) }
    await page.screenshot({ path: `${output}/roster-${backend}.png` })
    assert.deepEqual(errors, [])
    await page.goto(`${base}/?${backend === 'webgl' ? 'webgl=1' : ''}`)
    await page.getByRole('button', { name: 'Select Janette' }).click()
    await page.waitForFunction(() => document.querySelector('.ps-character-status')?.textContent === 'Ready to play')
    await page.reload()
    await page.waitForFunction(() => document.querySelector('.ps-character-status')?.textContent === 'Ready to play')
    assert.equal(await page.locator('.ps-character-name').textContent(), 'Janette')
    assert.equal(await page.locator('.ps-character-option').count(), 4)
    assert(await page.locator('.ps-character-option img').evaluateAll(images => images.every(i => i.complete && i.naturalWidth > 0)))
    await page.getByRole('button', { name: '+ Create my character' }).click()
    const iframe = page.locator('iframe[title="Character Studio creator"]')
    assert(new URL(await iframe.getAttribute('src')).searchParams.get('origin') === new URL(base).origin)
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { origin: 'https://characterstudio.wawasensei.dev', source: window, data: { type: 'cs.v1.character.exported', bakeId: 'spoof', name: 'Spoof', gender: 'man', manifestUrl: 'https://characterstudio.wawasensei.dev/api/models/b/spoof.json' } })))
    assert.equal(await page.locator('.ps-character-name').textContent(), 'Janette')
    await page.getByRole('button', { name: 'Close character creator' }).click()
    assert.equal(await page.locator('dialog').count(), 0)
    await page.screenshot({ path: `${output}/lobby-${backend}.png` })
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`${backend}: four real models, animation, clones, weapon mounts, lifecycle, selection, thumbnails and embed origin checks passed`)
  }
} finally { await browser.close() }

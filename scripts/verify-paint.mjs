/** Surface attachment checks on all four real outfits, in both rendering backends. */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.BASE_URL || 'http://localhost:5180'
const output = process.env.ARTIFACT_DIR || '/tmp/pascal-strike-paint'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu'] })
try {
  for (const backend of ['webgl', 'webgpu']) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('console', e => { if (e.type() === 'error') errors.push(e.text()) })
    await page.goto(`${base}/?dev=characters${backend === 'webgl' ? '&webgl=1' : ''}`)
    await page.waitForFunction(() => window.__psCharacters?.avatars.every(a => a.object.userData.characterStatus === 'ready'))
    await page.waitForTimeout(400)
    const counts = await page.evaluate(() => {
      const { avatars } = window.__psCharacters
      return avatars.map(a => {
        for (const [x,y] of [[0,1.25],[.1,.9],[-.1,.7],[0,1.6]]) a.addSplat(a.object.position.clone().add({x,y,z:-.2}),null,0x20cbbd)
        const patches = []; a.object.traverse(n => { if(n.name==='character-paint') patches.push(n) })
        return patches.length
      })
    })
    assert(counts.every(c => c >= 2), `Real outfits must receive surface paint: ${counts}`)
    await page.screenshot({ path: `${output}/idle-${backend}.png` })
    for (const action of ['Walk', 'Crouch', 'Fire', 'Reload']) {
      await page.getByRole('button', { name: action, exact: true }).click()
      await page.waitForTimeout(300)
      const distances = await page.evaluate(() => {
        const { avatars } = window.__psCharacters
        return avatars.map(a => {
          let max = 0, checked = 0
          a.object.updateWorldMatrix(true, true)
          a.object.traverse(paint => {
            if (paint.name !== 'character-paint') return
            const source = paint.parent, original = source.geometry.getAttribute('position'), patch = paint.geometry.getAttribute('position')
            const index = new Map()
            const key = (attribute,i) => [attribute.getX(i),attribute.getY(i),attribute.getZ(i)].map(Math.fround).join(',')
            for(let i=0;i<original.count;i++) index.set(key(original,i), i)
            for(let i=0;i<patch.count;i+=3) {
              const j = index.get(key(patch,i))
              const actual = paint.getVertexPosition(i,a.object.position.clone()).applyMatrix4(paint.matrixWorld)
              const expected = source.getVertexPosition(j,a.object.position.clone()).applyMatrix4(source.matrixWorld)
              max = Math.max(max, actual.distanceTo(expected)); checked++
            }
          })
          return { max, checked }
        })
      })
      assert(distances.every(d => d.checked > 0 && d.max < .00001), `${action}: ${JSON.stringify(distances)}`)
    }
    await page.screenshot({ path: `${output}/moving-${backend}.png` })
    await page.getByRole('button', { name: 'Respawn', exact: true }).click()
    assert.equal(await page.evaluate(() => { let count=0; window.__psCharacters.avatars.forEach(a=>a.object.traverse(n=>{if(n.name==='character-paint')count++}));return count }),0)
    assert.deepEqual(errors, [])
    console.log(`${backend}: paint lies on all four outfits through walking, crouching, firing and reloading; respawn clears it`)
    await page.close()
  }
} finally { await browser.close() }

/** Two independent clients use public quick play, with a bot-filled host already running. */
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.BASE_URL || 'http://localhost:5184'
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu'] })
try {
  const a = await browser.newPage(), b = await browser.newPage()
  const errors = []
  for (const page of [a, b]) page.on('pageerror', e => errors.push(e.message))
  async function join(page, name) {
    await page.goto(`${base}/?debug=1&webgl=1`)
    await page.getByPlaceholder('Your name').fill(name)
    await page.getByRole('button', { name: 'Play online', exact: true }).click()
    await page.waitForFunction(() => window.__ps?.registry, {}, { timeout: 90000 })
    await page.evaluate(() => window.__ps.pickTeam('auto'))
  }
  await join(a, 'Online Host')
  await a.waitForFunction(() => window.__ps.room.players().length === 6)
  const roomCode = await a.evaluate(() => window.__ps.room.roomCode)
  // Change the host's map metadata and bots before joining: the guest must adopt both.
  await a.evaluate(() => {
    const g = window.__ps, map = g.room.getGlobal('map')
    g.room.setGlobal('map', { ...map, name: 'Online host map' }, true)
  })
  await join(b, 'Online Guest')
  assert.equal(await b.evaluate(() => window.__ps.room.roomCode), roomCode, 'Quick play must find the existing bot-filled public room without an invite')
  for (const page of [a, b]) {
    await page.waitForFunction(() => {
      const players = window.__ps.room.players()
      return players.length === 6 && players.filter(p => !p.isBot()).length === 2
    })
  }
  assert.equal(await b.evaluate(() => window.__ps.session().selection.name), 'Online host map')
  await a.evaluate(() => window.__ps.botsFill(false))
  await b.waitForFunction(() => window.__ps.room.players().length === 2)
  await b.close()
  await a.waitForFunction(() => window.__ps.room.players().length === 1)
  const c = await browser.newPage()
  c.on('pageerror', e => errors.push(e.message))
  await join(c, 'Online Late Guest')
  assert.equal(await c.evaluate(() => window.__ps.room.roomCode), roomCode)
  assert.equal(await c.evaluate(() => window.__ps.botsFill()), false, 'A quick-play default must not overwrite the host’s disabled bots')
  await c.waitForFunction(() => window.__ps.room.players().length === 2)
  await a.evaluate(() => window.__ps.menu(true))
  await a.getByRole('combobox', { name: 'Graphics quality' }).selectOption('medium')
  assert.equal(await a.evaluate(() => window.__ps.engine.graphics.quality), 'medium')
  await a.getByRole('combobox', { name: 'Graphics quality' }).selectOption('low')
  assert.equal(await a.evaluate(() => window.__ps.engine.post.settings.enabled), false)
  assert.deepEqual(errors, [])
  console.log('Public matchmaking: independent clients share a room, bots yield seats, late joiners adopt host map/bot settings, live graphics settings work; no runtime errors')
} finally { await browser.close() }

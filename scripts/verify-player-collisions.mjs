/** Two real Playroom clients. Run against a dev server or preview; creates a temporary room. */
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.BASE_URL || 'http://localhost:5181'
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: [
  '--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
] })
try {
  const host = await browser.newPage(), guest = await browser.newPage()
  const errors = []
  for (const page of [host, guest]) page.on('pageerror', e => errors.push(e.message))
  await host.goto(`${base}/?debug=1&webgl=1`)
  await host.getByPlaceholder('Your name').fill('Collision Host')
  await host.getByRole('combobox', { name: 'Match type' }).selectOption('private')
  await host.getByRole('button', { name: 'Create private room', exact: true }).click()
  await host.waitForFunction(() => window.__ps?.registry, {}, { timeout: 90000 })
  await host.waitForFunction(() => window.__ps.host())
  await host.evaluate(() => { window.__ps.botsFill(false); return window.__ps.pickTeam('a') })
  const hash = await host.evaluate(() => location.hash)
  await guest.goto(`${base}/?debug=1&webgl=1${hash}`)
  await guest.getByPlaceholder('Your name').fill('Collision Guest')
  await guest.getByRole('button', { name: 'Join match', exact: true }).click()
  await guest.waitForFunction(() => window.__ps?.registry, {}, { timeout: 90000 })
  await guest.evaluate(() => window.__ps.pickTeam('b'))
  await host.waitForFunction(() => window.__ps.registry.list().length === 2)
  await guest.waitForTimeout(5000)
  const target = await guest.evaluate(() => window.__ps.registry.local.id)
  const hostId = await host.evaluate(() => window.__ps.registry.local.id)

  async function placePair() {
    await guest.evaluate(() => window.__ps.stop())
    await host.evaluate(() => { const g = window.__ps; g.stop(); g.menu(false); g.local().place([-5, .1, 13], -Math.PI / 2) })
    // Let the guest see the host's teleport before placing it near the old host position.
    await guest.waitForFunction(id => Math.abs(window.__ps.registry.get(id)?.position.x + 5) < .1, hostId)
    await guest.evaluate(() => { const g = window.__ps; g.stop(); g.menu(false); g.local().place([-3, .1, 13], Math.PI / 2) })
    await host.waitForFunction(id => Math.abs(window.__ps.registry.get(id)?.position.x + 3) < .1, target).catch(async error => {
      for (const page of [host, guest]) console.log(JSON.stringify(await page.evaluate(() => window.__ps.registry.list().map(e => ({
        id: e.id, local: e.isLocal, alive: e.alive, position: e.position, speed: e.speed,
      })))))
      throw error
    })
    await host.waitForTimeout(300)
  }
  async function checkBlocked(mover) {
    await mover.evaluate(() => window.__ps.move(1, 0))
    await mover.waitForTimeout(1400)
    const x = await host.evaluate(() => window.__ps.registry.local.position.x)
    const otherX = await guest.evaluate(() => window.__ps.registry.local.position.x)
    assert(otherX - x > .55 && otherX - x < .7, `Expected adjacent solid players; separation ${otherX - x}`)
    await mover.evaluate(() => window.__ps.stop())
    console.log(`Blocked ${mover === host ? 'host' : 'guest'}: separation ${(otherX - x).toFixed(3)} m`)
  }
  await placePair()
  await checkBlocked(host)
  await placePair()
  await checkBlocked(guest)

  await placePair()
  await checkBlocked(host)
  // Exercise the real kill RPC so the remote alive state, not a local fixture, removes contact.
  for (let i = 0; i < 5; i++) {
    assert(await host.evaluate(({ target, i }) => {
      const g = window.__ps, e = g.registry.get(target)
      return g.host().submitHit({ by: g.room.me.id, target, shotId: `collision-check:${i}`,
        point: [e.position.x, e.position.y + 1.2, e.position.z], normal: [1, 0, 0], part: 'torso', weapon: 'rifle' })
    }, { target, i }))
    await host.waitForTimeout(110)
  }
  await host.waitForFunction(id => window.__ps.registry.get(id)?.alive === false, target)
  await host.evaluate(() => window.__ps.move(1, 0))
  await host.waitForTimeout(650)
  assert.equal(await guest.evaluate(() => window.__ps.registry.local.alive), false)
  assert(await host.evaluate(() => window.__ps.registry.local.position.x > -2.5), 'Must walk through the dead player before respawn')
  await host.evaluate(() => window.__ps.stop())
  console.log('Death stops blocking while the corpse is still present')
  await guest.waitForFunction(() => window.__ps.registry.local.alive, {}, { timeout: 10000 })
  await placePair()
  await checkBlocked(host)
  console.log('Respawn restores blocking')

  // The team balancer allows sharing a side with bot fill enabled. Remove the fill again
  // immediately so bot combat cannot interfere with this movement check.
  assert((await host.evaluate(target => {
    const g = window.__ps
    g.botsFill(true)
    const result = g.host().requestTeam(target, 'a')
    g.botsFill(false)
    return result
  }, target)).ok)
  await host.waitForFunction(() => window.__ps.registry.list().length === 2)
  await guest.waitForFunction(() => window.__ps.registry.local.team === 'a')
  await guest.waitForTimeout(1000)
  await placePair()
  await checkBlocked(host)
  console.log('Teammates also block')
  assert.deepEqual(errors, [])
  console.log('No browser runtime errors')
} finally { await browser.close() }

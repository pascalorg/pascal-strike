/**
 * Boot. Query flags route to package dev entries during development:
 *   ?dev=map      W1-A map/renderer viewer (fly camera)
 *   ?sandbox=1    W1-B player + weapons in the procedural test room
 *   ?dev=ui       W1-C lobby/HUD showcase with fake data
 *   ?dev=net      W1-C Playroom net harness (real room, text UI)
 * Default: lobby → game (W2 wires this).
 */
import './ui/styles.css'

const params = new URLSearchParams(location.search)

async function boot() {
  if (params.get('dev') === 'map') {
    const mod = await import('./dev/map-viewer')
    await mod.start()
    return
  }
  if (params.get('sandbox') === '1') {
    const mod = await import('./dev/sandbox')
    await mod.start()
    return
  }
  if (params.get('dev') === 'ui') {
    const mod = await import('./dev/ui-showcase')
    await mod.start()
    return
  }
  if (params.get('dev') === 'net') {
    const mod = await import('./dev/net-harness')
    await mod.start()
    return
  }
  const app = document.getElementById('app')!
  app.innerHTML = `<div style="padding:2rem;font-family:system-ui;color:#fafafa;background:#0d0d0f;min-height:100vh">
    <h1>Pascal Strike</h1><p>Game wiring not done yet. Try <code>?dev=map</code>, <code>?sandbox=1</code> or <code>?dev=ui</code>.</p></div>`
}

boot().catch((err) => {
  console.error(err)
  const app = document.getElementById('app')
  if (app) app.textContent = `Boot failed: ${err?.message ?? err}`
})

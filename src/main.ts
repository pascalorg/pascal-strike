/**
 * Boot. Query flags route to package dev entries during development:
 *   ?dev=map      W1-A map/renderer viewer (fly camera)
 *   ?sandbox=1    W1-B player + weapons in the procedural test room
 *   ?dev=ui       W1-C lobby/HUD showcase with fake data
 *   ?dev=net      W1-C Playroom net harness (real room, text UI)
 *   ?debug=1      in-game debug panel (FPS, backend, entities, N navmesh, C collider)
 * Default: platform check → lobby → room → game.
 */
import './ui/styles.css'
import { appRoot, el } from './ui/dom'
import { showLobby } from './ui/lobby'
import { isTouchOnly, showUnsupported } from './ui/unsupported'

// `net/room` pulls in playroomkit (which bundles React and phones home) and `storage/maps-upload`
// pulls in supabase-js. Both are imported lazily, inside the play route only, so the package dev
// entries (?dev=map, ?sandbox=1, ?dev=ui) stay free of them.

const params = new URLSearchParams(location.search)

async function boot(): Promise<void> {
  if (params.get('dev') === 'map') return (await import('./dev/map-viewer')).start()
  if (params.get('sandbox') === '1') return (await import('./dev/sandbox')).start()
  if (params.get('dev') === 'ui') return (await import('./dev/ui-showcase')).start()
  if (params.get('dev') === 'net') return (await import('./dev/net-harness')).start()

  if (isTouchOnly()) {
    showUnsupported('mobile')
    return
  }
  if (!hasGpu()) {
    showUnsupported('gpu')
    return
  }
  await play()
}

async function play(): Promise<void> {
  const mount = appRoot()
  const [{ joinRoom, roomCodeFromHash, RoomError }, { isConfigured, uploadMap }, { RendererInitError }] =
    await Promise.all([
      import('./net/room'),
      import('./storage/maps-upload'),
      import('./engine/renderer'),
    ])
  const joinCode = roomCodeFromHash() ?? null
  const banner = createBanner(mount)

  for (;;) {
    const lobby = await showLobby({
      joinCode,
      uploader: isConfigured() ? uploadMap : undefined,
      mount,
    })
    banner.clear()
    try {
      const room = await joinRoom({
        name: lobby.name,
        roomCode: lobby.roomCode,
        map: lobby.map,
      })
      lobby.setStatus('Loading the map…', 'ok')
      const { startGame } = await import('./game/game')
      lobby.dispose()
      banner.dispose()
      await startGame({ room, map: lobby.map, mount })
      return
    } catch (err) {
      if (err instanceof RendererInitError) {
        lobby.dispose()
        banner.dispose()
        showUnsupported('gpu')
        return
      }
      // The lobby promise is already settled, so a retry needs a fresh screen; the banner
      // carries the reason across it.
      const message = err instanceof RoomError ? err.message : String((err as Error)?.message ?? err)
      console.error('[main]', err)
      lobby.dispose()
      banner.show(message)
    }
  }
}

/** WebGPU, or the WebGL2 fallback the renderer would pick. */
function hasGpu(): boolean {
  if ('gpu' in navigator) return true
  try {
    return !!document.createElement('canvas').getContext('webgl2')
  } catch {
    return false
  }
}

function createBanner(mount: HTMLElement) {
  const node = el('div', {
    style:
      'position:absolute;top:0;left:0;right:0;z-index:30;display:none;padding:10px 16px;' +
      'text-align:center;font:500 13px Inter,system-ui;color:#fecaca;background:#7f1d1d;',
  })
  mount.appendChild(node)
  return {
    show(message: string) {
      node.textContent = `${message} — try again`
      node.style.display = ''
    },
    clear() {
      node.style.display = 'none'
    },
    dispose() {
      node.remove()
    },
  }
}

boot().catch((err) => {
  console.error(err)
  const app = document.getElementById('app')
  if (app) {
    app.appendChild(
      el('div', {
        style: 'padding:2rem;font:14px Inter,system-ui;color:#fafafa',
        text: `Boot failed: ${err?.message ?? err}`,
      }),
    )
  }
})

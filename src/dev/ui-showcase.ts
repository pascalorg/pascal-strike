/**
 * `?dev=ui` — the whole W1-C interface driven by fake data, so the lobby and the HUD can be
 * designed (and reviewed) without a renderer, a map or a network.
 */
import { BUILTIN_MAPS, MATCH, PLAYER, WEAPON } from '../config'
import { createEntityRegistry } from '../game/entities'
import { createInitialMatch } from '../game/match'
import type { MapSelection, MatchState, PlayerEntity, TeamId } from '../types'
import { appRoot, el } from '../ui/dom'
import { createHud } from '../ui/hud'
import { showLobby } from '../ui/lobby'
import { createScoreboard } from '../ui/scoreboard'

const FAKE_NAMES = ['Wassim', 'Nina', 'Ozan', 'Pixel', 'Voxel', 'Bezier']

export async function start(): Promise<void> {
  const app = appRoot()

  const lobby = await showLobby({
    maps: [...BUILTIN_MAPS.map((m) => ({ ...m })), { id: 'demo-loft', name: 'Sunset Loft', url: '' }],
    uploader: fakeUpload,
  })
  await wait(500)
  lobby.dispose()

  const stage = el('div', { class: 'ps-screen', style: 'padding:0' })
  app.appendChild(stage)

  const registry = createEntityRegistry()
  const entities: PlayerEntity[] = FAKE_NAMES.map((name, i) =>
    registry.upsert({
      id: `p${i}`,
      name: i === 0 ? lobby.name : name,
      team: (i % 2 === 0 ? 'a' : 'b') as TeamId,
      isBot: i >= 4,
      isLocal: i === 0,
      kills: [7, 5, 4, 3, 2, 1][i],
      deaths: [2, 3, 5, 4, 6, 7][i],
    }),
  )
  registry.setLocal('p0')

  const hud = createHud(app)
  const board = createScoreboard({ mount: app, localId: 'p0' })
  hud.setRoom('QK4T2', `${location.origin}${location.pathname}#r=RQK4T2`)

  const t0 = Date.now()
  const match: MatchState = createInitialMatch(t0)
  match.phase = 'live'
  // Start inside the last minute: the showcase only runs for 40 s, and the clock's warning
  // states (orange under a minute, pulsing under ten seconds) are the ones worth reviewing.
  match.endsAt = t0 + Math.min(MATCH.durationMs, 52_000)
  hud.setPhase('live')

  let hp = PLAYER.maxHp
  let hopper = WEAPON.hopperSize
  let reloading = false
  let ended = false
  const timers: number[] = []

  // Match clock + a hopper that drains like someone is holding fire.
  timers.push(
    window.setInterval(() => {
      hud.setScores(match.scores.a, match.scores.b, match.endsAt - Date.now())
      if (reloading) return
      hopper = Math.max(0, hopper - 1)
      hud.setHopper(hopper, false)
      if (hopper === 0) {
        reloading = true
        hud.setHopper(0, true)
        window.setTimeout(() => {
          hopper = WEAPON.hopperSize
          reloading = false
          hud.setHopper(hopper, false)
        }, WEAPON.reloadMs)
      }
    }, 110),
  )

  timers.push(window.setInterval(() => hud.hitMarker(), 2000))

  timers.push(
    window.setInterval(() => {
      const [killer, victim] = pickPair(entities)
      killer.kills++
      victim.deaths++
      match.scores[killer.team]++
      hud.killFeed({
        killer: killer.id,
        victim: victim.id,
        killerTeam: killer.team,
        victimTeam: victim.team,
        killerName: killer.name,
        victimName: victim.name,
        killerBot: killer.isBot,
        victimBot: victim.isBot,
      })
    }, 3000),
  )

  timers.push(
    window.setInterval(() => {
      const angle = Math.random() * Math.PI * 2
      hud.damageFrom([Math.sin(angle), Math.cos(angle)], Math.random() < 0.5 ? 'a' : 'b')
      hp = Math.max(0, hp - PLAYER.hitDamage)
      hud.setHp(hp)
      if (hp === 0) deathSequence()
    }, 5000),
  )

  const deathSequence = () => {
    const deadline = Date.now() + PLAYER.respawnDelayMs
    const tick = window.setInterval(() => {
      const left = deadline - Date.now()
      hud.setRespawn(left)
      if (left > 0) return
      window.clearInterval(tick)
      hud.setRespawn(0)
      hp = PLAYER.maxHp
      hud.setHp(hp)
      hud.setInvincible(true)
      window.setTimeout(() => hud.setInvincible(false), PLAYER.invincibleMs)
    }, 50)
    timers.push(tick)
  }

  // Crosshair breathing so the spread behaviour is visible.
  let t = 0
  timers.push(
    window.setInterval(() => {
      t += 0.06
      hud.setSpread((Math.sin(t) * 0.5 + 0.5) * 0.6)
      hud.setFps(58 + Math.round(Math.sin(t * 0.7) * 4))
    }, 60),
  )

  const onKey = (e: KeyboardEvent) => {
    if (e.code !== 'Tab' || ended) return
    e.preventDefault()
    if (e.type === 'keydown') board.show(registry.list(), match)
    else board.hide()
  }
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)

  // End screen after 40 s, exactly like a real round ending.
  timers.push(
    window.setTimeout(() => {
      ended = true
      match.phase = 'ended'
      match.winner = match.scores.a >= match.scores.b ? 'a' : 'b'
      match.endsAt = Date.now() + MATCH.endScreenMs
      hud.setPhase('ended')
      board.end(match, registry.list())
    }, 40_000),
  )

  Object.assign(window as unknown as Record<string, unknown>, {
    __psUi: { hud, board, registry, match, stop: () => timers.forEach((id) => window.clearTimeout(id)) },
  })
}

function pickPair(entities: PlayerEntity[]): [PlayerEntity, PlayerEntity] {
  const killer = entities[Math.floor(Math.random() * entities.length)]
  const enemies = entities.filter((e) => e.team !== killer.team)
  return [killer, enemies[Math.floor(Math.random() * enemies.length)]]
}

async function fakeUpload(file: File, onProgress: (p: number) => void): Promise<MapSelection> {
  for (let p = 0; p <= 1; p += 0.12) {
    onProgress(Math.min(1, p))
    await wait(90)
  }
  return { id: `fake-${Date.now()}`, name: `Custom · ${file.name.replace(/\.glb$/i, '')}`, url: '' }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * In-match HUD. Every element is driven by explicit method calls — the HUD never reads game
 * state itself, so it stays cheap and testable (see `dev/ui-showcase.ts`).
 */
import { MATCH, PLAYER, TEAMS, WEAPON } from '../config'
import type { MatchPhase, TeamId } from '../types'
import { appRoot, clamp, el, formatClock, svg } from './dom'

export interface KillFeedEntry {
  killer: string
  victim: string
  killerTeam: TeamId
  victimTeam: TeamId
  killerName?: string
  victimName?: string
  killerBot?: boolean
  victimBot?: boolean
}

export interface Hud {
  el: HTMLElement
  setHp(hp: number): void
  setHopper(count: number, reloading?: boolean): void
  setScores(a: number, b: number, msLeft: number): void
  setPhase(phase: MatchPhase, round?: number): void
  killFeed(entry: KillFeedEntry): void
  hitMarker(): void
  /** `dirXZ` is view-space (x = right, y = forward); null = damage from nowhere in particular. */
  damageFrom(dirXZ: [number, number] | null, team: TeamId): void
  setRespawn(ms: number): void
  setInvincible(on: boolean): void
  setRoom(code: string, url: string): void
  /** 0..1 — how far the crosshair arms are pushed out by spread + recoil. */
  setSpread(spread: number): void
  setFps(fps: number | null): void
  dispose(): void
}

const SEGMENTS = 3
const FEED_MAX = 5
const FEED_MS = 6000

export function createHud(mount: HTMLElement = appRoot()): Hud {
  const arms = svg('g', { class: 'ps-ch-arms' }, [
    line(22, 4, 22, 13),
    line(22, 31, 22, 40),
    line(4, 22, 13, 22),
    line(31, 22, 40, 22),
  ])
  const hitmark = svg('g', { class: 'ps-hitmark', stroke: '#fafafa', 'stroke-width': '2.4' }, [
    line(11, 11, 17, 17),
    line(33, 11, 27, 17),
    line(11, 33, 17, 27),
    line(33, 33, 27, 27),
  ])
  const crosshair = el('div', { class: 'ps-crosshair' }, [
    svg('svg', { width: '44', height: '44', viewBox: '0 0 44 44' }, [
      svg('circle', { cx: '22', cy: '22', r: '1.4', fill: '#fafafa' }),
      arms,
      hitmark,
    ]),
  ])

  const scoreA = el('b', { class: 'ps-a', text: '0' })
  const scoreB = el('b', { class: 'ps-b', text: '0' })
  const timer = el('div', { class: 'ps-timer', text: '5:00' })
  const phase = el('div', { class: 'ps-phase', text: '' })
  const topbar = el('div', { class: 'ps-topbar' }, [
    el('div', { class: 'ps-score' }, [scoreA, el('span', { class: 'ps-sep' }), scoreB]),
    timer,
    phase,
  ])

  const segs: HTMLElement[] = []
  const meter = el('div', { class: 'ps-meter' })
  for (let i = 0; i < SEGMENTS; i++) {
    const fill = el('i')
    segs.push(fill)
    meter.appendChild(el('div', { class: 'ps-seg' }, [fill]))
  }
  const hpNum = el('div', { class: 'ps-hp-num' }, [
    el('span', { text: String(PLAYER.maxHp) }),
    el('small', { text: 'HP' }),
  ])
  const hpValue = hpNum.firstElementChild as HTMLElement
  const health = el('div', { class: 'ps-health' }, [hpNum, meter])

  const ammoCount = el('b', { text: String(WEAPON.hopperSize) })
  const ammo = el('div', { class: 'ps-ammo' }, [
    el('div', {}, [ammoCount, el('span', { text: `/${WEAPON.hopperSize}` })]),
    el('em', { text: 'Reloading' }),
  ])

  const feed = el('div', { class: 'ps-feed' })
  const vignette = el('div', { class: 'ps-vignette' })
  const respawnCount = el('div', { class: 'ps-count', text: '2.5' })
  const respawn = el('div', { class: 'ps-respawn' }, [
    el('h2', { text: 'You got splattered' }),
    respawnCount,
    el('p', { text: 'Respawning at your team spawn' }),
  ])
  const shield = el('div', { class: 'ps-shield' }, [el('span', { text: '◈' }), 'Invincible'])
  const fps = el('div', { class: 'ps-fps' })

  const roomCode = el('b', { text: '----' })
  const roomChip = el('div', { class: 'ps-room', title: 'Copy the invite link' }, [
    'Room',
    roomCode,
  ])

  const root = el('div', { class: 'ps-hud' }, [
    crosshair,
    topbar,
    health,
    ammo,
    feed,
    roomChip,
    shield,
    fps,
    vignette,
    respawn,
  ])
  mount.appendChild(root)

  let inviteUrl = ''
  roomChip.addEventListener('click', () => {
    if (!inviteUrl) return
    void navigator.clipboard?.writeText(inviteUrl).then(() => {
      const previous = roomChip.firstChild?.textContent ?? 'Room'
      if (roomChip.firstChild) roomChip.firstChild.textContent = 'Copied '
      window.setTimeout(() => {
        if (roomChip.firstChild) roomChip.firstChild.textContent = previous
      }, 1200)
    })
  })

  let lastA = 0
  let lastB = 0
  const timers = new Set<number>()
  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.delete(id)
      fn()
    }, ms)
    timers.add(id)
    return id
  }

  const hud: Hud = {
    el: root,
    setHp(hp) {
      const value = clamp(hp, 0, PLAYER.maxHp)
      hpValue.textContent = String(Math.round(value))
      const per = PLAYER.maxHp / SEGMENTS
      for (let i = 0; i < SEGMENTS; i++) {
        const fill = clamp((value - i * per) / per, 0, 1)
        segs[i].style.transform = `scaleX(${fill})`
        segs[i].parentElement?.classList.toggle('is-low', value <= PLAYER.hitDamage)
      }
    },
    setHopper(count, reloading = false) {
      ammoCount.textContent = String(Math.max(0, Math.round(count)))
      ammo.classList.toggle('is-reloading', reloading)
    },
    setScores(a, b, msLeft) {
      if (a !== lastA) bump(scoreA, a)
      if (b !== lastB) bump(scoreB, b)
      lastA = a
      lastB = b
      timer.textContent = formatClock(msLeft)
      timer.classList.toggle('is-low', msLeft < 30_000)
    },
    setPhase(p, round) {
      phase.textContent =
        p === 'warmup'
          ? `Warmup${round ? ` · Round ${round}` : ''}`
          : p === 'ended'
            ? 'Round over'
            : ''
    },
    killFeed(entry) {
      const item = el('div', { class: 'ps-feed-item' }, [
        nameSpan(entry.killerName ?? entry.killer, entry.killerTeam, entry.killerBot),
        splat(entry.killerTeam),
        nameSpan(entry.victimName ?? entry.victim, entry.victimTeam, entry.victimBot),
      ])
      feed.appendChild(item)
      while (feed.children.length > FEED_MAX) feed.firstElementChild?.remove()
      later(() => {
        item.classList.add('is-out')
        later(() => item.remove(), 300)
      }, FEED_MS)
    },
    hitMarker() {
      hitmark.classList.remove('is-on')
      void (hitmark as unknown as HTMLElement).getBoundingClientRect()
      hitmark.classList.add('is-on')
    },
    damageFrom(dirXZ, team) {
      const color = TEAMS[team].color
      const angle = dirXZ ? (Math.atan2(dirXZ[0], dirXZ[1]) * 180) / Math.PI : 0
      vignette.style.background = dirXZ
        ? `linear-gradient(${angle}deg, ${hexA(color, 0.55)} 0%, transparent 42%)`
        : `radial-gradient(circle at 50% 50%, transparent 45%, ${hexA(color, 0.5)} 100%)`
      vignette.classList.add('is-on')
      later(() => vignette.classList.remove('is-on'), 90)
    },
    setRespawn(ms) {
      root.classList.toggle('is-dead', ms > 0)
      if (ms <= 0) {
        respawn.classList.remove('is-on')
        return
      }
      respawn.classList.add('is-on')
      respawnCount.textContent = (ms / 1000).toFixed(1)
    },
    setInvincible(on) {
      shield.classList.toggle('is-on', on)
    },
    setRoom(code, url) {
      roomCode.textContent = code || '----'
      inviteUrl = url
    },
    setSpread(spread) {
      const scale = 1 + clamp(spread, 0, 1) * 0.75
      arms.setAttribute('transform', `scale(${scale.toFixed(3)})`)
      arms.style.transformOrigin = '22px 22px'
    },
    setFps(value) {
      fps.classList.toggle('is-on', value !== null)
      if (value !== null) fps.textContent = `${Math.round(value)} fps`
    },
    dispose() {
      for (const id of timers) window.clearTimeout(id)
      timers.clear()
      root.remove()
    },
  }

  hud.setHp(PLAYER.maxHp)
  hud.setScores(0, 0, MATCH.durationMs)
  hud.setSpread(0)
  return hud
}

function line(x1: number, y1: number, x2: number, y2: number): SVGElement {
  return svg('line', {
    x1,
    y1,
    x2,
    y2,
    stroke: '#fafafa',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'shape-rendering': 'geometricPrecision',
  })
}

function nameSpan(name: string, team: TeamId, isBot?: boolean): HTMLElement {
  return el('span', { style: `color:${TEAMS[team].color};font-weight:600` }, [
    name,
    isBot ? el('span', { class: 'ps-tag', text: 'BOT' }) : null,
  ])
}

/** A tiny paint blob so the feed reads as paintball, not as a shooter. */
function splat(team: TeamId): SVGElement {
  return svg('svg', { class: 'ps-splat', viewBox: '0 0 12 12', width: '12', height: '12' }, [
    svg('path', {
      d: 'M6 1.2c1.6 0 2.2 1.1 3.2 1.5 1 .4 1.6 1.5 1.2 2.5-.4 1-.2 1.6.1 2.4.3.9-.5 1.9-1.5 1.8-.9 0-1.4.4-2.1.9-.8.5-2 .2-2.4-.7-.3-.7-.8-1-1.6-1.2C1.9 8.1 1.4 7 1.8 6.1c.3-.7.3-1.3 0-2C1.4 3.2 2.1 2.1 3.1 2.2c.8 0 1.3-.2 1.9-.6.3-.3.7-.4 1-.4Z',
      fill: TEAMS[team].color,
    }),
  ])
}

function bump(node: HTMLElement, value: number) {
  node.textContent = String(value)
  node.classList.add('is-bump')
  window.setTimeout(() => node.classList.remove('is-bump'), 140)
}

function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

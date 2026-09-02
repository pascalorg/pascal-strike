/**
 * In-match HUD. Every element is driven by explicit method calls — the HUD never reads game
 * state itself, so it stays cheap and testable (see `dev/ui-showcase.ts`).
 */
import { MATCH, PLAYER, TEAMS, WEAPON } from '../config'
import type { BodyPart, MatchPhase, TeamId } from '../types'
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
  /** `part` upgrades the marker to the headshot variant, flashed in `team`'s colour. */
  hitMarker(part?: BodyPart, team?: TeamId): void
  /**
   * Paint splash from the direction we were hit: 2-3 blobs at the screen edge that drip and
   * fade over 1.2 s. `dirXZ` is view-space (x = right, y = forward); null = from nowhere in
   * particular. A headshot splashes heavier.
   */
  paintHit(dirXZ: [number, number] | null, team: TeamId, part?: BodyPart): void
  /** Kept for `weapons/effects.ts`'s damage callback — a paint splash with no direction. */
  damageFrom(dirXZ: [number, number] | null, team: TeamId): void
  setRespawn(ms: number): void
  setInvincible(on: boolean): void
  setRoom(code: string, url: string): void
  /** 0..1 — how far the crosshair arms are pushed out by spread + recoil. */
  setSpread(spread: number): void
  setFps(fps: number | null): void
  dispose(): void
}

const FEED_MAX = 5
const FEED_MS = 6000
/** Health bar colour thresholds (hp). Above `HP_WARN` the bar is team-neutral white. */
const HP_WARN = 40
const HP_CRIT = 20
/** How long a paint splash lives on screen. Must match the CSS animation below. */
const PAINT_MS = 1200

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

  // One continuous bar, not three segments: paintball damage comes in 20/34/50 chunks that no
  // segmentation lines up with. The ghost bar behind it shows the hit that just landed.
  const hpGhost = el('i', { class: 'ps-hp-ghost' })
  const hpFill = el('i', { class: 'ps-hp-fill' })
  const meter = el('div', { class: 'ps-hpbar' }, [hpGhost, hpFill])
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
  const paint = el('div', { class: 'ps-paint' })
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
    paint,
    respawn,
  ])
  injectStyles()
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
  let shownHp = PLAYER.maxHp
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
      const fraction = value / PLAYER.maxHp
      hpValue.textContent = String(Math.round(value))
      hpFill.style.transform = `scaleX(${fraction.toFixed(4)})`
      hpFill.classList.toggle('is-warn', value < HP_WARN && value >= HP_CRIT)
      hpFill.classList.toggle('is-crit', value < HP_CRIT)
      hpNum.classList.toggle('is-crit', value < HP_CRIT)
      if (value > shownHp) {
        // Healing (respawn): the ghost has nothing to trail, so snap it to the new value.
        hpGhost.style.transition = 'none'
        hpGhost.style.transform = `scaleX(${fraction.toFixed(4)})`
        void hpGhost.offsetWidth
        hpGhost.style.transition = ''
      } else {
        hpGhost.style.transform = `scaleX(${fraction.toFixed(4)})`
      }
      shownHp = value
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
    hitMarker(part, team) {
      const head = part === 'head'
      hitmark.classList.remove('is-on', 'is-head')
      // A CSS custom property, not the `stroke` attribute: the marker's lines carry their own
      // presentation attribute, which only a style rule can override.
      hitmark.style.setProperty('--hit', head && team ? TEAMS[team].color : '#fafafa')
      void (hitmark as unknown as HTMLElement).getBoundingClientRect()
      hitmark.classList.add('is-on')
      if (head) hitmark.classList.add('is-head')
    },
    paintHit(dirXZ, team, part) {
      const color = TEAMS[team].color
      const head = part === 'head'
      // 0 rad = hit from straight ahead, which splashes at the top edge (the vignette this
      // replaced used the same convention).
      const angle = dirXZ ? Math.atan2(dirXZ[0], dirXZ[1]) : 0
      const blobs = head ? 3 : 2
      for (let index = 0; index < blobs; index++) {
        const random = splashRandom()
        const spread = (index - (blobs - 1) / 2) * 0.42 + (random() - 0.5) * 0.3
        const reach = dirXZ ? 0.4 + random() * 0.1 : 0.46 + random() * 0.06
        const blob = el('div', { class: 'ps-paint-blob' }, [
          blobSvg(color, random, head ? 1.35 : 1),
        ])
        blob.style.left = `${(50 + Math.sin(angle + spread) * reach * 100).toFixed(2)}%`
        blob.style.top = `${(50 - Math.cos(angle + spread) * reach * 62).toFixed(2)}%`
        const size = (head ? 260 : 200) * (0.8 + random() * 0.45)
        blob.style.width = `${size.toFixed(0)}px`
        blob.style.opacity = head ? '1' : '0.9'
        blob.style.setProperty('--roll', `${(random() * 360).toFixed(0)}deg`)
        paint.appendChild(blob)
        later(() => blob.remove(), PAINT_MS)
      }
      // Keep the screen edge tinted for a beat so the direction reads even at 20 hp.
      paint.style.setProperty('--paint', hexA(color, head ? 0.32 : 0.22))
      paint.classList.remove('is-on')
      void paint.offsetWidth
      paint.classList.add('is-on')
      later(() => paint.classList.remove('is-on'), PAINT_MS)
    },
    damageFrom(dirXZ, team) {
      hud.paintHit(dirXZ, team)
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

/**
 * The health bar and the paint splash are new components, and `ui/styles.css` belongs to another
 * package — so this module ships its own rules and injects them once. Everything is prefixed
 * `ps-hp*` / `ps-paint*`, nothing overrides an existing rule.
 */
const STYLE_ID = 'ps-hud-paint-css'

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.ps-hpbar {
  position: relative;
  width: 176px;
  height: 13px;
  border-radius: 4px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.07);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
}
.ps-hpbar i {
  position: absolute;
  inset: 0;
  transform-origin: left center;
  border-radius: 4px;
}
.ps-hp-ghost {
  background: rgba(248, 113, 113, 0.55);
  transition: transform 420ms cubic-bezier(0.4, 0, 0.2, 1) 160ms;
}
.ps-hp-fill {
  background: linear-gradient(180deg, #ffffff, #d4d4d8);
  transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1), background 200ms linear;
}
.ps-hp-fill.is-warn { background: linear-gradient(180deg, #fdba74, #f97316); }
.ps-hp-fill.is-crit { background: linear-gradient(180deg, #fca5a5, #ef4444); }
.ps-hp-num.is-crit { color: #fca5a5; animation: ps-hp-pulse 900ms ease-in-out infinite; }
@keyframes ps-hp-pulse { 50% { opacity: 0.55; } }

.ps-paint {
  position: absolute;
  inset: 0;
  overflow: hidden;
  opacity: 0;
  --paint: rgba(249, 115, 22, 0.22);
  background: radial-gradient(circle at 50% 50%, transparent 58%, var(--paint) 100%);
  transition: opacity 700ms ease-out;
}
.ps-paint.is-on { opacity: 1; transition-duration: 70ms; }
.ps-paint-blob {
  position: absolute;
  transform: translate(-50%, -50%) rotate(var(--roll, 0deg));
  animation: ps-splash 1200ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
  will-change: transform, opacity;
}
.ps-paint-blob svg { display: block; width: 100%; height: auto; }
@keyframes ps-splash {
  0% { opacity: 0; transform: translate(-50%, -50%) rotate(var(--roll, 0deg)) scale(0.45); }
  8% { opacity: 1; transform: translate(-50%, -50%) rotate(var(--roll, 0deg)) scale(1.1); }
  60% { opacity: 1; transform: translate(-50%, -44%) rotate(var(--roll, 0deg)) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -32%) rotate(var(--roll, 0deg)) scale(1.04); }
}
.ps-paint-drip {
  transform-box: fill-box;
  transform-origin: top center;
  animation: ps-drip 1200ms cubic-bezier(0.33, 0, 0.67, 1) forwards;
}
@keyframes ps-drip { from { transform: scaleY(0.15); } to { transform: scaleY(1); } }

.ps-hitmark line { stroke: var(--hit, #fafafa); }
.ps-hitmark.is-on.is-head { animation: ps-hit-head 320ms ease-out; }
@keyframes ps-hit-head {
  0% { opacity: 1; transform: scale(0.6); }
  100% { opacity: 0; transform: scale(1.75); }
}
@media (prefers-reduced-motion: reduce) {
  .ps-paint-blob, .ps-paint-drip { animation-duration: 1ms; }
  .ps-hp-fill, .ps-hp-ghost { transition: none; }
}
`
  document.head.appendChild(style)
}

let splashSeed = 0x9e3779b9

/** Deterministic-ish per-blob randomness; a real Math.random would do, this keeps it cheap. */
function splashRandom(): () => number {
  let value = (splashSeed = Math.imul(splashSeed ^ (splashSeed >>> 15), 0x2545f491) >>> 0)
  return () => {
    value = Math.imul(value ^ (value >>> 13), 0x85ebca6b) >>> 0
    return value / 4294967296
  }
}

/** An irregular paint blob with 2-3 drips running off its bottom edge. */
function blobSvg(color: string, random: () => number, scale: number): SVGElement {
  const count = 13
  const ring: [number, number][] = []
  for (let index = 0; index < count; index++) {
    const angle = (index / count) * Math.PI * 2
    const radius = 25 + random() * 13 * scale
    ring.push([50 + Math.cos(angle) * radius, 46 + Math.sin(angle) * radius * 0.92])
  }
  // Quadratic curves through the midpoints: a paint blob has no straight edges.
  const mid = (a: [number, number], b: [number, number]) =>
    `${((a[0] + b[0]) / 2).toFixed(1)},${((a[1] + b[1]) / 2).toFixed(1)}`
  let d = `M${mid(ring[count - 1], ring[0])}`
  for (let index = 0; index < count; index++) {
    const current = ring[index]
    d += ` Q${current[0].toFixed(1)},${current[1].toFixed(1)} ${mid(current, ring[(index + 1) % count])}`
  }
  const children: SVGElement[] = [svg('path', { d: `${d}Z`, fill: color })]
  const drips = 2 + Math.floor(random() * 2)
  for (let index = 0; index < drips; index++) {
    const x = 30 + random() * 40
    const length = 12 + random() * 26 * scale
    children.push(
      svg('ellipse', {
        class: 'ps-paint-drip',
        cx: x.toFixed(1),
        cy: (66 + length / 2).toFixed(1),
        rx: (3 + random() * 3).toFixed(1),
        ry: (length / 2).toFixed(1),
        fill: color,
        style: `animation-delay:${(random() * 160).toFixed(0)}ms`,
      }),
    )
  }
  return svg('svg', { viewBox: '0 0 100 100', width: '100%', height: '100%' }, children)
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

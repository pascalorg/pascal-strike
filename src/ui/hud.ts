/**
 * In-match HUD. Every element is driven by explicit method calls — the HUD never reads game
 * state itself, so it stays cheap and testable (see `dev/ui-showcase.ts`).
 */
import { ARMOR, MATCH, PLAYER, TEAMS, WEAPONS } from '../config'
import type { BodyPart, MatchPhase, TeamId, WeaponKind } from '../types'
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
  setArmor(armor: number): void
  confirmKill(name: string): void
  setPointerReleased(free: boolean): void
  /** Rounds left in the magazine; `Infinity` (the knife) shows as a dash. */
  setHopper(count: number, reloading?: boolean): void
  /** Which slot is in hand: lights its dot and renames the widget. */
  setWeapon(kind: WeaponKind): void
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
  /**
   * Show or hide the whole HUD. Hidden while the team screen is up: every widget keeps being
   * driven underneath, so the frame after `setVisible(true)` is already current.
   */
  setVisible(visible: boolean): void
  dispose(): void
}

const FEED_MAX = 5
const FEED_MS = 6000
/** Health bar colour thresholds (hp). Above `HP_WARN` the bar is team-neutral white. */
const HP_WARN = 40
const HP_CRIT = 20
/** Clock warnings: orange under a minute, breathing under ten seconds. */
const CLOCK_LOW_MS = 60_000
const CLOCK_URGENT_MS = 10_000
/** Below this fraction of the magazine the ammo number turns orange. */
const LOW_AMMO = 0.25
/** How long a paint splash lives on screen. Must match the CSS animation below. */
const PAINT_MS = 1200

export function createHud(mount: HTMLElement = appRoot()): Hud {
  const arms = svg('g', { class: 'ps-ch-arms' }, [
    line(22, 4, 22, 13),
    line(22, 31, 22, 40),
    line(4, 22, 13, 22),
    line(31, 22, 40, 22),
  ])
  let hitAnimation: Animation | undefined
  let killAnimation: Animation | undefined
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

  // Scores and clock ride the same pill. A bare grey clock disappeared into the shadows of the
  // house; a translucent plate under it is the only thing that holds its contrast on *any*
  // backdrop, black corridor or white plaster wall.
  const scoreA = el('b', { class: 'ps-a', text: '0' })
  const scoreB = el('b', { class: 'ps-b', text: '0' })
  const timer = el('div', { class: 'ps-timer', text: formatClock(MATCH.durationMs) })
  const phase = el('div', { class: 'ps-phase', text: '' })
  const topbar = el('div', { class: 'ps-topbar' }, [
    el('div', { class: 'ps-score' }, [
      scoreA,
      el('span', { class: 'ps-sep' }),
      timer,
      el('span', { class: 'ps-sep' }),
      scoreB,
    ]),
    phase,
  ])

  // One continuous bar, not three segments: paintball damage comes in 20/34/50 chunks that no
  // segmentation lines up with. The ghost bar behind it shows the hit that just landed. The
  // heart and the "HP" caps are what make the widget read as health rather than as a paint gauge.
  const hpGhost = el('i', { class: 'ps-hp-ghost' })
  const hpFill = el('i', { class: 'ps-hp-fill' })
  const meter = el('div', { class: 'ps-hpbar' }, [hpGhost, hpFill])
  const hpValue = el('b', { text: String(PLAYER.maxHp) })
  const hpNum = el('div', { class: 'ps-hp-num' }, [hpValue, el('small', { text: 'HP' })])
  const health = el('div', { class: 'ps-health' }, [
    heartSvg(),
    el('div', { class: 'ps-hp-col' }, [hpNum, meter]),
  ])

  // Weapon widget: name, the three slot chips, then the magazine. `∞` is the reserve — you
  // never run out of paint, only out of what is in the gun. The hairline under the number is
  // the reload, timed from the weapon's own `reloadMs`.
  const weaponName = el('i', { class: 'ps-weapon-name', text: WEAPONS.rifle.label })
  const slotDots = WEAPON_SLOTS.map((kind, index) =>
    el('i', { class: index === 0 ? 'is-on' : '', text: String(WEAPONS[kind].slot) }))
  const slots = el('div', { class: 'ps-slots' }, slotDots)
  const ammoCount = el('b', { text: String(WEAPONS.rifle.ammo) })
  const ammoSuffix = el('span', { text: '/ ∞' })
  const reloadFill = el('i')
  const ammo = el('div', { class: 'ps-ammo' }, [
    el('div', { class: 'ps-weapon' }, [weaponName, slots]),
    el('div', { class: 'ps-ammo-num' }, [ammoCount, ammoSuffix]),
    el('div', { class: 'ps-reload' }, [reloadFill]),
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

  const armorValue = el('b', { text: String(ARMOR.max) })
  const armor = el('div', { class: 'ps-armor', 'aria-label': 'Armor and helmet' }, ['◈ ', armorValue, ' ARMOR'])
  const killConfirm = el('div', { class: 'ps-kill-confirm', role: 'status', 'aria-live': 'polite' })
  const pointerHint = el('div', { class: 'ps-pointer-hint', text: 'Pointer free · click the game or press P to resume', hidden: true })
  const root = el('div', { class: 'ps-hud' }, [
    armor, killConfirm, pointerHint,
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
  /** Magazine size and reload time of the weapon in hand: `setHopper` only gets a count and a
   * boolean, so the low-ammo tint and the reload line are timed from what `setWeapon` last saw. */
  let ammoMax: number = WEAPONS.rifle.ammo
  let reloadMs: number = WEAPONS.rifle.reloadMs
  let reloadShown = false
  /** The clock only warns during `live`: a 5 s warmup would otherwise spend all of it flashing. */
  let shownPhase: MatchPhase = 'live'
  const timers = new Set<number>()
  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.delete(id)
      fn()
    }, ms)
    timers.add(id)
    return id
  }

  /** Run the reload line from empty to full over the weapon's own reload time. */
  const startReloadLine = () => {
    reloadFill.style.transition = 'none'
    reloadFill.style.transform = 'scaleX(0)'
    void reloadFill.offsetWidth
    reloadFill.style.transition = `transform ${Math.max(1, reloadMs)}ms linear`
    reloadFill.style.transform = 'scaleX(1)'
  }

  const hud: Hud = {
    el: root,
    setPointerReleased(free) { pointerHint.hidden = !free },
    setArmor(value) {
      armorValue.textContent = String(Math.max(0, Math.round(value)))
      armor.classList.toggle('is-empty', value <= 0)
    },
    confirmKill(name) {
      killConfirm.textContent = `ELIMINATED · ${name}`
      killAnimation?.cancel()
      killAnimation = killConfirm.animate([{ opacity: 0, transform: 'translate(-50%, 8px)' }, { opacity: 1, transform: 'translate(-50%, 0)', offset: .12 }, { opacity: 1, offset: .75 }, { opacity: 0, transform: 'translate(-50%, -4px)' }], { duration: 1800 })
      hitAnimation?.cancel()
      hitmark.style.setProperty('--hit', '#ffcf70')
      hitAnimation = hitmark.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 550 })
    },
    setHp(hp) {
      const value = clamp(hp, 0, PLAYER.maxHp)
      const fraction = value / PLAYER.maxHp
      hpValue.textContent = String(Math.round(value))
      hpFill.style.transform = `scaleX(${fraction.toFixed(4)})`
      const warn = value < HP_WARN && value >= HP_CRIT
      const crit = value < HP_CRIT
      hpFill.classList.toggle('is-warn', warn)
      hpFill.classList.toggle('is-crit', crit)
      // On the pill, so the heart, the number and the bar all say the same thing at a glance.
      health.classList.toggle('is-warn', warn)
      health.classList.toggle('is-crit', crit)
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
      // The knife has no magazine: `Infinity` reads as a dash, not as "Infinity".
      const finite = Number.isFinite(count)
      ammoCount.textContent = finite ? String(Math.max(0, Math.round(count))) : '—'
      ammoSuffix.hidden = !finite
      ammoCount.classList.toggle('is-low', finite && ammoMax > 0 && count / ammoMax < LOW_AMMO)
      ammo.classList.toggle('is-reloading', reloading)
      if (reloading !== reloadShown) {
        reloadShown = reloading
        if (reloading) startReloadLine()
      }
    },
    setWeapon(kind) {
      const spec = WEAPONS[kind]
      weaponName.textContent = spec.label
      ammoMax = spec.ammo
      reloadMs = spec.reloadMs
      for (let index = 0; index < slotDots.length; index++) {
        slotDots[index].classList.toggle('is-on', WEAPON_SLOTS[index] === kind)
      }
      if (!Number.isFinite(spec.ammo)) {
        ammoCount.textContent = '—'
        ammoCount.classList.remove('is-low')
        ammoSuffix.hidden = true
      } else {
        ammoSuffix.hidden = false
      }
    },
    setScores(a, b, msLeft) {
      if (a !== lastA) bump(scoreA, a)
      if (b !== lastB) bump(scoreB, b)
      lastA = a
      lastB = b
      timer.textContent = formatClock(msLeft)
      const live = shownPhase === 'live'
      timer.classList.toggle('is-low', live && msLeft < CLOCK_LOW_MS)
      timer.classList.toggle('is-urgent', live && msLeft < CLOCK_URGENT_MS)
    },
    setPhase(p, round) {
      shownPhase = p
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
      hitmark.classList.toggle('is-head', head)
      hitmark.style.setProperty('--hit', head ? '#ffcf70' : '#ffffff')
      hitAnimation?.cancel()
      hitAnimation = hitmark.animate([{ opacity: 1 }, { opacity: 1, offset: .35 }, { opacity: 0 }], { duration: head ? 420 : 300 })
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
    setVisible(visible) {
      root.classList.toggle('is-hidden', !visible)
    },
    dispose() {
      hitAnimation?.cancel()
      killAnimation?.cancel()
      for (const id of timers) window.clearTimeout(id)
      timers.clear()
      root.remove()
    },
  }

  hud.setHp(PLAYER.maxHp)
  hud.setScores(0, 0, MATCH.durationMs)
  hud.setSpread(0)
  hud.setWeapon('rifle')

  // The weapon widget is driven by `game/game.ts` (`setWeapon` on every switch, `setHopper` from
  // the HUD poll), like every other widget here; the `ps:weapon` bridge it used meanwhile is gone.
  return hud
}

/** Slot order of the weapon dots, 1 → 3. */
const WEAPON_SLOTS: readonly WeaponKind[] = ['rifle', 'pistol', 'knife']

/**
 * The paint splash is generated markup (blobs with per-hit geometry), so its rules travel with
 * the code that builds them instead of living in `ui/styles.css` next to the static widgets.
 * Everything here is prefixed `ps-paint*` / `ps-hitmark*`.
 */
const STYLE_ID = 'ps-hud-paint-css'

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
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
  .ps-hitmark.is-on, .ps-hitmark.is-on.is-head { animation-duration: 1ms; }
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

/**
 * The health pill's glyph. A heart is the one shape nobody has to be taught: without it the bar
 * read as another paint gauge next to the hopper.
 */
function heartSvg(): SVGElement {
  return svg('svg', { class: 'ps-hp-icon', viewBox: '0 0 24 24', width: '19', height: '19' }, [
    svg('path', {
      d: 'M12 21.05 10.6 19.8C5.5 15.2 2.1 12.1 2.1 8.35 2.1 5.28 4.5 2.9 7.55 2.9c1.72 0 3.38.8 4.45 2.07A5.9 5.9 0 0 1 16.45 2.9c3.05 0 5.45 2.38 5.45 5.45 0 3.75-3.4 6.85-8.5 11.46L12 21.05Z',
      fill: 'currentColor',
    }),
  ])
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

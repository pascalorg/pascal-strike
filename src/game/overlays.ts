/**
 * The DOM the game owns on top of the HUD (W2): the loading screen, the Esc menu and the
 * `?debug=1` panel — plus the status snapshot both the panel and `window.__ps.state()` read.
 *
 * Everything here is plain DOM on the shared Pascal tokens from `ui/styles.css`; the in-match
 * HUD proper lives in `ui/hud.ts` and is not touched by this file.
 */
import { BUILTIN_MAPS } from '../config'
import type { Room } from '../net/room'
import { isConfigured, uploadMap } from '../storage/maps-upload'
import type { MapSelection, MatchState } from '../types'
import { el } from '../ui/dom'
import type { EntityRegistry } from './entities'
import type { LocalPlayer } from './local-player'
import type { MapSession } from './map-session'
import { msLeft } from './match'

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadingOverlay {
  set(progress: number, text: string): void
  show(): void
  hide(): void
  dispose(): void
}

export function createLoadingOverlay(mount: HTMLElement): LoadingOverlay {
  const bar = el('i', {
    style: 'display:block;height:100%;width:0;background:var(--team-a);transition:width 160ms',
  })
  const label = el('div', { class: 'ps-map-meta', style: 'margin-top:10px', text: 'Loading' })
  const screen = el('div', { class: 'ps-screen', style: 'z-index:20' }, [
    el('div', { class: 'ps-card', style: 'max-width:420px;text-align:center' }, [
      el('h1', { class: 'ps-title', html: 'Pascal <em>Strike</em>' }),
      el(
        'div',
        { style: 'height:6px;border-radius:99px;background:#27272a;overflow:hidden;margin-top:18px' },
        [bar],
      ),
      label,
    ]),
  ])
  mount.appendChild(screen)
  return {
    set(progress, text) {
      bar.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`
      label.textContent = text
    },
    show() {
      screen.style.display = ''
    },
    hide() {
      screen.style.display = 'none'
    },
    dispose() {
      screen.remove()
    },
  }
}

// ---------------------------------------------------------------------------
// Pause / Esc menu
// ---------------------------------------------------------------------------

export interface PauseMenuOptions {
  mount: HTMLElement
  room: Room
  isHost(): boolean
  onResume(): void
  onMap(map: MapSelection): void
  onAudio(on: boolean): void
  onLeave(): void
  /** Room state: does the host fill empty slots with bots? Read while the menu is open. */
  botsFill(): boolean
  /** Host-only — the menu never calls this for anyone else. */
  setBotsFill(on: boolean): void
}

export interface PauseMenu {
  readonly isOpen: boolean
  open(): void
  close(): void
  dispose(): void
}

export function createPauseMenu(opts: PauseMenuOptions): PauseMenu {
  const note = el('div', { class: 'ps-note' })
  const mapsRow = el('div', { class: 'ps-maps', style: 'margin-top:10px' })
  const mapsField = el('div', { class: 'ps-field', style: 'display:none' }, [
    el('label', { class: 'ps-label', text: 'Change map — everyone reloads' }),
    mapsRow,
  ])
  const resume = el('button', { class: 'ps-btn ps-btn--primary ps-btn--block' }, ['Play'])
  const invite = el('button', { class: 'ps-btn ps-btn--block' }, ['Copy invite link'])
  const sound = el('button', { class: 'ps-btn ps-btn--block' }, ['Sound: on'])
  const bots = el('button', { class: 'ps-btn ps-btn--block' }, ['Bots: on'])
  const leave = el('button', { class: 'ps-btn ps-btn--ghost ps-btn--block' }, ['Leave to lobby'])
  const screen = el('div', { class: 'ps-screen', style: 'z-index:15;display:none' }, [
    el('div', { class: 'ps-card', style: 'max-width:440px' }, [
      el('h1', { class: 'ps-title', html: 'Pascal <em>Strike</em>' }),
      el('p', {
        class: 'ps-tagline',
        html: '<b>WASD</b> move · <b>SHIFT</b> walk · <b>SPACE</b> jump · <b>CTRL</b> crouch · <b>R</b> reload · <b>E</b> doors · <b>TAB</b> scores · <b>ESC</b> menu',
      }),
      mapsField,
      el('div', { class: 'ps-actions' }, [resume, invite, sound, bots, leave, note]),
    ]),
  ])
  opts.mount.appendChild(screen)

  const fileInput = el('input', { type: 'file', accept: '.glb', style: 'display:none' })
  screen.appendChild(fileInput)
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (!file) return
    note.textContent = `Uploading ${file.name}…`
    uploadMap(file, (p) => {
      note.textContent = `Uploading ${file.name}… ${Math.round(p * 100)}%`
    })
      .then((map) => {
        note.textContent = `${map.name} is live for everyone.`
        opts.onMap(map)
      })
      .catch((err: Error) => {
        note.textContent = err.message
      })
  })

  const renderMaps = () => {
    mapsField.style.display = opts.isHost() ? '' : 'none'
    if (!opts.isHost() || mapsRow.childElementCount > 0) return
    for (const builtin of BUILTIN_MAPS) {
      const card = el('button', { class: 'ps-map', type: 'button' }, [
        el('span', { class: 'ps-map-name', text: builtin.name }),
        el('span', { class: 'ps-map-meta', text: 'Built-in · Pascal export' }),
      ])
      card.addEventListener('click', () => opts.onMap({ ...builtin }))
      mapsRow.appendChild(card)
    }
    if (isConfigured()) {
      const drop = el('button', { class: 'ps-drop', type: 'button' }, [
        el('span', { html: '<b>Upload a Pascal GLB</b> &nbsp;·&nbsp; everyone reloads' }),
      ])
      drop.addEventListener('click', () => fileInput.click())
      mapsRow.appendChild(drop)
    }
  }

  /**
   * The host owns the setting, so everyone else gets the same line without a button: the state
   * is the room's, not this client's. Re-read on a timer so a flip by the host (or a host
   * migration) shows up on a menu that is already open.
   */
  const renderBots = () => {
    const on = opts.botsFill()
    const host = opts.isHost()
    bots.textContent = host
      ? `Bots fill empty slots: ${on ? 'on' : 'off'}`
      : `Bots: ${on ? 'on' : 'off'}`
    bots.toggleAttribute('disabled', !host)
    bots.title = host
      ? 'Off empties the room of bots; on refills both teams to three.'
      : 'Only the host can change this.'
  }

  let open = false
  let audioOn = true

  const menu: PauseMenu = {
    get isOpen() {
      return open
    },
    open() {
      if (open) return
      open = true
      renderMaps()
      renderBots()
      screen.style.display = ''
    },
    close() {
      if (!open) return
      open = false
      screen.style.display = 'none'
    },
    dispose() {
      window.clearInterval(botsTimer)
      screen.remove()
    },
  }

  const botsTimer = window.setInterval(() => {
    if (open) renderBots()
  }, 500)

  resume.addEventListener('click', () => {
    menu.close()
    opts.onResume()
  })
  invite.addEventListener('click', () => {
    note.textContent = opts.room.inviteUrl
    void navigator.clipboard?.writeText(opts.room.inviteUrl).then(() => {
      note.textContent = 'Invite link copied to the clipboard.'
    })
  })
  sound.addEventListener('click', () => {
    audioOn = !audioOn
    sound.textContent = `Sound: ${audioOn ? 'on' : 'off'}`
    opts.onAudio(audioOn)
  })
  bots.addEventListener('click', () => {
    if (!opts.isHost()) return
    const next = !opts.botsFill()
    opts.setBotsFill(next)
    renderBots()
    note.textContent = next
      ? 'Bots will refill both teams to three.'
      : 'Bots kicked — humans only until you turn this back on.'
  })
  leave.addEventListener('click', () => opts.onLeave())

  return menu
}

// ---------------------------------------------------------------------------
// Debug panel + status snapshot
// ---------------------------------------------------------------------------

/** Everything the debug panel and `window.__ps.state()` need, sampled at call time. */
export interface GameStatus {
  backend: string
  fps: number
  room: Room
  clockOffset: number
  now: number
  registry: EntityRegistry
  /** Null for the length of a map change: the old world is gone, the next one is loading. */
  session: MapSession | null
  match: MatchState | null
  local: LocalPlayer
  bots: boolean
  /** Room setting, not "is the bot runner up": whether empty slots get filled with bots. */
  botsFill: boolean
  menuOpen: boolean
  locked: boolean
}

/** JSON-friendly view of the whole game — the playtest harness asserts against this. */
export function statusSnapshot(s: GameStatus) {
  const me = s.registry.local
  const session = s.session
  return {
    backend: s.backend,
    fps: Math.round(s.fps),
    room: s.room.roomCode,
    invite: s.room.inviteUrl,
    isHost: s.room.isHost(),
    /** Null while a map change is in flight — the playtests read it as "still loading". */
    map: session?.selection.name ?? null,
    mapUrl: session?.selection.url ?? null,
    navReady: !!session?.nav?.ready,
    spawns: session && {
      a: session.spawns.a.length,
      b: session.spawns.b.length,
      source: session.spawns.source,
    },
    doorsOpen: session
      ? session.map.doors.filter((d) => session.doors.isOpen(d.id)).map((d) => d.label)
      : [],
    decals: session?.decals.count ?? 0,
    balls: session?.projectiles.liveCount ?? 0,
    bots: s.bots,
    botsFill: s.botsFill,
    menuOpen: s.menuOpen,
    locked: s.locked,
    match: s.match && {
      phase: s.match.phase,
      round: s.match.round,
      scores: { ...s.match.scores },
      msLeft: Math.round(msLeft(s.match, s.now)),
    },
    me: me && {
      id: me.id.slice(0, 6),
      name: me.name,
      team: me.team,
      hp: me.hp,
      alive: me.alive,
      kills: me.kills,
      deaths: me.deaths,
      frozen: s.local.dead,
      pos: round2(s.local.position),
      yaw: Number(s.local.yaw.toFixed(3)),
    },
    entities: s.registry.list().map((e) => ({
      id: e.id.slice(0, 6),
      name: e.name,
      team: e.team,
      bot: e.isBot,
      local: e.isLocal,
      hp: e.hp,
      alive: e.alive,
      kills: e.kills,
      deaths: e.deaths,
      pos: round2(e.position),
    })),
  }
}

export interface DebugPanel {
  update(): void
  dispose(): void
}

export function createDebugPanel(
  mount: HTMLElement,
  enabled: boolean,
  read: () => GameStatus,
): DebugPanel {
  if (!enabled) return { update() {}, dispose() {} }
  // Below the HUD's room-code chip (`.ps-room`, top-left at `--hud-pad`), not on top of it:
  // the chip is ~28 px tall, so the panel starts one chip plus a gap further down.
  const node = el('div', {
    class: 'ps-debug',
    style:
      'position:absolute;left:var(--hud-pad);top:calc(var(--hud-pad) + 42px);z-index:9;' +
      'font:11px/1.5 JetBrains Mono,monospace;' +
      'color:#a1a1aa;background:#09090bcc;border:1px solid #27272a;border-radius:8px;' +
      'padding:8px 10px;pointer-events:none;white-space:pre',
  })
  mount.appendChild(node)
  return {
    update() {
      const s = read()
      const p = s.local.position
      const session = s.session
      node.textContent = [
        `${s.backend} · ${Math.round(s.fps)} fps`,
        `room ${s.room.roomCode}${s.room.isHost() ? ' (host)' : ''} · clock ${s.clockOffset} ms`,
        `entities ${s.registry.size} · bots ${s.bots ? 'on' : 'off'} · fill ${s.botsFill ? 'on' : 'off'} · nav ${session?.nav?.ready ? 'ready' : '…'}`,
        session
          ? `spawns ${session.spawns.source} a=${session.spawns.a.length} b=${session.spawns.b.length}`
          : 'loading the next map…',
        `decals ${session?.decals.count ?? 0} · balls ${session?.projectiles.liveCount ?? 0}`,
        `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)} · yaw ${s.local.yaw.toFixed(2)}`,
        s.match
          ? `${s.match.phase} r${s.match.round} ${s.match.scores.a}:${s.match.scores.b} ${Math.round(msLeft(s.match, s.now) / 1000)}s`
          : 'match —',
        'N navmesh · C collider',
      ].join('\n')
    },
    dispose() {
      node.remove()
    },
  }
}

function round2(v: { x: number; y: number; z: number }): [number, number, number] {
  return [Number(v.x.toFixed(2)), Number(v.y.toFixed(2)), Number(v.z.toFixed(2))]
}

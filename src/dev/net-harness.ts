/**
 * `?dev=net` — a text-only harness on the real Playroom stack: join a room, watch teams fill
 * with bots, fire fake shots and hits, and see the host apply damage, kills and respawns.
 *
 * No renderer, no map: positions are a random walk, spawns are two fixed anchors.
 */
import { Vector3 } from 'three'
import { MATCH, NET } from '../config'
import { createEntityRegistry, type EntityRegistry } from '../game/entities'
import { msLeft } from '../game/match'
import { createEventBus } from '../engine/events'
import { bindNetToRegistry, requestTeamSwap, type NetBinding } from '../net/client'
import { startHostAuthority, type HostAuthority } from '../net/host'
import {
  BOTS_FILL_DEFAULT,
  botsFillFrom,
  botsFillIsSet,
  botsFillValue,
  GS,
  PS,
  RPCS,
  teamFrom,
  type TeamChoice,
} from '../net/protocol'
import { joinRoom, roomCodeFromHash, type Room } from '../net/room'
import { createClock, createSnapshotSender, type NetClock } from '../net/sync'
import type { MatchState, PlayerSnapshot, SpawnPoint, TeamId } from '../types'
import { appRoot, el } from '../ui/dom'

const SPAWN_ANCHORS: Record<TeamId, Vector3> = {
  a: new Vector3(-8, 0, 0),
  b: new Vector3(8, 0, 0),
}

export async function start(): Promise<void> {
  const app = appRoot()
  const root = el('div', { class: 'ps-dev' })
  app.appendChild(root)

  const hashCode = roomCodeFromHash()
  const nameInput = el('input', {
    class: 'ps-input',
    style: 'max-width:220px',
    value: localStorage.getItem('ps.name') || `Tester ${Math.floor(Math.random() * 90 + 10)}`,
  })
  const codeInput = el('input', {
    class: 'ps-input',
    style: 'max-width:160px;text-transform:uppercase',
    placeholder: 'room code',
    value: hashCode ?? '',
  })
  const createBtn = el('button', { class: 'ps-btn ps-btn--primary' }, ['Create room'])
  const joinBtn = el('button', { class: 'ps-btn' }, ['Join code'])
  // Only meaningful on "Create room": a joiner adopts whatever the host published.
  const fillInput = el('input', { type: 'checkbox', id: 'ps-fill' })
  fillInput.checked = localStorage.getItem('ps.botsFill') !== '0'
  const fillLabel = el('label', { class: 'ps-dim', for: 'ps-fill' }, [
    fillInput,
    ' fill empty slots with bots',
  ])
  const landing = el('section', {}, [
    el('h2', { text: 'connect' }),
    el('div', { class: 'ps-row' }, [nameInput, fillLabel, createBtn, codeInput, joinBtn]),
    el('div', {
      class: 'ps-dim',
      style: 'margin-top:8px',
      text: hashCode
        ? `#r= points at room ${hashCode} — "Join code" or "Create room" both land there.`
        : 'Create a room, then open the invite link in a second tab.',
    }),
  ])

  root.appendChild(el('h1', { text: 'Pascal Strike · net harness' }))
  root.appendChild(landing)

  const connect = async (roomCode?: string, creating = false) => {
    createBtn.toggleAttribute('disabled', true)
    joinBtn.toggleAttribute('disabled', true)
    const name = nameInput.value.trim() || 'Tester'
    const botsFill = fillInput.checked
    localStorage.setItem('ps.name', name)
    localStorage.setItem('ps.botsFill', botsFill ? '1' : '0')
    try {
      const room = await joinRoom({ name, roomCode, botsFill: creating ? botsFill : undefined })
      landing.remove()
      run(root, room, name, creating ? botsFill : undefined)
    } catch (err) {
      landing.appendChild(
        el('div', { style: 'color:#f87171;margin-top:8px', text: String((err as Error)?.message ?? err) }),
      )
      createBtn.toggleAttribute('disabled', false)
      joinBtn.toggleAttribute('disabled', false)
    }
  }

  createBtn.addEventListener('click', () => void connect(hashCode ?? undefined, true))
  joinBtn.addEventListener('click', () => void connect(codeInput.value.trim() || undefined))
}

function run(root: HTMLElement, room: Room, name: string, botsFill?: boolean): void {
  const events = createEventBus()
  const registry = createEntityRegistry()
  const clock = createClock(room)
  const binding: NetBinding = bindNetToRegistry(room, registry, events)

  // --- fake locomotion -----------------------------------------------------
  const walkers = new Map<string, { x: number; z: number; yaw: number }>()
  const walker = (id: string, team: TeamId) => {
    let w = walkers.get(id)
    if (!w) {
      const anchor = SPAWN_ANCHORS[team]
      w = { x: anchor.x + rand(2), z: anchor.z + rand(2), yaw: team === 'a' ? 1.57 : -1.57 }
      walkers.set(id, w)
    }
    return w
  }
  const step = (w: { x: number; z: number; yaw: number }) => {
    w.yaw += rand(0.25)
    w.x = clampRange(w.x + Math.sin(w.yaw) * 0.25, -14, 14)
    w.z = clampRange(w.z + Math.cos(w.yaw) * 0.25, -14, 14)
    return w
  }
  const snapshotOf = (w: { x: number; z: number; yaw: number }): PlayerSnapshot => ({
    x: w.x,
    y: 0,
    z: w.z,
    yaw: w.yaw,
    pitch: 0,
    c: 0,
    t: clock.now(),
  })

  /** Our side, or null while we are still choosing one (W5-A). */
  const myTeam = (): TeamId | null => teamFrom(room.me.getState(PS.team))

  const sender = createSnapshotSender(room, () => {
    // A spectator has no body: nothing on the wire until the host puts us on a team.
    const team = myTeam()
    if (!team) return null
    const me = registry.get(room.me.id)
    const w = step(walker(room.me.id, team))
    if (me) me.position.set(w.x, 0, w.z)
    return snapshotOf(w)
  })

  // --- host ---------------------------------------------------------------
  const spawnFor = (team: TeamId): SpawnPoint => ({
    position: SPAWN_ANCHORS[team].clone().add(new Vector3(rand(3), 0, rand(3))),
    yaw: team === 'a' ? Math.PI / 2 : -Math.PI / 2,
  })
  let host: HostAuthority | null = null
  const ensureHost = () => {
    if (room.isHost() && !host) host = startHostAuthority(room, registry, spawnFor, events, clock)
  }
  // The harness has no `game.ts` to publish the room's settings, so it does the same thing:
  // the creator states the bot fill once, and never overwrites a value the room already has.
  if (room.isHost() && !botsFillIsSet(room.getGlobal<unknown>(GS.botsFill))) {
    room.setGlobal(GS.botsFill, botsFillValue(botsFill ?? BOTS_FILL_DEFAULT), true)
  }
  ensureHost()
  room.onHostChange((isHost) => {
    log(`host changed → ${isHost ? 'I am the host now' : 'someone else hosts'}`)
    ensureHost()
  })

  /** Bots have no client of their own: whoever hosts walks them (W2-B replaces this). */
  const botTimer = window.setInterval(() => {
    if (!room.isHost()) return
    for (const entity of registry.list()) {
      if (!entity.isBot) continue
      const w = step(walker(entity.id, entity.team))
      entity.position.set(w.x, 0, w.z)
      entity.yaw = w.yaw
      const player = room.players().find((p) => p.id === entity.id)
      player?.setState(PS.snap, snapshotOf(w), false)
    }
  }, Math.round(1000 / NET.botSnapshotHz))

  // --- ui -----------------------------------------------------------------
  const info = el('div')
  const tableBox = el('div')
  const logBox = el('div', { class: 'ps-log' })
  const shotBtn = el('button', { class: 'ps-btn' }, ['Send shot'])
  const hitBtn = el('button', { class: 'ps-btn' }, ['Send hit on random enemy'])
  const targetSelect = el('select', { class: 'ps-input', style: 'max-width:220px;height:32px' })
  const hitSelBtn = el('button', { class: 'ps-btn' }, ['Send hit on selected'])
  const pickButtons: { choice: TeamChoice; node: HTMLButtonElement }[] = [
    { choice: 'a', node: el('button', { class: 'ps-btn' }, ['Join Orange']) },
    { choice: 'b', node: el('button', { class: 'ps-btn' }, ['Join Teal']) },
    { choice: 'auto', node: el('button', { class: 'ps-btn' }, ['Join Auto']) },
  ]
  const fillToggle = el('input', { type: 'checkbox', id: 'ps-fill-live' })
  const fillToggleLabel = el('label', { class: 'ps-dim', for: 'ps-fill-live' }, [
    fillToggle,
    ' bots fill (host)',
  ])
  const leaveBtn = el('button', { class: 'ps-btn' }, ['Leave'])
  const invite = el('a', { href: room.inviteUrl, target: '_blank', text: room.inviteUrl })

  root.appendChild(
    el('section', {}, [
      el('h2', { text: 'room' }),
      info,
      el('div', { style: 'margin-top:6px' }, ['invite: ', invite]),
    ]),
  )
  root.appendChild(el('section', {}, [el('h2', { text: 'participants' }), tableBox]))
  root.appendChild(
    el('section', {}, [
      el('h2', { text: 'team' }),
      el('div', { class: 'ps-row' }, pickButtons.map((b) => b.node)),
    ]),
  )
  root.appendChild(
    el('section', {}, [
      el('h2', { text: 'actions' }),
      el('div', { class: 'ps-row' }, [
        shotBtn,
        hitBtn,
        targetSelect,
        hitSelBtn,
        fillToggleLabel,
        leaveBtn,
      ]),
    ]),
  )
  root.appendChild(el('section', {}, [el('h2', { text: 'events' }), logBox]))

  const lines: string[] = []
  function log(message: string) {
    lines.unshift(`${new Date().toLocaleTimeString()}  ${message}`)
    if (lines.length > 60) lines.pop()
    logBox.textContent = lines.join('\n')
  }
  log(`joined as ${name} (${room.me.id.slice(0, 6)}) — host: ${room.isHost()}`)

  events.on('player-joined', (e) => log(`+ ${e.name} ${e.isBot ? '[bot]' : ''} ${e.id.slice(0, 6)}`))
  events.on('player-left', (e) => log(`- ${e.id.slice(0, 6)} left`))
  events.on('damage', (d) => {
    const target = registry.get(d.target)
    const by = registry.get(d.by)
    log(`damage ${by?.name ?? d.by.slice(0, 6)} → ${target?.name ?? d.target.slice(0, 6)} · hp ${d.hp}`)
  })
  events.on('kill', (k) => {
    const killer = registry.get(k.killer)
    const victim = registry.get(k.victim)
    log(`KILL ${killer?.name ?? k.killer.slice(0, 6)} killed ${victim?.name ?? k.victim.slice(0, 6)}`)
  })
  events.on('respawn', (r) => {
    const who = registry.get(r.player)
    log(
      `respawn ${who?.name ?? r.player.slice(0, 6)} at ${r.position.map((v) => v.toFixed(1)).join(',')} inv +${
        Math.max(0, r.invincibleUntil - clock.now()) / 1000
      }s`,
    )
  })
  events.on('match', (m) => log(`match → ${m.phase} round ${m.round} ${m.scores.a}:${m.scores.b}`))
  events.on('shot', (s) => log(`shot from ${registry.get(s.by)?.name ?? s.by.slice(0, 6)}`))

  // --- actions -------------------------------------------------------------
  let shotCounter = 0
  const nextShotId = () => `${room.me.id}:${++shotCounter}`

  shotBtn.addEventListener('click', () => {
    const me = registry.get(room.me.id)
    const team = myTeam()
    if (!me || !team) return log('pick a team first — a spectator cannot shoot')
    void room.rpc.call(
      RPCS.shot,
      {
        id: nextShotId(),
        by: room.me.id,
        team,
        origin: [me.position.x, me.position.y + 1.5, me.position.z],
        dir: [Math.sin(me.yaw), 0, Math.cos(me.yaw)],
        speed: 70,
        t: clock.now(),
        seed: Math.floor(Math.random() * 1e6),
      },
      'others',
    )
    log('sent shot')
  })

  const sendHit = (targetId?: string) => {
    const team = myTeam()
    if (!team) return log('pick a team first — a spectator cannot shoot')
    const enemies = registry.enemiesOf(team).filter((e) => e.alive)
    const target = targetId ? registry.get(targetId) : enemies[Math.floor(Math.random() * enemies.length)]
    if (!target) return log('no living enemy to hit')
    const hit = {
      shotId: nextShotId(),
      by: room.me.id,
      target: target.id,
      // Aim at the chest of wherever we last saw them, so the host's desync check passes.
      point: [target.position.x, target.position.y + 1.2, target.position.z] as [number, number, number],
      normal: [0, 1, 0] as [number, number, number],
    }
    if (host && room.isHost()) {
      const ok = host.submitHit(hit)
      log(`hit on ${target.name} submitted locally → ${ok ? 'applied' : 'REJECTED'}`)
    } else {
      void room.rpc.call(RPCS.hit, hit, 'host')
      log(`hit sent to host on ${target.name}`)
    }
  }
  hitBtn.addEventListener('click', () => sendHit())
  hitSelBtn.addEventListener('click', () => sendHit(targetSelect.value || undefined))

  // The team screen, minus the screen: same RPC, same host rules, same 'auto'.
  const pickTeam = (choice: TeamChoice) => {
    const answer = (result: { ok: boolean; assigned?: TeamId; reason?: string }) =>
      log(
        result.ok
          ? `team ${choice} → accepted, on ${result.assigned ?? '?'}`
          : `team ${choice} → REFUSED (${result.reason ?? 'no reason'})`,
      )
    if (host && room.isHost()) {
      const result = host.requestTeam(room.me.id, choice)
      void room.rpc.call(RPCS.teamResult, result, 'others')
      answer(result)
      return
    }
    void requestTeamSwap(room, choice).then(answer)
  }
  for (const { choice, node } of pickButtons) {
    node.addEventListener('click', () => pickTeam(choice))
  }

  fillToggle.addEventListener('change', () => {
    const on = fillToggle.checked
    if (host && room.isHost()) host.setBotsFill(on)
    else if (room.isHost()) room.setGlobal(GS.botsFill, botsFillValue(on), true)
    else return log('only the host can change the bot fill')
    log(`bots fill → ${on ? 'on' : 'off'}`)
  })

  leaveBtn.addEventListener('click', () => {
    window.clearInterval(botTimer)
    window.clearInterval(refresh)
    sender.stop()
    binding.stop()
    host?.stop()
    clock.stop()
    room.leave()
    log('left the room')
  })

  // --- refresh -------------------------------------------------------------
  let optionKey = ''
  const refresh = window.setInterval(() => {
    const now = clock.now()
    binding.update()

    const match = room.getGlobal<MatchState>(GS.match) ?? null
    const me = registry.get(room.me.id)
    const fill = botsFillFrom(room.getGlobal<unknown>(GS.botsFill))
    if (fillToggle.checked !== fill) fillToggle.checked = fill
    fillToggle.toggleAttribute('disabled', !room.isHost())
    const mine = myTeam()
    const waiting = binding.spectators()
    for (const { choice, node } of pickButtons) {
      node.toggleAttribute('disabled', choice !== 'auto' && choice === mine)
    }
    info.replaceChildren(
      row('room', room.roomCode),
      row('me', `${name} · ${room.me.id.slice(0, 6)} · team ${mine ?? 'choosing…'}`),
      row('host', String(room.isHost())),
      row('clock offset', `${clock.offset} ms (now ${now})`),
      row(
        'match',
        match
          ? `${match.phase} · round ${match.round} · ${match.scores.a}:${match.scores.b} · ${(
              msLeft(match, now) / 1000
            ).toFixed(1)}s left`
          : '—',
      ),
      row('bots fill', fill ? 'on' : 'off'),
      row('teams', teamSummary(registry)),
      // Nobody choosing has an entity (no avatar, no capsule, no bot can see them), so the
      // participants table below cannot show them: this row is where they are.
      row(
        'choosing',
        waiting.length
          ? waiting.map((s) => `${s.name}${s.isLocal ? ' (you)' : ''}`).join(', ')
          : '—',
      ),
    )

    tableBox.replaceChildren(renderTable(registry, binding, room.me.id, room.isHost()))

    const enemies = mine ? registry.enemiesOf(mine) : []
    const key = enemies.map((e) => e.id).join(',')
    if (key !== optionKey) {
      optionKey = key
      targetSelect.replaceChildren(
        ...enemies.map((e) => el('option', { value: e.id, text: `${e.name}${e.isBot ? ' [bot]' : ''}` })),
      )
    }
  }, 200)

  Object.assign(window as unknown as Record<string, unknown>, {
    __psNet: { room, registry, clock, binding, host: () => host, events },
  })
}

function renderTable(
  registry: EntityRegistry,
  binding: NetBinding,
  localId: string,
  hostSim: boolean,
): HTMLElement {
  const now = Date.now()
  const rows = registry
    .list()
    .slice()
    .sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name))
    .map((e) => {
      const age = binding.lastSnapshotAt(e.id)
      return el('tr', { class: e.team === 'a' ? 'ps-a' : 'ps-b' }, [
        el('td', { text: e.id.slice(0, 6) + (e.id === localId ? ' *' : '') }),
        el('td', { text: e.name }),
        el('td', { text: e.team }),
        el('td', { text: e.isBot ? 'bot' : 'human' }),
        el('td', { text: String(e.hp) }),
        el('td', { text: e.alive ? 'alive' : 'DEAD' }),
        el('td', { text: `${e.kills}/${e.deaths}` }),
        el('td', {
          text: `${e.position.x.toFixed(1)}, ${e.position.z.toFixed(1)}`,
        }),
        el('td', {
          class: 'ps-dim',
          text: hostSim && e.isBot ? 'host-sim' : age ? `${now - age} ms` : '—',
        }),
      ])
    })
  return el('table', {}, [
    el('thead', {}, [
      el('tr', {}, [
        'id',
        'name',
        'team',
        'kind',
        'hp',
        'state',
        'k/d',
        'pos xz',
        'snapshot age',
      ].map((h) => el('th', { text: h }))),
    ]),
    el('tbody', {}, rows),
  ])
}

function teamSummary(registry: EntityRegistry): string {
  const a = registry.byTeam('a')
  const b = registry.byTeam('b')
  return `A ${a.length}/${MATCH.teamSize} (${a.map((e) => e.name).join(', ') || '—'})  ·  B ${
    b.length
  }/${MATCH.teamSize} (${b.map((e) => e.name).join(', ') || '—'})`
}

function row(label: string, value: string): HTMLElement {
  return el('div', {}, [el('span', { class: 'ps-dim', text: `${label.padEnd(14, ' ')}` }), value])
}

function rand(scale: number): number {
  return (Math.random() - 0.5) * 2 * scale
}

function clampRange(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

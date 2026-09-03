/**
 * The read side of the network: turns Playroom players + RPCs into registry entities and
 * `EventBus` events. Runs on every client, host included.
 */
import { Vector3 } from 'three'
import { PLAYER } from '../config'
import type { EntityRegistry } from '../game/entities'
import type {
  DamageEvent,
  EventBus,
  KillEvent,
  PlayerEntity,
  PlayerSnapshot,
  RespawnEvent,
  ShotEvent,
  WeaponKind,
} from '../types'
import {
  GS,
  PS,
  RPCS,
  TEAM_SWAP_TIMEOUT_MS,
  teamFrom,
  type BotStats,
  type TeamChoice,
  type TeamRequest,
  type TeamResult,
} from './protocol'
import { isBotPlayer, type Room } from './room'
import { createInterpolator, type Interpolator, type PoseOut } from './sync'

/** How often we re-read the reliable per-player states (Playroom has no per-key change event). */
const STATE_POLL_MS = 100

const scratchPos = new Vector3()
const scratchPose: PoseOut = { yaw: 0, pitch: 0, crouching: false, speed: 0 }

/** Somebody in the room who is still on the team screen (W5-A). */
export interface Spectator {
  id: string
  name: string
  isLocal: boolean
}

export interface NetBinding {
  /** Call every frame: pulls `p` snapshots and writes interpolated poses into the entities. */
  update(): void
  /** Date.now() when we last received a snapshot for this player (0 = never). */
  lastSnapshotAt(id: string): number
  interpolatorFor(id: string): Interpolator | undefined
  /**
   * Everyone in the room with no `team` state — the players choosing a side. They deliberately
   * have no entity (no avatar, no name tag, no hittable, nothing for a bot to look at), so this
   * is the only place they show up: the team screen's "Choosing…" line reads it.
   */
  spectators(): Spectator[]
  stop(): void
}

export function bindNetToRegistry(
  room: Room,
  registry: EntityRegistry,
  events: EventBus,
): NetBinding {
  const interps = new Map<string, Interpolator>()
  const cleanups: (() => void)[] = []
  /** Rebuilt by every poll; the team screen reads it at 100 ms resolution. */
  const spectatorList: Spectator[] = []

  registry.setLocal(room.me.id)

  const ensureEntity = (id: string): PlayerEntity | undefined => {
    const player = room.players().find((p) => p.id === id)
    if (!player) return registry.get(id)
    return addPlayer(player)
  }

  /**
   * A human with no `team` state has not picked a side yet (W5-A) and gets NO entity: an entity
   * is what gives you an avatar in `remote-players.ts`, a capsule in the projectile sim and a
   * body for the bot brains to see, and a spectator must have none of the three. They reappear
   * the moment the host publishes their team — the poll below adds them within 100 ms.
   * Ourselves excepted: the local entity is the one the whole game is wired to, and it exists
   * from the first frame whether we have picked or not.
   */
  const isSpectator = (player: ReturnType<Room['players']>[number]): boolean =>
    player.id !== room.me.id && !isBotPlayer(player) && teamFrom(player.getState(PS.team)) === null

  const addPlayer = (player: ReturnType<Room['players']>[number]): PlayerEntity | undefined => {
    if (isSpectator(player)) return registry.get(player.id)
    const isLocal = player.id === room.me.id
    const isBot = isBotPlayer(player)
    const isNew = !registry.get(player.id)
    const entity = registry.upsert({
      id: player.id,
      name: readName(player, isBot),
      team: teamFrom(player.getState(PS.team)) ?? 'a',
      isBot,
      isLocal,
      hp: numberOr(player.getState(PS.hp), PLAYER.maxHp),
      alive: player.getState(PS.alive) !== false,
      invincibleUntil: numberOr(player.getState(PS.inv), 0),
      kills: numberOr(player.getState(PS.kills), 0),
      deaths: numberOr(player.getState(PS.deaths), 0),
      weapon: weaponOr(player.getState(PS.weapon)),
    })
    if (!isLocal && !interps.has(player.id)) interps.set(player.id, createInterpolator(entity))
    // onJoin and the state poll can both discover a player; only announce them once.
    if (isNew) events.emit('player-joined', entity)
    return entity
  }

  cleanups.push(
    room.onJoin((player) => {
      addPlayer(player)
    }),
  )
  cleanups.push(
    room.onLeave((id) => {
      interps.delete(id)
      lastRaw.delete(id)
      registry.remove(id)
      events.emit('player-left', { id })
    }),
  )

  // --- reliable state poll -------------------------------------------------
  /**
   * Last raw value seen per player state key. The poll is EDGE triggered: reliable state can
   * lag the `damage`/`kill` RPCs by a second or more, and re-applying a stale `hp: 100` over
   * the value an RPC just delivered makes health flicker. So we only write a field into the
   * entity when the state itself changed.
   */
  const lastRaw = new Map<string, Record<string, unknown>>()

  const applyIfChanged = (
    id: string,
    key: string,
    value: unknown,
    write: (v: unknown) => void,
  ) => {
    let seen = lastRaw.get(id)
    if (!seen) lastRaw.set(id, (seen = {}))
    if (key in seen && seen[key] === value) return
    seen[key] = value
    write(value)
  }

  const poll = () => {
    const players = room.players()
    spectatorList.length = 0
    for (const player of players) {
      const isBot = isBotPlayer(player)
      const entity = registry.get(player.id)
      if (isSpectator(player)) {
        spectatorList.push({ id: player.id, name: readName(player, isBot), isLocal: false })
        // They had a team and lost it: only a host that never published one can do that, and
        // the honest answer is to take the body away again.
        if (entity) {
          interps.delete(player.id)
          lastRaw.delete(player.id)
          registry.remove(player.id)
          events.emit('player-left', { id: player.id })
        }
        continue
      }
      if (player.id === room.me.id && teamFrom(player.getState(PS.team)) === null) {
        spectatorList.push({ id: player.id, name: readName(player, isBot), isLocal: true })
      }
      if (!entity) {
        addPlayer(player)
        continue
      }
      entity.name = readName(player, isBot)
      entity.isBot = isBot
      const id = player.id
      applyIfChanged(id, PS.team, player.getState(PS.team), (v) => {
        if (v === 'a' || v === 'b') entity.team = v
      })
      applyIfChanged(id, PS.hp, player.getState(PS.hp), (v) => {
        entity.hp = numberOr(v, entity.hp)
      })
      applyIfChanged(id, PS.alive, player.getState(PS.alive), (v) => {
        entity.alive = v !== false
      })
      applyIfChanged(id, PS.inv, player.getState(PS.inv), (v) => {
        entity.invincibleUntil = numberOr(v, 0)
      })
      applyIfChanged(id, PS.kills, player.getState(PS.kills), (v) => {
        entity.kills = numberOr(v, entity.kills)
      })
      applyIfChanged(id, PS.deaths, player.getState(PS.deaths), (v) => {
        entity.deaths = numberOr(v, entity.deaths)
      })
      // What they are holding: the remote presentation mounts the model from this.
      applyIfChanged(id, PS.weapon, player.getState(PS.weapon), (v) => {
        entity.weapon = weaponOr(v)
      })
    }
    applyBotStats()
    // Anyone the registry still knows but Playroom dropped (missed onQuit). Not gated on the
    // sizes any more: with spectators the registry is legitimately smaller than the room, so a
    // stale entity would sit there forever behind a `size > length` test.
    const live = new Set(players.map((p) => p.id))
    for (const entity of registry.list()) {
      if (!live.has(entity.id)) {
        interps.delete(entity.id)
        lastRaw.delete(entity.id)
        registry.remove(entity.id)
        events.emit('player-left', { id: entity.id })
      }
    }
  }
  /**
   * A bot's own player state is delivered to us once, when it joins, and never again (see
   * `GS.botStats`) — so its kills, deaths and team would sit frozen at whatever they were when
   * we walked in. The host mirrors those three into a global, which does sync; on the host they
   * are already right, so it reads its own writes instead.
   */
  const applyBotStats = () => {
    if (room.isHost()) return
    const stats = room.getGlobal<BotStats>(GS.botStats)
    if (!stats) return
    for (const id of Object.keys(stats)) {
      const stat = stats[id]
      const entity = registry.get(id)
      if (!stat || !entity || !entity.isBot) continue
      if (stat.team === 'a' || stat.team === 'b') entity.team = stat.team
      entity.kills = numberOr(stat.kills, entity.kills)
      entity.deaths = numberOr(stat.deaths, entity.deaths)
    }
  }

  poll()
  const pollTimer = window.setInterval(poll, STATE_POLL_MS)
  cleanups.push(() => window.clearInterval(pollTimer))

  // --- RPCs ----------------------------------------------------------------
  cleanups.push(
    room.rpc.register<ShotEvent>(RPCS.shot, (shot) => {
      if (shot?.by === room.me.id) return
      events.emit('shot', shot)
    }),
  )

  cleanups.push(
    room.rpc.register<DamageEvent>(RPCS.damage, (dmg) => {
      const entity = registry.get(dmg.target)
      if (entity) entity.hp = dmg.hp
      events.emit('damage', dmg)
      if (dmg.target === room.me.id) {
        events.emit('local-damaged', { hp: dmg.hp, from: dmg.point })
      }
    }),
  )

  cleanups.push(
    room.rpc.register<KillEvent>(RPCS.kill, (kill) => {
      const victim = registry.get(kill.victim)
      if (victim) {
        victim.alive = false
        victim.hp = 0
      }
      events.emit('kill', kill)
    }),
  )

  cleanups.push(
    room.rpc.register<RespawnEvent>(RPCS.respawn, (ev) => {
      const entity = registry.get(ev.player) ?? ensureEntity(ev.player)
      if (entity) {
        entity.position.set(ev.position[0], ev.position[1], ev.position[2])
        entity.yaw = ev.yaw
        entity.alive = true
        entity.hp = PLAYER.maxHp
        entity.invincibleUntil = ev.invincibleUntil
        entity.speed = 0
        // Teleports must not be interpolated across the map. Dropping the buffer is the whole
        // fix: the entity above already holds the spawn pose, and the interpolator leaves it
        // alone until real snapshots resume (250 ms at worst, even for a player standing
        // still). Seeding it with a synthetic snapshot is what we must NOT do — its `t` would
        // come from our clock rather than the sender's, and the jitter buffer would anchor its
        // arrival mapping on that stamp and spend the next half second unwinding the offset.
        interps.get(ev.player)?.reset()
      }
      events.emit('respawn', ev)
    }),
  )

  return {
    update() {
      for (const player of room.players()) {
        if (player.id === room.me.id) continue
        const entity = registry.get(player.id)
        if (!entity) continue
        // The host simulates its own bots, so it must not fight the interpolator for them.
        if (entity.isBot && room.isHost()) continue
        const interp = interps.get(player.id)
        if (!interp) continue
        const snap = player.getState(PS.snap) as PlayerSnapshot | undefined
        if (snap) interp.push(snap)
        if (interp.sample(scratchPos, scratchPose)) {
          entity.position.copy(scratchPos)
          entity.yaw = scratchPose.yaw
          entity.pitch = scratchPose.pitch
          entity.crouching = scratchPose.crouching
          entity.speed = scratchPose.speed
        }
      }
    },
    lastSnapshotAt(id) {
      return interps.get(id)?.receivedAt ?? 0
    },
    interpolatorFor(id) {
      return interps.get(id)
    },
    spectators() {
      return spectatorList
    },
    stop() {
      for (const off of cleanups) off()
      cleanups.length = 0
      interps.clear()
      lastRaw.clear()
      spectatorList.length = 0
    },
  }
}

/**
 * Ask the host for a side — the team screen's cards and the Esc menu both come through here.
 * `'auto'` lets the host pick the smaller team.
 *
 * The answer cannot come back as an RPC return value — `room.rpc.register` drops what a handler
 * returns — so the host broadcasts a `teamResult` and this filters it by player id. A host that
 * never answers (migration mid-request, dropped packet) resolves as a refusal rather than
 * leaving the screen stuck on "…".
 */
export function requestTeamSwap(
  room: Room,
  team: TeamChoice,
  timeoutMs = TEAM_SWAP_TIMEOUT_MS,
): Promise<TeamResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: TeamResult) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      off()
      resolve(result)
    }
    const off = room.rpc.register<TeamResult>(RPCS.teamResult, (result) => {
      if (result?.player === room.me.id) finish(result)
    })
    const timer = window.setTimeout(() => {
      finish({ player: room.me.id, team, ok: false, reason: 'The host did not answer' })
    }, timeoutMs)
    void room.rpc.call(RPCS.team, { team } satisfies TeamRequest, 'host')
  })
}

/** Anything we do not recognise (an old client, a missing state) is the rifle. */
function weaponOr(value: unknown): WeaponKind {
  return value === 'pistol' || value === 'knife' ? value : 'rifle'
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readName(player: { getState(key: string): unknown; getProfile(): { name: string } }, isBot: boolean): string {
  const stateName = player.getState(PS.name)
  if (typeof stateName === 'string' && stateName.trim()) return stateName
  if (isBot) return 'Bot'
  try {
    return player.getProfile()?.name || 'Player'
  } catch {
    return 'Player'
  }
}

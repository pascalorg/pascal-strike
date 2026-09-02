/**
 * Host authority: the rules live here and nowhere else.
 *
 * Everything is idempotent and re-entrant — the same code path runs on the first host and on
 * whoever inherits the room after a migration, adopting whatever state the previous host
 * published (teams, scores, match phase) instead of resetting the match.
 */
import { MATCH, PLAYER } from '../config'
import type { EntityRegistry } from '../game/entities'
import { createMatch, isLive, type Match } from '../game/match'
import { botName, otherTeam, pickTeam } from '../game/teams'
import type {
  EventBus,
  HitEvent,
  MapSelection,
  MatchState,
  PlayerSnapshot,
  SpawnPoint,
  TeamId,
} from '../types'
import { GS, HIT_MAX_DESYNC_M, PS, RPCS, SEEN_SHOTS } from './protocol'
import { isBotPlayer, type Room } from './room'
import type { NetClock } from './sync'

/** Where a respawning player goes. The second argument lets a provider avoid crowded points. */
export type SpawnsProvider = (team: TeamId, registry?: EntityRegistry) => SpawnPoint | null

export interface HostAuthority {
  stop(): void
  /** Feed a hit produced locally (host-simulated bots) through the same validation. */
  submitHit(hit: HitEvent): boolean
  /** Host-only map change; everyone reloads from the `map` global. */
  setMap(map: MapSelection): void
  /** Force everyone back to a spawn point (used on round change). */
  respawnAll(): void
  /**
   * Put one player back on a spawn point immediately. W2 needs it for the `fell` RPC: falling
   * out of the world is not damage, so it cannot go through `submitHit`.
   */
  respawnPlayer(id: string | undefined): boolean
  readonly match: Match
  readonly scores: { a: number; b: number }
}

interface HostPlayer {
  id: string
  team: TeamId | null
  hp: number
  alive: boolean
  kills: number
  deaths: number
  inv: number
  isBot: boolean
  /** Host clock ms at which the player comes back, 0 when alive. */
  respawnAt: number
  /** False until this host has placed them at a spawn point at least once. */
  spawned: boolean
}

const TICK_MS = 50
const BALANCE_MS = 500

let active: HostAuthority | null = null

export function startHostAuthority(
  room: Room,
  registry: EntityRegistry,
  spawnsProvider: SpawnsProvider,
  events: EventBus,
  clock: NetClock,
): HostAuthority {
  // Starting twice (e.g. the game reacting to onHostChange) must not double-register RPCs.
  if (active) return active

  const players = new Map<string, HostPlayer>()
  const seenShots: string[] = []
  const seenShotSet = new Set<string>()
  const scores = { a: 0, b: 0 }
  const match: Match = createMatch(clock, room.getGlobal<MatchState>(GS.match) ?? null)
  let adopted = false
  let addingBot = false
  let lastBalance = 0

  // --- helpers -------------------------------------------------------------

  const playerById = (id: string) => room.players().find((p) => p.id === id)

  const write = (id: string, key: string, value: unknown) => {
    const p = playerById(id)
    if (!p) return
    if (p.getState(key) !== value) p.setState(key, value, true)
  }

  const ensure = (id: string, isBot: boolean): HostPlayer => {
    let hp = players.get(id)
    if (!hp) {
      const p = playerById(id)
      // Adopt whatever the previous host published so a migration is invisible to players:
      // someone who already has a team was placed by the old host and must not be teleported,
      // while someone who was dead gets a fresh respawn timer (the old one died with its host).
      const team = (p?.getState(PS.team) as TeamId | undefined) ?? null
      const alive = p?.getState(PS.alive) !== false
      hp = {
        id,
        team,
        hp: num(p?.getState(PS.hp), PLAYER.maxHp),
        alive,
        kills: num(p?.getState(PS.kills), 0),
        deaths: num(p?.getState(PS.deaths), 0),
        inv: num(p?.getState(PS.inv), 0),
        isBot,
        respawnAt: alive ? 0 : clock.now() + PLAYER.respawnDelayMs,
        spawned: team !== null,
      }
      players.set(id, hp)
    }
    hp.isBot = isBot
    return hp
  }

  const spawnFor = (team: TeamId): SpawnPoint | null => {
    try {
      return spawnsProvider(team, registry)
    } catch {
      return null
    }
  }

  const respawn = (hp: HostPlayer, now: number) => {
    const team = hp.team ?? 'a'
    const point = spawnFor(team)
    const position: [number, number, number] = point
      ? [point.position.x, point.position.y, point.position.z]
      : [0, 0, 0]
    const yaw = point?.yaw ?? 0
    hp.alive = true
    hp.hp = PLAYER.maxHp
    hp.respawnAt = 0
    hp.spawned = true
    hp.inv = now + PLAYER.invincibleMs
    write(hp.id, PS.hp, hp.hp)
    write(hp.id, PS.alive, true)
    write(hp.id, PS.inv, hp.inv)
    // Bots have no client of their own; seed their pose so everyone can place them.
    if (hp.isBot) {
      const snap: PlayerSnapshot = {
        x: position[0],
        y: position[1],
        z: position[2],
        yaw,
        pitch: 0,
        c: 0,
        t: now,
      }
      playerById(hp.id)?.setState(PS.snap, snap, false)
    }
    void room.rpc.call(RPCS.respawn, { player: hp.id, position, yaw, invincibleUntil: hp.inv }, 'all')
  }

  const respawnAll = () => {
    const now = clock.now()
    for (const hp of players.values()) respawn(hp, now)
  }

  // --- teams, bot fill -----------------------------------------------------

  const balance = () => {
    const list = room.players()
    const humans: HostPlayer[] = []
    const bots: HostPlayer[] = []
    const live = new Set<string>()

    for (const p of list) {
      live.add(p.id)
      const hp = ensure(p.id, isBotPlayer(p))
      ;(hp.isBot ? bots : humans).push(hp)
    }
    for (const id of [...players.keys()]) if (!live.has(id)) players.delete(id)

    const counts = { a: 0, b: 0 }
    for (const hp of humans) {
      let team = hp.team
      if (!team || counts[team] >= MATCH.teamSize) {
        team = pickTeam(fakeCount(counts))
        if (counts[team] >= MATCH.teamSize) team = otherTeam(team)
      }
      hp.team = team
      counts[team]++
      write(hp.id, PS.team, team)
    }
    for (const hp of bots) {
      let team = hp.team
      if (!team || counts[team] >= MATCH.teamSize) {
        const alt = team ? otherTeam(team) : pickTeam(fakeCount(counts))
        if (counts[alt] < MATCH.teamSize) team = alt
        else {
          // Both sides are full: this bot is the one a joining human replaces.
          players.delete(hp.id)
          room.kick(hp.id)
          continue
        }
      }
      hp.team = team
      counts[team]++
      write(hp.id, PS.team, team)
      if (!playerById(hp.id)?.getState(PS.name)) {
        const taken = [...players.values()]
          .map((o) => (o.id === hp.id ? null : playerById(o.id)?.getState(PS.name)))
          .filter((n): n is string => typeof n === 'string')
        write(hp.id, PS.name, botName(players.size, taken))
      }
    }

    const total = counts.a + counts.b
    if (total < MATCH.maxPlayers && !addingBot) {
      addingBot = true
      room
        .addBot()
        .then((bot) => {
          const hp = ensure(bot.id, true)
          const taken = [...players.values()]
            .map((o) => (o.id === hp.id ? null : playerById(o.id)?.getState(PS.name)))
            .filter((n): n is string => typeof n === 'string')
          bot.setState(PS.name, botName(players.size, taken), true)
          bot.setState(PS.hp, PLAYER.maxHp, true)
          bot.setState(PS.alive, true, true)
          bot.setState(PS.kills, 0, true)
          bot.setState(PS.deaths, 0, true)
          bot.setState(PS.inv, 0, true)
          // The tick's "alive but never spawned" pass places it once balance() gave it a team.
          void hp
        })
        .catch(() => {
          /* room not ready yet — the next tick retries */
        })
        .finally(() => {
          addingBot = false
        })
    }
  }

  // --- damage --------------------------------------------------------------

  const rememberShot = (shotId: string): boolean => {
    if (seenShotSet.has(shotId)) return false
    seenShotSet.add(shotId)
    seenShots.push(shotId)
    if (seenShots.length > SEEN_SHOTS) {
      const old = seenShots.shift()
      if (old) seenShotSet.delete(old)
    }
    return true
  }

  const validate = (hit: HitEvent, senderId?: string): { shooter: HostPlayer; target: HostPlayer } | null => {
    if (!hit || !hit.by || !hit.target || hit.by === hit.target) return null
    if (!isLive(match.state)) return null
    const shooter = players.get(hit.by)
    const target = players.get(hit.target)
    if (!shooter || !target) return null
    // Only the shooter (or the host, on behalf of its bots) may claim a hit.
    if (senderId && senderId !== hit.by && !(shooter.isBot && senderId === room.me.id)) return null
    if (!shooter.alive || !target.alive) return null
    if (shooter.team && target.team && shooter.team === target.team) return null
    const now = clock.now()
    if (target.inv > now) return null
    if (!hit.shotId || !rememberShot(hit.shotId)) return null
    const snap = playerById(target.id)?.getState(PS.snap) as PlayerSnapshot | undefined
    if (snap && hit.point) {
      const dx = hit.point[0] - snap.x
      const dy = hit.point[1] - snap.y
      const dz = hit.point[2] - snap.z
      if (dx * dx + dy * dy + dz * dz > HIT_MAX_DESYNC_M * HIT_MAX_DESYNC_M) return null
    }
    return { shooter, target }
  }

  const applyHit = (hit: HitEvent, senderId?: string): boolean => {
    const valid = validate(hit, senderId)
    if (!valid) return false
    const { shooter, target } = valid
    const now = clock.now()

    target.hp = Math.max(0, target.hp - PLAYER.hitDamage)
    write(target.id, PS.hp, target.hp)
    void room.rpc.call(
      RPCS.damage,
      { target: target.id, by: shooter.id, hp: target.hp, point: hit.point },
      'all',
    )

    if (target.hp > 0) return true

    target.alive = false
    target.deaths++
    target.respawnAt = now + PLAYER.respawnDelayMs
    shooter.kills++
    write(target.id, PS.alive, false)
    write(target.id, PS.deaths, target.deaths)
    write(shooter.id, PS.kills, shooter.kills)
    const killerTeam = shooter.team ?? 'a'
    const victimTeam = target.team ?? 'b'
    scores[killerTeam]++
    void room.rpc.call(
      RPCS.kill,
      { killer: shooter.id, victim: target.id, killerTeam, victimTeam },
      'all',
    )
    return true
  }

  const offHit = room.rpc.register<HitEvent>(RPCS.hit, (hit, sender) => {
    if (!room.isHost()) return
    applyHit(hit, sender?.id)
  })

  // --- tick ----------------------------------------------------------------

  const adopt = () => {
    const published = room.getGlobal<MatchState>(GS.match)
    if (published) {
      match.adopt(published)
      scores.a = published.scores?.a ?? 0
      scores.b = published.scores?.b ?? 0
    } else {
      const fresh = match.reset(clock.now())
      room.setGlobal(GS.match, fresh, true)
      events.emit('match', fresh)
    }
    // Recount from what players actually have, so kills survive a migration.
    players.clear()
    balance()
    adopted = true
  }

  const tick = () => {
    if (!room.isHost()) {
      adopted = false
      return
    }
    if (!adopted) adopt()

    const now = clock.now()
    if (now - lastBalance > BALANCE_MS) {
      lastBalance = now
      balance()
    }

    for (const hp of players.values()) {
      if (!hp.alive && hp.respawnAt && now >= hp.respawnAt) respawn(hp, now)
      else if (hp.alive && !hp.spawned && hp.team) respawn(hp, now)
    }

    const previousRound = match.state.round
    const changed = match.update(now, scores)
    if (changed) {
      scores.a = changed.scores.a
      scores.b = changed.scores.b
      room.setGlobal(GS.match, changed, true)
      events.emit('match', changed)
      if (changed.round !== previousRound) {
        for (const hp of players.values()) {
          hp.kills = 0
          hp.deaths = 0
          write(hp.id, PS.kills, 0)
          write(hp.id, PS.deaths, 0)
        }
      }
      if (changed.phase === 'warmup') respawnAll()
    }
  }

  const timer = window.setInterval(tick, TICK_MS)
  const offHostChange = room.onHostChange((isNowHost) => {
    if (isNowHost) adopted = false
  })
  tick()

  const authority: HostAuthority = {
    stop() {
      window.clearInterval(timer)
      offHit()
      offHostChange()
      players.clear()
      active = null
    },
    submitHit: (hit) => applyHit(hit, room.me.id),
    setMap(map) {
      room.setGlobal(GS.map, map, true)
      events.emit('map-changed', map)
    },
    respawnAll,
    respawnPlayer(id) {
      if (!id || !room.isHost()) return false
      const hp = players.get(id)
      if (!hp) return false
      respawn(hp, clock.now())
      return true
    },
    get match() {
      return match
    },
    scores,
  }
  active = authority
  return authority
}

/** `pickTeam` works on entities; the balancer only has counters. */
function fakeCount(counts: { a: number; b: number }): { team: TeamId }[] {
  const out: { team: TeamId }[] = []
  for (let i = 0; i < counts.a; i++) out.push({ team: 'a' })
  for (let i = 0; i < counts.b; i++) out.push({ team: 'b' })
  return out
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

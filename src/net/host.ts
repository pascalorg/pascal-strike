/**
 * Host authority: the rules live here and nowhere else.
 *
 * Everything is idempotent and re-entrant — the same code path runs on the first host and on
 * whoever inherits the room after a migration, adopting whatever state the previous host
 * published (teams, scores, match phase) instead of resetting the match.
 */
import { DAMAGE, WEAPONS, MATCH, PLAYER } from '../config'
import type { EntityRegistry } from '../game/entities'
import { createMatch, isLive, type Match } from '../game/match'
import { botName, otherTeam, pickTeam, teamName } from '../game/teams'
import type {
  BodyPart,
  EventBus,
  HitEvent,
  MapSelection,
  MatchState,
  PlayerSnapshot,
  SpawnPoint,
  TeamId,
} from '../types'
import {
  BOT_STATS_MS,
  botsFillFrom,
  botsFillValue,
  GS,
  HIT_MAX_DESYNC_M,
  HIT_REJECT_NOTICE_MS,
  PS,
  RPCS,
  SEEN_SHOTS,
  TEAM_SWAP_COOLDOWN_MS,
  teamChoiceFrom,
  teamFrom,
  type BotStats,
  type HitRejected,
  type TeamChoice,
  type TeamRequest,
  type TeamResult,
} from './protocol'
import { isBotPlayer, type Room } from './room'
import type { NetClock } from './sync'

/** Where a respawning player goes. The second argument lets a provider avoid crowded points. */
export type SpawnsProvider = (team: TeamId, registry?: EntityRegistry) => SpawnPoint | null

export interface HostAuthority {
  stop(): void
  /**
   * Feed a hit this tab produced through the same validation the `hit` RPC goes through.
   * Two callers: our own projectile sim (us and our bots), and `host-side.ts` replaying a hit
   * that reached the room before this authority existed — hence `senderId`, which is who
   * actually claimed it. It defaults to us, because normally we are the claimant.
   */
  submitHit(hit: HitEvent, senderId?: string): boolean
  /** Host-only map change; everyone reloads from the `map` global. */
  setMap(map: MapSelection): void
  /** Room state: are empty slots filled with bots? */
  readonly botsFill: boolean
  /**
   * Host-only: flip the bot fill. Off kicks every bot at once (their entities leave through the
   * usual onLeave path), on refills to `MATCH.maxPlayers`.
   */
  setBotsFill(on: boolean): void
  /**
   * A player picked a side — on the team screen (their first pick) or in the Esc menu (a swap).
   * `'auto'` resolves here to the smaller team. Accepted while the HUMAN counts stay within one
   * of each other (bots do not count — the fill rebalances around them) and the player has not
   * swapped in the last `TEAM_SWAP_COOLDOWN_MS`. A first pick pays no cooldown: there is no side
   * to leave, and the screen it comes from is the only way into the match. The answer is
   * broadcast as `teamResult` and returned, so the host's own client can skip the round trip.
   */
  requestTeam(playerId: string, team: TeamChoice): TeamResult
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
  /** Null = a human who has not picked yet (the team screen is up on their client). */
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
  /** Last seen `botsFill`; a change rebalances on the very next tick instead of after 500 ms. */
  let lastFill: boolean | null = null

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
      // No team means they were still choosing when the room changed hands — they stay that way,
      // and `balance()` keeps them out of the match instead of dropping them onto a side.
      const team = teamFrom(p?.getState(PS.team))
      const alive = team !== null && p?.getState(PS.alive) !== false
      hp = {
        id,
        team,
        hp: num(p?.getState(PS.hp), PLAYER.maxHp),
        alive,
        kills: num(p?.getState(PS.kills), 0),
        deaths: num(p?.getState(PS.deaths), 0),
        inv: num(p?.getState(PS.inv), 0),
        isBot,
        // A spectator is not "waiting to respawn": no team, no timer, nothing to come back to.
        respawnAt: alive || team === null ? 0 : clock.now() + PLAYER.respawnDelayMs,
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
    // No team, no spawn: a player who has not picked yet stays off the map entirely (W5-A).
    const team = hp.team
    if (!team) return
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

  /** The room's "fill empty slots with bots" flag; absent (old rooms) means on. */
  const botsFill = () => botsFillFrom(room.getGlobal<unknown>(GS.botsFill))

  const dropBot = (hp: HostPlayer) => {
    players.delete(hp.id)
    room.kick(hp.id)
  }

  /**
   * A human who has not picked a side: off the map, out of the numbers. `alive: false` is what
   * carries that to everyone else — the bot brains, the projectile sim and this file's own hit
   * validation all skip a target that is not alive, so a spectator cannot be seen, shot or
   * counted anywhere, on any client, without a new state key.
   */
  const spectate = (hp: HostPlayer) => {
    hp.alive = false
    hp.hp = PLAYER.maxHp
    hp.respawnAt = 0
    hp.spawned = false
    write(hp.id, PS.alive, false)
    write(hp.id, PS.hp, PLAYER.maxHp)
  }

  const balance = () => {
    const list = room.players()
    const humans: HostPlayer[] = []
    const bots: HostPlayer[] = []
    const live = new Set<string>()
    const fill = botsFill()

    for (const p of list) {
      live.add(p.id)
      const hp = ensure(p.id, isBotPlayer(p))
      ;(hp.isBot ? bots : humans).push(hp)
    }
    for (const id of [...players.keys()]) if (!live.has(id)) players.delete(id)

    // Humans only: every bot goes, and none is ever added below. Team balancing for the
    // humans is untouched — they still spread over both teams.
    if (!fill) {
      for (const hp of bots) dropBot(hp)
      bots.length = 0
    }

    const counts = { a: 0, b: 0 }
    for (const hp of humans) {
      // Nobody is dropped onto a side any more (W5-A): a human joins as a spectator and stays
      // one until they pick. Only an over-full side (a migration adopting a bad state) is moved.
      if (!hp.team) {
        spectate(hp)
        continue
      }
      let team = hp.team
      if (counts[team] >= MATCH.teamSize) {
        team = pickTeam(fakeCount(counts))
        if (counts[team] >= MATCH.teamSize) team = otherTeam(team)
      }
      hp.team = team
      counts[team]++
      write(hp.id, PS.team, team)
    }
    for (const hp of bots) {
      let team = hp.team
      if (!team) {
        team = pickTeam(fakeCount(counts))
        if (counts[team] >= MATCH.teamSize) team = otherTeam(team)
      }
      if (counts[team] >= MATCH.teamSize) {
        // Its side is full — a human took the slot, by joining or by swapping. The bot is
        // KICKED, never moved across: playroomkit 0.0.97 delivers a bot's state to the other
        // clients when it joins and never again, so a bot that changed shirt would keep the old
        // colour (and count for the old team) everywhere but here. A kick and a fresh bot do
        // reach everyone, and the fill below adds that fresh one on the side that needs a body.
        dropBot(hp)
        continue
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

    // Seats, not team slots: a spectator still occupies one of the room's `maxPlayersPerRoom`
    // places, so filling up to `counts.a + counts.b` would ask Playroom for a seventh
    // participant and the `addBot` would simply fail. The teams do fill to 3 + 3 around them —
    // the bot the picker displaces is kicked and re-added on the other side by the pass above.
    if (fill && players.size < MATCH.maxPlayers && !addingBot) {
      addingBot = true
      room
        .addBot()
        .then((bot) => {
          const hp = ensure(bot.id, true)
          const taken = [...players.values()]
            .map((o) => (o.id === hp.id ? null : playerById(o.id)?.getState(PS.name)))
            .filter((n): n is string => typeof n === 'string')
          // Team first, and in the same burst as the rest: everyone else only ever sees the
          // state a bot has when it joins (see the kick above), so waiting for the next
          // `balance()` would risk publishing the team after the join reached them.
          const seats = { a: 0, b: 0 }
          for (const other of players.values()) {
            if (other.id !== hp.id && other.team) seats[other.team]++
          }
          const team = seats.b < seats.a ? 'b' : 'a'
          if (seats[team] < MATCH.teamSize) {
            hp.team = team
            bot.setState(PS.team, team, true)
          }
          bot.setState(PS.name, botName(players.size, taken), true)
          bot.setState(PS.hp, PLAYER.maxHp, true)
          bot.setState(PS.alive, true, true)
          bot.setState(PS.kills, 0, true)
          bot.setState(PS.deaths, 0, true)
          bot.setState(PS.inv, 0, true)
          // The tick's "has a side but was never placed" pass puts it on a spawn point on its
          // next run — `hp.alive` is still false here, and that is exactly why that pass must
          // not test it.
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

  // --- bot stats -----------------------------------------------------------
  // Everything else about a bot reaches the other clients through the bot's own player state —
  // except that playroomkit only sends that state when the bot joins (see `GS.botStats`). So the
  // fields that move afterwards go out as a global instead, which does sync, at 2 Hz. `alive` and
  // `hp` ride along not for the scoreboard but because they are a client's only way back from a
  // lost `kill`/`respawn`: a bot stuck dead over there is a bot nobody can hit.

  let publishedBotStats = ''
  let lastBotStatsAt = 0

  const publishBotStats = (now: number) => {
    if (now - lastBotStatsAt < BOT_STATS_MS) return
    const stats: BotStats = {}
    for (const hp of players.values()) {
      if (!hp.isBot || !hp.team) continue
      stats[hp.id] = { team: hp.team, kills: hp.kills, deaths: hp.deaths, alive: hp.alive, hp: hp.hp }
    }
    // Cheap deep compare: the object is six ids at most, and this runs 20 times a second.
    const encoded = JSON.stringify(stats)
    if (encoded === publishedBotStats) return
    publishedBotStats = encoded
    lastBotStatsAt = now
    room.setGlobal(GS.botStats, stats, true)
  }

  // --- team swaps ----------------------------------------------------------

  /** Host clock ms of the last ACCEPTED swap per player (the rate limit). */
  const lastSwap = new Map<string, number>()

  /**
   * Humans per team. Bots are deliberately not counted: they are filler, and `balance()` moves
   * one of them the other way right after an accepted swap so the room stays 3v3.
   */
  const humanCounts = (): { a: number; b: number } => {
    const counts = { a: 0, b: 0 }
    for (const hp of players.values()) if (!hp.isBot && hp.team) counts[hp.team]++
    return counts
  }

  /** Bots per team — the tie-breaker for `'auto'`. */
  const botCounts = (): { a: number; b: number } => {
    const counts = { a: 0, b: 0 }
    for (const hp of players.values()) if (hp.isBot && hp.team) counts[hp.team]++
    return counts
  }

  /**
   * `'auto'` = the smaller HUMAN side; a tie goes to the side with fewer bots (the one whose
   * filler will be kicked to make room, so the room churns less), and a dead tie goes to 'a'.
   * The asking player is not counted: they are joining, not staying.
   */
  const autoTeam = (id: string): TeamId => {
    const humans = humanCounts()
    const mine = players.get(id)?.team
    if (mine) humans[mine]--
    if (humans.a !== humans.b) return humans.b < humans.a ? 'b' : 'a'
    const bots = botCounts()
    return bots.b < bots.a ? 'b' : 'a'
  }

  const requestTeam = (id: string, choice: TeamChoice): TeamResult => {
    const answer = (ok: boolean, reason?: string, assigned?: TeamId): TeamResult => ({
      player: id,
      team: choice,
      ok,
      assigned,
      reason,
    })
    if (!room.isHost()) return answer(false, 'No host here')
    if (!teamChoiceFrom(choice)) return answer(false, 'Unknown team')
    const hp = players.get(id)
    if (!hp) return answer(false, 'Not in the match yet')
    if (hp.isBot) return answer(false, 'Bots do not pick sides')
    const wanted: TeamId = choice === 'auto' ? autoTeam(id) : choice
    if (hp.team === wanted) return answer(true, undefined, wanted)

    const now = clock.now()
    // A first pick is not a swap: there is no side to leave and the team screen is the only way
    // into the match, so the anti-flip cooldown only starts once somebody has a team to change.
    const joining = hp.team === null
    const since = now - (lastSwap.get(id) ?? -Infinity)
    if (!joining && since < TEAM_SWAP_COOLDOWN_MS) {
      const wait = Math.ceil((TEAM_SWAP_COOLDOWN_MS - since) / 1000)
      return answer(false, `Wait ${wait} s before switching again`)
    }

    // Balance is judged on the humans only, as they would stand after the move — and only when
    // there are no bots to make up the numbers. With the fill on, two friends sharing a side
    // against a team of bots is the whole point of the button; all that matters then is that a
    // side never holds more than three heads.
    const counts = humanCounts()
    if (hp.team) counts[hp.team]--
    counts[wanted]++
    if (counts[wanted] > MATCH.teamSize) return answer(false, `${teamName(wanted)} is full`)
    if (!botsFill() && Math.abs(counts.a - counts.b) > 1) {
      return answer(false, 'Teams would be unbalanced — turn bots on to share a side')
    }

    if (!joining) lastSwap.set(id, now)
    hp.team = wanted
    write(id, PS.team, wanted)
    // Coming off the team screen: they were `alive: false` so that nothing could see or shoot
    // them, and the respawn below is their first appearance in the house.
    if (joining) {
      hp.alive = true
      hp.hp = PLAYER.maxHp
      hp.spawned = false
    }
    // Rebalance on the spot instead of at the next 500 ms window: with the fill on this is what
    // kicks a bot from the side we joined; the same pass adds a fresh one to the side we left,
    // so the room is back to 3v3 within a tick instead of sitting at 4v2.
    lastBalance = now
    balance()
    // Kill-less respawn: no death, no score, straight to the new team's spawn with the usual
    // invincibility. Somebody who is waiting to respawn keeps their timer (swapping is not a way
    // to skip it) — that pending respawn already uses the new team's spawn.
    if (hp.alive) respawn(hp, now)
    return answer(true, undefined, wanted)
  }

  const offTeam = room.rpc.register<TeamRequest>(RPCS.team, (payload, sender) => {
    if (!room.isHost()) return
    // The sender id is the only identity we trust; the payload only carries the wish.
    const id = sender?.id
    if (!id) return
    const choice = teamChoiceFrom(payload?.team)
    void room.rpc.call(
      RPCS.teamResult,
      choice
        ? requestTeam(id, choice)
        : ({ player: id, team: 'auto', ok: false, reason: 'Unknown team' } satisfies TeamResult),
      'all',
    )
  })

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

  /**
   * Every rule here used to answer with the same `null`, which is why a player whose hits stopped
   * counting had nothing to report but a feeling. The refusals carry their reason now, in words
   * meant to be pasted into a bug report; `noticeRejection` sends it back to whoever fired.
   */
  type Validation =
    | { ok: true; shooter: HostPlayer; target: HostPlayer }
    | { ok: false; reason: string }

  const validate = (hit: HitEvent, senderId?: string): Validation => {
    if (!hit || !hit.by || !hit.target) return { ok: false, reason: 'the claim is missing a shooter or a target' }
    if (hit.by === hit.target) return { ok: false, reason: 'you cannot hit yourself' }
    if (!isLive(match.state)) return { ok: false, reason: `the match is in ${match.state.phase}, not live` }
    const shooter = players.get(hit.by)
    const target = players.get(hit.target)
    if (!shooter) return { ok: false, reason: 'the host has no record of the shooter' }
    if (!target) return { ok: false, reason: 'the host has no record of the target' }
    // Only the shooter (or the host, on behalf of its bots) may claim a hit.
    if (senderId && senderId !== hit.by && !(shooter.isBot && senderId === room.me.id)) {
      return { ok: false, reason: 'only the shooter may claim their own hit' }
    }
    if (!shooter.alive) return { ok: false, reason: 'the shooter is dead on the host' }
    if (!target.alive) return { ok: false, reason: 'the target was already dead on the host' }
    // Somebody still on the team screen is on nobody's side: they cannot shoot and cannot be shot.
    if (!shooter.team) return { ok: false, reason: 'the shooter has not picked a side' }
    if (!target.team) return { ok: false, reason: 'the target has not picked a side' }
    if (shooter.team === target.team) return { ok: false, reason: 'same team' }
    const now = clock.now()
    if (target.inv > now) {
      return { ok: false, reason: `the target is invincible for another ${Math.round(target.inv - now)} ms` }
    }
    if (!hit.shotId) return { ok: false, reason: 'the claim carries no shot id' }
    if (!rememberShot(hit.shotId)) return { ok: false, reason: 'that shot has already scored' }
    const snap = playerById(target.id)?.getState(PS.snap) as PlayerSnapshot | undefined
    if (snap && hit.point) {
      const dx = hit.point[0] - snap.x
      const dy = hit.point[1] - snap.y
      const dz = hit.point[2] - snap.z
      const distanceSq = dx * dx + dy * dy + dz * dz
      if (distanceSq > HIT_MAX_DESYNC_M * HIT_MAX_DESYNC_M) {
        return {
          ok: false,
          reason: `the impact is ${Math.sqrt(distanceSq).toFixed(1)} m from where the host last saw the target (max ${HIT_MAX_DESYNC_M} m)`,
        }
      }
    }
    return { ok: true, shooter, target }
  }

  /** Host clock ms of the last rejection notice sent to each shooter — the rate limit. */
  const lastRejectNotice = new Map<string, number>()

  /**
   * Tell the shooter why their hit did not count. Broadcast and filtered by id, like
   * `teamResult`; skipped for a bot, whose shooter is this very tab.
   */
  const noticeRejection = (hit: HitEvent, reason: string): void => {
    if (!hit?.by || players.get(hit.by)?.isBot) return
    const now = clock.now()
    if (now - (lastRejectNotice.get(hit.by) ?? -Infinity) < HIT_REJECT_NOTICE_MS) return
    lastRejectNotice.set(hit.by, now)
    const payload: HitRejected = { player: hit.by, shotId: hit.shotId ?? '', reason }
    void room.rpc.call(RPCS.hitRejected, payload, 'all')
  }

  /**
   * Was the knife planted in the victim's back? The rule is `weapons/melee.ts`'s, applied here
   * so a client cannot claim a backstab it did not earn: with `to` the unit vector from the
   * victim to the impact point on XZ and `forward` its facing, `dot(forward, to) < -0.3` — the
   * blade landed on the back half, with a margin so a hit from the side is not one. The pose is
   * the victim's own last published one (its snapshot, or the entity when nothing has landed
   * yet), never the attacker's word.
   */
  const isBackstab = (target: HostPlayer, point: [number, number, number] | undefined): boolean => {
    if (!point) return false
    const snap = playerById(target.id)?.getState(PS.snap) as PlayerSnapshot | undefined
    const entity = registry.get(target.id)
    const yaw = snap?.yaw ?? entity?.yaw
    const x = snap?.x ?? entity?.position.x
    const z = snap?.z ?? entity?.position.z
    if (yaw === undefined || x === undefined || z === undefined) return false
    const dx = point[0] - x
    const dz = point[2] - z
    const length = Math.hypot(dx, dz)
    if (length < 1e-4) return false
    // yaw 0 looks toward -Z (three.js), so forward = (-sin, -cos) on XZ.
    return (-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / length < -0.3
  }

  const applyHit = (hit: HitEvent, senderId?: string): boolean => {
    const valid = validate(hit, senderId)
    if (!valid.ok) {
      noticeRejection(hit, valid.reason)
      return false
    }
    const { shooter, target } = valid
    const now = clock.now()

    // The shooter names the body part; the host still owns the number that goes with it.
    const part = bodyPart(hit.part)
    const weapon = hit.weapon && hit.weapon in WEAPONS ? hit.weapon : 'rifle'
    const amount = weapon === 'knife'
      ? Math.round(WEAPONS.knife.damage * (isBackstab(target, hit.point) ? WEAPONS.knife.backstabScale : 1))
      : Math.round(DAMAGE[part] * WEAPONS[weapon].damageScale)
    target.hp = Math.max(0, target.hp - amount)
    write(target.id, PS.hp, target.hp)
    void room.rpc.call(
      RPCS.damage,
      { target: target.id, by: shooter.id, hp: target.hp, point: hit.point, part, amount },
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
    const fill = botsFill()
    if (fill !== lastFill) {
      // Somebody (maybe another client's Esc menu, before it handed the room over) flipped the
      // flag: kick or refill now rather than at the next balance window.
      lastFill = fill
      lastBalance = now
      balance()
    } else if (now - lastBalance > BALANCE_MS) {
      lastBalance = now
      balance()
    }

    for (const hp of players.values()) {
      // A side, but never placed: this is the pass that turns a body onto the map, and it must
      // not ask whether they are alive first.
      //
      // `ensure()` records everyone it has not met as a spectator — no team, `alive: false`,
      // no respawn clock — because a human who has not picked yet must have no body anywhere
      // (W5-A). A bot added by the fill goes through that same door: `ensure(bot.id, true)` runs
      // before its `team` state is written, so the record it gets is the spectator one, and the
      // fill then sets `hp.team` a few statements later without touching `alive`. Keying this
      // pass on `alive` therefore meant a bot the fill added was never spawned by anybody: dead
      // to the rules (so unhittable, and every hit on it refused as "already dead"), never
      // respawned by the pass below either, whose clock it never had. It lay at the origin for
      // the rest of the match. A human is spared only because `requestTeam` repairs the record
      // by hand when they pick.
      if (hp.team && !hp.spawned) respawn(hp, now)
      else if (!hp.alive && hp.respawnAt && now >= hp.respawnAt) respawn(hp, now)
      // Dead, on a side, and with no clock running. Only a bad adopt or a side picked in the
      // middle of dying reaches this, and without it they wait for a respawn nobody scheduled.
      else if (!hp.alive && hp.team && !hp.respawnAt) hp.respawnAt = now + PLAYER.respawnDelayMs
    }

    // A bot's entry in the registry is ours to keep honest. Nothing else can: a bot has no
    // client writing its state, and the state Playroom replayed for it when it joined can be
    // arbitrarily old (see `GS.botStats`). A stale `alive: false` reaching the registry is not
    // a cosmetic problem — `remote-players.ts` builds no capsule for a corpse, so the bot would
    // stand there on the host's own screen with every paintball passing through it.
    for (const hp of players.values()) {
      if (!hp.isBot) continue
      const entity = registry.get(hp.id)
      if (!entity) continue
      entity.alive = hp.alive
      entity.hp = hp.hp
    }

    publishBotStats(now)

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
      offTeam()
      offHostChange()
      players.clear()
      lastSwap.clear()
      lastRejectNotice.clear()
      active = null
    },
    submitHit: (hit, senderId) => applyHit(hit, senderId ?? room.me.id),
    setMap(map) {
      room.setGlobal(GS.map, map, true)
      events.emit('map-changed', map)
    },
    get botsFill() {
      return botsFill()
    },
    setBotsFill(on) {
      if (!room.isHost()) return
      room.setGlobal(GS.botsFill, botsFillValue(on), true)
      lastFill = on
      lastBalance = clock.now()
      balance()
    },
    requestTeam,
    respawnAll,
    respawnPlayer(id) {
      if (!id || !room.isHost()) return false
      const hp = players.get(id)
      // Nothing to put back for a player who has not picked a side yet.
      if (!hp?.team) return false
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

/** Never trust a body part off the wire: an unknown one is a torso hit. */
function bodyPart(value: unknown): BodyPart {
  return typeof value === 'string' && value in DAMAGE ? (value as BodyPart) : 'torso'
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

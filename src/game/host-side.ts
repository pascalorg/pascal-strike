/**
 * Everything that only runs on the host (W2): the rules authority and the bot simulation.
 *
 * The host is not a special build of the game — any client can become one after a migration —
 * so this is a small state machine around `room.isHost()`: start when we inherit the room, stop
 * when we lose it, rebuild when the map changes.
 */
import { Vector3 } from 'three'
import { DOORS } from '../config'
import type { Audio, AudioListenerPose } from '../engine/audio'
import { startHostAuthority, type HostAuthority } from '../net/host'
import { PS, RPCS, type FellEvent } from '../net/protocol'
import type { Room } from '../net/room'
import type { NetClock } from '../net/sync'
import type { BotRunner, EventBus, SpawnPoint, TeamId } from '../types'
import type { EntityRegistry } from './entities'
import type { MapSession } from './map-session'

export interface HostSideOptions {
  room: Room
  registry: EntityRegistry
  events: EventBus
  clock: NetClock
  audio: Audio
  /**
   * Read at call time — the session object is replaced on every map change, and is null for
   * the length of one: nothing here may touch a map that is being torn down.
   */
  session: () => MapSession | null
  /** Listener pose for positional bot gunfire. */
  listener: () => AudioListenerPose
}

export interface HostSide {
  /** Null while somebody else hosts. */
  readonly authority: HostAuthority | null
  readonly bots: BotRunner | null
  /**
   * Stop and free the bot runner. Must be called *before* the session it was built from is
   * disposed: the runner holds that map's recast navmesh, and a path query against a freed
   * one hangs the main thread.
   */
  suspend(): void
  /** Rebuild the bot runner against the current session (after a map change). */
  reload(): void
  dispose(): void
}

/** How often the host checks whether a bot has fallen out of the world. */
const FALL_CHECK_MS = 1000
/**
 * How often the host looks for a shut door in front of a bot. Bots run at 5.5 m/s, so this is
 * a check every ~0.5 m — a per-frame test would cost the same decision at 8x the price, and
 * the door tick has to survive `bots.update` being driven from `game.ts`, not from here.
 */
const BOT_DOOR_CHECK_MS = 90
/** One toggle per door per this long, so two bots in a doorway cannot flap it. */
const BOT_DOOR_COOLDOWN_MS = 1_500
/** A bot only opens doors on its own floor (door centres sit ~1 m above the slab). */
const BOT_DOOR_MAX_VERTICAL = 2
const BOT_DOOR_RADIUS_SQ = DOORS.botOpenRadius * DOORS.botOpenRadius
const _spawnScratch: Vector3[] = []
const _respawnPoint = new Vector3()

export function createHostSide(opts: HostSideOptions): HostSide {
  const { room, registry, events, clock, audio } = opts
  let authority: HostAuthority | null = null
  let bots: BotRunner | null = null
  let disposed = false

  // --- spawns --------------------------------------------------------------

  const spawnProvider = (team: TeamId): SpawnPoint | null => {
    const session = opts.session()
    if (!session) return null
    _spawnScratch.length = 0
    for (const entity of registry.list()) if (entity.alive) _spawnScratch.push(entity.position)
    return session.leastCrowdedSpawn(team, _spawnScratch)
  }

  // --- bots ----------------------------------------------------------------

  async function startBots(): Promise<void> {
    const session = opts.session()
    if (!session) return
    // Bots path with recast, so they wait for it rather than walking into walls meanwhile.
    // A map change while we wait replaces (or clears) the session — then this build is stale.
    const nav = await session.navReady
    if (disposed || opts.session() !== session || !authority || bots) return
    let create: typeof import('../bots/bot').createBotRunner
    try {
      ;({ createBotRunner: create } = await import('../bots/bot'))
    } catch (err) {
      console.warn('[host] no bots package — bots will stand at their spawn', err)
      return
    }
    if (disposed || opts.session() !== session || !authority || bots) return

    bots = create({
      map: session.map,
      world: session.world,
      nav: nav ?? fallbackNav(session),
      entities: () => registry.list(),
      spawns: () => session.spawns,
      onShot: (bot, shot) => {
        // Bot bullets are simulated here (detectPlayers), so their hits reach `submitHit`
        // through the same projectile sim as ours; everyone else only paints.
        session.projectiles.spawn(shot, { detectPlayers: true })
        void room.rpc.call(RPCS.shot, shot, 'others')
        audio.play('shot', bot.position, opts.listener())
      },
      onSnapshot: (bot, snapshot) => {
        // The runner reuses one snapshot object per bot, so copy before handing it to Playroom.
        room.players().find((p) => p.id === bot.id)?.setState(PS.snap, { ...snapshot }, false)
      },
      now: () => clock.now(),
      seed: hashString(session.selection.id || session.selection.url),
    })
    for (const entity of registry.list()) if (entity.isBot) bots.addBot(entity)
  }

  function stopBots(): void {
    bots?.dispose()
    bots = null
  }

  // --- lifecycle -----------------------------------------------------------

  function start(): void {
    if (authority || !room.isHost()) return
    authority = startHostAuthority(room, registry, spawnProvider, events, clock)
    void startBots()
  }

  function stop(): void {
    stopBots()
    authority?.stop()
    authority = null
  }

  start()
  const offHostChange = room.onHostChange((isHost) => (isHost ? start() : stop()))

  // Falling out of the world is not damage, so it cannot go through `hit`.
  const offFell = room.rpc.register<FellEvent>(RPCS.fell, (payload, sender) => {
    authority?.respawnPlayer(sender?.id ?? payload?.player)
  })

  const offChange = registry.onChange((change, entity) => {
    if (!entity || !bots) return
    if (change === 'added' && entity.isBot) bots.addBot(entity)
    else if (change === 'removed') bots.removeBot(entity.id)
  })

  const offRespawn = events.on('respawn', (ev) => {
    if (!bots || !registry.get(ev.player)?.isBot) return
    _respawnPoint.set(ev.position[0], ev.position[1], ev.position[2])
    bots.respawn(ev.player, _respawnPoint, ev.yaw)
  })

  // --- bots and doors ------------------------------------------------------
  // Players open doors with E; bots cannot press keys, so the host nudges the door in front of
  // them through the very same RPC. Windows are never touched: a bot has no reason to, and the
  // sash swinging into a room it is walking past looks like a bug.

  const doorCooldown = new Map<string, number>()
  const doorTimer = window.setInterval(() => {
    const session = opts.session()
    if (!authority || !session) return
    const doors = session.map.doors
    if (doors.length === 0) return
    const now = Date.now()
    for (const entity of registry.list()) {
      if (!entity.isBot || !entity.alive) continue
      const feet = entity.position
      for (const door of doors) {
        if ((door.kind ?? 'door') !== 'door') continue
        if (session.doors.isOpen(door.id)) continue
        if ((doorCooldown.get(door.id) ?? 0) > now) continue
        if (Math.abs(feet.y - (door.center.y - 1)) >= BOT_DOOR_MAX_VERTICAL) continue
        const dx = feet.x - door.center.x
        const dz = feet.z - door.center.z
        if (dx * dx + dz * dz > BOT_DOOR_RADIUS_SQ) continue
        doorCooldown.set(door.id, now + BOT_DOOR_COOLDOWN_MS)
        void room.rpc.call(RPCS.door, { id: door.id, open: true, by: entity.id }, 'all')
      }
    }
  }, BOT_DOOR_CHECK_MS)

  // A bot that slips through a gap in the map would otherwise fall forever.
  const fallTimer = window.setInterval(() => {
    const session = opts.session()
    if (!authority || !session) return
    const floor = session.map.bounds.min.y - 8
    for (const entity of registry.list()) {
      if (entity.isBot && entity.alive && entity.position.y < floor) {
        authority.respawnPlayer(entity.id)
      }
    }
  }, FALL_CHECK_MS)

  return {
    get authority() {
      return authority
    },
    get bots() {
      return bots
    },
    suspend() {
      stopBots()
    },
    reload() {
      stopBots()
      doorCooldown.clear()
      if (authority) void startBots()
    },
    dispose() {
      disposed = true
      window.clearInterval(fallTimer)
      window.clearInterval(doorTimer)
      doorCooldown.clear()
      offHostChange()
      offFell()
      offChange()
      offRespawn()
      stop()
    },
  }
}

/** Straight-line stand-in with the shape `Navigation` demands, when recast is unavailable. */
function fallbackNav(session: MapSession) {
  const center = session.map.bounds.getCenter(new Vector3())
  return {
    ready: false,
    findPath: (from: Vector3, to: Vector3) => [from.clone(), to.clone()],
    randomPoint: () => center.clone(),
    randomPointAround: (c: Vector3) => c.clone(),
    closestPoint: (p: Vector3) => p.clone(),
  }
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

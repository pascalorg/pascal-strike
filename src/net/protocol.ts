/**
 * The wire contract: every state key, RPC name and payload shape used by the net layer.
 *
 * Single source of truth — host and clients import from here so a rename can never
 * desynchronise the two sides.
 */
import { PLAYER } from '../config'
import type {
  DamageEvent,
  HitEvent,
  KillEvent,
  MapSelection,
  MatchState,
  PlayerSnapshot,
  RespawnEvent,
  ShotEvent,
  TeamId,
} from '../types'

export type {
  DamageEvent,
  HitEvent,
  KillEvent,
  MapSelection,
  MatchState,
  PlayerSnapshot,
  RespawnEvent,
  ShotEvent,
  TeamId,
}

/** Per-player state keys (`player.setState(key, value, reliable)`). */
export const PS = {
  /** string — display name */
  name: 'name',
  /** TeamId — host assigns */
  team: 'team',
  /** number — host writes */
  hp: 'hp',
  /** boolean — host writes */
  alive: 'alive',
  /** number — Date.now() ms until which the player cannot be damaged. Host writes. */
  inv: 'inv',
  /** number — host writes */
  kills: 'kills',
  /** number — host writes */
  deaths: 'deaths',
  /** PlayerSnapshot — owner writes unreliably at NET.snapshotHz (host writes for bots) */
  snap: 'p',
} as const

/** Global (room) state keys — host only writes these. */
export const GS = {
  /** MapSelection */
  map: 'map',
  /** MatchState */
  match: 'match',
  /** number — host Date.now(), refreshed every CLOCK_SYNC_MS so clients can estimate an offset */
  hostNow: 'hostNow',
} as const

/** RPC names. */
export const RPCS = {
  /** OTHERS — ShotEvent, receivers spawn a paint-only projectile */
  shot: 'shot',
  /** HOST — HitEvent, the host validates then applies damage */
  hit: 'hit',
  /** ALL — DamageEvent, HUD feedback */
  damage: 'damage',
  /** ALL — KillEvent, kill feed + death FX */
  kill: 'kill',
  /** ALL — RespawnEvent, teleport + shield */
  respawn: 'respawn',
} as const

export type RpcName = (typeof RPCS)[keyof typeof RPCS]

/** How a call is routed. Mapped onto Playroom's numeric `RPC.Mode` inside `room.ts`. */
export type RpcMode = 'host' | 'all' | 'others'

/** Host refreshes `hostNow` at this period (ms). */
export const CLOCK_SYNC_MS = 5_000

/** A hit whose impact point is farther than this from the target's last snapshot is rejected. */
export const HIT_MAX_DESYNC_M = 3

/** How many recent shot ids the host remembers to reject replays. */
export const SEEN_SHOTS = 512

export const DEFAULT_PLAYER_STATES: Record<string, unknown> = {
  [PS.name]: '',
  [PS.hp]: PLAYER.maxHp,
  [PS.alive]: true,
  [PS.inv]: 0,
  [PS.kills]: 0,
  [PS.deaths]: 0,
}

export const DEFAULT_STATES: Record<string, unknown> = {
  [GS.hostNow]: 0,
}

/** Payload of every RPC, keyed by name — lets `rpc.register` stay type safe. */
export interface RpcPayloads {
  shot: ShotEvent
  hit: HitEvent
  damage: DamageEvent
  kill: KillEvent
  respawn: RespawnEvent
}

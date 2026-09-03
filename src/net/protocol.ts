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
  /** WeaponKind — the weapon in hand; owner writes on every switch. Missing = rifle. */
  weapon: 'w',
} as const

/** Global (room) state keys — host only writes these. */
export const GS = {
  /** MapSelection */
  map: 'map',
  /** MatchState */
  match: 'match',
  /** number — host Date.now(), refreshed every CLOCK_SYNC_MS so clients can estimate an offset */
  hostNow: 'hostNow',
  /**
   * DoorStates — every openable's state in the current map. The host rewrites it on every
   * `door` RPC so a late joiner can adopt the house as it is instead of a house of shut doors.
   */
  doors: 'doors',
  /**
   * `'on' | 'off'` — "fill empty slots with bots". The room creator picks it in the lobby and
   * the host can flip it mid-match from the Esc menu; `host.ts` reads it on every balance pass.
   * Living in global state means a host migration inherits it like everything else.
   *
   * Not a boolean on the wire on purpose: playroomkit 0.0.97 never delivers a global whose
   * value is exactly `false` to the other clients (`0`, `'off'` and `true` all arrive), which
   * would leave joiners showing a stale "bots on" and — worse — hand a new host after a
   * migration a room that refills itself. Always encode with `botsFillValue`, decode with
   * `botsFillFrom`; a missing value (old rooms) reads as ON.
   */
  botsFill: 'botsFill',
} as const

/** What `botsFill` means when the room state has no value for it. */
export const BOTS_FILL_DEFAULT = true

/** Encode the flag for `setGlobal`. */
export function botsFillValue(on: boolean): 'on' | 'off' {
  return on ? 'on' : 'off'
}

/** Read the flag, tolerating a room that never published one (and legacy booleans). */
export function botsFillFrom(value: unknown): boolean {
  if (value === 'off' || value === false) return false
  if (value === 'on' || value === true) return true
  return BOTS_FILL_DEFAULT
}

/** Has anybody published the flag yet? (An unset room is not the same as one set to on.) */
export function botsFillIsSet(value: unknown): boolean {
  return value === 'on' || value === 'off' || typeof value === 'boolean'
}

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
  /**
   * HOST — FellEvent. Falling out of the world is not damage, so it cannot go through `hit`:
   * the victim asks the host to put it back on a spawn point (W2 addition).
   */
  fell: 'fell',
  /**
   * ALL — DoorEvent. Openables are not host-authoritative: whoever pressed E decides and
   * everyone (the caller included, hence ALL) applies the same state. The host additionally
   * mirrors the result into the `doors` room state for late joiners.
   */
  door: 'door',
  /**
   * HOST — TeamRequest. Teams stay host-authoritative: the Esc menu asks, the host decides
   * (balance, cooldown, bot rebalance) and answers with `teamResult`.
   */
  team: 'team',
  /**
   * ALL — TeamResult. Playroom has no "reply to one player" mode and our `rpc.register`
   * wrapper drops handler return values, so the host's answer is a broadcast that every
   * client filters by `player`.
   */
  teamResult: 'teamResult',
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

/** One accepted team swap per player per this long (host-enforced). */
export const TEAM_SWAP_COOLDOWN_MS = 10_000

/** How long the menu waits for the host's `teamResult` before giving up on a swap. */
export const TEAM_SWAP_TIMEOUT_MS = 4_000

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

/** Sent to the host by a player whose controller fell out of the world. */
export interface FellEvent {
  /** Who fell — the host trusts the sender id, this is only a sanity check. */
  player: string
}

/** Somebody opened or closed a door or a window. */
export interface DoorEvent {
  /** `DoorInfo.id` (the Pascal id of the door/window node). */
  id: string
  open: boolean
  /** Player or bot that triggered it, for the SFX/feedback side. */
  by: string
}

/** Value of the `doors` room state: `{ [DoorInfo.id]: open }` for the current map. */
export type DoorStates = Record<string, boolean>

/** "Move me to the other team." The host trusts the sender id, never the payload. */
export interface TeamRequest {
  team: TeamId
}

/** The host's answer to one `team` request. Broadcast; only `player` acts on it. */
export interface TeamResult {
  player: string
  /** The team that was asked for (not necessarily the one the player ends up on). */
  team: TeamId
  ok: boolean
  /** Why it was refused, ready to show in the menu ("Teams would be unbalanced"). */
  reason?: string
}

/** Payload of every RPC, keyed by name — lets `rpc.register` stay type safe. */
export interface RpcPayloads {
  shot: ShotEvent
  hit: HitEvent
  damage: DamageEvent
  kill: KillEvent
  respawn: RespawnEvent
  fell: FellEvent
  door: DoorEvent
  team: TeamRequest
  teamResult: TeamResult
}

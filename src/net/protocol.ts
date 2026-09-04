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
  /**
   * TeamId — the host writes it, and only once the player has PICKED (W5-A). Missing is a
   * meaningful value: that human is still on the team screen, i.e. a spectator — no spawn, no
   * hittable, not counted for balance or bot fill. Bots always have one from the moment they join.
   */
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
  /**
   * GlassStates — the ids of every pane broken in the current map, mirrored by the host on
   * every `glass` RPC so a late joiner walks into the house with the same windows missing.
   * Cleared on a map change: pane ids are per map.
   */
  glass: 'glass',
  /**
   * BotStats — `{ team, kills, deaths, alive, hp }` per bot, republished by the host whenever
   * one changes (at most every `BOT_STATS_MS`).
   *
   * A bot is a real participant with its own state, but playroomkit 0.0.97 only ever delivers
   * that state to the other clients when the bot JOINS: every later `setState` on a bot stays on
   * the host, so a joiner's scoreboard showed bots frozen at the kills they had when it walked
   * in. Globals do sync, so the host mirrors the fields that move.
   *
   * `alive` and `hp` are here for a harder reason than a scoreboard. On a client they are moved
   * by the `kill`, `respawn` and `damage` RPCs and by nothing else, so one dropped `respawn`
   * leaves a bot dead forever — and a dead body has no capsule in `remote-players.ts`, which is
   * a bot that every paintball passes through, on that one client, for the rest of the match.
   * This is the only thing that can get a client out of that, so it is not optional bookkeeping.
   */
  botStats: 'botStats',
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
   * ALL — GlassEvent. Like doors, a pane is not host-authoritative: whoever's paintball went
   * through it says so and everyone shatters the same id. Receivers dedupe on `isBroken`, so a
   * client that already broke it from its own simulation does nothing.
   */
  glass: 'glass',
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
  /**
   * ALL — HitRejected, filtered by `player` the way `teamResult` is (Playroom cannot answer one
   * player). Sent only when a HUMAN's claim is refused: a bot's shooter is the host itself, and
   * a held trigger on an invincible target would be twelve broadcasts a second of the host
   * telling itself something it already knows.
   *
   * Every rule in `validate()` used to return the same silent `null`, so a shooter could not
   * tell a refusal from a paintball that missed — which is why "hits stopped registering" could
   * only ever be reported as a feeling. Now the reason travels back to whoever fired.
   */
  hitRejected: 'hitRejected',
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

/** How often the host may republish `botStats` (2 Hz — scoreboard numbers, not gameplay). */
export const BOT_STATS_MS = 500

/**
 * How long the `botStats` mirror must disagree with a bot entity before a client believes it
 * over its own copy. The mirror is the host's truth but it is the slower of the two channels
 * (2 Hz, and only on a change), so a fresh disagreement means the RPCs are simply ahead of it —
 * not that anything is wrong. Comfortably longer than `BOT_STATS_MS` plus a round trip.
 */
export const BOT_MIRROR_GRACE_MS = 1_500

/**
 * At most one rejection notice per shooter per this long. A rifle held on an invincible target
 * is twelve refusals a second and the shooter only needs to know that it is happening.
 */
export const HIT_REJECT_NOTICE_MS = 500

/** One accepted team swap per player per this long (host-enforced). */
export const TEAM_SWAP_COOLDOWN_MS = 10_000

/** How long the menu waits for the host's `teamResult` before giving up on a swap. */
export const TEAM_SWAP_TIMEOUT_MS = 4_000

/**
 * How long `isHost()` must hold one value before a client acts on it (W5-A).
 *
 * A Playroom socket hiccup flipped a guest's `isHost()` to true for about a second; it started a
 * full authority — adopt, bot loader, state writes — while the real host was still there, and for
 * that second two clients wrote the same player states. `isHost()` is polled at 1 Hz, so three
 * consecutive agreeing seconds is the cheapest filter that a blip cannot pass; a real migration
 * pays three seconds of nobody hosting, which the players never see (the authority is idempotent
 * and adopts the published state when it does start).
 */
export const HOST_STABLE_MS = 3_000

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

/** What the host publishes about one bot (see `GS.botStats`). */
export interface BotStat {
  team: TeamId
  kills: number
  deaths: number
  /** Host truth, and a client's only way back from a lost `kill`/`respawn` RPC. */
  alive: boolean
  hp: number
}

/**
 * The host threw one of your hits away, and why. Reaches every client (Playroom has no reply-to-
 * one mode); the shooter is the one whose id matches `player`. `?debug=1` shows the last reason.
 */
export interface HitRejected {
  player: string
  /** `HitEvent.shotId`, or empty when the claim was too malformed to carry one. */
  shotId: string
  /** Plain English, meant to be read in a bug report. */
  reason: string
}

/** Value of the `botStats` room state: bot player id → its stats. */
export type BotStats = Record<string, BotStat>

/** Somebody's paintball shattered a pane. */
export interface GlassEvent {
  /** `GlassPane.id` (`glass:<n>` in GLB traversal order, the same on every client). */
  id: string
  /** Who fired the shot that broke it. */
  by: string
}

/** Value of the `glass` room state: the ids of the panes broken in the current map. */
export type GlassStates = string[]

/**
 * What a player may ask for: a side, or `'auto'` — "put me on the smaller team" (W5-A). The host
 * resolves `'auto'` itself so the answer cannot depend on a client's stale view of the room.
 */
export type TeamChoice = TeamId | 'auto'

/** Read a `PS.team` state value: anything that is not a side means "still choosing". */
export function teamFrom(value: unknown): TeamId | null {
  return value === 'a' || value === 'b' ? value : null
}

/** Read a team choice off the wire ('auto' included); unknown values are refused by the host. */
export function teamChoiceFrom(value: unknown): TeamChoice | null {
  return value === 'a' || value === 'b' || value === 'auto' ? value : null
}

/** "Put me on this team." The host trusts the sender id, never the payload. */
export interface TeamRequest {
  team: TeamChoice
}

/** The host's answer to one `team` request. Broadcast; only `player` acts on it. */
export interface TeamResult {
  player: string
  /** What was asked for — `'auto'` included, so a refusal can be shown on the card that asked. */
  team: TeamChoice
  ok: boolean
  /** The side the host actually put them on. Only set when `ok`. */
  assigned?: TeamId
  /** Why it was refused, ready to show on the card ("Teal is full"). */
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
  glass: GlassEvent
  team: TeamRequest
  teamResult: TeamResult
}

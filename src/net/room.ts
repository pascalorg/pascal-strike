/**
 * Playroom wrapper. Everything the rest of the game knows about the network goes through
 * this small surface, so the SDK's quirks (array-vs-record participants, `#r=R<code>` hash
 * format, host polling) stay in one file.
 */
import {
  Bot,
  RPC,
  addBot as prAddBot,
  getParticipants,
  getRoomCode,
  getState,
  insertCoin,
  isHost,
  myPlayer,
  onPlayerJoin,
  setState,
  type PlayerState,
} from 'playroomkit'
import { ENV, MATCH } from '../config'
import type { MapSelection } from '../types'
import { DEFAULT_PLAYER_STATES, DEFAULT_STATES, GS, PS, type RpcMode } from './protocol'

/**
 * Playroom instantiates the bot class on every client (the host drives it, the others just
 * need the object to exist), so the constructor must stay side-effect free. The brain and the
 * state initialisation live in `host.ts` / W2-B, behind an `isHost()` guard.
 */
export class PascalBot extends Bot {
  constructor(params: object) {
    super(params)
  }
}

/** The bot's underlying participant. Present at runtime, missing from playroomkit's types. */
interface BotWithPlayer {
  player: PlayerState
}

export type RoomErrorCode =
  | 'ROOM_FULL'
  | 'KICKED'
  | 'NO_GAME_ID'
  | 'ALREADY_JOINED'
  | 'QUOTA_EXCEEDED'
  | 'CONNECT_FAILED'

export class RoomError extends Error {
  code: RoomErrorCode
  constructor(code: RoomErrorCode, message: string) {
    super(message)
    this.name = 'RoomError'
    this.code = code
  }
}

export interface Room {
  me: PlayerState
  isHost(): boolean
  roomCode: string
  inviteUrl: string
  /** Humans + bots currently in the room. */
  players(): PlayerState[]
  /** Fires for players already in the room too (Playroom replays them in join order). */
  onJoin(cb: (p: PlayerState) => void): () => void
  onLeave(cb: (id: string) => void): () => void
  onHostChange(cb: (isHost: boolean) => void): () => void
  getGlobal<T>(key: string): T | undefined
  setGlobal(key: string, value: unknown, reliable?: boolean): void
  addBot(): Promise<PlayerState>
  kick(id: string): void
  rpc: {
    register<T>(name: string, cb: (payload: T, sender: PlayerState) => void | Promise<unknown>): () => void
    call(name: string, payload: unknown, mode?: RpcMode): Promise<unknown>
  }
  leave(): void
}

export interface JoinOptions {
  name: string
  /** Explicit code for "join with code"; otherwise the `#r=` hash decides, else a new room. */
  roomCode?: string
  /** Host-only: the map everyone will load. */
  map?: MapSelection | null
}

const RPC_MODE = { all: RPC.Mode.ALL, others: RPC.Mode.OTHERS, host: RPC.Mode.HOST } as const

/** Playroom's hash carries the code prefixed with "R" (`#r=RabC12`); it slices that R off. */
export function roomCodeFromHash(): string | undefined {
  const match = /(?:^|[#&])r=([^&]+)/.exec(location.hash)
  if (!match) return undefined
  const raw = decodeURIComponent(match[1])
  return raw.startsWith('R') ? raw.slice(1) : raw
}

export function inviteUrlFor(code: string): string {
  // Keep the query string so dev routes (?dev=net) survive the invite.
  return `${location.origin}${location.pathname}${location.search}#r=R${code}`
}

function participants(): PlayerState[] {
  const raw = getParticipants() as unknown as PlayerState[] | Record<string, PlayerState>
  return Array.isArray(raw) ? raw : Object.values(raw ?? {})
}

/** Runtime helper: playroomkit's `PlayerState` type omits `isBot()`. */
export function isBotPlayer(p: PlayerState): boolean {
  return (p as unknown as { isBot?: () => boolean }).isBot?.() === true
}

let joined: Promise<Room> | null = null

/** `insertCoin` can only be called once per page — the second call silently never resolves. */
export function currentRoom(): Promise<Room> | null {
  return joined
}

export function joinRoom(opts: JoinOptions): Promise<Room> {
  if (joined) return joined
  joined = connect(opts).catch((err) => {
    joined = null
    throw err
  })
  return joined
}

async function connect(opts: JoinOptions): Promise<Room> {
  if (!ENV.playroomGameId) {
    throw new RoomError('NO_GAME_ID', 'VITE_PLAYROOM_GAME_ID is not set — check your .env')
  }
  if ((window as unknown as { __playroomjs_mounted?: boolean }).__playroomjs_mounted) {
    throw new RoomError('ALREADY_JOINED', 'Already connected to a room in this tab')
  }

  // Never seed `name` here: room defaults are shared, so bots would inherit the creator's name.
  const defaultPlayerStates = { ...DEFAULT_PLAYER_STATES }
  const defaultStates = { ...DEFAULT_STATES }
  if (opts.map) defaultStates[GS.map] = opts.map

  try {
    await insertCoin({
      gameId: ENV.playroomGameId,
      skipLobby: true,
      maxPlayersPerRoom: MATCH.maxPlayers,
      enableBots: true,
      botOptions: { botClass: PascalBot },
      roomCode: opts.roomCode,
      defaultPlayerStates,
      defaultStates,
    })
  } catch (err) {
    throw toRoomError(err)
  }

  const me = myPlayer()
  me.setState(PS.name, opts.name, true)

  const code = getRoomCode() ?? ''
  const leaveListeners = new Set<(id: string) => void>()
  const cleanups: (() => void)[] = []
  const watchedQuits = new Set<string>()

  const watchQuit = (p: PlayerState) => {
    if (watchedQuits.has(p.id)) return
    watchedQuits.add(p.id)
    const off = p.onQuit(() => {
      watchedQuits.delete(p.id)
      for (const cb of leaveListeners) cb(p.id)
    })
    cleanups.push(off)
  }
  cleanups.push(onPlayerJoin(watchQuit))

  let hostFlag = isHost()
  const hostListeners = new Set<(h: boolean) => void>()
  const hostTimer = window.setInterval(() => {
    const now = isHost()
    if (now === hostFlag) return
    hostFlag = now
    for (const cb of hostListeners) cb(now)
  }, 1000)
  cleanups.push(() => window.clearInterval(hostTimer))

  const room: Room = {
    me,
    isHost: () => isHost(),
    roomCode: code,
    inviteUrl: inviteUrlFor(code),
    players: participants,
    onJoin(cb) {
      return onPlayerJoin((p) => {
        watchQuit(p)
        cb(p)
      })
    },
    onLeave(cb) {
      leaveListeners.add(cb)
      return () => leaveListeners.delete(cb)
    },
    onHostChange(cb) {
      hostListeners.add(cb)
      return () => hostListeners.delete(cb)
    },
    getGlobal<T>(key: string) {
      const value = getState(key)
      return (value ?? undefined) as T | undefined
    },
    setGlobal(key, value, reliable = true) {
      setState(key, value, reliable)
    },
    async addBot() {
      const bot = (await prAddBot()) as unknown as BotWithPlayer
      if (!bot?.player) throw new RoomError('CONNECT_FAILED', 'addBot() returned no player')
      return bot.player
    },
    kick(id) {
      const target = participants().find((p) => p.id === id)
      target?.kick()
    },
    rpc: {
      register(name, cb) {
        return RPC.register(name, async (payload, sender) => {
          await cb(payload, sender)
          return undefined
        })
      },
      call(name, payload, mode = 'all') {
        return RPC.call(name, payload, RPC_MODE[mode])
      },
    },
    leave() {
      for (const off of cleanups) off()
      cleanups.length = 0
      try {
        me.leaveRoom()
      } catch {
        /* already gone */
      }
      joined = null
    },
  }

  return room
}

function toRoomError(err: unknown): RoomError {
  const message = String((err as { message?: string })?.message ?? err ?? 'unknown error')
  if (message.includes('ROOM_LIMIT_EXCEEDED')) {
    return new RoomError('ROOM_FULL', 'That room is full (6 players max).')
  }
  if (message.includes('PLAYER_KICKED')) return new RoomError('KICKED', 'You were kicked.')
  if (message.includes('QUOTA_EXCEEDED')) {
    return new RoomError('QUOTA_EXCEEDED', 'Playroom quota exceeded for this game id.')
  }
  return new RoomError('CONNECT_FAILED', `Could not join the room: ${message}`)
}

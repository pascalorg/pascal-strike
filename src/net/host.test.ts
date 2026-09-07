// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { ARMOR, MATCH, PLAYER } from '../config'
import { createEventBus } from '../engine/events'
import { createEntityRegistry } from '../game/entities'
import type { HitEvent, SpawnPoint } from '../types'
import { startHostAuthority } from './host'
import { PS, RPCS } from './protocol'
import type { Room } from './room'
import type { NetClock } from './sync'

/**
 * The authority ticks on `window.setInterval`. Capturing the callback instead of running it is
 * what makes the respawn clock testable: nothing here waits 2.5 real seconds.
 */
const ticks: Array<() => void> = []
if (typeof window === 'undefined') {
  ;(globalThis as unknown as { window: unknown }).window = {
    setInterval: (fn: () => void) => ticks.push(fn),
    clearInterval: () => {},
  }
}

interface FakePlayer {
  id: string
  state: Record<string, unknown>
  bot: boolean
}

function makeRoom(participants: FakePlayer[]) {
  const calls: { name: string; payload: any }[] = []
  const globals: Record<string, unknown> = {}
  const player = (p: FakePlayer) => ({
    id: p.id,
    getState: (key: string) => p.state[key],
    setState: (key: string, value: unknown) => {
      p.state[key] = value
    },
    isBot: () => p.bot,
  })
  const room = {
    me: player(participants[0]),
    isHost: () => true,
    roomCode: 'TEST',
    inviteUrl: '',
    players: () => participants.map(player),
    onJoin: () => () => {},
    onLeave: () => () => {},
    onHostChange: () => () => {},
    getGlobal: <T,>(key: string) => globals[key] as T | undefined,
    setGlobal: (key: string, value: unknown) => {
      globals[key] = value
    },
    // The fill is satisfied by the participants we were handed; nothing new joins mid-test.
    addBot: () => Promise.reject(new Error('no more seats')),
    kick: () => {},
    rpc: {
      register: () => () => {},
      call: (name: string, payload: unknown) => {
        calls.push({ name, payload })
        return Promise.resolve(undefined)
      },
    },
    leave: () => {},
  } as unknown as Room
  return { room, calls, globals }
}

const spawn: SpawnPoint = { position: new Vector3(3, 0, 4), yaw: 0 }

function setup() {
  ticks.length = 0
  let now = 1_000_000
  const clock: NetClock = { now: () => now, offset: 0, stop() {} }
  // A human who has already picked, and a bot straight out of the fill: its `team` state is
  // written by `balance()`, but nothing ever marks its record alive. That is the whole bug.
  const participants: FakePlayer[] = [
    { id: 'human', bot: false, state: { [PS.team]: 'a', [PS.alive]: true, [PS.hp]: PLAYER.maxHp } },
    { id: 'bot', bot: true, state: {} },
  ]
  const { room, calls } = makeRoom(participants)
  const registry = createEntityRegistry()
  registry.upsert({ id: 'human', isLocal: true, team: 'a' })
  const bot = registry.upsert({ id: 'bot', isBot: true, team: 'b' })
  const events = createEventBus()
  const authority = startHostAuthority(room, registry, () => spawn, events, clock)
  const tick = (advanceMs = 0) => {
    now += advanceMs
    for (const fn of ticks) fn()
  }
  return { authority, calls, tick, bot, participants, at: () => now }
}

test('a bot the fill just added is put on a spawn point, not left lying at the origin', () => {
  const { authority, calls, tick, bot, participants } = setup()
  tick()
  tick()

  // The record the rules read, mirrored into the registry every tick.
  expect(bot.alive).toBe(true)
  expect(bot.hp).toBe(PLAYER.maxHp)
  expect(bot.armor).toBe(ARMOR.max)
  // And it was actually placed, rather than merely flagged alive where it stood.
  const respawns = calls.filter((c) => c.name === RPCS.respawn && c.payload.player === 'bot')
  expect(respawns).toHaveLength(1)
  expect(respawns[0].payload.position).toEqual([3, 0, 4])
  // A bot with no side of its own gets one from `balance()` before any of that.
  expect(participants[1].state[PS.team]).toBeOneOf(['a', 'b'])
  authority.stop()
})

test('a dead bot stands up again once respawnDelayMs has passed, and not before', () => {
  const { authority, calls, tick, bot, participants } = setup()
  tick()
  // Put the shooter on the other side from whatever `balance()` gave the bot, so the hit is
  // legal, and run out the warmup and the bot's spawn invincibility — both refuse damage.
  const shooterTeam = participants[1].state[PS.team] === 'a' ? 'b' : 'a'
  participants[0].state[PS.team] = shooterTeam
  tick(MATCH.warmupMs + PLAYER.invincibleMs + 500)
  const before = calls.filter((c) => c.name === RPCS.respawn).length

  const hit: HitEvent = {
    shotId: 'k:1',
    by: 'human',
    target: 'bot',
    point: [3, 1, 4],
    normal: [0, 0, 1],
    part: 'head',
    weapon: 'rifle',
  }
  // Helmet + kevlar take the first 50 damage: three headshots, each with a distinct id.
  expect(authority.submitHit({ ...hit, shotId: 'k:0' })).toBe(true)
  expect(authority.submitHit({ ...hit, shotId: 'k:1' })).toBe(true)
  tick()
  expect(bot.alive).toBe(true)
  expect(authority.submitHit({ ...hit, shotId: 'k:2' })).toBe(true)
  // The registry only learns about it on the next tick — that mirror is what the avatars read.
  tick()
  expect(bot.alive).toBe(false)

  tick(PLAYER.respawnDelayMs - 200)
  expect(bot.alive).toBe(false)
  tick(400)
  expect(bot.alive).toBe(true)
  expect(bot.hp).toBe(PLAYER.maxHp)
  expect(bot.armor).toBe(ARMOR.max)
  expect(calls.filter((c) => c.name === RPCS.respawn).length).toBe(before + 1)
  authority.stop()
})

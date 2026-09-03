// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { NET, PLAYER } from '../config'
import type { PlayerEntity, PlayerSnapshot } from '../types'
import { createInterpolator, netStats, type PoseOut } from './sync'

const FRAME_MS = 1000 / 60

function entity(id: string): PlayerEntity {
  return {
    id,
    name: id,
    team: 'a',
    isBot: false,
    isLocal: false,
    hp: PLAYER.maxHp,
    alive: true,
    invincibleUntil: 0,
    kills: 0,
    deaths: 0,
    position: new Vector3(),
    yaw: 0,
    pitch: 0,
    crouching: false,
    speed: 0,
  }
}

interface Options {
  /** Sender stamps come from a clock this far from ours (a wall-clock difference). */
  senderEpoch?: number
  latencyMs?: number
  jitterMs?: number
  sendEveryMs?: number
  speed?: number
  yawAt?: (seconds: number) => number
}

/**
 * Runs a feed through the interpolator the way the game does: the sender stamps snapshots on
 * its own clock, they arrive one latency later, and `sample()` runs once per rendered frame.
 */
function replay(id: string, seconds: number, options: Options = {}) {
  const {
    senderEpoch = 1_700_000_000_000,
    latencyMs = 45,
    jitterMs = 0,
    sendEveryMs = 1000 / NET.snapshotHz,
    speed = 5,
    yawAt,
  } = options
  const interp = createInterpolator(entity(id), () => local)
  const out: PoseOut = { yaw: 0, pitch: 0, crouching: false, speed: 0 }
  const position = new Vector3()
  const frames: { local: number; delta: number; state: string; yaw: number; speed: number }[] = []
  const queue: { at: number; snap: PlayerSnapshot }[] = []
  let local = 0
  let nextSend = 0
  let random = 12345
  const noise = () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0
    return (random / 4294967296) * jitterMs
  }
  let previous: Vector3 | null = null

  for (let step = 0; local < seconds * 1000; step++) {
    local = step * FRAME_MS
    const senderTime = local // the sender is a peer running the same wall clock
    while (nextSend <= senderTime) {
      const s = nextSend / 1000
      queue.push({
        at: nextSend + latencyMs + noise(),
        snap: {
          x: speed * s,
          y: 0,
          z: 0,
          yaw: yawAt ? yawAt(s) : 0,
          pitch: 0,
          c: 0,
          t: senderEpoch + nextSend,
        },
      })
      nextSend += sendEveryMs
    }
    while (queue.length && queue[0].at <= local) interp.push(queue.shift()!.snap)

    if (interp.sample(position, out)) {
      const delta = previous ? position.distanceTo(previous) : 0
      frames.push({ local, delta, state: netStats.get(id)!.state, yaw: out.yaw, speed: out.speed })
      previous = previous ? previous.copy(position) : position.clone()
    }
  }
  return { frames, interp, position, out, stats: netStats.get(id)!, stopAt: local }
}

function summary(deltas: number[]) {
  const sorted = [...deltas].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length
  const sd = Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length)
  return { median, mean, sd, max: sorted[sorted.length - 1] }
}

test('a steady feed replays as even motion, whatever the sender clock says', () => {
  // Sender stamps are 40 s off our clock — the old sampler snapped to the newest sample for
  // a difference of a few tens of ms; arrival-time buffering does not care at all.
  const run = replay('steady', 4, { senderEpoch: Date.now() + 40_000 })
  const settled = run.frames.filter((f) => f.local > 1500)
  expect(settled.length).toBeGreaterThan(100)
  expect(settled.every((f) => f.state === 'interp')).toBe(true)

  const { median, sd, max } = summary(settled.map((f) => f.delta))
  // 5 m/s at 60 fps is 8.3 cm a frame, and every frame should be that same step.
  expect(median).toBeGreaterThan(0.07)
  expect(median).toBeLessThan(0.095)
  expect(sd / median).toBeLessThan(0.15)
  expect(max).toBeLessThan(median * 2)
})

test('jitter on arrival does not reach the avatar', () => {
  const run = replay('jitter', 4, { jitterMs: 25 })
  const settled = run.frames.filter((f) => f.local > 1500)
  const { median, sd, max } = summary(settled.map((f) => f.delta))
  expect(sd / median).toBeLessThan(0.25)
  expect(max).toBeLessThan(median * 2.5)
  expect(settled.filter((f) => f.state === 'interp').length / settled.length).toBeGreaterThan(0.9)
})

test('the playout delay adapts to a slow sender (>= 1.5 intervals)', () => {
  const run = replay('slow', 5, { sendEveryMs: 100 })
  expect(run.stats.interval).toBeGreaterThan(90)
  expect(run.stats.delay).toBeGreaterThanOrEqual(140)
  expect(run.stats.delay).toBeLessThanOrEqual(320)
  const settled = run.frames.filter((f) => f.local > 2500)
  expect(settled.filter((f) => f.state === 'interp').length / settled.length).toBeGreaterThan(0.9)
})

test('a dead feed coasts at most 100 ms and then holds', () => {
  const id = 'stall'
  const interp = createInterpolator(entity(id), () => local)
  const out: PoseOut = { yaw: 0, pitch: 0, crouching: false, speed: 0 }
  const position = new Vector3()
  let local = 0
  const speed = 5
  // 1.5 s of feed, then silence.
  for (let step = 0; step * FRAME_MS < 3000; step++) {
    local = step * FRAME_MS
    if (local <= 1500) {
      const t = Math.floor(local / 50) * 50
      interp.push({ x: (speed * t) / 1000, y: 0, z: 0, yaw: 0, pitch: 0, c: 0, t: 1_000_000 + t })
    }
    interp.sample(position, out)
  }
  const lastSent = (speed * 1500) / 1000
  // Never further than the last known position plus 100 ms of coasting (eased, so ~half).
  expect(position.x).toBeGreaterThan(lastSent - 0.6)
  expect(position.x).toBeLessThan(lastSent + speed * 0.1)
  expect(netStats.get(id)!.state).toBe('hold')
  // And it is standing still by then, so the legs stop.
  expect(out.speed).toBe(0)
})

test('yaw takes the short way around and never notches', () => {
  // Sweeps from +2.9 rad through PI to -2.9 rad: the wrap must cost 0.34 rad, not 5.8.
  const run = replay('yaw', 3, { speed: 0, yawAt: (s) => wrap(2.9 + s * 0.6) })
  const settled = run.frames.filter((f) => f.local > 1200)
  let maxStep = 0
  for (let i = 1; i < settled.length; i++) {
    maxStep = Math.max(maxStep, Math.abs(shortest(settled[i - 1].yaw, settled[i].yaw)))
  }
  expect(maxStep).toBeLessThan(0.1)
  expect(Math.abs(shortest(run.out.yaw, wrap(2.9 + run.stopAt / 1000 * 0.6)))).toBeLessThan(0.25)
})

test('a teleport snaps instead of sliding across the map', () => {
  const id = 'port'
  const interp = createInterpolator(entity(id), () => local)
  const out: PoseOut = { yaw: 0, pitch: 0, crouching: false, speed: 0 }
  const position = new Vector3()
  let local = 0
  for (let step = 0; step * FRAME_MS < 1500; step++) {
    local = step * FRAME_MS
    const t = Math.floor(local / 50) * 50
    interp.push({ x: t / 1000, y: 0, z: 0, yaw: 0, pitch: 0, c: 0, t: 2_000_000 + t })
    interp.sample(position, out)
  }
  // The respawn path: reset, then one snapshot 30 m away.
  interp.reset()
  interp.push({ x: 30, y: 0, z: 30, yaw: 1, pitch: 0, c: 0, t: 2_000_000 + 1500 })
  local += FRAME_MS
  interp.sample(position, out)
  expect(position.x).toBeCloseTo(30, 3)
  expect(position.z).toBeCloseTo(30, 3)
})

function wrap(a: number): number {
  let v = a
  while (v > Math.PI) v -= Math.PI * 2
  while (v < -Math.PI) v += Math.PI * 2
  return v
}

function shortest(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

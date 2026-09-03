/**
 * Snapshot transport: sending our own state at a fixed rate, and replaying everyone else's
 * with a small delay so remote motion looks smooth on a 20 Hz feed.
 */
import type { Vector3 } from 'three'
import { NET } from '../config'
import type { PlayerEntity, PlayerSnapshot } from '../types'
import { GS, PS, CLOCK_SYNC_MS } from './protocol'
import type { Room } from './room'

const TWO_PI = Math.PI * 2

/** Shortest-arc difference b - a, in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TWO_PI
  if (d > Math.PI) d -= TWO_PI
  if (d < -Math.PI) d += TWO_PI
  return d
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SnapshotSender {
  /** Send now if the state changed (called by the timer, exposed for tests). */
  tick(): void
  stop(): void
}

const ROUND = 1000

/**
 * Longest silence an idle player may leave on the wire. Skipping identical poses is free
 * bandwidth, but a receiver that hears nothing for a second has no way to tell a standing
 * player from a stalled feed, and its jitter buffer drifts blind — so repeat the last pose
 * this often. Four extra messages a second per idle player buys a live playout clock.
 */
const IDLE_RESEND_MS = 250

function quantize(s: PlayerSnapshot): PlayerSnapshot {
  return {
    x: Math.round(s.x * ROUND) / ROUND,
    y: Math.round(s.y * ROUND) / ROUND,
    z: Math.round(s.z * ROUND) / ROUND,
    yaw: Math.round(s.yaw * ROUND) / ROUND,
    pitch: Math.round(s.pitch * ROUND) / ROUND,
    c: s.c ? 1 : 0,
    t: s.t,
  }
}

function samePose(a: PlayerSnapshot | null, b: PlayerSnapshot): boolean {
  return (
    !!a && a.x === b.x && a.y === b.y && a.z === b.z && a.yaw === b.yaw && a.pitch === b.pitch && a.c === b.c
  )
}

/**
 * Writes the local player's pose into the unreliable `p` state at `NET.snapshotHz`.
 * Repeats an unchanged pose only every `IDLE_RESEND_MS` (idle players cost almost nothing).
 */
export function createSnapshotSender(
  room: Room,
  getLocal: () => PlayerSnapshot | null,
  player = room.me,
): SnapshotSender {
  let last: PlayerSnapshot | null = null
  let lastSentAt = 0
  const tick = () => {
    const raw = getLocal()
    if (!raw) return
    const snap = quantize(raw)
    const now = Date.now()
    if (samePose(last, snap) && now - lastSentAt < IDLE_RESEND_MS) return
    last = snap
    lastSentAt = now
    player.setState(PS.snap, snap, false)
  }
  const timer = window.setInterval(tick, Math.round(1000 / NET.snapshotHz))
  return {
    tick,
    stop: () => window.clearInterval(timer),
  }
}

// ---------------------------------------------------------------------------
// Receiving — a jitter buffer on ARRIVAL time
// ---------------------------------------------------------------------------

/**
 * Why arrival time and not `snapshot.t`.
 *
 * The playout point used to be `hostClock.now() - interpDelayMs` compared against the sender's
 * `t`. Both sides only *estimate* the host clock (`createClock` below), from a value published
 * every 5 s, and each estimate is off by roughly one network latency — in opposite directions.
 * Measured on two browsers: a client's snapshots reached the host stamped ~60 ms in its past,
 * which ate the whole 110 ms of buffer, so the sampler sat past the newest sample and replayed
 * the feed as freeze-then-jump: 76 % of frames "hold", median per-frame motion 0 m, single
 * frames stepping 3 m. Bots looked fine on the same screen only because the host writes their
 * `t` from the clock everyone else is estimating.
 *
 * So the buffer is anchored on the local clock instead: every accepted snapshot is stamped with
 * `performance.now()` on arrival, and `skew` tracks (arrival - t) with a fast-down / slow-up
 * filter — the fastest packet is the best measurement of the mapping, the same trick as
 * minimum-RTT in NTP. `t` is then only used to order samples and to measure the sender's
 * interval, which is what keeps playback evenly spaced; nothing depends on the two machines
 * agreeing on a wall clock, or on `t` being a wall clock at all.
 */

/** Never guess further than this past the last snapshot; better to freeze than to teleport. */
const MAX_EXTRAPOLATION_MS = 100
const BUFFER_SIZE = 24
/** Playout delay bounds around `NET.interpDelayMs` (its floor). */
const MAX_DELAY_MS = 320
/** Per accepted snapshot, how fast the delay moves toward its target (~1 s to converge). */
const DELAY_FOLLOW = 0.06
/** Clock mapping: snap toward a faster observation, drift toward a slower one. */
const SKEW_FAST = 0.25
const SKEW_SLOW = 0.02
/** A jump this big is a different clock (rejoin, host migration), not jitter: re-anchor. */
const SKEW_RESET_MS = 400
const JITTER_FOLLOW = 0.12
/**
 * Shortest sample spacing a velocity may be measured over. Two snapshots a few ms apart (an
 * idle repeat racing the send timer) would otherwise divide a rounding error by ~0 and fling
 * the avatar across the room.
 */
const MIN_VELOCITY_SPAN_MS = 20
/**
 * Longest pose gap worth interpolating across. A longer one is a stall or a lost burst; the
 * avatar holds and then covers the distance over the last slice instead of creeping for a
 * second at a fraction of walking speed.
 */
const MAX_SPAN_MS = 400
/** A playout discontinuity is absorbed over this long instead of being shown as a jump. */
const ERROR_TAU_S = 0.12
/** Past this, a jump is a real teleport (respawn, map change): snap, never smooth. */
const SNAP_DISTANCE = 1.5
/** Fastest a player can plausibly move, m/s — used to tell motion from a discontinuity. */
const MAX_SPEED = 8
/** Follow rates for the cosmetic channels (rad/s-ish and 1/s). */
const YAW_FOLLOW = 25
const SPEED_FOLLOW = 7

export interface PoseOut {
  yaw: number
  pitch: number
  crouching: boolean
  speed: number
}

/** What the sampler did on the last frame — the smoothness diagnostic. */
export type InterpState = 'empty' | 'interp' | 'extrap' | 'hold' | 'snap'

export interface InterpStats {
  id: string
  state: InterpState
  /** How many `sample()` calls ended in each state. */
  counts: Record<InterpState, number>
  /** Snapshots accepted. */
  pushes: number
  buffered: number
  /** Measured sender interval, ms. */
  interval: number
  /** Current playout delay, ms. */
  delay: number
  /** Arrival minus sender stamp, ms (absorbs latency and any clock difference). */
  skew: number
  /** Mean |arrival jitter| around `skew`, ms. */
  jitter: number
  /** Playout point minus the newest sample, ms: negative = interpolating with margin. */
  lead: number
}

/**
 * Live stats per entity id, for the headless smoothness harness: importing this module from
 * the page (the same URL the app loaded) hands back this very map, so a test can read the
 * interpolator's state histogram without a global or a hook through `game.ts`. Plain numbers
 * only — nothing here keeps an entity alive.
 */
export const netStats = new Map<string, InterpStats>()

function makeStats(id: string): InterpStats {
  const stats: InterpStats = {
    id,
    state: 'empty',
    counts: { empty: 0, interp: 0, extrap: 0, hold: 0, snap: 0 },
    pushes: 0,
    buffered: 0,
    interval: 0,
    delay: 0,
    skew: 0,
    jitter: 0,
    lead: 0,
  }
  netStats.set(id, stats)
  return stats
}

export interface Interpolator {
  push(snapshot: PlayerSnapshot): void
  /**
   * Writes the interpolated pose into `outPos`/`out`. False when nothing has arrived yet.
   * Call it once per rendered frame: the playout clock is local (`performance.now()`) and
   * continuous, so no caller has to hand it a time.
   */
  sample(outPos: Vector3, out: PoseOut): boolean
  /** Date.now() when the newest snapshot was received locally (0 = never). */
  readonly receivedAt: number
  /** Sender timestamp of the newest snapshot. */
  readonly newestT: number
  reset(): void
}

/** A snapshot plus the local time it arrived. Pooled: nothing is allocated after warm-up. */
interface Sample {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  c: number
  /** Sender stamp — ordering and spacing only. */
  t: number
  /**
   * Set when this sample is farther from the one before it than a player can move in the
   * time between them: a respawn, a map change, a fall-out. Shown as a jump, never blended
   * with its predecessor and never used as a velocity.
   */
  teleport: boolean
}

export function createInterpolator(
  entity: PlayerEntity,
  nowLocal: () => number = () => performance.now(),
): Interpolator {
  const buf: Sample[] = []
  const stats = makeStats(entity.id)
  let receivedAt = 0

  let skew = 0
  let hasSkew = false
  let jitter = 0
  let interval = 1000 / NET.snapshotHz
  let delay = NET.interpDelayMs

  // Output filter state: the raw playout position, the error being absorbed, and the pose
  // channels that are smoothed rather than sampled.
  let hasRaw = false
  let rawX = 0
  let rawY = 0
  let rawZ = 0
  let lastRawX = 0
  let lastRawY = 0
  let lastRawZ = 0
  let errX = 0
  let errY = 0
  let errZ = 0
  let outX = 0
  let outY = 0
  let outZ = 0
  let yawOut = 0
  let pitchOut = 0
  let speedOut = 0
  let lastSampleAt = 0

  const acquire = (): Sample => {
    if (buf.length >= BUFFER_SIZE) return buf.shift()!
    return { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, c: 0, t: 0, teleport: false }
  }

  const state: Interpolator = {
    push(snapshot: PlayerSnapshot) {
      if (!snapshot || typeof snapshot.t !== 'number') return
      const newest = buf[buf.length - 1]
      if (newest && snapshot.t <= newest.t) return // duplicate or out of order
      const arrival = nowLocal()

      // Map the sender's timeline onto ours. `obs` carries latency + any clock difference;
      // the smallest recent value is the closest thing to the truth.
      const obs = arrival - snapshot.t
      if (!hasSkew || Math.abs(obs - skew) > SKEW_RESET_MS) {
        hasSkew = true
        skew = obs
        jitter = 0
      } else {
        jitter += (Math.abs(obs - skew) - jitter) * JITTER_FOLLOW
        skew += (obs - skew) * (obs < skew ? SKEW_FAST : SKEW_SLOW)
      }

      if (newest) {
        const gap = snapshot.t - newest.t
        // Idle repeats and lost bursts must not drag the interval estimate around.
        if (gap >= 5 && gap <= 200) interval += (gap - interval) * 0.15
      }
      const target = Math.min(MAX_DELAY_MS, Math.max(NET.interpDelayMs, interval * 1.5 + jitter * 1.5))
      delay += (target - delay) * DELAY_FOLLOW

      const sample = acquire()
      // A jump no player could have made in `gap` ms is a teleport (respawn, map change): it
      // must be shown as one. Interpolating across it slides the avatar across the map, and
      // extrapolating from it flings the avatar past its spawn and yanks it back.
      sample.teleport = !!newest && (() => {
        const dx = snapshot.x - newest.x
        const dy = snapshot.y - newest.y
        const dz = snapshot.z - newest.z
        const seconds = Math.max(snapshot.t - newest.t, MIN_VELOCITY_SPAN_MS) / 1000
        return Math.sqrt(dx * dx + dy * dy + dz * dz) > MAX_SPEED * seconds + 0.1
      })()
      sample.x = snapshot.x
      sample.y = snapshot.y
      sample.z = snapshot.z
      sample.yaw = snapshot.yaw
      sample.pitch = snapshot.pitch
      sample.c = snapshot.c
      sample.t = snapshot.t
      buf.push(sample)
      receivedAt = Date.now()
      stats.pushes++
      stats.buffered = buf.length
      stats.interval = Math.round(interval)
      stats.delay = Math.round(delay)
      stats.skew = Math.round(skew)
      stats.jitter = Math.round(jitter)
    },

    sample(outPos: Vector3, out: PoseOut): boolean {
      const now = nowLocal()
      const dt = lastSampleAt ? Math.min(0.1, Math.max(1e-4, (now - lastSampleAt) / 1000)) : 1 / 60
      lastSampleAt = now
      if (buf.length === 0) {
        mark('empty')
        return false
      }

      const newest = buf[buf.length - 1]
      const oldest = buf[0]
      // Playout point, in the sender's own units.
      const target = now - skew - delay
      stats.lead = Math.round(target - newest.t)
      let yawRaw: number
      let pitchRaw: number
      let crouchingRaw: boolean

      if (buf.length === 1 || target <= oldest.t) {
        // Behind everything we hold (a fresh feed, or the delay just grew).
        rawX = oldest.x
        rawY = oldest.y
        rawZ = oldest.z
        yawRaw = oldest.yaw
        pitchRaw = oldest.pitch
        crouchingRaw = oldest.c === 1
        mark('snap')
      } else if (target >= newest.t) {
        // Ahead of the feed: carry on with the last known velocity, easing off so the avatar
        // coasts to a stop instead of overshooting and being yanked back when data resumes.
        const prev = buf[buf.length - 2]
        const span = newest.t - prev.t
        const ahead = Math.min(target - newest.t, MAX_EXTRAPOLATION_MS)
        const e = ahead / MAX_EXTRAPOLATION_MS
        const eased = MAX_EXTRAPOLATION_MS * (e - 0.5 * e * e)
        // A stale or too-tight pair says nothing about the current velocity: hold instead.
        const k =
          !newest.teleport && span >= MIN_VELOCITY_SPAN_MS && span <= MAX_SPAN_MS ? eased / span : 0
        rawX = newest.x + (newest.x - prev.x) * k
        rawY = newest.y + (newest.y - prev.y) * k
        rawZ = newest.z + (newest.z - prev.z) * k
        yawRaw = newest.yaw + clamp(angleDelta(prev.yaw, newest.yaw) * k, -0.35, 0.35)
        pitchRaw = newest.pitch
        crouchingRaw = newest.c === 1
        mark(target - newest.t > MAX_EXTRAPOLATION_MS ? 'hold' : 'extrap')
      } else {
        // The normal path: the pair bracketing `target` (buffers are tiny).
        let i = buf.length - 1
        while (i > 0 && buf[i - 1].t > target) i--
        const a = buf[i - 1]
        const b = buf[i]
        const span = b.t - a.t
        // Across a stall, hold at `a` and cover the distance over the last slice rather than
        // crawling the whole way at a fraction of walking speed.
        const from = span > MAX_SPAN_MS ? b.t - MAX_SPAN_MS : a.t
        const width = b.t - from
        const t = b.teleport ? 1 : width > 0 ? clamp((target - from) / width, 0, 1) : 1
        rawX = a.x + (b.x - a.x) * t
        rawY = a.y + (b.y - a.y) * t
        rawZ = a.z + (b.z - a.z) * t
        yawRaw = lerpAngle(a.yaw, b.yaw, t)
        pitchRaw = a.pitch + (b.pitch - a.pitch) * t
        crouchingRaw = (t < 0.5 ? a.c : b.c) === 1
        mark('interp')
      }

      // Absorb playout discontinuities (a delay change, data resuming after a hold) over
      // ERROR_TAU_S instead of showing them as a jump. A real teleport is left alone.
      const decay = Math.exp(-dt / ERROR_TAU_S)
      errX *= decay
      errY *= decay
      errZ *= decay
      if (hasRaw) {
        const jx = rawX - lastRawX
        const jy = rawY - lastRawY
        const jz = rawZ - lastRawZ
        const jump = Math.sqrt(jx * jx + jy * jy + jz * jz)
        if (jump > MAX_SPEED * dt + 0.05) {
          if (jump >= SNAP_DISTANCE) {
            errX = errY = errZ = 0
          } else {
            errX = outX - rawX
            errY = outY - rawY
            errZ = outZ - rawZ
          }
        }
      }
      lastRawX = rawX
      lastRawY = rawY
      lastRawZ = rawZ
      hasRaw = true

      const prevX = outX
      const prevZ = outZ
      outX = rawX + errX
      outY = rawY + errY
      outZ = rawZ + errZ
      outPos.set(outX, outY, outZ)

      // Pose channels are cosmetic, so they are followed rather than sampled: a 20 Hz feed
      // steps yaw in visible notches otherwise.
      const follow = Math.min(1, dt * YAW_FOLLOW)
      yawOut = lerpAngle(yawOut, yawRaw, follow)
      pitchOut += (pitchRaw - pitchOut) * follow
      // Legs are driven by what the body actually does on screen — including standing still
      // during a hold, which the sender-derived speed used to paper over.
      const moved = Math.sqrt((outX - prevX) ** 2 + (outZ - prevZ) ** 2) / dt
      speedOut += (Math.min(moved, MAX_SPEED) - speedOut) * Math.min(1, dt * SPEED_FOLLOW)
      out.yaw = yawOut
      out.pitch = pitchOut
      out.crouching = crouchingRaw
      out.speed = speedOut < 0.05 ? 0 : speedOut
      return true
    },

    get receivedAt() {
      return receivedAt
    },
    get newestT() {
      return buf.length ? buf[buf.length - 1].t : 0
    },

    reset() {
      buf.length = 0
      receivedAt = 0
      hasSkew = false
      hasRaw = false
      errX = errY = errZ = 0
      speedOut = 0
      lastSampleAt = 0
      stats.buffered = 0
    },
  }

  function mark(next: InterpState): void {
    stats.state = next
    stats.counts[next]++
    stats.buffered = buf.length
  }

  // The first sample of a fresh remote should not swing in from wherever the avatar happened
  // to be standing, so the smoothed channels start from the entity itself.
  yawOut = entity.yaw
  pitchOut = entity.pitch
  return state
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface NetClock {
  /** Host wall-clock time in ms. */
  now(): number
  /** now() - Date.now(), 0 on the host. */
  readonly offset: number
  stop(): void
}

const OFFSET_SAMPLES = 5
/**
 * How often clients look for a new `hostNow`. Playroom has no per-key change callback in
 * vanilla JS, so the polling period is a direct bias on every observation — at 1 Hz the
 * estimate was ~300 ms late, which is more than the whole interpolation delay.
 */
const CLOCK_POLL_MS = 100

/**
 * Host publishes `hostNow` every 5 s; clients turn each new value into an offset observation
 * `hostNow - Date.now()`, which is always too negative by (network latency + detection delay).
 * The largest of the last few observations is therefore the one that travelled fastest and the
 * best estimate — the same trick as taking the minimum RTT in NTP.
 *
 * Remote *movement* no longer depends on this (see the jitter buffer above); match timers and
 * invincibility windows do, and they tolerate the tens of ms this is out by.
 */
export function createClock(room: Room): NetClock {
  let offset = 0
  const samples: number[] = []
  let lastSeen = 0
  let lastPublished = 0

  const tick = () => {
    if (room.isHost()) {
      const t = Date.now()
      if (t - lastPublished >= CLOCK_SYNC_MS) {
        lastPublished = t
        room.setGlobal(GS.hostNow, t, true)
      }
      if (offset !== 0) {
        offset = 0
        samples.length = 0
      }
      return
    }
    const value = room.getGlobal<number>(GS.hostNow) ?? 0
    if (!value || value === lastSeen) return
    lastSeen = value
    samples.push(value - Date.now())
    if (samples.length > OFFSET_SAMPLES) samples.shift()
    offset = Math.max(...samples)
  }

  tick()
  const timer = window.setInterval(tick, CLOCK_POLL_MS)

  return {
    now: () => Date.now() + offset,
    get offset() {
      return offset
    },
    stop: () => window.clearInterval(timer),
  }
}

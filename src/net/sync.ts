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
/** Never guess further than this past the last snapshot; better to freeze than to teleport. */
const MAX_EXTRAPOLATION_MS = 100
const BUFFER_SIZE = 24

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
 * Skips sends while the pose is identical (idle players cost nothing).
 */
export function createSnapshotSender(
  room: Room,
  getLocal: () => PlayerSnapshot | null,
  player = room.me,
): SnapshotSender {
  let last: PlayerSnapshot | null = null
  const tick = () => {
    const raw = getLocal()
    if (!raw) return
    const snap = quantize(raw)
    if (samePose(last, snap)) return
    last = snap
    player.setState(PS.snap, snap, false)
  }
  const timer = window.setInterval(tick, Math.round(1000 / NET.snapshotHz))
  return {
    tick,
    stop: () => window.clearInterval(timer),
  }
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

export interface PoseOut {
  yaw: number
  pitch: number
  crouching: boolean
  speed: number
}

export interface Interpolator {
  push(snapshot: PlayerSnapshot): void
  /** Writes the interpolated pose into `outPos`/`out`. False when nothing has arrived yet. */
  sample(now: number, outPos: Vector3, out: PoseOut): boolean
  /** Date.now() when the newest snapshot was received locally (0 = never). */
  readonly receivedAt: number
  /** Sender timestamp of the newest snapshot. */
  readonly newestT: number
  reset(): void
}

export function createInterpolator(entity: PlayerEntity): Interpolator {
  const buf: PlayerSnapshot[] = []
  let receivedAt = 0

  const state = {
    push(snapshot: PlayerSnapshot) {
      if (!snapshot || typeof snapshot.t !== 'number') return
      const newest = buf[buf.length - 1]
      if (newest && snapshot.t <= newest.t) return // duplicate or out of order
      buf.push(snapshot)
      if (buf.length > BUFFER_SIZE) buf.shift()
      receivedAt = Date.now()
    },
    sample(now: number, outPos: Vector3, out: PoseOut): boolean {
      if (buf.length === 0) return false
      const target = now - NET.interpDelayMs
      const newest = buf[buf.length - 1]
      const oldest = buf[0]

      if (buf.length === 1 || target <= oldest.t) {
        outPos.set(oldest.x, oldest.y, oldest.z)
        out.yaw = oldest.yaw
        out.pitch = oldest.pitch
        out.crouching = oldest.c === 1
        out.speed = 0
        return true
      }

      if (target >= newest.t) {
        const prev = buf[buf.length - 2]
        const dt = newest.t - prev.t
        const ahead = Math.min(target - newest.t, MAX_EXTRAPOLATION_MS)
        const k = dt > 0 ? ahead / dt : 0
        outPos.set(
          newest.x + (newest.x - prev.x) * k,
          newest.y + (newest.y - prev.y) * k,
          newest.z + (newest.z - prev.z) * k,
        )
        out.yaw = lerpAngle(prev.yaw, newest.yaw, 1 + k)
        out.pitch = newest.pitch
        out.crouching = newest.c === 1
        out.speed = speedBetween(prev, newest)
        return true
      }

      // Walk back to the pair bracketing `target` (buffers are tiny).
      let i = buf.length - 1
      while (i > 0 && buf[i - 1].t > target) i--
      const a = buf[i - 1]
      const b = buf[i]
      const span = b.t - a.t
      const t = span > 0 ? (target - a.t) / span : 1
      outPos.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t)
      out.yaw = lerpAngle(a.yaw, b.yaw, t)
      out.pitch = a.pitch + (b.pitch - a.pitch) * t
      out.crouching = (t < 0.5 ? a.c : b.c) === 1
      out.speed = speedBetween(a, b)
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
    },
  }
  // `entity` is kept in the closure so callers can pair 1:1 with a registry entry and so we
  // can seed the first sample from wherever the entity already is.
  void entity
  return state
}

function speedBetween(a: PlayerSnapshot, b: PlayerSnapshot): number {
  const dt = (b.t - a.t) / 1000
  if (dt <= 0) return 0
  const dx = b.x - a.x
  const dz = b.z - a.z
  return Math.sqrt(dx * dx + dz * dz) / dt
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

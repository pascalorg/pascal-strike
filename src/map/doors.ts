/**
 * Auto-opening doors (W1-A).
 *
 * Every client runs this locally over the actor positions it knows (local player, remotes, bots)
 * — no network traffic. The baked clip's rest pose is "closed", so playing it forward opens and
 * playing it backward closes; a door that reverses mid-swing just flips `timeScale`.
 */
import { AnimationMixer, LoopOnce, Vector3, type AnimationAction } from 'three'
import { DOORS } from '../config'
import type { DoorInfo, MapData } from '../types'

export interface DoorSystem {
  /** `actors` are feet positions of every player/bot this client knows about. */
  update(dt: number, actors: ArrayLike<Vector3>): void
  /** Logical state: true while the door wants to be open. */
  isOpen(id: string): boolean
  /** Animation progress, 0 = fully closed, 1 = fully open. */
  openness(id: string): number
  /** Fires when the logical state flips — hook for the door "whoosh" SFX. */
  onToggle(cb: (door: DoorInfo, open: boolean) => void): () => void
  mixer: AnimationMixer
  dispose(): void
}

interface DoorRuntime {
  info: DoorInfo
  action: AnimationAction
  duration: number
  open: boolean
  /** Timestamp (ms, performance clock) since when no actor has been near. */
  clearSince: number
  /** Y of the floor the door stands on (its centre sits ~1 m above it). */
  floorY: number
}

const OPEN_RADIUS_SQ = DOORS.openRadius * DOORS.openRadius
const CLOSE_RADIUS_SQ = DOORS.closeRadius * DOORS.closeRadius
const MAX_VERTICAL = 2

export function createDoorSystem(map: MapData): DoorSystem {
  const mixer = new AnimationMixer(map.root)
  const runtimes: DoorRuntime[] = []
  const byId = new Map<string, DoorRuntime>()
  const listeners = new Set<(door: DoorInfo, open: boolean) => void>()

  for (const door of map.doors) {
    const action = mixer.clipAction(door.clip)
    action.setLoop(LoopOnce, 1)
    action.clampWhenFinished = true
    action.enabled = true
    action.weight = 1
    action.timeScale = DOORS.openTimeScale
    action.play()
    // Hold the rest pose (closed) until an actor walks up.
    action.time = 0
    action.paused = true

    const runtime: DoorRuntime = {
      info: door,
      action,
      duration: Math.max(door.clip.duration, 1e-3),
      open: false,
      clearSince: 0,
      floorY: door.center.y - 1,
    }
    runtimes.push(runtime)
    byId.set(door.id, runtime)
  }

  function setState(runtime: DoorRuntime, open: boolean) {
    if (runtime.open === open) return
    runtime.open = open
    // The close timer only starts once the last actor has actually walked away.
    runtime.clearSince = 0
    runtime.action.timeScale = open ? DOORS.openTimeScale : -DOORS.openTimeScale
    // Un-pausing keeps `action.time` where it is, so a half-open door reverses from where it is.
    runtime.action.paused = false
    runtime.action.enabled = true
    for (const cb of listeners) cb(runtime.info, open)
  }

  function update(dt: number, actors: ArrayLike<Vector3>) {
    const now = performance.now()

    for (let i = 0; i < runtimes.length; i++) {
      const runtime = runtimes[i]
      const center = runtime.info.center

      let nearestSq = Infinity
      for (let a = 0; a < actors.length; a++) {
        const actor = actors[a]
        if (!actor) continue
        if (Math.abs(actor.y - runtime.floorY) >= MAX_VERTICAL) continue
        const dx = actor.x - center.x
        const dz = actor.z - center.z
        const d2 = dx * dx + dz * dz
        if (d2 < nearestSq) nearestSq = d2
      }

      if (runtime.open) {
        if (nearestSq > CLOSE_RADIUS_SQ) {
          if (runtime.clearSince === 0) runtime.clearSince = now
          if (now - runtime.clearSince >= DOORS.closeDelayMs) setState(runtime, false)
        } else {
          runtime.clearSince = 0
        }
      } else if (nearestSq <= OPEN_RADIUS_SQ) {
        setState(runtime, true)
      }
    }

    mixer.update(dt)
  }

  return {
    update,
    isOpen(id) {
      return byId.get(id)?.open ?? false
    },
    openness(id) {
      const runtime = byId.get(id)
      if (!runtime) return 0
      return clamp01(runtime.action.time / runtime.duration)
    },
    onToggle(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    mixer,
    dispose() {
      listeners.clear()
      mixer.stopAllAction()
      mixer.uncacheRoot(map.root)
    },
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

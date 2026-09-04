import type { Scene, Vector3 } from 'three'
import { PLAYER } from '../config'
import type { Audio, AudioListenerPose } from '../engine/audio'

/** One stride cycle in metres; this is the distance cadence the local player already used. */
export const FOOTSTEP_DISTANCE = 2.2
export const LOCAL_RUN_THRESHOLD = PLAYER.walkSpeed + 0.2
export const REMOTE_RUN_THRESHOLD = PLAYER.walkSpeed + 0.3
export const REMOTE_FOOTSTEP_CULL_DISTANCE = 22
export const REMOTE_FOOTSTEP_CULL_DISTANCE_SQ = REMOTE_FOOTSTEP_CULL_DISTANCE ** 2
/** Interpolated feet moving less than this vertically are treated as planted on the floor. */
export const REMOTE_GROUNDED_VERTICAL_SPEED = 0.5

export interface FootstepCadence {
  /** True once when the accumulated running distance crosses a stride boundary. */
  update(dt: number, speed: number, grounded: boolean, silent: boolean): boolean
  reset(): void
}

/**
 * Distance-driven cadence shared by local and remote actors. Ineligible motion pauses the
 * stride instead of adding silent walking/crouching distance that would fire on the next run.
 */
export function createFootstepCadence(runThreshold: number): FootstepCadence {
  let distance = 0

  return {
    update(dt, speed, grounded, silent) {
      if (dt <= 0 || speed <= runThreshold || !grounded || silent) return false
      distance += speed * dt
      if (distance <= FOOTSTEP_DISTANCE) return false
      distance = 0
      return true
    },
    reset() {
      distance = 0
    },
  }
}

interface FootstepAudioBinding {
  audio: Pick<Audio, 'play'>
  listener: AudioListenerPose
}

// RemotePlayers is deliberately constructed without game services. The local player already
// owns the correct audio/listener pair, so keep that pair scoped to their shared scene rather
// than introducing another AudioContext or widening the game orchestrator's API.
const audioByScene = new WeakMap<Scene, FootstepAudioBinding>()

export function bindFootstepAudio(
  scene: Scene,
  audio: Pick<Audio, 'play'>,
  listener: AudioListenerPose,
): () => void {
  const binding = { audio, listener }
  audioByScene.set(scene, binding)
  return () => {
    if (audioByScene.get(scene) === binding) audioByScene.delete(scene)
  }
}

export function playRemoteFootstep(scene: Scene, at: Vector3): void {
  const binding = audioByScene.get(scene)
  if (binding) binding.audio.play('footstep', at, binding.listener)
}

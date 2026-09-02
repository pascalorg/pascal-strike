import { Vector3 } from 'three'
import type { MoveInput, Navigation } from '../types'

const CORNER_DISTANCE = 0.35
const ARRIVAL_DISTANCE = 0.35
const REPLAN_SECONDS = 1.5
const PROGRESS_SECONDS = 1
const MIN_PROGRESS = 0.3
const JUMP_SECONDS = 0.2
const EPSILON = 1e-8
const EMPTY_PATH: Vector3[] = []

export interface PathFollowerResult {
  move: MoveInput
  yaw: number
  arrived: boolean
  stuck: boolean
}

export interface PathFollower {
  setGoal(point: Vector3): void
  update(feet: Vector3, dt: number): PathFollowerResult
}

/**
 * Follow Navigation paths while keeping movement in the returned yaw's local frame.
 * The result and its MoveInput are stable objects, so ordinary updates allocate nothing.
 */
export function createPathFollower(nav: Navigation): PathFollower {
  const goal = new Vector3()
  const progressOrigin = new Vector3()
  const result: PathFollowerResult = {
    move: { forward: 0, right: 0, jump: false, crouch: false },
    yaw: 0,
    arrived: true,
    stuck: false,
  }

  let hasGoal = false
  let path: Vector3[] = EMPTY_PATH
  let cornerIndex = 0
  let needsReplan = false
  let replanElapsed = 0
  let progressElapsed = 0
  let trackingProgress = false
  let jumpRemaining = 0

  function plan(feet: Vector3): void {
    path = nav.findPath(feet, goal)
    cornerIndex = 0
    replanElapsed = 0
    needsReplan = false
    trackingProgress = false
    progressElapsed = 0
    advanceCorners(feet)
  }

  function advanceCorners(feet: Vector3): void {
    while (cornerIndex < path.length) {
      const corner = path[cornerIndex]
      const dx = corner.x - feet.x
      const dz = corner.z - feet.z
      if (dx * dx + dz * dz > CORNER_DISTANCE * CORNER_DISTANCE) break
      cornerIndex++
    }
  }

  function stop(arrived: boolean): PathFollowerResult {
    result.move.forward = 0
    result.move.right = 0
    result.move.jump = false
    result.move.crouch = false
    result.arrived = arrived
    result.stuck = false
    return result
  }

  function pauseWhileJumping(): PathFollowerResult {
    result.move.forward = 0
    result.move.right = 0
    result.move.jump = jumpRemaining > 0
    result.move.crouch = false
    result.arrived = false
    if (jumpRemaining > 0) jumpRemaining = Math.max(0, jumpRemaining - currentDt)
    return result
  }

  let currentDt = 0

  return {
    setGoal(point) {
      // Avoid throwing away a useful path when a caller repeats an unchanged goal.
      if (hasGoal && goal.distanceToSquared(point) < EPSILON) return
      goal.copy(point)
      hasGoal = true
      needsReplan = true
      result.arrived = false
      trackingProgress = false
      progressElapsed = 0
      jumpRemaining = 0
    },

    update(feet, dt) {
      dt = Math.max(0, dt)
      currentDt = dt
      if (!hasGoal) return stop(true)

      const goalDx = goal.x - feet.x
      const goalDz = goal.z - feet.z
      if (goalDx * goalDx + goalDz * goalDz <= ARRIVAL_DISTANCE * ARRIVAL_DISTANCE) {
        hasGoal = false
        path = EMPTY_PATH
        jumpRemaining = 0
        return stop(true)
      }

      replanElapsed += dt
      result.stuck = false
      if (needsReplan || path.length === 0 || replanElapsed >= REPLAN_SECONDS) plan(feet)
      if (path.length === 0) return pauseWhileJumping()

      advanceCorners(feet)

      if (cornerIndex >= path.length) {
        // A path can terminate slightly away from its requested goal. Replan instead of
        // reporting arrival unless the actual goal tolerance was met above.
        needsReplan = true
        return stop(false)
      }

      const corner = path[cornerIndex]
      const dx = corner.x - feet.x
      const dz = corner.z - feet.z
      const wantsMove = dx * dx + dz * dz > EPSILON
      if (wantsMove) {
        if (!trackingProgress) {
          progressOrigin.copy(feet)
          progressElapsed = 0
          trackingProgress = true
        } else {
          progressElapsed += dt
          if (progressElapsed >= PROGRESS_SECONDS) {
            const movedX = feet.x - progressOrigin.x
            const movedZ = feet.z - progressOrigin.z
            if (movedX * movedX + movedZ * movedZ < MIN_PROGRESS * MIN_PROGRESS) {
              result.stuck = true
              jumpRemaining = JUMP_SECONDS
              plan(feet)
            } else {
              progressOrigin.copy(feet)
              progressElapsed = 0
            }
          }
        }
      } else {
        trackingProgress = false
        progressElapsed = 0
      }

      // Planning after a stuck event may have changed the active corner.
      if (cornerIndex >= path.length) return pauseWhileJumping()
      const activeCorner = path[cornerIndex]
      const activeDx = activeCorner.x - feet.x
      const activeDz = activeCorner.z - feet.z
      if (activeDx * activeDx + activeDz * activeDz <= EPSILON) return pauseWhileJumping()

      result.yaw = Math.atan2(-activeDx, -activeDz)
      result.move.forward = 1
      result.move.right = 0
      result.move.jump = jumpRemaining > 0
      result.move.crouch = false
      result.arrived = false
      if (jumpRemaining > 0) jumpRemaining = Math.max(0, jumpRemaining - dt)
      return result
    },
  }
}

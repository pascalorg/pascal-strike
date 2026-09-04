import { Vector3 } from 'three'
import type { MoveInput, Navigation } from '../types'

const CORNER_DISTANCE = 0.35
const ARRIVAL_DISTANCE = 0.35
const REPLAN_SECONDS = 1.5
const PROGRESS_SECONDS = 1
const MIN_PROGRESS = 0.3
const JUMP_SECONDS = 0.2
/**
 * A second stall this soon after the first, and this close to it, is a goal the bot cannot
 * reach: the jump-and-replan below has already had its go and the navmesh handed back the same
 * corner. Anything longer than this and the two stalls are unrelated.
 */
const SECOND_STUCK_SECONDS = 4
const SAME_SPOT_DISTANCE = 0.6
const STAIR_RISE = 0.3
const STAIR_PUSH_SECONDS = 0.4
const VERTICAL_ARRIVAL_DISTANCE = 0.5
const EPSILON = 1e-8
const EMPTY_PATH: Vector3[] = []

export interface PathFollowerResult {
  move: MoveInput
  yaw: number
  arrived: boolean
  stuck: boolean
  /**
   * True on the single update where the follower gives up: it stalled twice in the same spot
   * within `SECOND_STUCK_SECONDS`, so the goal is unreachable from here and the caller should
   * pick another one (and remember not to pick this one again for a while).
   */
  abandoned: boolean
}

export interface PathFollower {
  setGoal(point: Vector3): void
  update(feet: Vector3, dt: number): PathFollowerResult
  /** Live state for the debug accessor; the vectors are the follower's own, do not mutate. */
  readonly debug: {
    readonly goal: Vector3 | null
    readonly corner: Vector3 | null
    readonly stuckCount: number
    readonly abandonedCount: number
  }
}

/**
 * Follow Navigation paths while keeping movement in the returned yaw's local frame.
 * The result and its MoveInput are stable objects, so ordinary updates allocate nothing.
 */
export function createPathFollower(nav: Navigation): PathFollower {
  const goal = new Vector3()
  const progressOrigin = new Vector3()
  const stuckOrigin = new Vector3()
  const result: PathFollowerResult = {
    move: { forward: 0, right: 0, jump: false, crouch: false },
    yaw: 0,
    arrived: true,
    stuck: false,
    abandoned: false,
  }

  let hasGoal = false
  let path: Vector3[] = EMPTY_PATH
  let cornerIndex = 0
  let needsReplan = false
  let replanElapsed = 0
  let progressElapsed = 0
  let trackingProgress = false
  let jumpRemaining = 0
  let stairPushRemaining = 0
  let stuckCount = 0
  let abandonedCount = 0
  let elapsed = 0
  let firstStuckAt = -Infinity

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
      if (dx * dx + dz * dz > CORNER_DISTANCE * CORNER_DISTANCE
        || Math.abs(corner.y - feet.y) > VERTICAL_ARRIVAL_DISTANCE) break
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

  const debug = {
    get goal() { return hasGoal ? goal : null },
    get corner() { return cornerIndex < path.length ? path[cornerIndex] : null },
    get stuckCount() { return stuckCount },
    get abandonedCount() { return abandonedCount },
  }

  return {
    debug,

    setGoal(point) {
      // Avoid throwing away a useful path when a caller repeats an unchanged goal.
      if (hasGoal && goal.distanceToSquared(point) < EPSILON) return
      goal.copy(point)
      hasGoal = true
      needsReplan = true
      result.arrived = false
      result.abandoned = false
      trackingProgress = false
      progressElapsed = 0
      jumpRemaining = 0
      stairPushRemaining = 0
      firstStuckAt = -Infinity
    },

    update(feet, dt) {
      dt = Math.max(0, dt)
      currentDt = dt
      elapsed += dt
      result.abandoned = false
      if (!hasGoal) return stop(true)

      const goalDx = goal.x - feet.x
      const goalDz = goal.z - feet.z
      if (goalDx * goalDx + goalDz * goalDz <= ARRIVAL_DISTANCE * ARRIVAL_DISTANCE
        && Math.abs(goal.y - feet.y) <= VERTICAL_ARRIVAL_DISTANCE) {
        hasGoal = false
        path = EMPTY_PATH
        jumpRemaining = 0
        stairPushRemaining = 0
        return stop(true)
      }

      const pushingUpStair = stairPushRemaining > 0
      if (!pushingUpStair) replanElapsed += dt
      result.stuck = false
      if (!pushingUpStair
        && (needsReplan || path.length === 0 || replanElapsed >= REPLAN_SECONDS)) plan(feet)
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
        if (pushingUpStair) {
          trackingProgress = false
          progressElapsed = 0
        } else if (!trackingProgress) {
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
              stuckCount++
              const stuckDx = feet.x - stuckOrigin.x
              const stuckDz = feet.z - stuckOrigin.z
              const twiceHere = elapsed - firstStuckAt <= SECOND_STUCK_SECONDS
                && stuckDx * stuckDx + stuckDz * stuckDz < SAME_SPOT_DISTANCE * SAME_SPOT_DISTANCE
              firstStuckAt = elapsed
              stuckOrigin.copy(feet)
              if (twiceHere) {
                // Jump-and-replan has already been tried here and the navmesh gave back the
                // same corner, because what is in the way — an open leaf, a chair — is not on
                // the navmesh at all. Hand the problem up: only the brain can choose elsewhere.
                abandonedCount++
                hasGoal = false
                path = EMPTY_PATH
                jumpRemaining = 0
                stairPushRemaining = 0
                trackingProgress = false
                progressElapsed = 0
                firstStuckAt = -Infinity
                result.move.forward = 0
                result.move.right = 0
                result.move.jump = false
                result.move.crouch = false
                result.arrived = false
                result.abandoned = true
                return result
              }
              if (corner.y - feet.y > STAIR_RISE) {
                // Stair lips need a committed jump. Replanning immediately tends to return the
                // same corner and leaves the bot oscillating at the bottom of the flight.
                stairPushRemaining = STAIR_PUSH_SECONDS
                jumpRemaining = STAIR_PUSH_SECONDS
                trackingProgress = false
                progressElapsed = 0
              } else {
                jumpRemaining = JUMP_SECONDS
                plan(feet)
              }
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
      if (stairPushRemaining > 0) {
        stairPushRemaining = Math.max(0, stairPushRemaining - dt)
        if (stairPushRemaining === 0) needsReplan = true
      }
      return result
    },
  }
}

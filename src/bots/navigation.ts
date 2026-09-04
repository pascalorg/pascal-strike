import { Vector3, type Mesh } from 'three'
import type { DoorInfo, MoveInput, Navigation } from '../types'

const CORNER_DISTANCE = 0.35
const ARRIVAL_DISTANCE = 0.35
const REPLAN_SECONDS = 1.5
const PROGRESS_SECONDS = 1
const MIN_PROGRESS = 0.3
const JUMP_SECONDS = 0.2
const STAIR_RISE = 0.3
const STAIR_PUSH_SECONDS = 0.4
const VERTICAL_ARRIVAL_DISTANCE = 0.5
const DOOR_CROSS_MARGIN = 0.4
const DOOR_FLOOR_RANGE = 2.2
const DOOR_APPROACH_DISTANCE = 1.2
const DOOR_LATERAL_SLACK = 0.15
const SINGLE_DOOR_OFFSET = 0.25
const SECOND_STUCK_SECONDS = 4
const SAME_STUCK_DISTANCE = 0.6
const THIRD_STUCK_SECONDS = 8
const RECOVERY_BACK_DISTANCE = 0.8
const RECOVERY_BACK_SECONDS = 0.5
const RECOVERY_SIDE_DISTANCE = 0.5
const RECOVERY_SIDE_SECONDS = 0.5
const RECOVERY_REACHED_DISTANCE = 0.08
const EPSILON = 1e-8
const EMPTY_PATH: Vector3[] = []

export interface PathFollowerResult {
  move: MoveInput
  yaw: number
  arrived: boolean
  stuck: boolean
  /** True for the update on which repeated recovery attempts abandon the current goal. */
  abandoned: boolean
}

export interface PathFollower {
  /** Monotonic count of goals abandoned after the third nearby stuck event. */
  readonly giveUp: number
  setGoal(point: Vector3): void
  update(feet: Vector3, dt: number): PathFollowerResult
}

export interface PathFollowerOptions {
  doors?: readonly DoorInfo[]
  /** Optional authoritative animation progress; otherwise leaf world matrices are inspected. */
  doorOpenness?: (id: string) => number
}

interface DoorFunnel {
  door: DoorInfo
  point: Vector3
  normalX: number
  normalZ: number
  widthX: number
  widthZ: number
  crossingT: number
}

type RecoveryPhase = 'none' | 'backoff' | 'sidestep'

/**
 * Follow Navigation paths while keeping movement in the returned yaw's local frame.
 * The result and its MoveInput are stable objects, so ordinary updates allocate nothing.
 */
export function createPathFollower(
  nav: Navigation,
  opts: PathFollowerOptions = {},
): PathFollower {
  const goal = new Vector3()
  const progressOrigin = new Vector3()
  const stuckOrigin = new Vector3()
  const approachDirection = new Vector3()
  const recoveryTarget = new Vector3()
  const leafCenter = new Vector3()
  const leafAxis = new Vector3()
  const leafSize = new Vector3()
  const result: PathFollowerResult = {
    move: { forward: 0, right: 0, jump: false, crouch: false },
    yaw: 0,
    arrived: true,
    stuck: false,
    abandoned: false,
  }

  let hasGoal = false
  let path: Vector3[] = EMPTY_PATH
  let funnels: Array<DoorFunnel | null> = []
  let cornerIndex = 0
  let needsReplan = false
  let replanElapsed = 0
  let progressElapsed = 0
  let trackingProgress = false
  let jumpRemaining = 0
  let stairPushRemaining = 0
  let elapsed = 0
  let stuckStage = 0
  let firstStuckAt = -Infinity
  let giveUp = 0
  let recoveryPhase: RecoveryPhase = 'none'
  let recoveryElapsed = 0
  let recoveryFunnel: DoorFunnel | null = null

  function plan(feet: Vector3): void {
    const navPath = nav.findPath(feet, goal)
    buildDoorwayPath(navPath, feet)
    cornerIndex = 0
    replanElapsed = 0
    needsReplan = false
    trackingProgress = false
    progressElapsed = 0
    advanceCorners(feet)
  }

  function buildDoorwayPath(navPath: Vector3[], feet: Vector3): void {
    const doors = opts.doors
    if (!doors || doors.length === 0 || navPath.length < 2) {
      path = navPath
      funnels = new Array<DoorFunnel | null>(navPath.length).fill(null)
      return
    }

    const doorwayPath: Vector3[] = [navPath[0]]
    const doorwayFunnels: Array<DoorFunnel | null> = [null]
    const usedDoors = new Set<string>()
    for (let pointIndex = 1; pointIndex < navPath.length; pointIndex++) {
      const from = navPath[pointIndex - 1]
      const to = navPath[pointIndex]
      const crossings: DoorFunnel[] = []
      for (let doorIndex = 0; doorIndex < doors.length; doorIndex++) {
        const door = doors[doorIndex]
        if (door.kind === 'window' || usedDoors.has(door.id)) continue
        const funnel = crossingFunnel(door, from, to, feet.y)
        if (funnel) crossings.push(funnel)
      }
      crossings.sort((a, b) => a.crossingT - b.crossingT)
      for (let crossingIndex = 0; crossingIndex < crossings.length; crossingIndex++) {
        const funnel = crossings[crossingIndex]
        updateFunnelPoint(funnel, feet.y)
        doorwayPath.push(funnel.point)
        doorwayFunnels.push(funnel)
        usedDoors.add(funnel.door.id)
      }
      doorwayPath.push(to)
      doorwayFunnels.push(null)
    }
    path = doorwayPath
    funnels = doorwayFunnels
  }

  function crossingFunnel(
    door: DoorInfo,
    from: Vector3,
    to: Vector3,
    floorY: number,
  ): DoorFunnel | null {
    door.node.updateWorldMatrix(true, false)
    const elements = door.node.matrixWorld.elements
    let widthX = elements[0]
    let widthZ = elements[2]
    const widthLength = Math.hypot(widthX, widthZ)
    if (widthLength <= EPSILON) {
      widthX = 1
      widthZ = 0
    } else {
      widthX /= widthLength
      widthZ /= widthLength
    }

    // Project the node's local Z axis into the floor plane. If a malformed transform makes it
    // degenerate, the perpendicular to local X is still a valid doorway plane normal.
    let normalX = elements[8]
    let normalZ = elements[10]
    const normalLength = Math.hypot(normalX, normalZ)
    if (normalLength <= EPSILON) {
      normalX = -widthZ
      normalZ = widthX
    } else {
      normalX /= normalLength
      normalZ /= normalLength
      const handedness = normalX * -widthZ + normalZ * widthX < 0 ? -1 : 1
      normalX = -widthZ * handedness
      normalZ = widthX * handedness
    }

    const fromPlane = (from.x - door.center.x) * normalX
      + (from.z - door.center.z) * normalZ
    const toPlane = (to.x - door.center.x) * normalX
      + (to.z - door.center.z) * normalZ
    const planeDelta = toPlane - fromPlane
    if (Math.abs(planeDelta) <= EPSILON) return null
    const crossingT = -fromPlane / planeDelta
    if (crossingT <= 1e-4 || crossingT > 1) return null

    const crossingX = from.x + (to.x - from.x) * crossingT
    const crossingZ = from.z + (to.z - from.z) * crossingT
    const lateral = (crossingX - door.center.x) * widthX
      + (crossingZ - door.center.z) * widthZ
    if (Math.abs(lateral) > door.halfWidth + DOOR_CROSS_MARGIN) return null
    const crossingY = from.y + (to.y - from.y) * crossingT
    if (Math.abs(door.center.y - crossingY) > DOOR_FLOOR_RANGE
      && Math.abs(door.center.y - floorY) > DOOR_FLOOR_RANGE) return null

    return {
      door,
      point: new Vector3(door.center.x, crossingY, door.center.z),
      normalX,
      normalZ,
      widthX,
      widthZ,
      crossingT,
    }
  }

  /** Keep a single open leaf on the hinge side of the capsule, leaving the free half clear. */
  function updateFunnelPoint(funnel: DoorFunnel, floorY: number): void {
    const door = funnel.door
    funnel.point.set(door.center.x, floorY, door.center.z)
    if (door.leafMeshes.length === 0) return

    let openLeaves = 0
    let allOpen = true
    let hingeLateralSum = 0
    let hasNegativeSide = false
    let hasPositiveSide = false
    for (let leafIndex = 0; leafIndex < door.leafMeshes.length; leafIndex++) {
      const leaf = door.leafMeshes[leafIndex]
      leaf.updateWorldMatrix(true, false)
      const openness = opts.doorOpenness?.(door.id) ?? inferredLeafOpenness(leaf, funnel)
      if (openness <= 0.5) {
        allOpen = false
        continue
      }
      openLeaves++
      leafWorldCenter(leaf, leafCenter)
      const lateral = (leafCenter.x - door.center.x) * funnel.widthX
        + (leafCenter.z - door.center.z) * funnel.widthZ
      hingeLateralSum += lateral
      if (lateral < -0.08) hasNegativeSide = true
      if (lateral > 0.08) hasPositiveSide = true
    }

    // Opposing open leaves belong to a double door; its centre line is already the clear line.
    if (openLeaves === 0 || (allOpen && hasNegativeSide && hasPositiveSide)) return
    const hingeLateral = hingeLateralSum / openLeaves
    const freeSide = hingeLateral <= 0 ? 1 : -1
    funnel.point.x += funnel.widthX * SINGLE_DOOR_OFFSET * freeSide
    funnel.point.z += funnel.widthZ * SINGLE_DOOR_OFFSET * freeSide
  }

  function inferredLeafOpenness(leaf: Mesh, funnel: DoorFunnel): number {
    const geometry = leaf.geometry
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    const box = geometry.boundingBox
    if (!box) return 0
    box.getSize(leafSize)
    const elements = leaf.matrixWorld.elements
    const xHorizontalScale = Math.hypot(elements[0], elements[2]) * leafSize.x
    const zHorizontalScale = Math.hypot(elements[8], elements[10]) * leafSize.z
    if (xHorizontalScale >= zHorizontalScale) leafAxis.set(elements[0], 0, elements[2])
    else leafAxis.set(elements[8], 0, elements[10])
    const length = Math.hypot(leafAxis.x, leafAxis.z)
    if (length <= EPSILON) return 0
    return Math.abs((leafAxis.x * funnel.normalX + leafAxis.z * funnel.normalZ) / length)
  }

  function leafWorldCenter(leaf: Mesh, out: Vector3): void {
    const geometry = leaf.geometry
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    if (geometry.boundingBox) geometry.boundingBox.getCenter(out)
    else out.set(0, 0, 0)
    out.applyMatrix4(leaf.matrixWorld)
  }

  function advanceCorners(feet: Vector3): void {
    while (cornerIndex < path.length) {
      const corner = path[cornerIndex]
      const funnel = funnels[cornerIndex]
      if (funnel) {
        updateFunnelPoint(funnel, feet.y)
        const planeDistance = Math.abs(
          (feet.x - funnel.door.center.x) * funnel.normalX
          + (feet.z - funnel.door.center.z) * funnel.normalZ,
        )
        const lateralError = Math.abs(
          (feet.x - corner.x) * funnel.widthX + (feet.z - corner.z) * funnel.widthZ,
        )
        if (planeDistance > CORNER_DISTANCE || lateralError >= DOOR_LATERAL_SLACK) break
        cornerIndex++
        continue
      }
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

  function driveToward(target: Vector3): PathFollowerResult {
    const dx = target.x - currentFeet.x
    const dz = target.z - currentFeet.z
    if (dx * dx + dz * dz <= EPSILON) return pauseWhileJumping()
    result.yaw = Math.atan2(-dx, -dz)
    result.move.forward = 1
    result.move.right = 0
    result.move.jump = false
    result.move.crouch = false
    result.arrived = false
    return result
  }

  function beginRecovery(feet: Vector3, dx: number, dz: number): void {
    const length = Math.hypot(dx, dz)
    if (length > EPSILON) approachDirection.set(dx / length, 0, dz / length)
    else approachDirection.set(-Math.sin(result.yaw), 0, -Math.cos(result.yaw))
    recoveryTarget.copy(feet).addScaledVector(approachDirection, -RECOVERY_BACK_DISTANCE)
    recoveryPhase = 'backoff'
    recoveryElapsed = 0
    recoveryFunnel = funnels[cornerIndex] ?? null
    trackingProgress = false
    progressElapsed = 0
    jumpRemaining = 0
    stairPushRemaining = 0
  }

  function beginSidestep(feet: Vector3): void {
    let sideX = 0
    let sideZ = 0
    if (recoveryFunnel) {
      updateFunnelPoint(recoveryFunnel, feet.y)
      const towardX = recoveryFunnel.point.x - feet.x
      const towardZ = recoveryFunnel.point.z - feet.z
      const along = towardX * approachDirection.x + towardZ * approachDirection.z
      sideX = towardX - approachDirection.x * along
      sideZ = towardZ - approachDirection.z * along
    }
    const length = Math.hypot(sideX, sideZ)
    if (length > EPSILON) {
      sideX /= length
      sideZ /= length
    } else {
      sideX = approachDirection.z
      sideZ = -approachDirection.x
    }
    recoveryTarget.set(
      feet.x + sideX * RECOVERY_SIDE_DISTANCE,
      feet.y,
      feet.z + sideZ * RECOVERY_SIDE_DISTANCE,
    )
    recoveryPhase = 'sidestep'
    recoveryElapsed = 0
  }

  function updateRecovery(feet: Vector3, dt: number): PathFollowerResult | null {
    if (recoveryPhase === 'none') return null
    recoveryElapsed += dt
    const dx = recoveryTarget.x - feet.x
    const dz = recoveryTarget.z - feet.z
    const reached = dx * dx + dz * dz <= RECOVERY_REACHED_DISTANCE * RECOVERY_REACHED_DISTANCE
    const timedOut = recoveryElapsed >= (recoveryPhase === 'backoff'
      ? RECOVERY_BACK_SECONDS
      : RECOVERY_SIDE_SECONDS)
    if (!reached && !timedOut) return driveToward(recoveryTarget)
    if (recoveryPhase === 'backoff') {
      beginSidestep(feet)
      return driveToward(recoveryTarget)
    }
    recoveryPhase = 'none'
    recoveryFunnel = null
    needsReplan = true
    plan(feet)
    return null
  }

  function firstStuckRecovery(feet: Vector3, cornerY: number): void {
    if (cornerY - feet.y > STAIR_RISE) {
      // Stair lips need a committed jump. Replanning immediately tends to return the same
      // corner and leaves the bot oscillating at the bottom of the flight.
      stairPushRemaining = STAIR_PUSH_SECONDS
      jumpRemaining = STAIR_PUSH_SECONDS
      trackingProgress = false
      progressElapsed = 0
    } else {
      jumpRemaining = JUMP_SECONDS
      plan(feet)
    }
  }

  function handleStuck(feet: Vector3, dx: number, dz: number, cornerY: number): boolean {
    result.stuck = true
    if (stuckStage === 0) {
      stuckStage = 1
      firstStuckAt = elapsed
      stuckOrigin.copy(feet)
      firstStuckRecovery(feet, cornerY)
      return false
    }

    const stuckDx = feet.x - stuckOrigin.x
    const stuckDz = feet.z - stuckOrigin.z
    const distanceFromFirstSq = stuckDx * stuckDx + stuckDz * stuckDz
    if (stuckStage === 1
      && elapsed - firstStuckAt <= SECOND_STUCK_SECONDS
      && distanceFromFirstSq < SAME_STUCK_DISTANCE * SAME_STUCK_DISTANCE) {
      stuckStage = 2
      beginRecovery(feet, dx, dz)
      return false
    }

    if (stuckStage === 2 && elapsed - firstStuckAt <= THIRD_STUCK_SECONDS) {
      giveUp++
      hasGoal = false
      path = EMPTY_PATH
      funnels.length = 0
      recoveryPhase = 'none'
      result.abandoned = true
      result.move.forward = 0
      result.move.right = 0
      result.move.jump = false
      result.move.crouch = false
      result.arrived = false
      return true
    }

    stuckStage = 1
    firstStuckAt = elapsed
    stuckOrigin.copy(feet)
    firstStuckRecovery(feet, cornerY)
    return false
  }

  let currentDt = 0
  let currentFeet = new Vector3()

  return {
    get giveUp() { return giveUp },

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
      stuckStage = 0
      firstStuckAt = -Infinity
      recoveryPhase = 'none'
      recoveryFunnel = null
    },

    update(feet, dt) {
      dt = Math.max(0, dt)
      currentDt = dt
      currentFeet = feet
      elapsed += dt
      result.abandoned = false
      if (!hasGoal) return stop(true)

      const goalDx = goal.x - feet.x
      const goalDz = goal.z - feet.z
      if (goalDx * goalDx + goalDz * goalDz <= ARRIVAL_DISTANCE * ARRIVAL_DISTANCE
        && Math.abs(goal.y - feet.y) <= VERTICAL_ARRIVAL_DISTANCE) {
        hasGoal = false
        path = EMPTY_PATH
        funnels.length = 0
        jumpRemaining = 0
        stairPushRemaining = 0
        stuckStage = 0
        return stop(true)
      }

      result.stuck = false
      const recovering = updateRecovery(feet, dt)
      if (recovering) return recovering

      const pushingUpStair = stairPushRemaining > 0
      if (!pushingUpStair) replanElapsed += dt
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
      const funnel = funnels[cornerIndex]
      if (funnel) {
        const planeDistance = Math.abs(
          (feet.x - funnel.door.center.x) * funnel.normalX
          + (feet.z - funnel.door.center.z) * funnel.normalZ,
        )
        if (planeDistance <= DOOR_APPROACH_DISTANCE) updateFunnelPoint(funnel, feet.y)
      }
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
              if (handleStuck(feet, dx, dz, corner.y)) return result
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

      if (recoveryPhase !== 'none') return updateRecovery(feet, 0) ?? pauseWhileJumping()

      // Planning after a stuck event may have changed the active corner.
      if (cornerIndex >= path.length) return pauseWhileJumping()
      const activeCorner = path[cornerIndex]
      const activeFunnel = funnels[cornerIndex]
      if (activeFunnel) updateFunnelPoint(activeFunnel, feet.y)
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

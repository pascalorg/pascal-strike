import { Vector3 } from 'three'
import { BOTS, PLAYER, WEAPON } from '../config'
import type {
  BotDecision,
  Navigation,
  PlayerEntity,
  SpawnLayout,
  WorldQuery,
} from '../types'
import { createPathFollower, type PathFollower } from './navigation'
import type { RoamTargetSet } from './roam'

const DEG_TO_RAD = Math.PI / 180
const MAX_TURN_RATE = 540 * DEG_TO_RAD
const MAX_PITCH = Math.PI / 2 - 0.05
const TARGET_HEIGHT = 1.2
const LEAD_SECONDS = 0.15
const AIM_SAMPLE_MS = 250
const FIRE_TOLERANCE_COS = Math.cos(6 * DEG_TO_RAD)
const ALLY_TOLERANCE_COS = Math.cos(1.5 * DEG_TO_RAD)
const ROAM_ARRIVAL_DISTANCE_SQ = 0.6 * 0.6
const ROAM_TIMEOUT_MS = 12_000
const RETREAT_MS = 3_000
const RETREAT_RADIUS = 6
const OUTDOOR_RETURN_MS = 6_000

export type BotState = 'roam' | 'hunt' | 'engage' | 'retreat'

export interface BotBrainOptions {
  self: PlayerEntity
  world: WorldQuery
  nav: Navigation
  rng: () => number
  difficulty?: Partial<typeof BOTS>
  /** Runner injection point; callers normally let the brain create its own follower. */
  pathFollower?: PathFollower
  /** Shared map-level roam candidates, built once by the runner. */
  roamTargets?: RoamTargetSet
}

export interface BotBrain {
  readonly state: BotState
  readonly pathFollower: PathFollower
  update(
    dt: number,
    now: number,
    enemies: PlayerEntity[],
    allies: PlayerEntity[],
    spawns: SpawnLayout,
  ): BotDecision
  reset(now?: number): void
}

/** Deterministic perception, state selection, aiming, and movement for one bot. */
export function createBotBrain(opts: BotBrainOptions): BotBrain {
  const decisionHz = opts.difficulty?.decisionHz ?? BOTS.decisionHz
  const viewDistance = opts.difficulty?.viewDistance ?? BOTS.viewDistance
  const fovCos = Math.cos((opts.difficulty?.fovDeg ?? BOTS.fovDeg) * 0.5 * DEG_TO_RAD)
  const aimSigma = (opts.difficulty?.aimErrorDeg ?? BOTS.aimErrorDeg) * DEG_TO_RAD
  const reactionMs = opts.difficulty?.reactionMs ?? BOTS.reactionMs
  const memoryMs = opts.difficulty?.memoryMs ?? BOTS.memoryMs
  const burstShots = Math.max(1, opts.difficulty?.burstShots ?? BOTS.burstShots)
  const burstPauseMs = opts.difficulty?.burstPauseMs ?? BOTS.burstPauseMs
  const perceptionPeriod = 1 / Math.max(decisionHz, 0.001)
  const viewDistanceSq = viewDistance * viewDistance
  const follower = opts.pathFollower ?? createPathFollower(opts.nav)

  const decision: BotDecision = {
    move: { forward: 0, right: 0, jump: false, crouch: false },
    yaw: opts.self.yaw,
    pitch: opts.self.pitch,
    fire: false,
  }

  // All geometric work reuses these vectors. Navigation implementations own the vectors
  // returned by their infrequent path/random-point calls.
  const eye = new Vector3()
  const targetPoint = new Vector3()
  const predictedTarget = new Vector3()
  const trueAimDirection = new Vector3()
  const aimDirection = new Vector3()
  const relative = new Vector3()
  const allyPoint = new Vector3()
  const lastSeenPosition = new Vector3()
  const observedPosition = new Vector3()
  const targetVelocity = new Vector3()
  const navGoal = new Vector3()
  const ownAnchor = new Vector3()
  const enemyAnchor = new Vector3()
  const retreatFallback = new Vector3()

  let state: BotState = 'roam'
  let perceptionAccumulator = perceptionPeriod
  let visibleTarget: PlayerEntity | null = null
  let engagedTarget: PlayerEntity | null = null
  let firstSeenId: string | null = null
  let firstSeenAt = -Infinity
  let lastSeenAt = -Infinity
  let observedId: string | null = null
  let observedAt = -Infinity
  let hasNavGoal = false
  let roamPickedAt = -Infinity
  let retreatUntil = -Infinity
  let retreatUsedForThreat = false
  let strafeDirection = 1
  let strafeUntil = -Infinity
  let crouchWhileFar = false
  let aimErrorYaw = 0
  let aimErrorPitch = 0
  let nextAimSampleAt = -Infinity
  let burstActive = false
  let burstEndsAt = -Infinity
  let nextBurstAt = -Infinity
  let outdoorWithoutEnemySince = -Infinity
  let returningIndoors = false

  function setEye(): void {
    eye.copy(opts.self.position)
    eye.y += opts.self.crouching ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight
  }

  function setTargetPoint(target: PlayerEntity): void {
    targetPoint.copy(target.position)
    targetPoint.y += TARGET_HEIGHT
  }

  function setNavigationGoal(point: Vector3): void {
    if (hasNavGoal && navGoal.distanceToSquared(point) < 0.25 * 0.25) return
    navGoal.copy(point)
    follower.setGoal(navGoal)
    hasNavGoal = true
  }

  function enterState(next: BotState): void {
    if (state === next) return
    state = next
    if (next === 'engage') {
      strafeUntil = -Infinity
      nextAimSampleAt = -Infinity
      burstActive = false
      nextBurstAt = -Infinity
    } else {
      burstActive = false
      decision.fire = false
    }
    if (next === 'roam') {
      hasNavGoal = false
      roamPickedAt = -Infinity
    }
  }

  function observeTarget(target: PlayerEntity, now: number): void {
    if (observedId === target.id && observedAt < now) {
      const inverseSeconds = 1000 / (now - observedAt)
      targetVelocity.subVectors(target.position, observedPosition).multiplyScalar(inverseSeconds)
      targetVelocity.y = 0
    } else {
      targetVelocity.set(0, 0, 0)
    }
    observedId = target.id
    observedAt = now
    observedPosition.copy(target.position)
  }

  function chooseVisibleTarget(enemies: PlayerEntity[]): PlayerEntity | null {
    setEye()
    const forwardX = -Math.sin(decision.yaw)
    const forwardZ = -Math.cos(decision.yaw)
    let nearest: PlayerEntity | null = null
    let nearestDistanceSq = viewDistanceSq + 1

    for (let index = 0; index < enemies.length; index++) {
      const enemy = enemies[index]
      if (!enemy.alive) continue
      const dx = enemy.position.x - eye.x
      const dz = enemy.position.z - eye.z
      const horizontalSq = dx * dx + dz * dz
      const dy = enemy.position.y + TARGET_HEIGHT - eye.y
      const distanceSq = horizontalSq + dy * dy
      if (distanceSq > viewDistanceSq || distanceSq >= nearestDistanceSq) continue
      const horizontalDistance = Math.sqrt(horizontalSq)
      if (horizontalDistance > 1e-6
        && (dx * forwardX + dz * forwardZ) / horizontalDistance < fovCos) continue
      setTargetPoint(enemy)
      if (!opts.world.lineOfSight(eye, targetPoint)) continue
      nearest = enemy
      nearestDistanceSq = distanceSq
    }
    return nearest
  }

  function enterRetreat(threat: PlayerEntity, now: number): void {
    enterState('retreat')
    retreatUntil = now + RETREAT_MS
    retreatUsedForThreat = true
    engagedTarget = threat
    setTargetPoint(threat)

    let foundHidden = false
    let fallbackDistanceSq = -1
    for (let index = 0; index < 8; index++) {
      const point = opts.nav.randomPointAround(opts.self.position, RETREAT_RADIUS)
      relative.copy(point)
      relative.y += PLAYER.eyeHeight
      if (!opts.world.lineOfSight(relative, targetPoint)) {
        setNavigationGoal(point)
        foundHidden = true
        break
      }
      const distanceSq = point.distanceToSquared(threat.position)
      if (distanceSq > fallbackDistanceSq) {
        fallbackDistanceSq = distanceSq
        retreatFallback.copy(point)
      }
    }

    if (!foundHidden) {
      if (fallbackDistanceSq < 0) {
        retreatFallback.subVectors(opts.self.position, threat.position)
        retreatFallback.y = 0
        if (retreatFallback.lengthSq() < 1e-6) retreatFallback.set(0, 0, 1)
        retreatFallback.normalize().multiplyScalar(RETREAT_RADIUS).add(opts.self.position)
        retreatFallback.copy(opts.nav.closestPoint(retreatFallback))
      }
      setNavigationGoal(retreatFallback)
    }
  }

  function perceive(now: number, enemies: PlayerEntity[]): void {
    visibleTarget = chooseVisibleTarget(enemies)
    if (visibleTarget) {
      setTargetPoint(visibleTarget)
      observeTarget(visibleTarget, now)
      lastSeenPosition.copy(visibleTarget.position)
      lastSeenAt = now

      if (firstSeenId !== visibleTarget.id) {
        firstSeenId = visibleTarget.id
        firstSeenAt = now
      }

      if (opts.self.hp > 34) retreatUsedForThreat = false
      if (state !== 'retreat' && opts.self.hp <= 34 && !retreatUsedForThreat) {
        enterRetreat(visibleTarget, now)
        return
      }

      if (state !== 'retreat' && now - firstSeenAt >= reactionMs) {
        engagedTarget = visibleTarget
        enterState('engage')
      }
      return
    }

    firstSeenId = null
    firstSeenAt = -Infinity
    observedId = null
    targetVelocity.set(0, 0, 0)
    retreatUsedForThreat = false
    if (state === 'engage') {
      enterState('hunt')
      setNavigationGoal(lastSeenPosition)
    } else if (state === 'hunt' && now - lastSeenAt > memoryMs) {
      enterState('roam')
    }
  }

  function averageSpawn(points: SpawnLayout['a'], out: Vector3): boolean {
    if (points.length === 0) return false
    out.set(0, 0, 0)
    for (let index = 0; index < points.length; index++) out.add(points[index].position)
    out.multiplyScalar(1 / points.length)
    return true
  }

  function pickRoamGoal(now: number, spawns: SpawnLayout): void {
    const buildingTarget = opts.roamTargets?.sample(opts.rng)
    if (buildingTarget) {
      setNavigationGoal(buildingTarget)
      roamPickedAt = now
      return
    }

    const ownSpawns = spawns[opts.self.team]
    const enemySpawns = spawns[opts.self.team === 'a' ? 'b' : 'a']
    const hasOwnAnchor = averageSpawn(ownSpawns, ownAnchor)
    const hasEnemyAnchor = averageSpawn(enemySpawns, enemyAnchor)

    if (opts.rng() < 0.6) {
      let candidate = opts.nav.randomPoint()
      if (hasOwnAnchor && hasEnemyAnchor) {
        for (let attempt = 0; attempt < 7
          && candidate.distanceToSquared(ownAnchor) < candidate.distanceToSquared(enemyAnchor);
          attempt++) {
          candidate = opts.nav.randomPoint()
        }
      }
      setNavigationGoal(candidate)
    } else if (enemySpawns.length > 0) {
      const index = Math.min(enemySpawns.length - 1, Math.floor(opts.rng() * enemySpawns.length))
      setNavigationGoal(opts.nav.randomPointAround(enemySpawns[index].position, RETREAT_RADIUS))
    } else {
      setNavigationGoal(opts.nav.randomPoint())
    }
    roamPickedAt = now
  }

  function smoothLook(desiredYaw: number, desiredPitch: number, dt: number): void {
    const maxStep = MAX_TURN_RATE * Math.max(0, dt)
    const yawDelta = wrapAngle(desiredYaw - decision.yaw)
    decision.yaw = wrapAngle(decision.yaw + clamp(yawDelta, -maxStep, maxStep))
    decision.pitch = clamp(
      decision.pitch + clamp(desiredPitch - decision.pitch, -maxStep, maxStep),
      -MAX_PITCH,
      MAX_PITCH,
    )
  }

  function setMoveFromWorld(worldX: number, worldZ: number, jump: boolean, crouch: boolean): void {
    const length = Math.hypot(worldX, worldZ)
    if (length > 1) {
      worldX /= length
      worldZ /= length
    }
    const sin = Math.sin(decision.yaw)
    const cos = Math.cos(decision.yaw)
    decision.move.forward = worldX * -sin + worldZ * -cos
    decision.move.right = worldX * cos + worldZ * -sin
    decision.move.jump = jump
    decision.move.crouch = crouch
  }

  function updatePathMovement(dt: number, now: number, spawns: SpawnLayout): void {
    if (state === 'retreat' && now >= retreatUntil) enterState('roam')
    if (state === 'hunt' && now - lastSeenAt > memoryMs) enterState('roam')
    // `-Infinity` is the "not outdoors" sentinel, so it must be excluded before the age
    // test: `now - (-Infinity)` is `Infinity`, which would make every indoor bot think it
    // had been stranded outside forever and repick a goal on every tick.
    const needsIndoorGoal = state === 'roam'
      && outdoorWithoutEnemySince !== -Infinity
      && now - outdoorWithoutEnemySince > OUTDOOR_RETURN_MS
      && !returningIndoors
    if (needsIndoorGoal) {
      const indoorTarget = opts.roamTargets?.sampleIndoor(opts.rng)
      if (indoorTarget) {
        setNavigationGoal(indoorTarget)
        roamPickedAt = now
        returningIndoors = true
      }
    }
    if (state === 'roam' && !returningIndoors
      && (!hasNavGoal || now - roamPickedAt >= ROAM_TIMEOUT_MS
      || navGoal.distanceToSquared(opts.self.position) < ROAM_ARRIVAL_DISTANCE_SQ)) {
      pickRoamGoal(now, spawns)
    }

    const path = follower.update(opts.self.position, dt)
    if (state === 'hunt' && path.arrived) enterState('roam')
    if (state === 'roam' && path.arrived) {
      returningIndoors = false
      pickRoamGoal(now, spawns)
    }

    const pathSin = Math.sin(path.yaw)
    const pathCos = Math.cos(path.yaw)
    const worldX = -pathSin * path.move.forward + pathCos * path.move.right
    const worldZ = -pathCos * path.move.forward - pathSin * path.move.right
    smoothLook(path.yaw, 0, dt)
    setMoveFromWorld(worldX, worldZ, path.move.jump, path.move.crouch)
    decision.fire = false
  }

  function sampleAimError(now: number): void {
    if (now < nextAimSampleAt) return
    const u1 = Math.max(opts.rng(), 1e-7)
    const u2 = opts.rng()
    const radius = Math.sqrt(-2 * Math.log(u1)) * aimSigma
    const angle = Math.PI * 2 * u2
    aimErrorYaw = Math.cos(angle) * radius
    aimErrorPitch = Math.sin(angle) * radius
    nextAimSampleAt = now + AIM_SAMPLE_MS
  }

  function alliesBlockDirection(
    allies: PlayerEntity[],
    targetDistance: number,
    direction: Vector3,
  ): boolean {
    const aimHorizontalSq = direction.x * direction.x + direction.z * direction.z
    if (aimHorizontalSq < 1e-8) return false
    for (let index = 0; index < allies.length; index++) {
      const ally = allies[index]
      if (!ally.alive || ally.id === opts.self.id) continue
      const allyX = ally.position.x - eye.x
      const allyZ = ally.position.z - eye.z
      const alongRay = (allyX * direction.x + allyZ * direction.z) / aimHorizontalSq
      if (alongRay <= 0 || alongRay >= targetDistance) continue
      // Aim at the nearest point on the ally's capsule axis, not only their chest.
      // Otherwise a chest-height target farther away can make the ray pass just above
      // a nearer ally's chest despite crossing that ally's body.
      const rayY = eye.y + direction.y * alongRay
      allyPoint.set(
        ally.position.x,
        clamp(rayY, ally.position.y + PLAYER.radius, ally.position.y + PLAYER.height - PLAYER.radius),
        ally.position.z,
      )
      relative.subVectors(allyPoint, eye)
      const distance = relative.length()
      if (distance <= 1e-6 || distance >= targetDistance) continue
      relative.multiplyScalar(1 / distance)
      if (relative.dot(direction) >= ALLY_TOLERANCE_COS) return true
    }
    return false
  }

  function updateBurst(now: number, eligible: boolean): boolean {
    if (burstActive && now >= burstEndsAt) burstActive = false
    if (!burstActive && eligible && now >= nextBurstAt) {
      const shotPeriodMs = 1000 / WEAPON.fireRate
      burstActive = true
      // Marker fires immediately, then at fireRate while held. Release between the
      // requested final shot and the following cadence slot.
      burstEndsAt = now + Math.max(1, burstShots - 0.25) * shotPeriodMs
      nextBurstAt = burstEndsAt + burstPauseMs
    }
    return burstActive && eligible
  }

  function updateEngage(dt: number, now: number, allies: PlayerEntity[]): void {
    const target = engagedTarget
    if (!target || !target.alive) {
      enterState('hunt')
      setNavigationGoal(lastSeenPosition)
      decision.move.forward = 0
      decision.move.right = 0
      decision.move.jump = false
      decision.move.crouch = false
      decision.fire = false
      return
    }

    setEye()
    predictedTarget.copy(target.position).addScaledVector(targetVelocity, LEAD_SECONDS)
    predictedTarget.y = target.position.y + TARGET_HEIGHT
    trueAimDirection.subVectors(predictedTarget, eye)
    const targetDistance = trueAimDirection.length()
    if (targetDistance <= 1e-6) {
      decision.move.forward = 0
      decision.move.right = 0
      decision.move.jump = false
      decision.move.crouch = false
      decision.fire = false
      return
    }
    trueAimDirection.multiplyScalar(1 / targetDistance)

    const horizontalDistance = Math.hypot(trueAimDirection.x, trueAimDirection.z)
    const targetYaw = Math.atan2(-trueAimDirection.x, -trueAimDirection.z)
    const targetPitch = Math.atan2(trueAimDirection.y, horizontalDistance)
    sampleAimError(now)
    smoothLook(targetYaw + aimErrorYaw, targetPitch + aimErrorPitch, dt)

    const cosPitch = Math.cos(decision.pitch)
    aimDirection.set(
      -Math.sin(decision.yaw) * cosPitch,
      Math.sin(decision.pitch),
      -Math.cos(decision.yaw) * cosPitch,
    )

    if (now >= strafeUntil) {
      strafeDirection = opts.rng() < 0.5 ? -1 : 1
      strafeUntil = now + 800 + opts.rng() * 800
      crouchWhileFar = opts.rng() < 0.2
    }

    const horizontalTargetDistance = Math.hypot(
      predictedTarget.x - opts.self.position.x,
      predictedTarget.z - opts.self.position.z,
    )
    let targetX = 0
    let targetZ = -1
    if (horizontalTargetDistance > 1e-6) {
      targetX = (predictedTarget.x - opts.self.position.x) / horizontalTargetDistance
      targetZ = (predictedTarget.z - opts.self.position.z) / horizontalTargetDistance
    }
    let worldX = -targetZ * strafeDirection
    let worldZ = targetX * strafeDirection
    if (horizontalTargetDistance > 9) {
      worldX += targetX
      worldZ += targetZ
    } else if (horizontalTargetDistance < 4) {
      worldX -= targetX
      worldZ -= targetZ
    }
    setMoveFromWorld(worldX, worldZ, false, horizontalTargetDistance > 8 && crouchWhileFar)

    setTargetPoint(target)
    const clear = opts.world.lineOfSight(eye, targetPoint)
    const accurate = aimDirection.dot(trueAimDirection) >= FIRE_TOLERANCE_COS
    // Guard both the noisy muzzle line and the intended target line. The latter keeps a
    // teammate directly between bot and target safe when gaussian aim error shifts the
    // muzzle a few degrees to one side.
    const safe = !alliesBlockDirection(allies, targetDistance, aimDirection)
      && !alliesBlockDirection(allies, targetDistance, trueAimDirection)
    decision.fire = updateBurst(now, clear && accurate && safe)
  }

  function reset(now = 0): void {
    state = 'roam'
    decision.yaw = opts.self.yaw
    decision.pitch = opts.self.pitch
    decision.fire = false
    decision.move.forward = 0
    decision.move.right = 0
    decision.move.jump = false
    decision.move.crouch = false
    perceptionAccumulator = perceptionPeriod
    visibleTarget = null
    engagedTarget = null
    firstSeenId = null
    firstSeenAt = -Infinity
    lastSeenAt = -Infinity
    observedId = null
    observedAt = -Infinity
    targetVelocity.set(0, 0, 0)
    hasNavGoal = false
    roamPickedAt = now - ROAM_TIMEOUT_MS
    retreatUntil = -Infinity
    retreatUsedForThreat = false
    burstActive = false
    nextBurstAt = -Infinity
    outdoorWithoutEnemySince = -Infinity
    returningIndoors = false
  }

  return {
    get state() { return state },
    pathFollower: follower,
    update(dt, now, enemies, allies, spawns) {
      perceptionAccumulator += Math.max(0, dt)
      if (perceptionAccumulator >= perceptionPeriod) {
        perceptionAccumulator %= perceptionPeriod
        perceive(now, enemies)
        if (visibleTarget || opts.roamTargets?.isIndoor(opts.self.position)) {
          outdoorWithoutEnemySince = -Infinity
          returningIndoors = false
        } else if (outdoorWithoutEnemySince === -Infinity) {
          outdoorWithoutEnemySince = now
        }
      }

      if (state === 'engage') updateEngage(dt, now, allies)
      else updatePathMovement(dt, now, spawns)
      return decision
    },
    reset,
  }
}

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle))
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

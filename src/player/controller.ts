import {
  Box3,
  DoubleSide,
  Line3,
  Ray,
  Vector3,
} from 'three'
import type { ExtendedTriangle, MeshBVH } from 'three-mesh-bvh'
import { PLAYER } from '../config'
import type {
  CharacterController,
  CharacterState,
  MoveInput,
  StaticCollider,
} from '../types'
import './bvh-setup'

export type CharacterControllerOptions = Partial<typeof PLAYER> & {
  onFellOut?: () => void
}

const EPSILON = 1e-5
const SKIN = 1e-4
const GROUND_PROBE = 0.08

class CapsuleController implements CharacterController {
  readonly state: CharacterState = {
    position: new Vector3(),
    velocity: new Vector3(),
    grounded: false,
    crouching: false,
  }

  readonly radius: number
  private readonly standingHeight: number
  private readonly crouchHeight: number
  private readonly standingEyeHeight: number
  private readonly crouchingEyeHeight: number
  private readonly runSpeed: number
  private readonly walkSpeed: number
  private readonly crouchSpeed: number
  private readonly airControl: number
  private readonly accel: number
  private readonly decel: number
  private readonly jumpVelocity: number
  private readonly gravity: number
  private readonly stepHeight: number
  private readonly slopeY: number
  private readonly onFellOut?: () => void
  private readonly bounds: Box3
  private readonly bvh: MeshBVH

  private currentHeight: number
  private fellOutReported = false
  private contactGround = false
  private contactCeiling = false
  private contactWall = false
  private stepBlocked = false
  private castMode: 'resolve' | 'test' = 'resolve'
  private castTolerance = SKIN
  private castCorrected = false
  private castPenetrating = false
  private castPosition: Vector3 = this.state.position

  private readonly capsule = new Line3()
  private readonly capsuleBounds = new Box3()
  private readonly trianglePoint = new Vector3()
  private readonly capsulePoint = new Vector3()
  private readonly correction = new Vector3()
  private readonly midpoint = new Vector3()
  private readonly triangleNormal = new Vector3()
  private readonly wish = new Vector3()
  private readonly desiredHorizontal = new Vector3()
  private readonly beforeMove = new Vector3()
  private readonly regularResult = new Vector3()
  private readonly stepResult = new Vector3()
  private readonly probeResult = new Vector3()
  private readonly ray = new Ray()
  private readonly groundProbeOffsets = [0, 0.5, 0.99, -0.5, -0.99]
  private readonly shapecastCallbacks = {
    intersectsBounds: (box: Box3) => box.intersectsBox(this.capsuleBounds),
    intersectsTriangle: (triangle: ExtendedTriangle) => this.castTriangle(triangle),
  }

  constructor(collider: StaticCollider, options: CharacterControllerOptions) {
    const config = { ...PLAYER, ...options }
    this.radius = config.radius
    this.standingHeight = config.height
    this.crouchHeight = config.crouchHeight
    this.standingEyeHeight = config.eyeHeight
    this.crouchingEyeHeight = config.crouchEyeHeight
    this.runSpeed = config.runSpeed
    this.walkSpeed = config.walkSpeed
    this.crouchSpeed = config.crouchSpeed
    this.airControl = config.airControl
    this.accel = config.accel
    this.decel = config.decel
    this.jumpVelocity = config.jumpVelocity
    this.gravity = config.gravity
    this.stepHeight = config.stepHeight
    this.slopeY = Math.cos(config.maxSlopeDeg * Math.PI / 180)
    this.onFellOut = options.onFellOut
    this.currentHeight = this.standingHeight
    collider.geometry.computeBoundingBox()
    this.bounds = collider.geometry.boundingBox?.clone() ?? new Box3()
    if (!collider.geometry.boundsTree) collider.geometry.computeBoundsTree({ targetLeafSize: 12 })
    this.bvh = collider.geometry.boundsTree as MeshBVH
  }

  get eyeHeight(): number {
    return this.state.crouching ? this.crouchingEyeHeight : this.standingEyeHeight
  }

  get height(): number {
    return this.currentHeight
  }

  setPosition(position: Vector3): void {
    this.state.position.copy(position)
    this.state.velocity.set(0, 0, 0)
    this.state.grounded = false
    this.fellOutReported = false
  }

  update(dt: number, input: MoveInput, yaw: number): void {
    if (!(dt > 0)) return
    dt = Math.min(dt, 0.05)

    this.updateCrouch(input.crouch)

    const wasGrounded = this.state.grounded
    const inputLength = Math.hypot(input.forward, input.right)
    const scale = inputLength > 1 ? 1 / inputLength : 1
    const sin = Math.sin(yaw)
    const cos = Math.cos(yaw)
    this.wish.set(
      (-sin * input.forward + cos * input.right) * scale,
      0,
      (-cos * input.forward - sin * input.right) * scale,
    )
    const speed = this.state.crouching ? this.crouchSpeed : input.walk ? this.walkSpeed : this.runSpeed
    const targetX = this.wish.x * speed
    const targetZ = this.wish.z * speed
    const rate = (inputLength > EPSILON ? this.accel : this.decel)
      * (wasGrounded ? 1 : this.airControl) * dt
    this.state.velocity.x = approach(this.state.velocity.x, targetX, rate)
    this.state.velocity.z = approach(this.state.velocity.z, targetZ, rate)

    if (input.jump && wasGrounded && !this.state.crouching) {
      this.state.velocity.y = this.jumpVelocity
      this.state.grounded = false
    } else {
      this.state.velocity.y -= this.gravity * dt
    }

    this.beforeMove.copy(this.state.position)
    this.desiredHorizontal.set(this.state.velocity.x * dt, 0, this.state.velocity.z * dt)

    this.state.position.x += this.desiredHorizontal.x
    this.state.position.z += this.desiredHorizontal.z
    this.state.position.y += this.state.velocity.y * dt
    this.resolveCapsule(this.state.position, this.currentHeight)
    this.regularResult.copy(this.state.position)
    const regularGround = this.contactGround
    const regularCeiling = this.contactCeiling
    const regularWall = this.contactWall
    const regularStepBlocked = this.stepBlocked

    const canStep = wasGrounded && !input.jump
      && this.desiredHorizontal.lengthSq() > EPSILON * EPSILON
    if (canStep && (regularStepBlocked || regularWall || regularGround)
      && this.horizontalProgress(this.regularResult) < 0.98) {
      if (this.tryStep()
        && this.horizontalProgress(this.stepResult) > this.horizontalProgress(this.regularResult) + 0.05) {
        this.state.position.copy(this.stepResult)
        this.contactGround = true
      } else {
        this.state.position.copy(this.regularResult)
        this.contactGround = regularGround
        this.contactCeiling = regularCeiling
        this.contactWall = regularWall
        this.stepBlocked = regularStepBlocked
      }
    }

    if (wasGrounded && !input.jump && !this.contactGround && this.tryGroundSnap()) {
      this.state.position.copy(this.stepResult)
      this.contactGround = true
    }

    this.state.grounded = this.contactGround
    if (this.state.grounded && this.state.velocity.y < 0) this.state.velocity.y = 0
    if (this.contactCeiling && this.state.velocity.y > 0) this.state.velocity.y = 0

    const actualX = this.state.position.x - this.beforeMove.x
    const actualZ = this.state.position.z - this.beforeMove.z
    if (Math.abs(actualX - this.desiredHorizontal.x) > 1e-3) this.state.velocity.x = actualX / dt
    if (Math.abs(actualZ - this.desiredHorizontal.z) > 1e-3) this.state.velocity.z = actualZ / dt

    if (this.state.position.y < this.bounds.min.y - 10) {
      if (!this.fellOutReported) this.onFellOut?.()
      this.fellOutReported = true
    } else {
      this.fellOutReported = false
    }
  }

  private updateCrouch(requested: boolean): void {
    if (requested) {
      this.state.crouching = true
      this.currentHeight = this.crouchHeight
      return
    }
    if (!this.state.crouching) return
    if (!this.hasPenetration(this.state.position, this.standingHeight)) {
      this.state.crouching = false
      this.currentHeight = this.standingHeight
    }
  }

  private horizontalProgress(position: Vector3): number {
    const desiredSq = this.desiredHorizontal.lengthSq()
    if (desiredSq < EPSILON * EPSILON) return 1
    return ((position.x - this.beforeMove.x) * this.desiredHorizontal.x
      + (position.z - this.beforeMove.z) * this.desiredHorizontal.z) / desiredSq
  }

  private tryStep(): boolean {
    const lift = this.stepHeight + 0.01
    if (!this.hasLiftClearance(this.beforeMove, this.currentHeight, lift)) return false
    this.stepResult.copy(this.beforeMove)
    this.stepResult.y += lift
    this.stepResult.x += this.desiredHorizontal.x
    this.stepResult.z += this.desiredHorizontal.z

    const beforeResolveX = this.stepResult.x
    const beforeResolveZ = this.stepResult.z
    this.resolveCapsule(this.stepResult, this.currentHeight)
    if (Math.hypot(this.stepResult.x - beforeResolveX, this.stepResult.z - beforeResolveZ) > this.radius * 0.5) return false
    if (this.contactCeiling) return false
    return this.findGround(this.stepResult, this.beforeMove.y, this.stepHeight + 0.01, GROUND_PROBE, false)
  }

  private tryGroundSnap(): boolean {
    this.stepResult.copy(this.state.position)
    return this.findGround(this.stepResult, this.beforeMove.y, 0.025, this.stepHeight + GROUND_PROBE, true)
  }

  /** Finds the highest walkable support beneath the capsule footprint. */
  private findGround(
    position: Vector3,
    referenceY: number,
    maxRise: number,
    maxDrop: number,
    flatOnly: boolean,
  ): boolean {
    const horizontalLength = Math.hypot(this.desiredHorizontal.x, this.desiredHorizontal.z)
    const directionX = horizontalLength > EPSILON ? this.desiredHorizontal.x / horizontalLength : 0
    const directionZ = horizontalLength > EPSILON ? this.desiredHorizontal.z / horizontalLength : 0
    const originY = referenceY + maxRise + 0.02
    const rayLength = maxRise + maxDrop + 0.04
    let bestY = -Infinity

    this.ray.direction.set(0, -1, 0)
    for (let index = 0; index < this.groundProbeOffsets.length; index++) {
      const offset = this.groundProbeOffsets[index]!
      this.ray.origin.set(
        position.x + directionX * this.radius * offset,
        originY,
        position.z + directionZ * this.radius * offset,
      )
      const hit = this.bvh.raycastFirst(this.ray, DoubleSide, 0, rayLength)
      if (!hit?.face) continue
      const normalY = Math.abs(hit.face.normal.y)
      // Slopes are handled continuously by capsule push-out. Snapping to the
      // floor beside or beneath one would pull the player off the ramp.
      if (flatOnly && normalY >= this.slopeY && normalY < 0.95) return false
      if (normalY < (flatOnly ? 0.95 : this.slopeY)) continue
      if (hit.point.y < referenceY - maxDrop - SKIN || hit.point.y > referenceY + maxRise + SKIN) continue
      if (hit.point.y <= bestY) continue

      this.probeResult.copy(position)
      this.probeResult.y = hit.point.y + SKIN
      if (this.hasPenetration(this.probeResult, this.currentHeight, 2e-3)) continue
      bestY = hit.point.y
    }
    if (bestY === -Infinity) return false
    position.y = bestY + SKIN
    return true
  }

  private setCapsule(position: Vector3, height: number): void {
    this.capsule.start.set(position.x, position.y + this.radius, position.z)
    this.capsule.end.set(position.x, position.y + height - this.radius, position.z)
    this.capsuleBounds.makeEmpty()
    this.capsuleBounds.expandByPoint(this.capsule.start)
    this.capsuleBounds.expandByPoint(this.capsule.end)
    this.capsuleBounds.min.addScalar(-this.radius)
    this.capsuleBounds.max.addScalar(this.radius)
  }

  private hasPenetration(position: Vector3, height: number, tolerance = SKIN): boolean {
    this.setCapsule(position, height)
    this.castMode = 'test'
    this.castTolerance = tolerance
    this.castPenetrating = false
    this.bvh.shapecast(this.shapecastCallbacks)
    return this.castPenetrating
  }

  private hasLiftClearance(position: Vector3, height: number, lift: number): boolean {
    // Sweeping the capsule's top sphere covers precisely the new volume entered
    // by an upward translation, without treating the floor or current wall
    // contacts as blockers.
    const topY = position.y + height - this.radius
    this.capsule.start.set(position.x, topY, position.z)
    this.capsule.end.set(position.x, topY + lift, position.z)
    this.capsuleBounds.makeEmpty()
    this.capsuleBounds.expandByPoint(this.capsule.start)
    this.capsuleBounds.expandByPoint(this.capsule.end)
    this.capsuleBounds.min.addScalar(-this.radius)
    this.capsuleBounds.max.addScalar(this.radius)
    this.castMode = 'test'
    this.castTolerance = 2e-3
    this.castPenetrating = false
    this.bvh.shapecast(this.shapecastCallbacks)
    return !this.castPenetrating
  }

  private resolveCapsule(position: Vector3, height: number): void {
    this.castPosition = position
    this.castTolerance = SKIN
    this.contactGround = false
    this.contactCeiling = false
    this.contactWall = false
    this.stepBlocked = false
    for (let pass = 0; pass < 5; pass++) {
      this.setCapsule(position, height)
      this.castMode = 'resolve'
      this.castCorrected = false
      this.bvh.shapecast(this.shapecastCallbacks)
      if (!this.castCorrected) break
    }
  }

  private castTriangle(triangle: ExtendedTriangle): boolean {
    const distance = triangle.closestPointToSegment(
      this.capsule,
      this.trianglePoint,
      this.capsulePoint,
    )
    if (distance >= this.radius - this.castTolerance) return false
    if (this.castMode === 'test') {
      this.castPenetrating = true
      return true
    }

    this.correction.subVectors(this.capsulePoint, this.trianglePoint)
    if (distance < EPSILON) {
      triangle.getNormal(this.triangleNormal)
      this.midpoint.addVectors(this.capsule.start, this.capsule.end).multiplyScalar(0.5)
      if (this.triangleNormal.dot(this.midpoint.sub(this.trianglePoint)) < 0) this.triangleNormal.negate()
      this.correction.copy(this.triangleNormal)
    } else {
      this.correction.multiplyScalar(1 / distance)
    }
    const depth = this.radius - distance + SKIN
    const normalY = this.correction.y
    if (normalY > this.slopeY) this.contactGround = true
    else if (normalY < -0.5) this.contactCeiling = true
    else {
      this.contactWall = true
      triangle.getNormal(this.triangleNormal)
      if (Math.abs(this.triangleNormal.y) < 0.25
        && this.trianglePoint.y <= this.castPosition.y + this.stepHeight + SKIN) {
        this.stepBlocked = true
      }
    }
    this.correction.multiplyScalar(depth)
    this.castPosition.add(this.correction)
    this.capsule.start.add(this.correction)
    this.capsule.end.add(this.correction)
    this.castCorrected = true
    return false
  }
}

function approach(value: number, target: number, amount: number): number {
  if (value < target) return Math.min(value + amount, target)
  return Math.max(value - amount, target)
}

export function createCharacterController(
  collider: StaticCollider,
  opts: CharacterControllerOptions = {},
): CharacterController {
  return new CapsuleController(collider, opts)
}

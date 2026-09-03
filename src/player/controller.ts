/**
 * Kinematic capsule controller (W1-B).
 *
 * Movement lives here — acceleration, gravity, jumping, crouching, stairs — while every question
 * about the world (push-out, penetration, headroom, what is underfoot) goes through
 * `CapsuleBody`, which owns the BVH work for both the static map and the moving door leaves.
 */
import { Box3, Ray, Vector3, type Mesh } from 'three'
import type { MeshBVH } from 'three-mesh-bvh'
import { PLAYER } from '../config'
import type {
  CharacterController,
  CharacterState,
  MoveInput,
  StaticCollider,
} from '../types'
import './bvh-setup'
import { CapsuleBody, SKIN } from './capsule-body'
import { registeredDynamicColliders } from './dynamic-colliders'

export type CharacterControllerOptions = Partial<typeof PLAYER> & {
  onFellOut?: () => void
}

const EPSILON = 1e-5
const GROUND_PROBE = 0.08
/** Below this a step-up is not worth attempting (and the ground snap covers it anyway). */
const MIN_STEP_LIFT = 0.05

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
  private readonly body: CapsuleBody

  private currentHeight: number
  private fellOutReported = false
  private grounded = false
  private ceiling = false

  private readonly wish = new Vector3()
  private readonly desiredHorizontal = new Vector3()
  private readonly beforeMove = new Vector3()
  private readonly regularResult = new Vector3()
  private readonly stepResult = new Vector3()
  private readonly probeResult = new Vector3()
  private readonly ray = new Ray()
  private readonly groundProbeOffsets = [0, 0.5, 0.99, -0.5, -0.99]

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
    this.body = new CapsuleBody(collider.geometry.boundsTree as MeshBVH, {
      radius: this.radius,
      slopeY: this.slopeY,
      stepHeight: this.stepHeight,
    })
    // Whoever built this collider may have registered the map's moving leaves against it.
    const registered = registeredDynamicColliders(collider.geometry)
    if (registered) this.body.setDynamicColliders(registered)
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

  setDynamicColliders(meshes: readonly Mesh[]): void {
    this.body.setDynamicColliders(meshes)
  }

  update(dt: number, input: MoveInput, yaw: number, speedScale = 1): void {
    if (!(dt > 0)) return
    dt = Math.min(dt, 0.05)

    this.body.refresh()
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
    // A lighter weapon moves you faster: the scale multiplies the target speed rather than the
    // wish vector, which is clamped to 1 and so could only ever slow the player down.
    const speed = (this.state.crouching ? this.crouchSpeed : input.walk ? this.walkSpeed : this.runSpeed)
      * (speedScale > 0 ? speedScale : 0)
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
    this.body.resolve(this.state.position, this.currentHeight)
    this.regularResult.copy(this.state.position)
    const regularGround = this.body.contactGround
    const regularCeiling = this.body.contactCeiling
    const regularWall = this.body.contactWall
    const regularStepBlocked = this.body.stepBlocked
    this.grounded = regularGround
    this.ceiling = regularCeiling

    const canStep = wasGrounded && !input.jump
      && this.desiredHorizontal.lengthSq() > EPSILON * EPSILON
    if (canStep && (regularStepBlocked || regularWall || regularGround)
      && this.horizontalProgress(this.regularResult) < 0.98) {
      if (this.tryStep()
        && this.horizontalProgress(this.stepResult) > this.horizontalProgress(this.regularResult) + 0.05) {
        this.state.position.copy(this.stepResult)
        this.grounded = true
        this.ceiling = false
      } else {
        this.state.position.copy(this.regularResult)
        this.grounded = regularGround
        this.ceiling = regularCeiling
      }
    }

    if (wasGrounded && !input.jump && !this.grounded && this.tryGroundSnap()) {
      this.state.position.copy(this.stepResult)
      this.grounded = true
    }

    this.state.grounded = this.grounded
    if (this.state.grounded && this.state.velocity.y < 0) this.state.velocity.y = 0
    if (this.ceiling && this.state.velocity.y > 0) this.state.velocity.y = 0

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
    if (!this.body.penetrates(this.state.position, this.standingHeight)) {
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

  /** Up (as far as the headroom allows), forward, then down onto the tread. */
  private tryStep(): boolean {
    const lift = this.body.availableLift(this.beforeMove, this.currentHeight, this.stepHeight + 0.01)
    if (lift < MIN_STEP_LIFT) return false
    this.stepResult.copy(this.beforeMove)
    this.stepResult.y += lift
    this.stepResult.x += this.desiredHorizontal.x
    this.stepResult.z += this.desiredHorizontal.z

    const beforeResolveX = this.stepResult.x
    const beforeResolveZ = this.stepResult.z
    this.body.resolve(this.stepResult, this.currentHeight)
    if (Math.hypot(this.stepResult.x - beforeResolveX, this.stepResult.z - beforeResolveZ) > this.radius * 0.5) return false
    if (this.body.contactCeiling) return false
    return this.findGround(this.stepResult, this.beforeMove.y, lift, GROUND_PROBE, false)
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
      if (!this.body.probeDown(this.ray, rayLength)) continue
      const point = this.body.probePoint
      const normalY = Math.abs(this.body.probeNormal.y)
      // Slopes are handled continuously by capsule push-out. Snapping to the
      // floor beside or beneath one would pull the player off the ramp.
      if (flatOnly && normalY >= this.slopeY && normalY < 0.95) return false
      if (normalY < (flatOnly ? 0.95 : this.slopeY)) continue
      if (point.y < referenceY - maxDrop - SKIN || point.y > referenceY + maxRise + SKIN) continue
      if (point.y <= bestY) continue

      this.probeResult.copy(position)
      this.probeResult.y = point.y + SKIN
      if (this.body.penetrates(this.probeResult, this.currentHeight, 2e-3)) continue
      bestY = point.y
    }
    if (bestY === -Infinity) return false
    position.y = bestY + SKIN
    return true
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

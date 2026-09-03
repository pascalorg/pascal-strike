import {
  Box3,
  DoubleSide,
  Line3,
  Ray,
  Vector3,
  type Mesh,
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
import {
  buildDynamicColliders,
  registeredDynamicColliders,
  type DynamicCollider,
} from './dynamic-colliders'

export type CharacterControllerOptions = Partial<typeof PLAYER> & {
  onFellOut?: () => void
}

const EPSILON = 1e-5
const SKIN = 1e-4
const GROUND_PROBE = 0.08
/** Below this a step-up is not worth attempting (and the ground snap covers it anyway). */
const MIN_STEP_LIFT = 0.05
/** Bisection steps when the full step lift does not fit: 0.46 m / 2^6 ≈ 7 mm of resolution. */
const LIFT_BISECTIONS = 6
/** Headroom left under a ceiling-limited lift: the step is rejected if the head touches it. */
const LIFT_MARGIN = 0.01

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
  private castMode: 'resolve' | 'test' | 'lift' = 'resolve'
  private castTolerance = SKIN
  private castCorrected = false
  private castPenetrating = false
  private castPosition: Vector3 = this.state.position
  /** Non-null while the shapecast runs in a dynamic mesh's local space. */
  private castEntry: DynamicCollider | null = null
  /** Capsule radius in the space of the current cast (scaled for a dynamic mesh). */
  private castRadius: number

  private dynamicMeshes: readonly Mesh[] | null = null
  private dynamics: DynamicCollider[] = []

  private readonly capsule = new Line3()
  private readonly capsuleBounds = new Box3()
  /** The same capsule in world space; the dynamic pass derives its local copy from it. */
  private readonly castStart = new Vector3()
  private readonly castEnd = new Vector3()
  private readonly trianglePoint = new Vector3()
  private readonly capsulePoint = new Vector3()
  private readonly correction = new Vector3()
  private readonly worldCorrection = new Vector3()
  private readonly worldPoint = new Vector3()
  private readonly worldNormal = new Vector3()
  private readonly midpoint = new Vector3()
  private readonly triangleNormal = new Vector3()
  private readonly wish = new Vector3()
  private readonly desiredHorizontal = new Vector3()
  private readonly beforeMove = new Vector3()
  private readonly regularResult = new Vector3()
  private readonly stepResult = new Vector3()
  private readonly probeResult = new Vector3()
  private readonly probePoint = new Vector3()
  private readonly probeNormal = new Vector3()
  private readonly hitPoint = new Vector3()
  private readonly hitNormal = new Vector3()
  private readonly ray = new Ray()
  private readonly groundProbeOffsets = [0, 0.5, 0.99, -0.5, -0.99]
  private readonly shapecastCallbacks = {
    intersectsBounds: (box: Box3) => box.intersectsBox(this.capsuleBounds),
    intersectsTriangle: (triangle: ExtendedTriangle) => this.castTriangle(triangle),
  }

  constructor(collider: StaticCollider, options: CharacterControllerOptions) {
    const config = { ...PLAYER, ...options }
    this.radius = config.radius
    this.castRadius = config.radius
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
    // Whoever built this collider may have registered the map's moving leaves against it.
    const registered = registeredDynamicColliders(collider.geometry)
    if (registered) this.setDynamicColliders(registered)
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
    this.dynamicMeshes = meshes
    this.dynamics = buildDynamicColliders(meshes)
  }

  update(dt: number, input: MoveInput, yaw: number, speedScale = 1): void {
    if (!(dt > 0)) return
    dt = Math.min(dt, 0.05)

    this.refreshDynamics()
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

  /** Once per fixed step: a leaf that swung since the last one is a different obstacle. */
  private refreshDynamics(): void {
    const source = this.dynamicMeshes
    if (source && source.length !== this.dynamics.length) this.setDynamicColliders(source)
    for (let index = 0; index < this.dynamics.length; index++) this.dynamics[index]!.refresh()
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
    const lift = this.availableLift(this.beforeMove, this.currentHeight, this.stepHeight + 0.01)
    if (lift < MIN_STEP_LIFT) return false
    this.stepResult.copy(this.beforeMove)
    this.stepResult.y += lift
    this.stepResult.x += this.desiredHorizontal.x
    this.stepResult.z += this.desiredHorizontal.z

    const beforeResolveX = this.stepResult.x
    const beforeResolveZ = this.stepResult.z
    this.resolveCapsule(this.stepResult, this.currentHeight)
    if (Math.hypot(this.stepResult.x - beforeResolveX, this.stepResult.z - beforeResolveZ) > this.radius * 0.5) return false
    if (this.contactCeiling) return false
    return this.findGround(this.stepResult, this.beforeMove.y, lift, GROUND_PROBE, false)
  }

  /**
   * How far the capsule may rise before its head meets something, up to `maxLift`.
   *
   * Asking only for "is the whole step lift free?" makes low ceilings forbid *every* step: a
   * Pascal storey is 2.48 m, a standing player 1.75 m, so from the first 0.30 m stair tread the
   * 0.46 m sweep pokes 3 cm into the ceiling and the staircase becomes unclimbable (jumping,
   * which skips this, still worked — exactly what was reported). A 0.25 m riser only needs
   * 0.25 m of headroom, so take as much of the lift as there is: the swept volume grows with
   * the lift, so the test is monotone and a short bisection finds the largest one that fits.
   */
  private availableLift(position: Vector3, height: number, maxLift: number): number {
    if (this.hasLiftClearance(position, height, maxLift)) return maxLift
    let free = 0
    let blocked = maxLift
    for (let i = 0; i < LIFT_BISECTIONS; i++) {
      const middle = (free + blocked) * 0.5
      if (this.hasLiftClearance(position, height, middle)) free = middle
      else blocked = middle
    }
    // Stop short of the ceiling: a lifted capsule that touches it counts as a ceiling contact
    // and the step is thrown away again.
    return Math.max(0, free - LIFT_MARGIN)
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
      if (!this.probeDown(rayLength)) continue
      const normalY = Math.abs(this.probeNormal.y)
      // Slopes are handled continuously by capsule push-out. Snapping to the
      // floor beside or beneath one would pull the player off the ramp.
      if (flatOnly && normalY >= this.slopeY && normalY < 0.95) return false
      if (normalY < (flatOnly ? 0.95 : this.slopeY)) continue
      if (this.probePoint.y < referenceY - maxDrop - SKIN || this.probePoint.y > referenceY + maxRise + SKIN) continue
      if (this.probePoint.y <= bestY) continue

      this.probeResult.copy(position)
      this.probeResult.y = this.probePoint.y + SKIN
      if (this.hasPenetration(this.probeResult, this.currentHeight, 2e-3)) continue
      bestY = this.probePoint.y
    }
    if (bestY === -Infinity) return false
    position.y = bestY + SKIN
    return true
  }

  /**
   * Nearest hit of `this.ray` (pointing down) within `rayLength`, static geometry and moving
   * leaves together, into `probePoint` / `probeNormal`. Standing on an open sash is ground too.
   */
  private probeDown(rayLength: number): boolean {
    let found = false
    const hit = this.bvh.raycastFirst(this.ray, DoubleSide, 0, rayLength)
    if (hit?.face) {
      this.probePoint.copy(hit.point)
      this.probeNormal.copy(hit.face.normal)
      found = true
    }
    for (let index = 0; index < this.dynamics.length; index++) {
      const entry = this.dynamics[index]!
      if (!this.ray.intersectsBox(entry.worldBox)) continue
      if (!entry.raycast(this.ray, rayLength, this.hitPoint, this.hitNormal)) continue
      // The ray points down, so the nearest hit is the highest one.
      if (found && this.hitPoint.y <= this.probePoint.y) continue
      this.probePoint.copy(this.hitPoint)
      this.probeNormal.copy(this.hitNormal)
      found = true
    }
    return found
  }

  private setCapsuleSegment(position: Vector3, height: number): void {
    this.castStart.set(position.x, position.y + this.radius, position.z)
    this.castEnd.set(position.x, position.y + height - this.radius, position.z)
  }

  private setCapsuleBounds(radius: number): void {
    this.capsuleBounds.makeEmpty()
    this.capsuleBounds.expandByPoint(this.capsule.start)
    this.capsuleBounds.expandByPoint(this.capsule.end)
    this.capsuleBounds.min.addScalar(-radius)
    this.capsuleBounds.max.addScalar(radius)
  }

  /**
   * Runs the world capsule (`castStart`..`castEnd`) against the static BVH and then against
   * every moving leaf whose world AABB it overlaps — each in that leaf's own local space, which
   * is where its BVH lives. In `resolve` mode every push-out keeps all three capsules in step.
   */
  private castCapsule(mode: 'resolve' | 'test' | 'lift'): void {
    this.castMode = mode
    this.castEntry = null
    this.castRadius = this.radius
    this.capsule.start.copy(this.castStart)
    this.capsule.end.copy(this.castEnd)
    this.setCapsuleBounds(this.radius)
    this.bvh.shapecast(this.shapecastCallbacks)
    if (mode !== 'resolve' && this.castPenetrating) return

    for (let index = 0; index < this.dynamics.length; index++) {
      const entry = this.dynamics[index]!
      this.capsule.start.copy(this.castStart)
      this.capsule.end.copy(this.castEnd)
      this.setCapsuleBounds(this.radius)
      if (!entry.worldBox.intersectsBox(this.capsuleBounds)) continue
      entry.toLocalSegment(this.castStart, this.castEnd, this.capsule)
      this.castEntry = entry
      this.castRadius = this.radius * entry.inverseScale
      this.setCapsuleBounds(this.castRadius)
      entry.bvh.shapecast(this.shapecastCallbacks)
      if (mode !== 'resolve' && this.castPenetrating) break
    }
    this.castEntry = null
    this.castRadius = this.radius
  }

  private hasPenetration(position: Vector3, height: number, tolerance = SKIN): boolean {
    this.setCapsuleSegment(position, height)
    this.castTolerance = tolerance
    this.castPenetrating = false
    this.castCapsule('test')
    return this.castPenetrating
  }

  private hasLiftClearance(position: Vector3, height: number, lift: number): boolean {
    // Sweeping the capsule's top sphere covers precisely the new volume entered
    // by an upward translation, without treating the floor or current wall
    // contacts as blockers.
    const topY = position.y + height - this.radius
    this.castStart.set(position.x, topY, position.z)
    this.castEnd.set(position.x, topY + lift, position.z)
    this.castTolerance = 2e-3
    this.castPenetrating = false
    this.castCapsule('lift')
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
      this.setCapsuleSegment(position, height)
      this.castCorrected = false
      this.castCapsule('resolve')
      if (!this.castCorrected) break
    }
  }

  private castTriangle(triangle: ExtendedTriangle): boolean {
    const entry = this.castEntry
    const toWorld = entry ? entry.scale : 1
    const distance = triangle.closestPointToSegment(
      this.capsule,
      this.trianglePoint,
      this.capsulePoint,
    )
    if (distance >= this.castRadius - this.castTolerance / toWorld) return false
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
    if (this.castMode === 'lift') {
      // Only what is *above* the head stops a lift. A stair handrail brushing the side of the
      // capsule is pushed away by the normal resolve pass; letting it veto the step would
      // strand a crouched player halfway up a flight.
      if (entry) entry.toWorldVector(this.correction, this.worldCorrection).normalize()
      else this.worldCorrection.copy(this.correction)
      if (this.worldCorrection.y < -0.5) this.castPenetrating = true
      return this.castPenetrating
    }
    this.correction.multiplyScalar(this.castRadius - distance + SKIN / toWorld)
    if (entry) entry.toWorldVector(this.correction, this.worldCorrection)
    else this.worldCorrection.copy(this.correction)

    const depth = this.worldCorrection.length()
    const normalY = depth > EPSILON ? this.worldCorrection.y / depth : 0
    if (normalY > this.slopeY) this.contactGround = true
    else if (normalY < -0.5) this.contactCeiling = true
    else {
      this.contactWall = true
      triangle.getNormal(this.triangleNormal)
      if (entry) {
        entry.toWorldVector(this.triangleNormal, this.worldNormal).normalize()
        entry.toWorldPoint(this.trianglePoint, this.worldPoint)
      } else {
        this.worldNormal.copy(this.triangleNormal)
        this.worldPoint.copy(this.trianglePoint)
      }
      if (Math.abs(this.worldNormal.y) < 0.25
        && this.worldPoint.y <= this.castPosition.y + this.stepHeight + SKIN) {
        this.stepBlocked = true
      }
    }
    this.castPosition.add(this.worldCorrection)
    this.castStart.add(this.worldCorrection)
    this.castEnd.add(this.worldCorrection)
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

/**
 * The capsule ↔ world half of the character controller (W1-B, extended by W4-E).
 *
 * Everything here answers one of three questions about a capsule standing at some position:
 * *where does the world push it* (`resolve`), *is it inside anything* (`penetrates`,
 * `availableLift`) and *what is under it* (`probeDown`). `controller.ts` owns the movement on
 * top of that.
 *
 * Two worlds are tested at once: the map's baked static BVH, in world space, and the openables'
 * moving leaves, each in its own local space (see `dynamic-colliders.ts`) — the capsule is
 * pushed into the leaf's space, the shapecast runs there, and the push-out comes back out.
 */
import { Box3, DoubleSide, Line3, Ray, Vector3, type Mesh } from 'three'
import type { ExtendedTriangle, MeshBVH } from 'three-mesh-bvh'
import './bvh-setup'
import { buildDynamicColliders, type DynamicCollider } from './dynamic-colliders'

const EPSILON = 1e-5
export const SKIN = 1e-4
/**
 * How close to the capsule something may already be and still count as "already touching" for
 * the head sweep. A stair handrail 2 cm off the shoulder is resolved by the push-out in the
 * same frame; letting it veto the step-up strands the player against it.
 */
const LIFT_CONTACT_SLACK = 0.02

export interface CapsuleBodyOptions {
  radius: number
  /** cos(maxSlopeDeg): a contact steeper than this is a wall, not ground. */
  slopeY: number
  /** Only used to classify a wall contact as "a step could clear this". */
  stepHeight: number
}

export class CapsuleBody {
  readonly radius: number

  /** Filled in by `resolve`. */
  contactGround = false
  contactCeiling = false
  contactWall = false
  /** A wall contact low enough that a step-up could get over it. */
  stepBlocked = false

  /** Filled in by `probeDown`. */
  readonly probePoint = new Vector3()
  readonly probeNormal = new Vector3()

  private readonly bvh: MeshBVH
  private readonly slopeY: number
  private readonly stepHeight: number

  private castMode: 'resolve' | 'test' | 'lift' = 'resolve'
  private castTolerance = SKIN
  private castCorrected = false
  private castPenetrating = false
  private castPosition = new Vector3()
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
  private readonly hitPoint = new Vector3()
  private readonly hitNormal = new Vector3()
  private readonly shapecastCallbacks = {
    intersectsBounds: (box: Box3) => box.intersectsBox(this.capsuleBounds),
    intersectsTriangle: (triangle: ExtendedTriangle) => this.castTriangle(triangle),
  }

  constructor(bvh: MeshBVH, options: CapsuleBodyOptions) {
    this.bvh = bvh
    this.radius = options.radius
    this.castRadius = options.radius
    this.slopeY = options.slopeY
    this.stepHeight = options.stepHeight
  }

  setDynamicColliders(meshes: readonly Mesh[]): void {
    this.dynamicMeshes = meshes
    this.dynamics = buildDynamicColliders(meshes)
  }

  /** Once per fixed step: a leaf that swung since the last one is a different obstacle. */
  refresh(): void {
    const source = this.dynamicMeshes
    if (source && source.length !== this.dynamics.length) this.setDynamicColliders(source)
    for (let index = 0; index < this.dynamics.length; index++) this.dynamics[index]!.refresh()
  }

  /** Pushes `position` out of everything it overlaps and reports what it touched. */
  resolve(position: Vector3, height: number): void {
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

  penetrates(position: Vector3, height: number, tolerance = SKIN): boolean {
    this.setCapsuleSegment(position, height)
    this.castTolerance = tolerance
    this.castPenetrating = false
    this.castCapsule('test')
    return this.castPenetrating
  }

  /**
   * How far the capsule may rise before its head meets something, up to `maxLift`.
   *
   * Asking only for "is the whole step lift free?" makes low ceilings forbid *every* step: a
   * Pascal storey is 2.48 m and a standing player 1.75 m, so from the first 0.30 m stair tread
   * the 0.46 m sweep pokes 3 cm into the ceiling and the staircase becomes unclimbable
   * (jumping, which skips this, still worked — exactly what was reported). A 0.25 m riser only
   * needs 0.25 m of headroom, so take as much of the lift as there is: the swept volume grows
   * with the lift, so the test is monotone and a short bisection finds the largest that fits.
   */
  availableLift(position: Vector3, height: number, maxLift: number, bisections = 6): number {
    if (this.hasLiftClearance(position, height, maxLift)) return maxLift
    let free = 0
    let blocked = maxLift
    for (let i = 0; i < bisections; i++) {
      const middle = (free + blocked) * 0.5
      if (this.hasLiftClearance(position, height, middle)) free = middle
      else blocked = middle
    }
    // Stop a centimetre short: a lifted capsule that touches the ceiling counts as a ceiling
    // contact and the step is thrown away again.
    return Math.max(0, free - 0.01)
  }

  /**
   * Nearest hit of a downward `ray` within `rayLength`, static geometry and moving leaves
   * together, into `probePoint` / `probeNormal`. Standing on an open sash is ground too.
   */
  probeDown(ray: Ray, rayLength: number): boolean {
    let found = false
    const hit = this.bvh.raycastFirst(ray, DoubleSide, 0, rayLength)
    if (hit?.face) {
      this.probePoint.copy(hit.point)
      this.probeNormal.copy(hit.face.normal)
      found = true
    }
    for (let index = 0; index < this.dynamics.length; index++) {
      const entry = this.dynamics[index]!
      if (!ray.intersectsBox(entry.worldBox)) continue
      if (!entry.raycast(ray, rayLength, this.hitPoint, this.hitNormal)) continue
      // The ray points down, so the nearest hit is the highest one.
      if (found && this.hitPoint.y <= this.probePoint.y) continue
      this.probePoint.copy(this.hitPoint)
      this.probeNormal.copy(this.hitNormal)
      found = true
    }
    return found
  }

  private hasLiftClearance(position: Vector3, height: number, lift: number): boolean {
    // Sweeping the capsule's top sphere covers precisely the new volume entered by an upward
    // translation, without treating the floor or current wall contacts as blockers.
    const topY = position.y + height - this.radius
    this.castStart.set(position.x, topY, position.z)
    this.castEnd.set(position.x, topY + lift, position.z)
    this.castTolerance = 2e-3
    this.castPenetrating = false
    this.castCapsule('lift')
    return !this.castPenetrating
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
      // Only something the capsule is not *already* touching stops a lift: a stair handrail
      // brushing its side is the resolve pass's business, and vetoing on it would strand a
      // crouched player halfway up a flight. Judging that by the push-out direction instead
      // ("is it overhead?") is not monotone — once the sweep is long enough to straddle a
      // ceiling the push turns sideways and a *longer* lift reports itself free, which is how
      // a 0.52 m step height came to hoist the capsule into the flight above.
      triangle.closestPointToPoint(this.capsule.start, this.worldPoint)
      if (this.worldPoint.distanceTo(this.capsule.start) < this.castRadius + LIFT_CONTACT_SLACK / toWorld) {
        return false
      }
      this.castPenetrating = true
      return true
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

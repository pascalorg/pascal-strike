/**
 * The knife: a swing every `1 / fireRate` seconds while the button is held, resolved on the
 * swing's hit frame against everything inside a cone in front of the eye.
 *
 * A swing is not a ray. Players expect a blade that sweeps to connect with anything it passes
 * through, so the test is capsule-vs-cone (nearest point on the victim's capsule segment to
 * the eye, then reach and angle), gated by a `lineOfSight` check so you cannot stab through a
 * wall. The body part still comes from the narrow-phase `HitShape`s, using the same
 * ray-capsule maths the paintballs use, so a swing that lines up with a head reads as a
 * headshot.
 *
 * Backstab. Nothing extra goes on the wire: the `HitEvent` carries `weapon: 'knife'` and the
 * impact `point`, and the host decides. The rule the host should apply is
 *
 *     to = normalize(point - victim.position)   // XZ only
 *     forward = (-sin(victim.yaw), -cos(victim.yaw))
 *     if (dot(forward, to) < -0.3) damage *= WEAPONS.knife.backstabScale
 *
 * i.e. the blade landed on the victim's back half. Doing it on the host means a client cannot
 * claim a backstab it did not earn. Until `net/host.ts` implements it the knife is a flat
 * `WEAPONS.knife.damage` (60 = two swings), which is the balance the spec asks for anyway.
 */
import { Vector3 } from 'three'
import { WEAPONS } from '../config'
import type { HitEvent, HitResult, HitShape, Hittable, TeamId, WorldQuery } from '../types'
import { rayCapsuleDistance } from './projectiles'
import type { WeaponSpec } from './marker'

export interface MeleeOptions {
  ownerId: string
  team: TeamId
  /** Defaults to the `WEAPONS.knife` row. */
  spec?: WeaponSpec
  now?: () => number
}

export interface MeleeUpdate {
  /** A swing started this frame: play `knifeSwing` and the view model's arc. */
  started: boolean
  /** Hits resolved on this frame's hit frame (0 or 1 in practice). */
  hits: HitEvent[]
  /** Static geometry the swing connected with — paint a smear. Null when it hit a player. */
  surface: HitResult | null
  /** Deterministic seed for the smear's shape and rotation. */
  seed: number
  /** 0..1 through the current swing, for the view model. */
  progress: number
}

export interface Melee {
  readonly swinging: boolean
  /** 0..1 through the current swing (1 = idle). */
  readonly progress: number
  /**
   * Step the swing clock. `targets` is the same hittable list the projectile sim runs
   * against; `world` gates hits on line of sight and finds the wall a miss paints.
   */
  update(
    dt: number,
    firing: boolean,
    eye: Vector3,
    direction: Vector3,
    targets: readonly Hittable[],
    world?: Pick<WorldQuery, 'raycast' | 'lineOfSight'> | null,
  ): MeleeUpdate
  setTeam(team: TeamId): void
  reset(): void
}

/** Where in the swing the blade is out front. The animation is built around the same number. */
export const HIT_FRAME_SECONDS = 0.12
/** How long the arc-and-return animation lasts. */
export const SWING_SECONDS = 0.32

const _closest = new Vector3()
const _toTarget = new Vector3()
const _point = new Vector3()
const _normal = new Vector3()
const _segment = new Vector3()
const _delta = new Vector3()

export function createMelee(options: MeleeOptions): Melee {
  const spec = options.spec ?? (WEAPONS.knife as WeaponSpec)
  const range = spec.range ?? 1.7
  const cosCone = Math.cos((spec.coneDeg ?? 25) * Math.PI / 180)
  const period = 1 / spec.fireRate
  let team = options.team
  let cooldown = 0
  let swingTime = SWING_SECONDS
  let pending = false
  let counter = 0
  const hits: HitEvent[] = []
  const result: MeleeUpdate = {
    started: false,
    hits,
    surface: null,
    seed: 0,
    progress: 1,
  }

  /** Nearest enemy whose capsule falls inside the reach cone, or null. */
  function pick(eye: Vector3, direction: Vector3, targets: readonly Hittable[],
    world?: Pick<WorldQuery, 'raycast' | 'lineOfSight'> | null): Hittable | null {
    let best: Hittable | null = null
    let bestDistance = Infinity
    for (const target of targets) {
      if (!target.alive || target.team === team || target.id === options.ownerId) continue
      closestPointOnSegment(target.capsuleStart, target.capsuleEnd, eye, _closest)
      _toTarget.subVectors(_closest, eye)
      const centreDistance = _toTarget.length()
      const surfaceDistance = centreDistance - target.capsuleRadius
      if (surfaceDistance > range || centreDistance < 1e-5) continue
      if (_toTarget.dot(direction) / centreDistance < cosCone) continue
      if (world && !world.lineOfSight(eye, _closest)) continue
      if (surfaceDistance < bestDistance) {
        bestDistance = surfaceDistance
        best = target
      }
    }
    return best
  }

  /** Which body part the blade landed on, and where. Falls back to the coarse capsule. */
  function resolvePart(target: Hittable, eye: Vector3, direction: Vector3): HitEvent {
    const reach = range + target.capsuleRadius
    let best: HitShape | null = null
    let bestDistance = Infinity
    let bestRay = -1
    for (const shape of target.shapes ?? []) {
      // First choice: a shape the look direction actually passes through.
      const rayDistance = rayCapsuleDistance(eye, direction, reach, shape.start, shape.end, shape.radius)
      if (rayDistance !== null && rayDistance < bestDistance) {
        bestDistance = rayDistance
        bestRay = rayDistance
        best = shape
      }
    }
    if (!best) {
      // A wide swing can connect without the crosshair being on a shape: take the shape
      // whose surface is nearest the eye instead.
      for (const shape of target.shapes ?? []) {
        closestPointOnSegment(shape.start, shape.end, eye, _closest)
        const distance = _closest.distanceTo(eye) - shape.radius
        if (distance < bestDistance) {
          bestDistance = distance
          bestRay = -1
          best = shape
        }
      }
    }
    if (bestRay >= 0) _point.copy(eye).addScaledVector(direction, bestRay)
    else if (best) {
      closestPointOnSegment(best.start, best.end, eye, _closest)
      _point.copy(_closest).addScaledVector(_toTarget.subVectors(eye, _closest).normalize(), best.radius)
    } else {
      closestPointOnSegment(target.capsuleStart, target.capsuleEnd, eye, _closest)
      _point.copy(_closest).addScaledVector(_toTarget.subVectors(eye, _closest).normalize(), target.capsuleRadius)
    }
    if (best) closestPointOnSegment(best.start, best.end, _point, _closest)
    else closestPointOnSegment(target.capsuleStart, target.capsuleEnd, _point, _closest)
    _normal.subVectors(_point, _closest)
    if (_normal.lengthSq() < 1e-8) _normal.copy(direction).negate()
    else _normal.normalize()
    return {
      shotId: `${options.ownerId}:knife:${counter}`,
      by: options.ownerId,
      target: target.id,
      point: [_point.x, _point.y, _point.z],
      normal: [_normal.x, _normal.y, _normal.z],
      part: best?.part ?? 'torso',
      weapon: 'knife',
    }
  }

  return {
    get swinging() { return swingTime < SWING_SECONDS },
    get progress() { return Math.min(1, swingTime / SWING_SECONDS) },
    update(dt, firing, eye, direction, targets, world) {
      hits.length = 0
      result.started = false
      result.surface = null

      if (cooldown > 0) cooldown = Math.max(0, cooldown - dt)
      swingTime = Math.min(SWING_SECONDS, swingTime + dt)

      if (firing && cooldown === 0) {
        counter++
        cooldown = period
        swingTime = 0
        pending = true
        result.started = true
        result.seed = hashSeed(options.ownerId, counter)
      }

      if (pending && swingTime >= HIT_FRAME_SECONDS) {
        pending = false
        const victim = pick(eye, direction, targets, world)
        if (victim) hits.push(resolvePart(victim, eye, direction))
        else if (world) result.surface = world.raycast(eye, direction, range)
      }

      result.progress = Math.min(1, swingTime / SWING_SECONDS)
      return result
    },
    setTeam(value) { team = value },
    reset() {
      cooldown = 0
      swingTime = SWING_SECONDS
      pending = false
      hits.length = 0
      result.started = false
      result.surface = null
      result.progress = 1
    },
  }
}

function closestPointOnSegment(a: Vector3, b: Vector3, point: Vector3, out: Vector3): Vector3 {
  _segment.subVectors(b, a)
  const lengthSq = _segment.lengthSq()
  const t = lengthSq > 0
    ? Math.max(0, Math.min(1, _segment.dot(_delta.subVectors(point, a)) / lengthSq))
    : 0
  return out.copy(a).addScaledVector(_segment, t)
}

function hashSeed(owner: string, counter: number): number {
  let hash = (0x811c9dc5 ^ (counter * 2654435761)) >>> 0
  for (let index = 0; index < owner.length; index++) {
    hash ^= owner.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

import {
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three'
import { TEAMS, WEAPON } from '../config'
import type {
  BodyPart,
  HitEvent,
  HitResult,
  HitShape,
  Hittable,
  ShotEvent,
  TeamId,
  WorldQuery,
} from '../types'
import type { Audio } from '../engine/audio'
import type { Decals } from './decals'
import type { Effects } from './effects'

export interface SpawnOptions {
  /** Test this ball against `hittables`. True only where the shot's owner simulates it. */
  detectPlayers: boolean
  /**
   * Where the ball is *drawn* leaving from, when that is not where it is simulated from.
   *
   * A shot is aimed and resolved from the shooter's eye, but on every other screen it has to
   * come out of the barrel of the gun we can see — paint leaving someone's head reads as a bug.
   * The ball therefore flies the owner's trajectory and is only rendered offset onto the muzzle,
   * converging back onto the real line over the first `VISUAL_CONVERGE_M`. Nothing about the
   * simulation, the hits or the decal moves with it.
   */
  visualOrigin?: Vector3
}

export interface Projectiles {
  spawn(shot: ShotEvent, opts: SpawnOptions): void
  update(dt: number, hittables: Hittable[]): void
  onPlayerHit(callback: (hit: HitEvent) => void): () => void
  /**
   * Announce a hit this module did not simulate — a knife swing (`melee.ts`). Melee is
   * hit-scan and instantaneous, but it is still "a hit my client detected on my own target",
   * so it must reach the host through exactly the same validated path as a paintball.
   */
  reportHit(hit: HitEvent): void
  /**
   * A paintball crossed an unbroken glass pane. Nothing is painted on the pane (it is about to
   * shatter) and the ball flies on, so the splat lands on whatever is behind it — exactly what
   * the raycast returns once the pane is gone. The game wires this to the glass system.
   */
  onGlassHit(callback: (hit: HitResult, shot: ShotEvent) => void): () => void
  /**
   * The hittables passed to the last `update`. Melee needs the same list the projectile sim
   * runs against and the game builds it once per frame; caching the reference here keeps the
   * knife from needing its own wiring through the game orchestrator.
   */
  readonly targets: readonly Hittable[]
  readonly liveCount: number
  dispose(): void
}

interface Ball {
  active: boolean
  shot: ShotEvent | null
  detectPlayers: boolean
  position: Vector3
  velocity: Vector3
  /** Render-only displacement toward the muzzle; see `SpawnOptions.visualOrigin`. */
  visualOffset: Vector3
  travelled: number
}

const MAX_LIVE = 256
const EMPTY_TARGETS: readonly Hittable[] = []
const MAX_STEP_DISTANCE = 0.5
/** Metres of flight over which a `visualOrigin` ball slides back onto its real trajectory. */
const VISUAL_CONVERGE_M = 2.5
/**
 * Cap on that displacement. The eye-to-muzzle offset is about a metre; anything larger means the
 * avatar we read the muzzle off is stale or the wrong one, and a ball drawn metres off its own
 * path is worse than one drawn at the eye.
 */
const MAX_VISUAL_OFFSET_M = 2
/** Step past a pane before the next query, or the same pane answers again. */
const GLASS_SKIN = 1e-3
/** Panes a single sub-step may cross before we stop looking for what is behind them. */
const MAX_GLASS_PER_STEP = 4
const direction = new Vector3()
const nextPosition = new Vector3()
const segmentDelta = new Vector3()
const bulletPoint = new Vector3()
const capsulePoint = new Vector3()
const pointDelta = new Vector3()
const hitNormal = new Vector3()
const glassOrigin = new Vector3()
const instanceMatrix = new Matrix4()
const hiddenMatrix = new Matrix4().makeScale(0, 0, 0)

export function createProjectiles(
  scene: Scene,
  world: WorldQuery,
  decals: Pick<Decals, 'add'>,
  effects: Pick<Effects, 'splat'>,
  audio: Pick<Audio, 'play'>,
): Projectiles {
  const geometry = new SphereGeometry(WEAPON.projectileRadius, 6, 4)
  const meshes: Record<TeamId, InstancedMesh> = {
    a: makeInstances('a'),
    b: makeInstances('b'),
  }
  scene.add(meshes.a, meshes.b)
  const balls: Ball[] = Array.from({ length: MAX_LIVE }, () => ({
    active: false,
    shot: null,
    detectPlayers: false,
    position: new Vector3(),
    velocity: new Vector3(),
    visualOffset: new Vector3(),
    travelled: 0,
  }))
  const callbacks = new Set<(hit: HitEvent) => void>()
  const glassCallbacks = new Set<(hit: HitResult, shot: ShotEvent) => void>()
  let cursor = 0
  let liveCount = 0
  let lastTargets: readonly Hittable[] = EMPTY_TARGETS
  let playerHitTarget: Hittable | null = null
  let playerHitDistance = Infinity
  let playerHitPart: BodyPart = 'torso'
  let playerHitShape: HitShape | null = null

  function makeInstances(team: TeamId): InstancedMesh {
    const material = new MeshStandardMaterial({
      color: TEAMS[team].colorHex,
      emissive: TEAMS[team].colorHex,
      emissiveIntensity: 0.35,
    })
    const mesh = new InstancedMesh(geometry, material, MAX_LIVE)
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.frustumCulled = false
    for (let index = 0; index < MAX_LIVE; index++) mesh.setMatrixAt(index, hiddenMatrix)
    mesh.instanceMatrix.needsUpdate = true
    return mesh
  }

  function deactivate(ball: Ball): void {
    if (!ball.active) return
    ball.active = false
    ball.shot = null
    liveCount--
  }

  function collidePlayers(ball: Ball, hittables: Hittable[], maxDistance: number): void {
    const shot = ball.shot!
    playerHitTarget = null
    playerHitDistance = Infinity
    playerHitPart = 'torso'
    playerHitShape = null
    for (const target of hittables) {
      if (!target.alive || target.team === shot.team || target.id === shot.by) continue
      const distance = rayCapsuleDistance(
        ball.position,
        direction,
        maxDistance,
        target.capsuleStart,
        target.capsuleEnd,
        target.capsuleRadius + WEAPON.projectileRadius,
      )
      if (distance !== null && distance < playerHitDistance) {
        playerHitTarget = target
        playerHitDistance = distance
      }
    }
    if (playerHitTarget) narrowPhase(playerHitTarget, ball.position, maxDistance)
  }

  /**
   * Which body part the coarse capsule hit. The capsule stays the broad phase (it is what the
   * host validates against and it forgives network jitter), so a shot that clips the capsule
   * without touching a shape still counts — as a torso hit, per types.ts.
   */
  function narrowPhase(target: Hittable, origin: Vector3, maxDistance: number): void {
    const shapes = target.shapes
    if (!shapes || shapes.length === 0) return
    let bestDistance = Infinity
    let best: HitShape | null = null
    for (const shape of shapes) {
      const distance = rayCapsuleDistance(
        origin,
        direction,
        maxDistance,
        shape.start,
        shape.end,
        shape.radius + WEAPON.projectileRadius,
      )
      if (distance !== null && distance < bestDistance) {
        bestDistance = distance
        best = shape
      }
    }
    if (!best) return
    playerHitPart = best.part
    playerHitShape = best
    // Refine the impact to the shape that was actually struck: the splat has to land on the
    // head, not on the capsule wall a hand's width in front of it.
    playerHitDistance = bestDistance
  }

  return {
    spawn(shot, opts) {
      let ball: Ball | undefined
      for (let offset = 0; offset < MAX_LIVE; offset++) {
        const candidate = balls[(cursor + offset) % MAX_LIVE]
        if (!candidate.active) {
          ball = candidate
          cursor = (cursor + offset + 1) % MAX_LIVE
          break
        }
      }
      if (!ball) {
        ball = balls[cursor]
        cursor = (cursor + 1) % MAX_LIVE
      } else {
        liveCount++
      }
      ball.active = true
      ball.shot = shot
      ball.detectPlayers = opts.detectPlayers
      ball.position.fromArray(shot.origin)
      ball.velocity.fromArray(shot.dir).normalize().multiplyScalar(shot.speed)
      ball.travelled = 0
      if (opts.visualOrigin) {
        ball.visualOffset.subVectors(opts.visualOrigin, ball.position)
        const offset = ball.visualOffset.length()
        if (offset > MAX_VISUAL_OFFSET_M) ball.visualOffset.multiplyScalar(MAX_VISUAL_OFFSET_M / offset)
      } else {
        ball.visualOffset.set(0, 0, 0)
      }
    },
    update(dt, hittables) {
      lastTargets = hittables
      for (const ball of balls) {
        if (!ball.active || !ball.shot) continue
        let remaining = Math.max(0, dt)
        while (remaining > 1e-8 && ball.active) {
          const speed = ball.velocity.length()
          const rangeLeft = WEAPON.maxRange - ball.travelled
          if (rangeLeft <= 0) {
            deactivate(ball)
            break
          }
          const subDt = Math.min(remaining, MAX_STEP_DISTANCE / Math.max(speed, 1), rangeLeft / Math.max(speed, 1))
          nextPosition.copy(ball.position).addScaledVector(ball.velocity, subDt)
          segmentDelta.subVectors(nextPosition, ball.position)
          const distance = segmentDelta.length()
          if (distance <= 1e-10) break
          direction.copy(segmentDelta).multiplyScalar(1 / distance)
          // Glass is transparent to a paintball in flight: report it, then keep looking for
          // the surface behind it inside the same sub-step.
          let staticHit = world.raycast(ball.position, direction, distance)
          let glassOffset = 0
          for (let pane = 0; staticHit && staticHit.kind === 'glass' && pane < MAX_GLASS_PER_STEP; pane++) {
            for (const callback of glassCallbacks) callback(staticHit, ball.shot)
            glassOffset += staticHit.distance + GLASS_SKIN
            const beyond = distance - glassOffset
            if (beyond <= 0) {
              staticHit = null
              break
            }
            glassOrigin.copy(ball.position).addScaledVector(direction, glassOffset)
            staticHit = world.raycast(glassOrigin, direction, beyond)
          }
          // Distances behind a pane are measured from the pane, not from the ball.
          const staticDistance = staticHit ? staticHit.distance + glassOffset : Infinity
          if (ball.detectPlayers) collidePlayers(ball, hittables, distance)
          else playerHitTarget = null

          if (playerHitTarget && playerHitDistance < staticDistance) {
            const target = playerHitTarget
            const shape = playerHitShape
            bulletPoint.copy(ball.position).addScaledVector(direction, playerHitDistance)
            if (shape) closestPointOnSegment(shape.start, shape.end, bulletPoint, capsulePoint)
            else closestPointOnSegment(target.capsuleStart, target.capsuleEnd, bulletPoint, capsulePoint)
            hitNormal.subVectors(bulletPoint, capsulePoint)
            if (hitNormal.lengthSq() < 1e-8) hitNormal.copy(direction).negate()
            else hitNormal.normalize()
            const event: HitEvent = {
              shotId: ball.shot.id,
              by: ball.shot.by,
              target: target.id,
              point: [bulletPoint.x, bulletPoint.y, bulletPoint.z],
              normal: [hitNormal.x, hitNormal.y, hitNormal.z],
              part: playerHitPart,
              weapon: ball.shot.weapon,
            }
            for (const callback of callbacks) callback(event)
            audio.play('hitConfirm')
            deactivate(ball)
            break
          }

          if (staticHit) {
            decals.add(
              staticHit.object as Parameters<Decals['add']>[0],
              staticHit.point,
              staticHit.normal,
              ball.shot.team,
              ball.shot.seed,
            )
            effects.splat(staticHit.point, staticHit.normal, ball.shot.team)
            audio.play('splat', staticHit.point)
            deactivate(ball)
            break
          }

          ball.position.copy(nextPosition)
          ball.velocity.y -= WEAPON.projectileGravity * subDt
          ball.travelled += distance
          if (ball.travelled >= WEAPON.maxRange) deactivate(ball)
          remaining -= subDt
        }
      }

      let indexA = 0
      let indexB = 0
      for (const ball of balls) {
        if (!ball.active || !ball.shot) continue
        // Drawn out of the barrel for the first couple of metres, then back on its own line.
        const lean = ball.travelled < VISUAL_CONVERGE_M ? 1 - ball.travelled / VISUAL_CONVERGE_M : 0
        instanceMatrix.makeTranslation(
          ball.position.x + ball.visualOffset.x * lean,
          ball.position.y + ball.visualOffset.y * lean,
          ball.position.z + ball.visualOffset.z * lean,
        )
        if (ball.shot.team === 'a') meshes.a.setMatrixAt(indexA++, instanceMatrix)
        else meshes.b.setMatrixAt(indexB++, instanceMatrix)
      }
      for (let index = indexA; index < meshes.a.count; index++) meshes.a.setMatrixAt(index, hiddenMatrix)
      for (let index = indexB; index < meshes.b.count; index++) meshes.b.setMatrixAt(index, hiddenMatrix)
      meshes.a.count = Math.max(indexA, 1)
      meshes.b.count = Math.max(indexB, 1)
      meshes.a.instanceMatrix.needsUpdate = true
      meshes.b.instanceMatrix.needsUpdate = true
    },
    onPlayerHit(callback) {
      callbacks.add(callback)
      return () => callbacks.delete(callback)
    },
    reportHit(hit) {
      for (const callback of callbacks) callback(hit)
    },
    onGlassHit(callback) {
      glassCallbacks.add(callback)
      return () => glassCallbacks.delete(callback)
    },
    get targets() { return lastTargets },
    get liveCount() { return liveCount },
    dispose() {
      lastTargets = EMPTY_TARGETS
      scene.remove(meshes.a, meshes.b)
      geometry.dispose()
      ;(meshes.a.material as MeshStandardMaterial).dispose()
      ;(meshes.b.material as MeshStandardMaterial).dispose()
      callbacks.clear()
      glassCallbacks.clear()
    },
  }
}

function closestPointOnSegment(a: Vector3, b: Vector3, point: Vector3, out: Vector3): Vector3 {
  segmentDelta.subVectors(b, a)
  const lengthSq = segmentDelta.lengthSq()
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, segmentDelta.dot(pointDelta.subVectors(point, a)) / lengthSq)) : 0
  return out.copy(a).addScaledVector(segmentDelta, t)
}

/**
 * Distance along `rayDirection` at which the ray first touches the capsule, or null past
 * `maxDistance`. Exported because the knife (`melee.ts`) picks its body part with the same
 * maths the paintballs use.
 */
export function rayCapsuleDistance(
  origin: Vector3,
  rayDirection: Vector3,
  maxDistance: number,
  start: Vector3,
  end: Vector3,
  radius: number,
): number | null {
  const bax = end.x - start.x
  const bay = end.y - start.y
  const baz = end.z - start.z
  const oax = origin.x - start.x
  const oay = origin.y - start.y
  const oaz = origin.z - start.z
  const baba = bax * bax + bay * bay + baz * baz
  // A HitShape with start === end is a sphere (the head): the capsule maths degenerates to
  // 0 === 0 there and would report a hit for any ray, so branch out before it does.
  if (baba < 1e-12) {
    const distance = raySphereDistance(origin, rayDirection, start, radius)
    return distance <= maxDistance ? distance : null
  }
  const bard = bax * rayDirection.x + bay * rayDirection.y + baz * rayDirection.z
  const baoa = bax * oax + bay * oay + baz * oaz
  const rdoa = rayDirection.x * oax + rayDirection.y * oay + rayDirection.z * oaz
  const oaoa = oax * oax + oay * oay + oaz * oaz
  const a = baba - bard * bard
  const b = baba * rdoa - baoa * bard
  const c = baba * oaoa - baoa * baoa - radius * radius * baba
  const discriminant = b * b - a * c
  if (c <= 0 && baoa >= 0 && baoa <= baba) return 0
  if (Math.abs(a) > 1e-10 && discriminant >= 0) {
    const distance = (-b - Math.sqrt(discriminant)) / a
    const height = baoa + distance * bard
    if (distance >= 0 && distance <= maxDistance && height > 0 && height < baba) return distance
  }

  let best = Infinity
  best = Math.min(best, raySphereDistance(origin, rayDirection, start, radius))
  best = Math.min(best, raySphereDistance(origin, rayDirection, end, radius))
  return best >= 0 && best <= maxDistance ? best : null
}

function raySphereDistance(origin: Vector3, rayDirection: Vector3, center: Vector3, radius: number): number {
  const ox = origin.x - center.x
  const oy = origin.y - center.y
  const oz = origin.z - center.z
  if (ox * ox + oy * oy + oz * oz <= radius * radius) return 0
  const projection = rayDirection.x * ox + rayDirection.y * oy + rayDirection.z * oz
  const discriminant = projection * projection - (ox * ox + oy * oy + oz * oz - radius * radius)
  if (discriminant < 0) return Infinity
  const near = -projection - Math.sqrt(discriminant)
  if (near >= 0) return near
  const far = -projection + Math.sqrt(discriminant)
  return far >= 0 ? far : Infinity
}

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
import type { BodyPart, HitEvent, HitShape, Hittable, ShotEvent, TeamId, WorldQuery } from '../types'
import type { Audio } from '../engine/audio'
import type { Decals } from './decals'
import type { Effects } from './effects'

export interface Projectiles {
  spawn(shot: ShotEvent, opts: { detectPlayers: boolean }): void
  update(dt: number, hittables: Hittable[]): void
  onPlayerHit(callback: (hit: HitEvent) => void): () => void
  readonly liveCount: number
  dispose(): void
}

interface Ball {
  active: boolean
  shot: ShotEvent | null
  detectPlayers: boolean
  position: Vector3
  velocity: Vector3
  travelled: number
}

const MAX_LIVE = 256
const MAX_STEP_DISTANCE = 0.5
const direction = new Vector3()
const nextPosition = new Vector3()
const segmentDelta = new Vector3()
const bulletPoint = new Vector3()
const capsulePoint = new Vector3()
const pointDelta = new Vector3()
const hitNormal = new Vector3()
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
    travelled: 0,
  }))
  const callbacks = new Set<(hit: HitEvent) => void>()
  let cursor = 0
  let liveCount = 0
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
    },
    update(dt, hittables) {
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
          const staticHit = world.raycast(ball.position, direction, distance)
          if (ball.detectPlayers) collidePlayers(ball, hittables, distance)
          else playerHitTarget = null

          if (playerHitTarget && (!staticHit || playerHitDistance < staticHit.distance)) {
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
        instanceMatrix.makeTranslation(ball.position.x, ball.position.y, ball.position.z)
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
    get liveCount() { return liveCount },
    dispose() {
      scene.remove(meshes.a, meshes.b)
      geometry.dispose()
      ;(meshes.a.material as MeshStandardMaterial).dispose()
      ;(meshes.b.material as MeshStandardMaterial).dispose()
      callbacks.clear()
    },
  }
}

function closestPointOnSegment(a: Vector3, b: Vector3, point: Vector3, out: Vector3): Vector3 {
  segmentDelta.subVectors(b, a)
  const lengthSq = segmentDelta.lengthSq()
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, segmentDelta.dot(pointDelta.subVectors(point, a)) / lengthSq)) : 0
  return out.copy(a).addScaledVector(segmentDelta, t)
}

function rayCapsuleDistance(
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

/**
 * Body-part hit shapes for a standing/crouching mannequin, in world space.
 * Shared by avatars (remotes, bots) and the local player so the host and every client
 * agree on what "head" means. Sizes match player/avatar.ts (total height 1.75 m).
 */
import { Vector3 } from 'three'
import type { BodyPart, HitShape } from '../types'
import { PLAYER } from '../config'

const PARTS: BodyPart[] = ['head', 'torso', 'arm', 'arm', 'leg', 'leg']

/** Allocate the six shapes once per entity; fill them every frame with computeHitShapes. */
export function createHitShapes(): HitShape[] {
  return PARTS.map((part) => ({ part, start: new Vector3(), end: new Vector3(), radius: 0.1 }))
}

const right = new Vector3()

/**
 * @param feet   world position of the feet
 * @param yaw    facing (radians, see types.ts conventions)
 * @param crouching  crouch pose (shorter torso, lower head)
 */
export function computeHitShapes(out: HitShape[], feet: Vector3, yaw: number, crouching: boolean): HitShape[] {
  const scale = crouching ? PLAYER.crouchHeight / PLAYER.height : 1
  const headY = 1.6 * scale
  const shoulderY = 1.38 * scale
  const hipY = 0.92 * scale
  // Right-hand direction for yaw (yaw 0 looks toward -Z).
  right.set(Math.cos(yaw), 0, -Math.sin(yaw))

  const [head, torso, armL, armR, legL, legR] = out
  head.start.set(feet.x, feet.y + headY, feet.z)
  head.end.copy(head.start)
  head.radius = 0.16

  torso.start.set(feet.x, feet.y + hipY, feet.z)
  torso.end.set(feet.x, feet.y + shoulderY, feet.z)
  torso.radius = 0.2

  for (const [arm, side] of [[armL, -1], [armR, 1]] as const) {
    arm.start.set(feet.x + right.x * 0.3 * side, feet.y + shoulderY, feet.z + right.z * 0.3 * side)
    arm.end.set(feet.x + right.x * 0.32 * side, feet.y + hipY - 0.1 * scale, feet.z + right.z * 0.32 * side)
    arm.radius = 0.07
  }
  for (const [leg, side] of [[legL, -1], [legR, 1]] as const) {
    leg.start.set(feet.x + right.x * 0.12 * side, feet.y + 0.1, feet.z + right.z * 0.12 * side)
    leg.end.set(feet.x + right.x * 0.12 * side, feet.y + hipY - 0.05, feet.z + right.z * 0.12 * side)
    leg.radius = 0.1
  }
  return out
}

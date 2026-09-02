/**
 * First-person view model: the marker (weapon-model.ts) plus two gloved hands, parented to
 * the camera.
 *
 * The whole rig is authored at real-world scale and then uniformly scaled down by
 * `VIEW_SCALE` about the camera origin. A uniform scale about the eye is invisible in a
 * perspective projection (x/(-z) is unchanged), so the marker still *looks* like a 0.63 m
 * weapon held 0.72 m away — but every polygon now lives within ~0.3 m of the camera, i.e.
 * closer than any wall the 0.3 m player capsule can reach. That lets the model keep a real
 * depth buffer (the chamfered panels need one) instead of the `depthTest: false` hack, and
 * it still never clips through geometry.
 *
 * Pose offsets below are therefore in "apparent metres" — the same units the model is
 * authored in — and are multiplied by VIEW_SCALE when written to the group.
 */
import { BoxGeometry, Camera, Group, Mesh, MeshStandardMaterial, PointLight, Vector3 } from 'three'
import { TEAMS } from '../config'
import type { TeamId } from '../types'
import { createWeaponModel, type WeaponModel } from '../weapons/weapon-model'

export interface ViewModel {
  readonly object: Group
  update(dt: number, speed: number, grounded: boolean): void
  fire(): void
  reload(progress: number): void
  setTeam(team: TeamId): void
  /** Drives the paint level inside the translucent hopper. */
  setHopper(count: number, max: number): void
  /** World position of the bore exit, for muzzle effects and tracers. */
  muzzleWorld(out: Vector3): Vector3
  dispose(): void
}

/** See the module comment: apparent-metres → camera-space metres. */
const VIEW_SCALE = 0.25
/** Rest pose of the grip relative to the eye, in apparent metres. */
const REST_X = 0.3
const REST_Y = -0.32
const REST_Z = -0.72
/** Critically damped recoil spring, ~120 ms to settle (4/omega). */
const KICK_OMEGA = 33
const KICK_MAX_STEP = 1 / 300
/** Recoil impulse per shot: 3 cm back, 1 degree of muzzle rise. */
const KICK_BACK = 0.03
const KICK_PITCH = Math.PI / 180
const FLASH_MS = 0.04
/**
 * Dedicated key light for the marker. Maps are lit for the map, and the side of the marker
 * the player sees is usually the shadow side, so the white body read as grey. The range is
 * cut just past the muzzle (0.29 m at VIEW_SCALE) so it cannot spill onto the world: the
 * player capsule keeps every wall at least PLAYER.radius = 0.3 m away.
 */
const KEY_INTENSITY = 0.17
const KEY_RANGE = 0.32
/** Slight inward cant so the marker shows its flank and converges on the crosshair. */
const BASE_YAW = 0.07

export function createViewModel(camera: Camera): ViewModel {
  const root = new Group()
  root.name = 'paintball-viewmodel'
  root.scale.setScalar(VIEW_SCALE)
  root.position.set(REST_X * VIEW_SCALE, REST_Y * VIEW_SCALE, REST_Z * VIEW_SCALE)
  camera.add(root)

  const marker: WeaponModel = createWeaponModel({ team: 'a', quality: 'first' })
  root.add(marker.object)

  const key = new PointLight(0xf4f6ff, KEY_INTENSITY, KEY_RANGE, 2)
  key.position.set(0.10, 0.07, -0.02)
  camera.add(key)
  const fill = new PointLight(0xbcd2ff, KEY_INTENSITY * 0.45, KEY_RANGE, 2)
  fill.position.set(-0.02, -0.06, -0.03)
  camera.add(fill)

  // Hands: a fist, a thumb wrap and a forearm each, one shade lighter than the marker's
  // charcoal so they separate from the grip instead of merging into one dark blob.
  const glove = new MeshStandardMaterial({ color: 0x3d3f47, roughness: 0.94, metalness: 0.02 })
  const cuff = new MeshStandardMaterial({ color: 0x24252b, roughness: 0.86, metalness: 0.05 })
  const hands = new Group()
  root.add(hands)
  const geometries = [
    // Trigger hand.
    part(hands, new BoxGeometry(0.060, 0.082, 0.062), glove, [0.004, -0.080, 0.030], [-0.26, 0, 0]),
    part(hands, new BoxGeometry(0.052, 0.026, 0.040), glove, [0.002, -0.036, 0.006], [-0.10, 0, 0]),
    part(hands, new BoxGeometry(0.056, 0.030, 0.030), cuff, [0.004, -0.122, 0.056], [-0.26, 0, 0]),
    part(hands, new BoxGeometry(0.052, 0.150, 0.052), cuff, [0.010, -0.190, 0.128], [-0.62, 0, 0]),
    // Support hand on the angled foregrip.
    part(hands, new BoxGeometry(0.058, 0.076, 0.058), glove, [0.002, -0.066, -0.252], [0.40, 0, 0]),
    part(hands, new BoxGeometry(0.050, 0.026, 0.042), glove, [0.000, -0.024, -0.228], [0.16, 0, 0]),
    part(hands, new BoxGeometry(0.054, 0.030, 0.030), cuff, [0.004, -0.106, -0.288], [0.40, 0, 0]),
    part(hands, new BoxGeometry(0.050, 0.140, 0.050), cuff, [0.012, -0.150, -0.330], [0.72, 0, 0]),
  ]
  hands.traverse((object) => {
    if (object instanceof Mesh) object.renderOrder = 99
  })

  let time = 0
  let sway = 0
  let kickZ = 0
  let kickZVelocity = 0
  let kickPitch = 0
  let kickPitchVelocity = 0
  let reloadTilt = 0
  let reloadTarget = 0
  let flash = 0
  let paint = 1
  let paintTarget = 1

  return {
    object: root,
    update(dt, speed, grounded) {
      time += dt * (5 + speed)
      sway += dt
      const steps = Math.max(1, Math.ceil(dt / KICK_MAX_STEP))
      const h = dt / steps
      const stiffness = KICK_OMEGA * KICK_OMEGA
      const damping = 2 * KICK_OMEGA
      for (let i = 0; i < steps; i++) {
        kickZVelocity += (-stiffness * kickZ - damping * kickZVelocity) * h
        kickZ += kickZVelocity * h
        kickPitchVelocity += (-stiffness * kickPitch - damping * kickPitchVelocity) * h
        kickPitch += kickPitchVelocity * h
      }
      reloadTilt += (reloadTarget - reloadTilt) * Math.min(1, dt * 14)
      if (flash > 0) {
        flash = Math.max(0, flash - dt)
        marker.setFireFlash(flash / FLASH_MS)
      }
      paint += (paintTarget - paint) * Math.min(1, dt * 9)
      marker.setPaintLevel(paint)

      const bob = grounded ? Math.min(speed / 5.5, 1) : 0
      // Idle sway: two slow, out-of-phase sines so the marker breathes when standing still.
      const idleX = Math.sin(sway * 0.85) * 0.009
      const idleY = Math.cos(sway * 0.61) * 0.007
      root.position.set(
        (REST_X + idleX + Math.sin(time) * 0.008 * bob) * VIEW_SCALE,
        (REST_Y + idleY + Math.abs(Math.cos(time)) * 0.009 * bob) * VIEW_SCALE,
        (REST_Z + kickZ) * VIEW_SCALE,
      )
      root.rotation.set(
        -0.05 + kickPitch + reloadTilt + idleY * 0.5,
        BASE_YAW + idleX * 0.6,
        -0.03 - reloadTilt * 0.35 - kickZ * 1.2,
      )
      reloadTarget = 0
    },
    fire() {
      kickZ = Math.min(kickZ + KICK_BACK, KICK_BACK * 1.8)
      kickPitch = Math.min(kickPitch + KICK_PITCH, KICK_PITCH * 2)
      flash = FLASH_MS
      marker.setFireFlash(1)
    },
    reload(progress) {
      reloadTarget = Math.sin(Math.max(0, Math.min(1, progress)) * Math.PI) * 0.75
    },
    setTeam(team) {
      marker.setTeam(team)
      cuff.color.setHex(TEAMS[team].colorHex).multiplyScalar(0.22)
    },
    setHopper(count, max) {
      paintTarget = max > 0 ? Math.max(0, Math.min(1, count / max)) : 0
    },
    muzzleWorld(out) {
      return marker.muzzle.getWorldPosition(out)
    },
    dispose() {
      root.removeFromParent()
      key.removeFromParent()
      fill.removeFromParent()
      key.dispose()
      fill.dispose()
      marker.dispose()
      for (const geometry of geometries) geometry.dispose()
      glove.dispose()
      cuff.dispose()
    },
  }
}

function part(
  parent: Group,
  geometry: BoxGeometry,
  material: MeshStandardMaterial,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number],
): BoxGeometry {
  const mesh = new Mesh(geometry, material)
  mesh.position.set(position[0], position[1], position[2])
  mesh.rotation.set(rotation[0], rotation[1], rotation[2])
  mesh.castShadow = false
  mesh.frustumCulled = false
  parent.add(mesh)
  return geometry
}

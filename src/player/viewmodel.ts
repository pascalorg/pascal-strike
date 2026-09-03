/**
 * First-person view model: the weapon in hand (weapon-model.ts) plus the gloved hands,
 * parented to the camera.
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
 *
 * All three weapons live in the rig at once (built on first use) and only one is visible.
 * Switching lowers what is in hand, swaps, and raises the next one; the timings match the
 * marker's `SWITCH_SECONDS` lockout, so the trigger comes back exactly when the gun is up.
 */
import { BoxGeometry, Camera, Group, Mesh, MeshStandardMaterial, PointLight, Vector3 } from 'three'
import { TEAMS } from '../config'
import type { TeamId, WeaponKind } from '../types'
import { createWeaponModel, type WeaponModel } from '../weapons/weapon-model'

export interface ViewModel {
  readonly object: Group
  /** The weapon currently in hand (already swapped halfway through a switch). */
  readonly weapon: WeaponKind
  update(dt: number, speed: number, grounded: boolean): void
  fire(): void
  /** Start the knife's arc-and-return. */
  swing(): void
  reload(progress: number): void
  /** Lower what is in hand and raise `kind`. */
  setWeapon(kind: WeaponKind): void
  setTeam(team: TeamId): void
  /** Drives the paint level inside the translucent hopper of the weapon in hand. */
  setHopper(count: number, max: number): void
  /** World position of the bore exit, for muzzle effects and tracers. */
  muzzleWorld(out: Vector3): Vector3
  dispose(): void
}

/** See the module comment: apparent-metres → camera-space metres. */
const VIEW_SCALE = 0.25
/** Critically damped recoil spring, ~120 ms to settle (4/omega). */
const KICK_OMEGA = 33
const KICK_MAX_STEP = 1 / 300
const FLASH_MS = 0.04
/** Lower the old weapon, then raise the new one — together they are marker.SWITCH_SECONDS. */
const SWITCH_DOWN = 0.2
const SWITCH_UP = 0.15
/** Knife arc, matching `melee.SWING_SECONDS` (the blade is out front at 120 ms). */
const SWING_SECONDS = 0.32
/**
 * Dedicated key light for the weapon. Maps are lit for the map, and the side of the marker
 * the player sees is usually the shadow side, so the white body read as grey. The range is
 * cut just past the muzzle (0.29 m at VIEW_SCALE) so it cannot spill onto the world: the
 * player capsule keeps every wall at least PLAYER.radius = 0.3 m away.
 */
const KEY_INTENSITY = 0.17
const KEY_RANGE = 0.32

interface Pose {
  /** Rest position of the grip relative to the eye, in apparent metres. */
  rest: readonly [number, number, number]
  /** Rest rotation; x = muzzle rise, y = inward cant, z = roll. */
  rotation: readonly [number, number, number]
  /** Recoil impulse per shot: metres back, radians of muzzle rise. */
  kickBack: number
  kickPitch: number
  /** Where the trigger hand sits for this weapon (the rifle's pose is the origin). */
  hand: readonly [number, number, number]
  /** A rifle is held with two hands; a sidearm and a blade are not. */
  supportHand: boolean
}

const POSES: Record<WeaponKind, Pose> = {
  rifle: {
    rest: [0.3, -0.32, -0.72],
    rotation: [-0.05, 0.07, -0.03],
    kickBack: 0.03,
    kickPitch: Math.PI / 180,
    hand: [0, 0, 0],
    supportHand: true,
  },
  pistol: {
    // Held closer and a touch more central: a sidearm sits in the middle of the screen.
    rest: [0.24, -0.30, -0.60],
    rotation: [-0.04, 0.10, -0.02],
    kickBack: 0.042,
    kickPitch: Math.PI / 180 * 2.1,
    hand: [0, 0.012, -0.004],
    supportHand: false,
  },
  knife: {
    // Blade up and inward, the way you actually carry a knife you mean to use.
    rest: [0.28, -0.30, -0.50],
    rotation: [-0.12, 0.26, 0.12],
    kickBack: 0,
    kickPitch: 0,
    hand: [0, 0.062, -0.020],
    supportHand: false,
  },
}

export function createViewModel(camera: Camera): ViewModel {
  const root = new Group()
  root.name = 'paintball-viewmodel'
  root.scale.setScalar(VIEW_SCALE)
  camera.add(root)

  let team: TeamId = 'a'
  let current: WeaponKind = 'rifle'
  let pose = POSES.rifle
  const models: Partial<Record<WeaponKind, WeaponModel>> = {}

  const modelFor = (kind: WeaponKind): WeaponModel => {
    let model = models[kind]
    if (!model) {
      model = createWeaponModel({ kind, team, quality: 'first' })
      model.object.visible = kind === current
      models[kind] = model
      root.add(model.object)
    }
    return model
  }
  modelFor('rifle')

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
  const triggerHand = new Group()
  const supportHand = new Group()
  hands.add(triggerHand, supportHand)
  const geometries = [
    // Trigger hand.
    part(triggerHand, new BoxGeometry(0.060, 0.082, 0.062), glove, [0.004, -0.080, 0.030], [-0.26, 0, 0]),
    part(triggerHand, new BoxGeometry(0.052, 0.026, 0.040), glove, [0.002, -0.036, 0.006], [-0.10, 0, 0]),
    part(triggerHand, new BoxGeometry(0.056, 0.030, 0.030), cuff, [0.004, -0.122, 0.056], [-0.26, 0, 0]),
    part(triggerHand, new BoxGeometry(0.052, 0.150, 0.052), cuff, [0.010, -0.190, 0.128], [-0.62, 0, 0]),
    // Support hand on the angled foregrip.
    part(supportHand, new BoxGeometry(0.058, 0.076, 0.058), glove, [0.002, -0.066, -0.252], [0.40, 0, 0]),
    part(supportHand, new BoxGeometry(0.050, 0.026, 0.042), glove, [0.000, -0.024, -0.228], [0.16, 0, 0]),
    part(supportHand, new BoxGeometry(0.054, 0.030, 0.030), cuff, [0.004, -0.106, -0.288], [0.40, 0, 0]),
    part(supportHand, new BoxGeometry(0.050, 0.140, 0.050), cuff, [0.012, -0.150, -0.330], [0.72, 0, 0]),
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
  let swingTime = SWING_SECONDS
  /** 0 = up, 1 = fully lowered. */
  let lowered = 0
  let switchPhase: 'none' | 'down' | 'up' = 'none'
  let switchTime = 0
  let pendingKind: WeaponKind | null = null

  const applyPose = (kind: WeaponKind) => {
    pose = POSES[kind]
    triggerHand.position.set(pose.hand[0], pose.hand[1], pose.hand[2])
    supportHand.visible = pose.supportHand
  }
  applyPose('rifle')

  return {
    object: root,
    get weapon() { return current },
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
        models[current]?.setFireFlash(flash / FLASH_MS)
      }
      paint += (paintTarget - paint) * Math.min(1, dt * 9)
      models[current]?.setPaintLevel(paint)

      // --- weapon switch: down, swap, up -----------------------------------
      if (switchPhase === 'down') {
        switchTime += dt
        lowered = Math.min(1, switchTime / SWITCH_DOWN)
        if (switchTime >= SWITCH_DOWN && pendingKind) {
          const next = pendingKind
          pendingKind = null
          const outgoing = models[current]
          if (outgoing) outgoing.object.visible = false
          current = next
          modelFor(next).object.visible = true
          applyPose(next)
          paint = paintTarget
          switchPhase = 'up'
          switchTime = 0
        }
      } else if (switchPhase === 'up') {
        switchTime += dt
        lowered = Math.max(0, 1 - switchTime / SWITCH_UP)
        if (switchTime >= SWITCH_UP) {
          switchPhase = 'none'
          lowered = 0
        }
      }

      // --- knife arc --------------------------------------------------------
      swingTime = Math.min(SWING_SECONDS, swingTime + dt)
      const swingT = swingTime / SWING_SECONDS
      // Wind up fast, slash through, ease back: one sine for the thrust and one for the arc.
      const swingEnvelope = swingT >= 1 ? 0 : Math.sin(Math.PI * Math.min(1, swingT * 1.15))
      const slash = swingT >= 1 ? 0 : Math.sin(Math.PI * 2 * Math.min(1, swingT)) * (1 - swingT)

      const bob = grounded ? Math.min(speed / 5.5, 1) : 0
      // Idle sway: two slow, out-of-phase sines so the marker breathes when standing still.
      const idleX = Math.sin(sway * 0.85) * 0.009
      const idleY = Math.cos(sway * 0.61) * 0.007
      root.position.set(
        (pose.rest[0] + idleX + Math.sin(time) * 0.008 * bob - slash * 0.16) * VIEW_SCALE,
        (pose.rest[1] + idleY + Math.abs(Math.cos(time)) * 0.009 * bob
          - lowered * 0.34 + swingEnvelope * 0.05) * VIEW_SCALE,
        (pose.rest[2] + kickZ - swingEnvelope * 0.13) * VIEW_SCALE,
      )
      root.rotation.set(
        pose.rotation[0] + kickPitch + reloadTilt + idleY * 0.5 + lowered * 0.9 - swingEnvelope * 0.35,
        pose.rotation[1] + idleX * 0.6 + slash * 0.5,
        pose.rotation[2] - reloadTilt * 0.35 - kickZ * 1.2 - lowered * 0.35 + slash * 1.1,
      )
      reloadTarget = 0
    },
    fire() {
      kickZ = Math.min(kickZ + pose.kickBack, pose.kickBack * 1.8)
      kickPitch = Math.min(kickPitch + pose.kickPitch, pose.kickPitch * 2)
      flash = FLASH_MS
      models[current]?.setFireFlash(1)
    },
    swing() {
      swingTime = 0
    },
    reload(progress) {
      reloadTarget = Math.sin(Math.max(0, Math.min(1, progress)) * Math.PI) * 0.75
    },
    setWeapon(kind) {
      if (kind === current && !pendingKind) return
      if (kind === pendingKind) return
      if (kind === current && pendingKind) {
        // Switched back before the swap: just come up again with what is already in hand.
        pendingKind = null
        switchPhase = 'up'
        switchTime = (1 - lowered) * SWITCH_UP
        return
      }
      modelFor(kind)
      pendingKind = kind
      switchPhase = 'down'
      switchTime = lowered * SWITCH_DOWN
    },
    setTeam(value) {
      team = value
      for (const model of Object.values(models)) model?.setTeam(value)
      cuff.color.setHex(TEAMS[value].colorHex).multiplyScalar(0.22)
    },
    setHopper(count, max) {
      // The knife has no reservoir: `max` is Infinity, and a full "hopper" reads as a clean blade.
      paintTarget = Number.isFinite(max) && max > 0 ? Math.max(0, Math.min(1, count / max)) : 1
    },
    muzzleWorld(out) {
      const model = models[current]
      return model ? model.muzzle.getWorldPosition(out) : out.setFromMatrixPosition(root.matrixWorld)
    },
    dispose() {
      root.removeFromParent()
      key.removeFromParent()
      fill.removeFromParent()
      key.dispose()
      fill.dispose()
      for (const model of Object.values(models)) model?.dispose()
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

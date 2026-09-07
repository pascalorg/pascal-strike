import { createFirstPersonArms } from '../characters/first-person'
import { readCharacter } from '../characters/catalog'
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
import { Camera, Group, PointLight, Vector3 } from 'three'
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
    rest: [0.23, -0.24, -0.56],
    rotation: [-0.03, 0.13, -0.02],
    kickBack: 0.042,
    kickPitch: Math.PI / 180 * 2.1,
    hand: [0, 0.012, -0.004],
    supportHand: false,
  },
  knife: {
    // Blade up and across the view: pointed straight down the bore a knife is just a dot.
    rest: [0.27, -0.29, -0.52],
    rotation: [0.24, 0.60, 0.12],
    kickBack: 0,
    kickPitch: 0,
    hand: [0, 0.035, -0.025],
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

  let disposed = false
  let arms: Awaited<ReturnType<typeof createFirstPersonArms>> | undefined
  void createFirstPersonArms(readCharacter()).then(value => {
    if (disposed) { value.dispose(); return }
    arms = value
    root.add(arms.object)
    applyPose(current)
  }).catch(error => console.error('[character hands]', error))

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
    if (arms) {
      arms.object.position.set(pose.hand[0], pose.hand[1], pose.hand[2])
      arms.setSupportHand(pose.supportHand)
      arms.setWeapon(kind)
    }
  }
  applyPose('rifle')

  return {
    object: root,
    get weapon() { return current },
    update(dt, speed, grounded) {
      arms?.update(dt)
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
      disposed = true
      arms?.dispose()
      root.removeFromParent()
      key.removeFromParent()
      fill.removeFromParent()
      key.dispose()
      fill.dispose()
      for (const model of Object.values(models)) model?.dispose()
    },
  }
}

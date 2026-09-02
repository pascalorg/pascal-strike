import { MathUtils, PerspectiveCamera, Vector3 } from 'three'

/** Largest stable integration step for the k=75..95 springs below. */
const SPRING_MAX_STEP = 1 / 120
/**
 * Screen shake amplitude for one shot: ~2 px at 1080p with a 75° vertical FOV
 * (75 / 1080 ≈ 0.069°/px). Small on purpose — it should read as punch, not as a hit.
 */
const SHAKE_RAD = 2 * (Math.PI / 180) * (75 / 1080)
/** Exponential time constant so the shake is gone (~2 %) after 80 ms. */
const SHAKE_TAU = 0.02
/**
 * Crouching moves the eye 0.6 m. The controller flips its height in one frame (it has to: the
 * capsule must shrink before the next collision pass), but teleporting the camera with it reads
 * as a glitch, so the eye follows exponentially — ~95 % of the way after EYE_SETTLE_MS, and
 * never past the target, which a spring would do.
 */
const EYE_SETTLE_MS = 120
const EYE_TAU = EYE_SETTLE_MS / 1000 / 3
/** Below this the lerp is over; a millimetre of eye height is worth no more frames. */
const EYE_EPSILON = 0.001

export interface FpsCamera {
  update(
    dt: number,
    feet: Vector3,
    eyeHeight: number,
    yaw: number,
    pitch: number,
    speed: number,
    grounded: boolean,
    /** Scales the view bob — walking (Shift) passes < 1 so the precise walk feels steady. */
    bobScale?: number,
  ): void
  kick(pitchRad: number, yawRad: number): void
  /** Extra screen shake, in radians of angular jitter (see SHAKE_RAD). */
  shake(radians: number): void
  landing(vy: number): void
  getLookDirection(out: Vector3): Vector3
  getEyePosition(out: Vector3): Vector3
}

export function createFpsCamera(camera: PerspectiveCamera): FpsCamera {
  let recoilPitch = 0
  let recoilYaw = 0
  let recoilPitchVelocity = 0
  let recoilYawVelocity = 0
  let bobTime = 0
  let landingDip = 0
  let landingVelocity = 0
  let shakeAmplitude = 0
  /** Lerped eye height; NaN until the first frame, which adopts whatever the caller passes. */
  let eyeHeightNow = NaN
  let shakeSeed = 0x9e3779b9
  // xorshift: cosmetic jitter that must not touch Math.random (shots are seeded elsewhere).
  const noise = (): number => {
    shakeSeed ^= shakeSeed << 13
    shakeSeed ^= shakeSeed >>> 17
    shakeSeed ^= shakeSeed << 5
    return ((shakeSeed >>> 0) / 2147483648) - 1
  }

  return {
    update(dt, feet, eyeHeight, yaw, pitch, speed, grounded, bobScale = 1) {
      const spring = 75
      const damping = 15
      // Semi-implicit Euler springs diverge past dt ~0.1 s; a frame hitch (navmesh build,
      // shader compile) once sent the camera to y = 2371 m. Sub-step with a stable h.
      const springSteps = Math.max(1, Math.ceil(dt / SPRING_MAX_STEP))
      const h = dt / springSteps
      for (let i = 0; i < springSteps; i++) {
        recoilPitchVelocity += (-spring * recoilPitch - damping * recoilPitchVelocity) * h
        recoilYawVelocity += (-spring * recoilYaw - damping * recoilYawVelocity) * h
        recoilPitch += recoilPitchVelocity * h
        recoilYaw += recoilYawVelocity * h

        landingVelocity += (-95 * landingDip - 18 * landingVelocity) * h
        landingDip += landingVelocity * h
      }
      shakeAmplitude *= Math.exp(-dt / SHAKE_TAU)
      if (shakeAmplitude < SHAKE_RAD * 0.02) shakeAmplitude = 0
      if (grounded && speed > 0.15) bobTime += dt * (7 + speed * 1.1)

      if (Number.isNaN(eyeHeightNow)) eyeHeightNow = eyeHeight
      else if (Math.abs(eyeHeight - eyeHeightNow) < EYE_EPSILON) eyeHeightNow = eyeHeight
      else eyeHeightNow += (eyeHeight - eyeHeightNow) * (1 - Math.exp(-dt / EYE_TAU))

      const bobWeight = grounded ? MathUtils.clamp(speed / 5.5, 0, 1) * bobScale : 0
      const bobY = Math.sin(bobTime * 2) * 0.012 * bobWeight
      const bobX = Math.cos(bobTime) * 0.009 * bobWeight
      camera.position.set(feet.x + bobX, feet.y + eyeHeightNow + bobY + landingDip, feet.z)
      camera.rotation.order = 'YXZ'
      camera.rotation.set(
        MathUtils.clamp(
          pitch + recoilPitch + noise() * shakeAmplitude,
          -Math.PI / 2 + 0.05,
          Math.PI / 2 - 0.05,
        ),
        yaw + recoilYaw + noise() * shakeAmplitude,
        noise() * shakeAmplitude * 0.6,
      )
      camera.updateMatrixWorld()
    },
    kick(pitchRad, yawRad) {
      recoilPitchVelocity += pitchRad * 48
      recoilYawVelocity += yawRad * 48
      shakeAmplitude = Math.min(SHAKE_RAD * 2, shakeAmplitude + SHAKE_RAD)
    },
    shake(radians) {
      shakeAmplitude = Math.min(SHAKE_RAD * 4, shakeAmplitude + radians)
    },
    landing(vy) {
      landingVelocity -= MathUtils.clamp(Math.abs(vy) * 0.018, 0.025, 0.13)
    },
    getLookDirection(out) {
      return camera.getWorldDirection(out)
    },
    getEyePosition(out) {
      return camera.getWorldPosition(out)
    },
  }
}

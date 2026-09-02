import { MathUtils, PerspectiveCamera, Vector3 } from 'three'

export interface FpsCamera {
  update(
    dt: number,
    feet: Vector3,
    eyeHeight: number,
    yaw: number,
    pitch: number,
    speed: number,
    grounded: boolean,
  ): void
  kick(pitchRad: number, yawRad: number): void
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

  return {
    update(dt, feet, eyeHeight, yaw, pitch, speed, grounded) {
      const spring = 75
      const damping = 15
      recoilPitchVelocity += (-spring * recoilPitch - damping * recoilPitchVelocity) * dt
      recoilYawVelocity += (-spring * recoilYaw - damping * recoilYawVelocity) * dt
      recoilPitch += recoilPitchVelocity * dt
      recoilYaw += recoilYawVelocity * dt

      landingVelocity += (-95 * landingDip - 18 * landingVelocity) * dt
      landingDip += landingVelocity * dt
      if (grounded && speed > 0.15) bobTime += dt * (7 + speed * 1.1)

      const bobWeight = grounded ? MathUtils.clamp(speed / 5.5, 0, 1) : 0
      const bobY = Math.sin(bobTime * 2) * 0.012 * bobWeight
      const bobX = Math.cos(bobTime) * 0.009 * bobWeight
      camera.position.set(feet.x + bobX, feet.y + eyeHeight + bobY + landingDip, feet.z)
      camera.rotation.order = 'YXZ'
      camera.rotation.set(
        MathUtils.clamp(pitch + recoilPitch, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05),
        yaw + recoilYaw,
        0,
      )
      camera.updateMatrixWorld()
    },
    kick(pitchRad, yawRad) {
      recoilPitchVelocity += pitchRad * 48
      recoilYawVelocity += yawRad * 48
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

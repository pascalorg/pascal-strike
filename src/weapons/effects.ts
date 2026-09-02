import {
  AdditiveBlending,
  CylinderGeometry,
  DataTexture,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  RGBAFormat,
  Scene,
  Sprite,
  SpriteMaterial,
  UnsignedByteType,
  Vector3,
} from 'three'
import { TEAMS } from '../config'
import type { TeamId } from '../types'

export interface EffectsCallbacks {
  hitMarker?: () => void
  damageVignette?: (team: TeamId) => void
}

export interface Effects {
  muzzle(position: Vector3, direction: Vector3, team: TeamId): void
  /** Thin additive streak from `origin` along `direction`; alive for ~2 frames. */
  tracer(origin: Vector3, direction: Vector3, team: TeamId): void
  splat(position: Vector3, normal: Vector3, team: TeamId): void
  hitMarker(): void
  damage(team: TeamId): void
  update(dt: number): void
  dispose(): void
}

interface Particle {
  sprite: Sprite
  velocity: Vector3
  life: number
  maxLife: number
  gravity: number
  /** Sprites that stand in for a muzzle flash shrink instead of growing. */
  flash: boolean
}

interface Tracer {
  mesh: Mesh
  material: MeshBasicMaterial
  life: number
}

const PARTICLE_COUNT = 96
const TRACER_COUNT = 10
/** Metres of streak drawn behind the ball. */
const TRACER_LENGTH = 1.5
const TRACER_LIFE = 0.05
const TRACER_START = 0.12
/** Puff spawns this far down the bore: a sprite sitting on the eye fills the whole screen. */
const MUZZLE_STANDOFF = 0.12
const scratchPoint = new Vector3()
const UP = new Vector3(0, 1, 0)
const tangent = new Vector3()
const bitangent = new Vector3()
const scratchDirection = new Vector3()
const scratchQuaternion = new Quaternion()

export function createEffects(scene: Scene, callbacks: EffectsCallbacks = {}): Effects {
  const texture = makeSoftTexture()
  const particles: Particle[] = []
  for (let index = 0; index < PARTICLE_COUNT; index++) {
    const material = new SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })
    const sprite = new Sprite(material)
    sprite.visible = false
    scene.add(sprite)
    particles.push({ sprite, velocity: new Vector3(), life: 0, maxLife: 0, gravity: 0, flash: false })
  }

  // One tapered cylinder per live tracer, base at the muzzle, tip 1.5 m downrange.
  const tracerGeometry = new CylinderGeometry(0.002, 0.007, 1, 6, 1, true)
  tracerGeometry.translate(0, 0.5, 0)
  const tracers: Tracer[] = []
  for (let index = 0; index < TRACER_COUNT; index++) {
    const material = new MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    })
    const mesh = new Mesh(tracerGeometry, material)
    mesh.visible = false
    mesh.frustumCulled = false
    mesh.renderOrder = 5
    scene.add(mesh)
    tracers.push({ mesh, material, life: 0 })
  }
  let tracerCursor = 0

  let cursor = 0
  let randomState = 0x6d2b79f5
  const random = () => {
    randomState = Math.imul(randomState ^ randomState >>> 15, randomState | 1)
    return ((randomState ^ randomState >>> 13) >>> 0) / 4294967296
  }
  const nextParticle = () => {
    const particle = particles[cursor]
    cursor = (cursor + 1) % particles.length
    return particle
  }
  const launch = (
    particle: Particle,
    position: Vector3,
    velocity: Vector3,
    team: TeamId,
    life: number,
    size: number,
    gravity: number,
    flash = false,
  ) => {
    particle.sprite.position.copy(position)
    particle.sprite.scale.setScalar(size)
    ;(particle.sprite.material as SpriteMaterial).color.setHex(TEAMS[team].colorHex)
    ;(particle.sprite.material as SpriteMaterial).opacity = flash ? 1 : 0.85
    particle.sprite.visible = true
    particle.velocity.copy(velocity)
    particle.life = particle.maxLife = life
    particle.gravity = gravity
    particle.flash = flash
  }

  const effects: Effects = {
    muzzle(position, direction, team) {
      scratchDirection.copy(direction).normalize()
      tangent.set(0, 1, 0).cross(scratchDirection)
      if (tangent.lengthSq() < 1e-5) tangent.set(1, 0, 0)
      else tangent.normalize()
      bitangent.crossVectors(scratchDirection, tangent).normalize()
      // One bright, short-lived core so the shot reads even in daylight. Kept small: the
      // caller's `position` can be a hand's length from the eye, and an additive sprite that
      // close fills the screen.
      scratchPoint.copy(position).addScaledVector(scratchDirection, MUZZLE_STANDOFF)
      const core = nextParticle()
      core.velocity.copy(scratchDirection).multiplyScalar(0.35)
      launch(core, scratchPoint, core.velocity, team, 0.045, 0.10, 0, true)
      // ...then the soft puff drifting off the muzzle.
      for (let index = 0; index < 3; index++) {
        const particle = nextParticle()
        particle.velocity.copy(scratchDirection).multiplyScalar(0.6 + random())
          .addScaledVector(tangent, (random() - 0.5) * 0.5)
          .addScaledVector(bitangent, (random() - 0.5) * 0.5)
        launch(particle, scratchPoint, particle.velocity, team, 0.16, 0.07 + random() * 0.05, 0)
      }
      effects.tracer(position, scratchDirection, team)
    },
    tracer(origin, direction, team) {
      const entry = tracers[tracerCursor]
      tracerCursor = (tracerCursor + 1) % tracers.length
      scratchDirection.copy(direction).normalize()
      // Start a little downrange: at the eye the base of the cone would smear across the
      // near plane and read as a blob on the crosshair.
      entry.mesh.position.copy(origin).addScaledVector(scratchDirection, TRACER_START)
      entry.mesh.quaternion.copy(scratchQuaternion.setFromUnitVectors(UP, scratchDirection))
      entry.mesh.scale.set(1, TRACER_LENGTH, 1)
      entry.mesh.visible = true
      entry.material.color.setHex(TEAMS[team].colorHex)
      entry.material.opacity = 0.85
      entry.life = TRACER_LIFE
    },
    splat(position, normal, team) {
      tangent.set(0, 1, 0).cross(normal)
      if (tangent.lengthSq() < 1e-5) tangent.set(1, 0, 0)
      else tangent.normalize()
      bitangent.crossVectors(normal, tangent).normalize()
      const count = 6 + Math.floor(random() * 5)
      for (let index = 0; index < count; index++) {
        const particle = nextParticle()
        particle.velocity.copy(normal).multiplyScalar(0.5 + random() * 1.7)
          .addScaledVector(tangent, (random() - 0.5) * 2)
          .addScaledVector(bitangent, (random() - 0.5) * 2)
        launch(particle, position, particle.velocity, team, 0.4, 0.025 + random() * 0.035, 5.5)
      }
    },
    hitMarker() { callbacks.hitMarker?.() },
    damage(team) { callbacks.damageVignette?.(team) },
    update(dt) {
      for (const particle of particles) {
        if (particle.life <= 0) continue
        particle.life -= dt
        if (particle.life <= 0) {
          particle.sprite.visible = false
          continue
        }
        particle.velocity.y -= particle.gravity * dt
        particle.sprite.position.addScaledVector(particle.velocity, dt)
        const alpha = particle.life / particle.maxLife
        ;(particle.sprite.material as SpriteMaterial).opacity = particle.flash ? alpha : alpha * 0.85
        particle.sprite.scale.multiplyScalar(1 + dt * (particle.flash ? -6 : 1.6))
      }
      for (const entry of tracers) {
        if (entry.life <= 0) continue
        entry.life -= dt
        if (entry.life <= 0) {
          entry.mesh.visible = false
          continue
        }
        entry.material.opacity = 0.85 * (entry.life / TRACER_LIFE)
      }
    },
    dispose() {
      for (const particle of particles) {
        scene.remove(particle.sprite)
        ;(particle.sprite.material as SpriteMaterial).dispose()
      }
      for (const entry of tracers) {
        scene.remove(entry.mesh)
        entry.material.dispose()
      }
      tracerGeometry.dispose()
      texture.dispose()
    },
  }
  return effects
}

function makeSoftTexture(): DataTexture {
  const size = 32
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size * 2 - 1
      const dy = (y + 0.5) / size * 2 - 1
      const alpha = Math.max(0, 1 - Math.hypot(dx, dy)) ** 2
      const offset = (y * size + x) * 4
      data[offset] = data[offset + 1] = data[offset + 2] = 255
      data[offset + 3] = Math.round(alpha * 255)
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType)
  texture.needsUpdate = true
  return texture
}

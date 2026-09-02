import {
  AdditiveBlending,
  DataTexture,
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
}

const PARTICLE_COUNT = 96
const tangent = new Vector3()
const bitangent = new Vector3()

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
    particles.push({ sprite, velocity: new Vector3(), life: 0, maxLife: 0, gravity: 0 })
  }
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
  ) => {
    particle.sprite.position.copy(position)
    particle.sprite.scale.setScalar(size)
    ;(particle.sprite.material as SpriteMaterial).color.setHex(TEAMS[team].colorHex)
    ;(particle.sprite.material as SpriteMaterial).opacity = 0.85
    particle.sprite.visible = true
    particle.velocity.copy(velocity)
    particle.life = particle.maxLife = life
    particle.gravity = gravity
  }

  return {
    muzzle(position, direction, team) {
      tangent.set(0, 1, 0).cross(direction)
      if (tangent.lengthSq() < 1e-5) tangent.set(1, 0, 0)
      else tangent.normalize()
      bitangent.crossVectors(direction, tangent).normalize()
      for (let index = 0; index < 3; index++) {
        const particle = nextParticle()
        particle.velocity.copy(direction).multiplyScalar(0.6 + random())
          .addScaledVector(tangent, (random() - 0.5) * 0.5)
          .addScaledVector(bitangent, (random() - 0.5) * 0.5)
        launch(particle, position, particle.velocity, team, 0.16, 0.07 + random() * 0.05, 0)
      }
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
        ;(particle.sprite.material as SpriteMaterial).opacity = alpha * 0.85
        particle.sprite.scale.multiplyScalar(1 + dt * 1.6)
      }
    },
    dispose() {
      for (const particle of particles) {
        scene.remove(particle.sprite)
        ;(particle.sprite.material as SpriteMaterial).dispose()
      }
      texture.dispose()
    },
  }
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

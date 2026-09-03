/**
 * Breakable glass (W4-A).
 *
 * A pane is a plain transparent mesh the map parser found (`MapData.breakables`). Breaking one is
 * two things: the pane stops existing for bullets and for the eye (`broken` + `visible = false`,
 * which is all `WorldQuery` and the renderer need), and a short burst of tumbling shards sells it.
 *
 * The decision itself is not taken here — the game broadcasts it and every client calls `break`
 * with the same id, so `states()` is the whole authority a late joiner has to catch up on. Ids
 * come from the GLB traversal order, so they mean the same thing on every machine.
 *
 * Shards live in one `InstancedMesh` (a pane can be shot at any time, and a per-shard mesh would
 * undo the batching work), and the sparkle is a small additive sprite pool.
 */
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Scene,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three'
import type { GlassPane, MapData } from '../types'

/** Shards per break, and how long one lives. */
const SHARDS_MIN = 10
const SHARDS_MAX = 16
const SHARD_LIFE = 0.8
/** Enough for a few panes going at once; the oldest shard is recycled beyond that. */
const MAX_SHARDS = 96
const SHARD_SIZE_MIN = 0.03
const SHARD_SIZE_MAX = 0.09
const SHARD_GRAVITY = 9.8
/** Speed away from the impact, along the shot and sideways. */
const SHARD_SPEED = 2.6
const SHARD_SPREAD = 1.7
const SHARD_SPIN = 9
/** Fraction of the life spent shrinking away. */
const SHARD_FADE = 0.35

const SPARKLE_COUNT = 4
const SPARKLE_LIFE = 0.26
const SPARKLE_SIZE = 0.55

export interface GlassSystem {
  /**
   * Shatter a pane. `impactPoint` and `dir` (the shot direction) only steer the shards. Returns
   * true when this call is what changed the state, so a caller can avoid re-broadcasting.
   */
  break(id: string, impactPoint?: Vector3, dir?: Vector3): boolean
  isBroken(id: string): boolean
  /** Ids of every broken pane — the shape the host mirrors into room state for late joiners. */
  states(): string[]
  /** Put a pane back (round reset, or a late joiner correcting itself). */
  restore(id: string): void
  /** Advance the shards. Call once per frame. */
  update(dt: number): void
  dispose(): void
}

const _matrix = new Matrix4()
const _position = new Vector3()
const _quaternion = new Quaternion()
const _scale = new Vector3()
const _axis = new Vector3()
const _dir = new Vector3()
const _side = new Vector3()
const _up = new Vector3(0, 1, 0)
const _center = new Vector3()
const _color = new Color()

interface Shard {
  position: Vector3
  velocity: Vector3
  rotation: Quaternion
  /** Tumble axis and rate (rad/s) — applied as an incremental rotation each frame. */
  spinAxis: Vector3
  spinRate: number
  size: number
  life: number
}

export function createGlassSystem(map: MapData, scene: Scene): GlassSystem {
  const panes = map.breakables ?? []
  const byId = new Map<string, GlassPane>()
  for (const pane of panes) byId.set(pane.id, pane)

  // --- shards --------------------------------------------------------------

  const shardGeometry = new PlaneGeometry(1, 1)
  const shardMaterial = new MeshStandardMaterial({
    color: 0xdbe7ef,
    roughness: 0.08,
    metalness: 0,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    // A tumbling shard shows both faces.
    side: DoubleSide,
  })
  const shards = new InstancedMesh(shardGeometry, shardMaterial, MAX_SHARDS)
  shards.name = 'glass-shards'
  shards.frustumCulled = false
  shards.castShadow = false
  shards.receiveShadow = false
  shards.renderOrder = 2
  scene.add(shards)

  const pool: Shard[] = []
  for (let i = 0; i < MAX_SHARDS; i++) {
    pool.push({
      position: new Vector3(),
      velocity: new Vector3(),
      rotation: new Quaternion(),
      spinAxis: new Vector3(0, 1, 0),
      spinRate: 0,
      size: 0,
      life: 0,
    })
    hideShard(i)
  }
  let cursor = 0
  let live = 0

  function hideShard(index: number): void {
    _matrix.makeScale(0, 0, 0)
    shards.setMatrixAt(index, _matrix)
  }

  // --- sparkle -------------------------------------------------------------

  const sparkleMaterial = new SpriteMaterial({
    map: sparkleTexture(),
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  })
  const sparkles: Sprite[] = []
  const sparkleLife: number[] = []
  for (let i = 0; i < SPARKLE_COUNT; i++) {
    const sprite = new Sprite(sparkleMaterial.clone())
    sprite.visible = false
    sprite.frustumCulled = false
    sprite.renderOrder = 3
    scene.add(sprite)
    sparkles.push(sprite)
    sparkleLife.push(0)
  }
  let sparkleCursor = 0

  // --- breaking ------------------------------------------------------------

  function spawn(pane: GlassPane, impactPoint?: Vector3, dir?: Vector3): void {
    pane.mesh.updateWorldMatrix(true, false)
    const geometry = pane.mesh.geometry
    if (!geometry.boundingSphere) geometry.computeBoundingSphere()
    const bounds = geometry.boundingSphere
    _center.copy(bounds ? bounds.center : _center.set(0, 0, 0)).applyMatrix4(pane.mesh.matrixWorld)
    const spread = bounds ? Math.min(bounds.radius, 1.2) : 0.4

    // Shards fly the way the shot was going; without a direction they fall out of the frame.
    if (dir && dir.lengthSq() > 1e-6) _dir.copy(dir).normalize()
    else _dir.set(0, 0.2, 0)
    _side.crossVectors(_dir, _up)
    if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0)
    _side.normalize()

    const origin = impactPoint ?? _center
    const count = SHARDS_MIN + Math.floor(Math.random() * (SHARDS_MAX + 1 - SHARDS_MIN))
    for (let i = 0; i < count; i++) {
      const index = cursor
      const shard = pool[index]
      if (shard.life <= 0) live++
      cursor = (cursor + 1) % MAX_SHARDS

      shard.position
        .copy(origin)
        .addScaledVector(_side, (Math.random() - 0.5) * spread)
        .addScaledVector(_up, (Math.random() - 0.5) * spread)
      shard.velocity
        .copy(_dir)
        .multiplyScalar(SHARD_SPEED * (0.4 + Math.random() * 0.9))
        .addScaledVector(_side, (Math.random() - 0.5) * SHARD_SPREAD)
        .addScaledVector(_up, Math.random() * SHARD_SPREAD * 0.6)
      shard.rotation.setFromAxisAngle(
        _axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
        Math.random() * Math.PI,
      )
      shard.spinAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
      shard.spinRate = SHARD_SPIN * (0.3 + Math.random()) * (Math.random() < 0.5 ? -1 : 1)
      shard.size = SHARD_SIZE_MIN + Math.random() * (SHARD_SIZE_MAX - SHARD_SIZE_MIN)
      shard.life = SHARD_LIFE

      // Shards take the pane's own tint so tinted glass does not rain white confetti.
      const material = pane.mesh.material
      const source = Array.isArray(material) ? material[0] : material
      _color.copy((source as MeshStandardMaterial)?.color ?? _color.setHex(0xdbe7ef))
      shards.setColorAt(index, _color)
    }
    if (shards.instanceColor) shards.instanceColor.needsUpdate = true

    const sparkle = sparkles[sparkleCursor]
    sparkleLife[sparkleCursor] = SPARKLE_LIFE
    sparkleCursor = (sparkleCursor + 1) % SPARKLE_COUNT
    sparkle.position.copy(origin)
    sparkle.scale.setScalar(SPARKLE_SIZE)
    sparkle.visible = true
  }

  return {
    break(id, impactPoint, dir) {
      const pane = byId.get(id)
      if (!pane || pane.broken) return false
      pane.broken = true
      pane.mesh.visible = false
      spawn(pane, impactPoint, dir)
      return true
    },

    isBroken(id) {
      return byId.get(id)?.broken === true
    },

    states() {
      const broken: string[] = []
      for (const pane of panes) if (pane.broken) broken.push(pane.id)
      return broken
    },

    restore(id) {
      const pane = byId.get(id)
      if (!pane || !pane.broken) return
      pane.broken = false
      pane.mesh.visible = true
    },

    update(dt) {
      if (live > 0) {
        live = 0
        for (let i = 0; i < MAX_SHARDS; i++) {
          const shard = pool[i]
          if (shard.life <= 0) continue
          shard.life -= dt
          if (shard.life <= 0) {
            hideShard(i)
            continue
          }
          live++
          shard.velocity.y -= SHARD_GRAVITY * dt
          shard.position.addScaledVector(shard.velocity, dt)
          _quaternion.setFromAxisAngle(shard.spinAxis, shard.spinRate * dt)
          shard.rotation.premultiply(_quaternion).normalize()
          const t = shard.life / SHARD_LIFE
          const scale = shard.size * (t > SHARD_FADE ? 1 : t / SHARD_FADE)
          _matrix.compose(shard.position, shard.rotation, _scale.setScalar(scale))
          shards.setMatrixAt(i, _matrix)
        }
        shards.instanceMatrix.needsUpdate = true
      }

      for (let i = 0; i < SPARKLE_COUNT; i++) {
        if (sparkleLife[i] <= 0) continue
        sparkleLife[i] -= dt
        const sprite = sparkles[i]
        if (sparkleLife[i] <= 0) {
          sprite.visible = false
          continue
        }
        const t = sparkleLife[i] / SPARKLE_LIFE
        sprite.scale.setScalar(SPARKLE_SIZE * (0.4 + t * 0.8))
        ;(sprite.material as SpriteMaterial).opacity = t
      }
    },

    dispose() {
      scene.remove(shards)
      shards.dispose()
      shardGeometry.dispose()
      shardMaterial.dispose()
      for (const sprite of sparkles) {
        scene.remove(sprite)
        ;(sprite.material as SpriteMaterial).dispose()
      }
      sparkleMaterial.map?.dispose()
      sparkleMaterial.dispose()
    },
  }
}

/** Small radial flash, drawn once into a canvas so the package stays asset-free. */
function sparkleTexture(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.35, 'rgba(214,236,255,0.55)')
  gradient.addColorStop(1, 'rgba(214,236,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 64)
  return new CanvasTexture(canvas)
}

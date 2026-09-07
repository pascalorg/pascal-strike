import { createCharacterPaint } from '../characters/paint-surface'
import {
  AdditiveBlending,
  CanvasTexture,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three'
import { defaultCharacter } from '../characters/catalog'
import { loadCharacterAsset, instantiateCharacter, type CharacterInstance } from '../characters/assets'
import { createCharacterAnimation } from '../characters/animation'
import { PLAYER, TEAMS } from '../config'
import type { CharacterSelection, HitShape, Hittable, TeamId, WeaponKind } from '../types'
import { computeHitShapes, createHitShapes } from './hitshapes'
import { getSplatTexture } from '../weapons/decals'
import { createWeaponModel, type WeaponModel } from '../weapons/weapon-model'

export interface Avatar {
  readonly object: Group
  readonly ready: Promise<void>
  setCharacter(character: CharacterSelection): void
  set(position: Vector3, yaw: number, pitch: number, crouching: boolean, speed: number, grounded?: boolean, reloading?: boolean): void
  flashHit(): void
  /** `colorHex` paints the death splat in the killer's colour; defaults to the victim's team. */
  die(colorHex?: number): void
  spawn(): void
  setInvincible(value: boolean): void
  setTeam(team: TeamId): void
  /** Mount the weapon the entity is carrying (`PlayerEntity.weapon`). No-op if unchanged. */
  setWeapon(kind: WeaponKind): void
  setName(name: string): void
  setNameTagVisible(visible: boolean): void
  /**
   * Size the name tag for a camera at `eye` and return the tag's distance in metres. The tag
   * keeps roughly the pixel height it has at `NAME_TAG_REF_DISTANCE` instead of growing into a
   * wall of text at contact range; the caller owns visibility (see `NAME_TAG_MAX_DISTANCE`).
   */
  sizeNameTagFor(eye: Vector3): number
  /**
   * Stick a paint splat on the body part nearest to `worldPoint`. The splat is projected onto
   * that part's surface (so a slightly desynced hit point still lands on the avatar) and
   * deforms with the outfit’s own skin weights. Oldest one is recycled past `MAX_SPLATS`.
   */
  addSplat(worldPoint: Vector3, worldNormal: Vector3 | null, colorHex: number): void
  /**
   * World position of the mounted weapon's muzzle, written into `out`. This is where a remote
   * shot must start: `ShotEvent.origin` is the shooter's eye, and paint leaving someone's head
   * looks like exactly that from the outside.
   */
  muzzleWorld(out: Vector3): Vector3
  /**
   * Play the firing beat: a flash on the muzzle and a kick through the arms, or a swing when
   * the shot came from a knife. `kind` overrides the mounted weapon for this one animation —
   * a shot event carries its weapon even when the entity's `w` state has not arrived.
   */
  fire(kind?: WeaponKind): void
  hittable(): Hittable
  dispose(): void
}

let avatarCounter = 0

/** Paint on a player is feedback, not decoration: enough to read "I am hit", never a blob suit. */
const MAX_SPLATS = 12
const SPLAT_MIN_SIZE = 0.18
const SPLAT_MAX_SIZE = 0.28
/** How far outside the body the surface ray starts. Longer than any limb is thick. */
const SPLAT_RAY_LENGTH = 0.9
/** A muzzle flash lasts two or three frames. */
const MUZZLE_FLASH_MS = 40

/** Height of the name tag above the avatar's feet. */
const NAME_TAG_Y = 2
/** Authored size of the tag sprite, in metres — the size it is drawn at NAME_TAG_REF_DISTANCE. */
const NAME_TAG_WIDTH = 1.5
const NAME_TAG_HEIGHT = 0.375
/**
 * A sprite with size attenuation grows as you close in, and at point-blank an enemy's name
 * covered a quarter of the screen. The tag is therefore scaled with the camera distance so it
 * holds the pixel height it has at this distance (~33 px at 1080p with the 75deg FOV) at any
 * range. Clamped at both ends: closer than a metre it may grow a little (the avatar itself is
 * culled at 0.5 m anyway), and past the hide range it stops growing altogether.
 */
const NAME_TAG_REF_DISTANCE = 8
const NAME_TAG_MIN_DISTANCE = 1
/** Beyond this a name tag is hidden: unreadable, and it gives an enemy away through a window. */
export const NAME_TAG_MAX_DISTANCE = 25

const clamp = (value: number, min: number, max: number) => (value < min ? min : value > max ? max : value)

const _surface = new Vector3()
const _normal = new Vector3()
const _segment = new Vector3()
const _toPoint = new Vector3()
const _closest = new Vector3()
const _rayOrigin = new Vector3()
const _rayDirection = new Vector3()

const splatMaterials = new Map<string, MeshStandardMaterial>()
const bodyPaintTextures = new Map<number, CanvasTexture>()

function bodyPaintTexture(variant: number): CanvasTexture {
  let texture = bodyPaintTextures.get(variant)
  if (!texture) {
    // Every border must be black: out-of-footprint UVs clamp here and remain transparent.
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 512
    canvas.getContext('2d')!.drawImage(getSplatTexture(variant).image, 16, 16, 480, 480)
    texture = new CanvasTexture(canvas)
    bodyPaintTextures.set(variant, texture)
  }
  return texture
}

function splatMaterial(colorHex: number, variant: number): MeshStandardMaterial {
  const key = `${colorHex}:${variant}`
  let material = splatMaterials.get(key)
  if (!material) {
    material = new MeshStandardMaterial({
      color: colorHex,
      alphaMap: bodyPaintTexture(variant),
      transparent: true,
      alphaTest: 0.02,
      depthWrite: false,
      roughness: 0.62,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -2,
    })
    splatMaterials.set(key, material)
  }
  return material
}

/** Squared distance from `point` to the capsule's axis, and the closest axis point. */
function closestOnShape(shape: HitShape, point: Vector3, out: Vector3): number {
  _segment.subVectors(shape.end, shape.start)
  const lengthSq = _segment.lengthSq()
  const t =
    lengthSq > 1e-12
      ? Math.max(0, Math.min(1, _segment.dot(_toPoint.subVectors(point, shape.start)) / lengthSq))
      : 0
  out.copy(shape.start).addScaledVector(_segment, t)
  return out.distanceToSquared(point)
}

export function createAvatar(initialTeam: TeamId, initialName: string, id?: string, initialCharacter: CharacterSelection | null = defaultCharacter(id)): Avatar {
  const root = new Group()
  root.name = id ?? `avatar-${++avatarCounter}`
  const body = new Group()
  body.name = 'avatar-body'
  root.add(body)

  const materials: MeshStandardMaterial[] = []
  let instance: CharacterInstance | undefined
  let animation: ReturnType<typeof createCharacterAnimation> | undefined
  let disposed = false
  let generation = 0
  let characterKey = ''
  let lastFrame = performance.now()
  let previousPosition = new Vector3()
  let hasPosition = false
  let weaponKind: WeaponKind = 'rifle'
  let weapon = createWeaponModel({ kind: weaponKind, team: initialTeam, quality: 'third' })
  const weaponHand = new Group()
  weaponHand.name = 'avatar-anchor-weapon'
  weaponHand.add(weapon.object)
  weaponHand.position.set(0.2, 1.2, -0.35)
  weaponHand.visible = false
  body.add(weaponHand)
  let paintSurface: ReturnType<typeof createCharacterPaint> | undefined

  async function setCharacter(character: CharacterSelection): Promise<void> {
    if (characterKey === character.manifestUrl) return
    characterKey = character.manifestUrl
    const version = ++generation
    root.userData.characterStatus = 'loading'
    try {
      const asset = await loadCharacterAsset(character)
      if (disposed || version !== generation) return
      clearSplats()
      weaponHand.removeFromParent()
      animation?.dispose(); instance?.dispose()
      instance = instantiateCharacter(asset)
      body.add(instance.object)
      animation = createCharacterAnimation(instance)
      materials.splice(1, materials.length - 1, ...instance.materials)
      const hand = instance.model.getObjectByName(asset.sockets.handRight.three)!
      animation.grip(hand, weaponHand.quaternion)
      // Inverse world rotation is a rig-wide calibration; parent yaw must not enter it.
      weaponHand.quaternion.multiply(root.quaternion)
      hand.add(weaponHand)
      weaponHand.position.set(0, 0.035, 0)
      // Bone scale includes authored height. Keep the marker the same size for every recipe.
      hand.updateWorldMatrix(true, false)
      hand.getWorldScale(_surface)
      weaponHand.scale.set(1 / _surface.x, 1 / _surface.y, 1 / _surface.z)
      weaponHand.visible = true
      paintSurface = createCharacterPaint(instance)
      if (!alive) animation.die()
      root.userData.characterStatus = 'ready'
      root.userData.characterId = character.id
    } catch (error) {
      if (disposed || version !== generation) return
      root.userData.characterStatus = 'error'
      console.error('[character]', error)
      if (character.manifestUrl !== defaultCharacter(id).manifestUrl) await setCharacter(defaultCharacter(id))
      else throw error
    }
  }

  const shieldMaterial = new MeshStandardMaterial({
    color: TEAMS[initialTeam].colorHex,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    blending: AdditiveBlending,
  })
  materials.push(shieldMaterial)
  const shield = new Mesh(new SphereGeometry(0.65, 16, 10), shieldMaterial)
  shield.name = 'avatar-shield'
  shield.position.y = 0.9
  shield.scale.y = 1.45
  shield.visible = false
  root.add(shield)
  const deathSplat = makeDeathSplat(initialTeam)
  deathSplat.position.set(0, 0.9, 0)
  deathSplat.visible = false
  root.add(deathSplat)

  let currentName = initialName
  let nameTagVisible = true
  let nameTagScale = 1
  let nameTag = makeNameTag(currentName, initialTeam)
  nameTag.position.set(0, NAME_TAG_Y, 0)
  root.add(nameTag)

  let team = initialTeam
  let alive = true
  let crouching = false
  let flashUntil = 0
  let deathStarted = 0
  let firedAt = -Infinity
  const capsuleStart = new Vector3()
  const capsuleEnd = new Vector3()
  const shapes = createHitShapes()
  const hittable: Hittable = {
    id: root.name,
    team,
    alive,
    capsuleStart,
    capsuleEnd,
    capsuleRadius: PLAYER.radius,
    shapes,
  }
  const splats: Mesh[] = []
  let splatCursor = 0
  let splatSeed = 1
  let fadedOut = false

  const ready = initialCharacter ? setCharacter(initialCharacter) : Promise.resolve()
  // Gameplay reports a failed default load through ready; avoid an unhandled rejection.
  void ready.catch(() => {})
  return {
    object: root,
    ready,
    setCharacter(character) { void setCharacter(character).catch(() => {}) },
    set(position, yaw, pitch, nextCrouching, speed, grounded = true, reloading = false) {
      const now = performance.now()
      const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000))
      lastFrame = now
      const backwards = hasPosition && ((position.x - previousPosition.x) * -Math.sin(yaw) + (position.z - previousPosition.z) * -Math.cos(yaw)) < -0.0001
      previousPosition.copy(position); hasPosition = true
      root.position.copy(position)
      root.rotation.y = yaw
      crouching = nextCrouching
      animation?.update(dt, speed, crouching, pitch, grounded, reloading, weaponKind, backwards)
      body.scale.y += ((crouching ? 0.95 : 1) - body.scale.y) * Math.min(1, dt * 16)
      weapon.setFireFlash(now - firedAt < MUZZLE_FLASH_MS ? 1 - (now - firedAt) / MUZZLE_FLASH_MS : 0)
      for (const material of instance?.materials ?? []) {
        material.emissive.setHex(now < flashUntil ? 0xffffff : 0x000000)
        material.emissiveIntensity = now < flashUntil ? 0.5 : 0
      }
      if (!alive) {
        const elapsed = Math.min((now - deathStarted) / 1000, 1)
        // Death01 supplies the fall; the final fade clears the respawn space.
        deathSplat.visible = true
        deathSplat.scale.setScalar(0.35 + elapsed * 1.4)
        ;(deathSplat.material as SpriteMaterial).opacity = 1 - elapsed
        for (const material of materials) {
          material.transparent = true
          material.opacity = 1 - elapsed
        }
        // Splat materials are shared between avatars, so they cannot fade with this one body:
        // drop them the moment the corpse is invisible instead of leaving paint hanging midair.
        if (elapsed >= 1 && !fadedOut) {
          fadedOut = true
          for (const splat of splats) splat.visible = false
          // The weapon model owns its materials and cannot fade with the body either.
          weapon.object.visible = false
        }
      }
      updateCapsule()
    },
    flashHit() {
      flashUntil = performance.now() + 80
      animation?.hit()
    },
    die(colorHex) {
      if (!alive) return
      alive = false
      deathStarted = performance.now()
      animation?.die()
      ;(deathSplat.material as SpriteMaterial).color.setHex(colorHex ?? TEAMS[team].colorHex)
      hittable.alive = false
    },
    spawn() {
      alive = true
      animation?.spawn()
      body.rotation.set(0, 0, 0)
      deathSplat.visible = false
      weapon.object.visible = true
      clearSplats()
      for (const material of materials) {
        material.opacity = material === shieldMaterial ? 0.18 : 1
        if (material !== shieldMaterial) material.transparent = false
      }
      hittable.alive = true
    },
    setInvincible(value) {
      shield.visible = value
    },
    setTeam(value) {
      team = value
      hittable.team = value
      weapon.setTeam(value)
      shieldMaterial.color.setHex(TEAMS[value].colorHex)
      ;(deathSplat.material as SpriteMaterial).color.setHex(TEAMS[value].colorHex)
      replaceNameTag(currentName)
    },
    setWeapon(kind) {
      if (kind === weaponKind) return
      weaponKind = kind
      weapon.dispose() // takes itself out of the hand and frees its geometries
      weapon = createWeaponModel({ kind, team, quality: 'third' })
      weapon.object.visible = alive
      weaponHand.add(weapon.object)
    },
    setName(value) {
      currentName = value
      replaceNameTag(value)
    },
    setNameTagVisible(visible) {
      nameTagVisible = visible
      nameTag.visible = visible
    },
    sizeNameTagFor(eye) {
      const dx = root.position.x - eye.x
      const dy = root.position.y + NAME_TAG_Y - eye.y
      const dz = root.position.z - eye.z
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const scale =
        clamp(distance, NAME_TAG_MIN_DISTANCE, NAME_TAG_MAX_DISTANCE) / NAME_TAG_REF_DISTANCE
      if (scale !== nameTagScale) {
        nameTagScale = scale
        nameTag.scale.set(NAME_TAG_WIDTH * scale, NAME_TAG_HEIGHT * scale, 1)
      }
      return distance
    },
    addSplat(worldPoint, worldNormal, colorHex) {
      if (!alive || !instance || !paintSurface) return
      updateCapsule()
      const index = nearestShape(worldPoint)
      const shape = shapes[index]
      closestOnShape(shape, worldPoint, _closest)
      _normal.subVectors(worldPoint, _closest)
      if (_normal.lengthSq() < 1e-8) {
        if (worldNormal && worldNormal.lengthSq() > 1e-8) _normal.copy(worldNormal).normalize()
        else _normal.set(0, 0, 1)
      } else {
        _normal.normalize()
      }
      // Walk the impact back onto the skin: fire a short ray at the body along the hit normal
      // and take the first surface it meets. That also snaps a hit point that arrived over the
      // network — computed against the shooter's view of us — onto the body we are drawing.
      root.updateWorldMatrix(false, true)
      _rayOrigin.copy(_closest).addScaledVector(_normal, SPLAT_RAY_LENGTH)
      _rayDirection.copy(_normal).negate()
      splatSeed = Math.imul(splatSeed ^ (splatSeed >>> 15), 0x2545f491) >>> 0
      const random = splatSeed / 4294967296
      const size = SPLAT_MIN_SIZE + (SPLAT_MAX_SIZE - SPLAT_MIN_SIZE) * random
      const splat = paintSurface.project(_rayOrigin, _rayDirection, SPLAT_RAY_LENGTH * 1.2, size, random * Math.PI * 2, splatMaterial(colorHex, splatSeed & 3))
      if (!splat) return
      const previous = splats[splatCursor]
      if (previous) { previous.removeFromParent(); previous.geometry.dispose() }
      splats[splatCursor] = splat
      splatCursor = (splatCursor + 1) % MAX_SPLATS
      fadedOut = false
    },
    muzzleWorld(out) {
      // Only the chain down to the muzzle node, not the whole avatar: this runs on every
      // remote shot, and the rest of the body was already updated for this frame.
      weapon.muzzle.updateWorldMatrix(true, false)
      return out.setFromMatrixPosition(weapon.muzzle.matrixWorld)
    },
    fire(kind) {
      animation?.fire(kind ?? weaponKind)
      if ((kind ?? weaponKind) !== 'knife') firedAt = performance.now()
    },
    hittable() {
      updateCapsule()
      return hittable
    },
    dispose() {
      disposed = true
      generation++
      clearSplats()
      animation?.dispose()
      weaponHand.removeFromParent()
      instance?.dispose()
      // Out of the tree before the traverse below, so its geometries are disposed once, by it.
      weapon.object.removeFromParent()
      weapon.dispose()
      root.removeFromParent()
      root.traverse((object) => {
        if (object instanceof Mesh) object.geometry.dispose()
      })
      shieldMaterial.dispose()
      disposeSprite(nameTag)
      disposeSprite(deathSplat)
    },
  }

  function replaceNameTag(value: string): void {
      const next = makeNameTag(value, team)
      next.position.copy(nameTag.position)
      next.scale.copy(nameTag.scale)
      next.visible = nameTagVisible
      root.remove(nameTag)
      disposeSprite(nameTag)
      nameTag = next
      root.add(nameTag)
  }

  function updateCapsule(): void {
    const height = crouching ? PLAYER.crouchHeight : PLAYER.height
    capsuleStart.set(root.position.x, root.position.y + PLAYER.radius, root.position.z)
    capsuleEnd.set(root.position.x, root.position.y + height - PLAYER.radius, root.position.z)
    // The narrow phase reads these every frame, so they must follow the pose, crouch included.
    computeHitShapes(shapes, root.position, root.rotation.y, crouching)
  }

  /** Nearest body part to a world point, as an index into `shapes`. */
  function nearestShape(worldPoint: Vector3): number {
    let best = 0
    let bestDistance = Infinity
    for (let index = 0; index < shapes.length; index++) {
      const shape = shapes[index]
      // Surface distance, not axis distance: a fat torso must win over a thin arm it contains.
      const distance = Math.sqrt(closestOnShape(shape, worldPoint, _closest)) - shape.radius
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    }
    return best
  }

  function clearSplats(): void {
    for (const splat of splats) { splat.removeFromParent(); splat.geometry.dispose() }
    splats.length = 0
    splatCursor = 0
    fadedOut = false
  }
}

function makeNameTag(name: string, team: TeamId): Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const context = canvas.getContext('2d')!
  context.font = '600 52px Inter, sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.lineWidth = 8
  context.strokeStyle = '#09090b'
  context.strokeText(name, 256, 64)
  context.fillStyle = TEAMS[team].color
  context.fillText(name, 256, 64)
  const texture = new CanvasTexture(canvas)
  // No depth write: the tag is a mostly transparent quad, and a quad in the depth buffer is a
  // quad in the ambient occlusion — a lighter rectangle hanging on the wall behind every name.
  const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false })
  const sprite = new Sprite(material)
  sprite.scale.set(NAME_TAG_WIDTH, NAME_TAG_HEIGHT, 1)
  return sprite
}

function makeDeathSplat(team: TeamId): Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'
  context.beginPath()
  for (let index = 0; index < 18; index++) {
    const angle = index / 18 * Math.PI * 2
    const radius = index % 3 === 0 ? 112 : 75 + (index * 17 % 28)
    const x = 128 + Math.cos(angle) * radius
    const y = 128 + Math.sin(angle) * radius
    if (index === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  }
  context.closePath()
  context.fill()
  const texture = new CanvasTexture(canvas)
  const material = new SpriteMaterial({
    map: texture,
    color: TEAMS[team].colorHex,
    transparent: true,
    depthWrite: false,
  })
  return new Sprite(material)
}

function disposeSprite(sprite: Sprite): void {
  const material = sprite.material as SpriteMaterial
  material.map?.dispose()
  material.dispose()
}

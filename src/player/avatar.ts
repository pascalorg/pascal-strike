import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  CapsuleGeometry,
  DoubleSide,
  Group,
  Mesh,
  Matrix3,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { PLAYER, TEAMS } from '../config'
import type { HitShape, Hittable, TeamId, WeaponKind } from '../types'
import { computeHitShapes, createHitShapes } from './hitshapes'
import { getSplatTexture } from '../weapons/decals'
import { createWeaponModel, type WeaponModel } from '../weapons/weapon-model'

export interface Avatar {
  readonly object: Group
  set(position: Vector3, yaw: number, pitch: number, crouching: boolean, speed: number): void
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
   * parented to it, so it follows the limb. Oldest one is recycled past `MAX_SPLATS`.
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
const SPLAT_MIN_SIZE = 0.12
const SPLAT_MAX_SIZE = 0.2
/** Lift off the body surface so the splat never z-fights with the curved limb underneath. */
const SPLAT_LIFT = 0.012
/** How far outside the body the surface ray starts. Longer than any limb is thick. */
const SPLAT_RAY_LENGTH = 0.9
/** Rest angle of both arms: reaching forward around the marker, not hanging at the sides. */
const ARM_REST = 0.8
/** How long a shot throws the arms back. Short: at 9 shots/s the kicks must not stack up. */
const FIRE_KICK_MS = 130
/** The flash on the model's own muzzle. Two or three frames, like a real one. */
const MUZZLE_FLASH_MS = 40
/** A knife swing is one arc of the whole arm — readable from across a room. */
const SWING_MS = 260

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

const _forward = new Vector3(0, 0, 1)
const _localNormal = new Vector3()
const _surface = new Vector3()
const _normal = new Vector3()
const _segment = new Vector3()
const _toPoint = new Vector3()
const _closest = new Vector3()
const _quaternion = new Quaternion()
const _inverse = new Matrix4()
const _normalMatrix = new Matrix3()
const _rayOrigin = new Vector3()
const _rayDirection = new Vector3()
const _raycaster = new Raycaster()

const splatGeometry = new PlaneGeometry(1, 1)
const splatMaterials = new Map<string, MeshStandardMaterial>()

function splatMaterial(colorHex: number, variant: number): MeshStandardMaterial {
  const key = `${colorHex}:${variant}`
  let material = splatMaterials.get(key)
  if (!material) {
    material = new MeshStandardMaterial({
      color: colorHex,
      alphaMap: getSplatTexture(variant),
      transparent: true,
      depthWrite: false,
      roughness: 0.62,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      side: DoubleSide, // a splat on a limb stays visible as the limb swings past the camera
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

export function createAvatar(initialTeam: TeamId, initialName: string, id?: string): Avatar {
  const root = new Group()
  root.name = id ?? `avatar-${++avatarCounter}`
  const body = new Group()
  root.add(body)

  const limbPairs: [Group, Mesh][] = []
  const limbMeshes: Mesh[] = []

  const teamMaterial = new MeshStandardMaterial({ color: TEAMS[initialTeam].colorHex, roughness: 0.72 })
  const limbMaterial = new MeshStandardMaterial({ color: 0x3f3f46, roughness: 0.82 })
  const visorMaterial = new MeshStandardMaterial({ color: 0x09090b, roughness: 0.25, metalness: 0.25 })
  const materials = [teamMaterial, limbMaterial, visorMaterial]

  const torsoPivot = new Group()
  torsoPivot.name = 'avatar-anchor-torso'
  torsoPivot.position.set(0, 1.1, 0)
  body.add(torsoPivot)
  const torso = part(torsoPivot, new CapsuleGeometry(0.25, 0.48, 4, 8), teamMaterial, [0, 0, 0])
  torso.name = 'avatar-body-torso'
  torso.scale.set(1, 1, 0.72)
  const headPivot = new Group()
  headPivot.name = 'avatar-anchor-head'
  headPivot.position.set(0, 1.53, 0)
  body.add(headPivot)
  const head = part(headPivot, new SphereGeometry(0.22, 10, 7), teamMaterial, [0, 0, 0])
  const visor = part(headPivot, new BoxGeometry(0.36, 0.105, 0.08), visorMaterial, [0, 0.02, -0.18])
  visor.rotation.x = -0.04
  const headMesh = mergeRigidParts(headPivot, [head, visor], 'avatar-body-head')

  const leftLeg = limb(body, -0.13, 'leg-left')
  const rightLeg = limb(body, 0.13, 'leg-right')
  const leftArm = arm(body, -0.31, 'arm-left')
  const rightArm = arm(body, 0.31, 'arm-right')
  // The marker is the real weapon model at avatar detail, held in the right hand. Its origin is
  // the grip and it fires along -Z, so the hand anchor only has to sit where the fist is.
  let weaponKind: WeaponKind = 'rifle'
  let weapon: WeaponModel = createWeaponModel({ kind: weaponKind, team: initialTeam, quality: 'third' })
  const weaponHand = new Group()
  weaponHand.name = 'avatar-anchor-weapon'
  weaponHand.position.set(-0.1, -0.44, -0.05)
  rightArm.add(weaponHand)
  weaponHand.add(weapon.object)
  // Paint sticks to these, not to the meshes: the torso mesh is squashed on Z and the limb
  // pivots are not, so an anchor per part keeps every splat round wherever it lands.
  /** Index-aligned with `createHitShapes()`: head, torso, arm L, arm R, leg L, leg R. */
  const splatAnchors: Object3D[] = [headPivot, torsoPivot, leftArm, rightArm, leftLeg, rightLeg]
  /**
   * Surfaces paint can land on, and where a splat that lands on each of them is parented. The
   * hit shapes are thinner than the meshes that draw them (torso: 0.20 vs 0.25 m), so a splat
   * placed on the shape would be buried inside the body — paint goes where the mesh actually is.
   */
  const paintMeshes: Mesh[] = [torso, headMesh, ...limbMeshes]
  const anchorByMesh = new Map<Mesh, Object3D>([
    [torso, torsoPivot],
    [headMesh, headPivot],
  ])
  for (const [pivot, mesh] of limbPairs) anchorByMesh.set(mesh, pivot)

  const shieldMaterial = new MeshStandardMaterial({
    color: TEAMS[initialTeam].colorHex,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    blending: AdditiveBlending,
  })
  materials.push(shieldMaterial)
  const shield = new Mesh(new SphereGeometry(0.65, 16, 10), shieldMaterial)
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
  let phase = 0
  let flashUntil = 0
  let deathStarted = 0
  let firedAt = -Infinity
  let swungAt = -Infinity
  let swinging = false
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

  function limb(parent: Group, x: number, name: string): Group {
    const pivot = new Group()
    pivot.name = `avatar-anchor-${name}`
    pivot.position.set(x, 0.67, 0)
    parent.add(pivot)
    const mesh = part(pivot, new CapsuleGeometry(0.105, 0.44, 4, 7), limbMaterial, [0, -0.27, 0])
    limbPairs.push([pivot, mesh])
    limbMeshes.push(mesh)
    return pivot
  }

  function arm(parent: Group, x: number, name: string): Group {
    const pivot = new Group()
    pivot.name = `avatar-anchor-${name}`
    pivot.position.set(x, 1.28, 0)
    pivot.rotation.x = -0.75
    parent.add(pivot)
    const mesh = part(pivot, new BoxGeometry(0.13, 0.52, 0.13), limbMaterial, [0, -0.23, -0.08])
    limbPairs.push([pivot, mesh])
    limbMeshes.push(mesh)
    return pivot
  }

  return {
    object: root,
    set(position, yaw, pitch, nextCrouching, speed) {
      const now = performance.now()
      root.position.copy(position)
      root.rotation.y = yaw
      crouching = nextCrouching
      phase += 0.055 * speed
      const swing = Math.sin(phase) * Math.min(speed / 5.5, 1) * 0.65
      leftLeg.rotation.x = swing
      rightLeg.rotation.x = -swing
      // Both arms reach forward around the marker (+x rotation tips the limb toward -Z, the
      // way the avatar faces); the swing only breaks the symmetry while running.
      leftArm.rotation.x = ARM_REST - swing * 0.2
      rightArm.rotation.x = ARM_REST + swing * 0.2
      // Firing: the arms rock back and ease home. Squared, so the kick is sharp and the
      // recovery soft — a linear ramp reads as a twitch.
      const sinceFire = now - firedAt
      const kick = sinceFire < FIRE_KICK_MS ? (1 - sinceFire / FIRE_KICK_MS) ** 2 : 0
      if (kick > 0) {
        rightArm.rotation.x -= kick * 0.24
        leftArm.rotation.x -= kick * 0.16
      }
      // Knife: one arc up and across, driven by the same fire event.
      const swingPhase = (now - swungAt) / SWING_MS
      if (swingPhase >= 0 && swingPhase < 1) {
        const arc = Math.sin(swingPhase * Math.PI)
        swinging = true
        rightArm.rotation.x = ARM_REST - arc * 1.5
        rightArm.rotation.z = -arc * 0.9
        leftArm.rotation.x = ARM_REST - arc * 0.3
      } else if (swinging) {
        swinging = false
        rightArm.rotation.z = 0
      }
      headPivot.rotation.x = pitch * 0.45
      body.position.y = crouching ? -0.18 : 0
      body.scale.y = crouching ? 0.78 : 1
      torsoPivot.rotation.x = Math.min(speed / 5.5, 1) * 0.08
      // Cancel the arm's own rotation so the barrel ends up pointing where the avatar looks,
      // damped like the head so a steep look does not swing the marker through the chest.
      // The hand cancels the arm's own rotation, so the kick has to be re-applied here or the
      // barrel would sit perfectly still while the elbow moves.
      weaponHand.rotation.x = clamp(pitch * 0.8, -0.6, 0.6) - rightArm.rotation.x - kick * 0.2
      weaponHand.rotation.y = Math.sin(phase * 0.5) * 0.015
      weapon.object.position.z = kick * 0.03
      weapon.setFireFlash(sinceFire < MUZZLE_FLASH_MS ? 1 - sinceFire / MUZZLE_FLASH_MS : 0)
      teamMaterial.emissive.setHex(now < flashUntil ? 0xffffff : 0x000000)
      teamMaterial.emissiveIntensity = now < flashUntil ? 1.5 : 0
      if (!alive) {
        const elapsed = Math.min((now - deathStarted) / 1000, 1)
        body.rotation.z = elapsed * Math.PI * 0.47
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
    },
    die(colorHex) {
      if (!alive) return
      alive = false
      deathStarted = performance.now()
      ;(deathSplat.material as SpriteMaterial).color.setHex(colorHex ?? TEAMS[team].colorHex)
      hittable.alive = false
    },
    spawn() {
      alive = true
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
      teamMaterial.color.setHex(TEAMS[value].colorHex)
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
      if (!alive) return
      updateCapsule()
      const index = nearestShape(worldPoint)
      const shape = shapes[index]
      let anchor = splatAnchors[index]
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
      _raycaster.set(_rayOrigin, _rayDirection.copy(_normal).negate())
      _raycaster.far = SPLAT_RAY_LENGTH * 1.2
      const surfaceHits = _raycaster.intersectObjects(paintMeshes, false)
      const surfaceHit = surfaceHits[0]
      if (surfaceHit) {
        _surface.copy(surfaceHit.point)
        anchor = anchorByMesh.get(surfaceHit.object as Mesh) ?? anchor
        if (surfaceHit.face) {
          _normalMatrix.getNormalMatrix(surfaceHit.object.matrixWorld)
          _normal.copy(surfaceHit.face.normal).applyMatrix3(_normalMatrix).normalize()
        }
      } else {
        // Nothing under the ray (a limb swung away, or a very stale point): sit just proud of
        // the hit shape, which is always a little thinner than the mesh.
        _surface.copy(_closest).addScaledVector(_normal, shape.radius * 1.3)
      }
      _surface.addScaledVector(_normal, SPLAT_LIFT)

      splatSeed = Math.imul(splatSeed ^ (splatSeed >>> 15), 0x2545f491) >>> 0
      const random = splatSeed / 4294967296
      let splat = splats[splatCursor]
      if (!splat) {
        splat = new Mesh(splatGeometry, splatMaterial(colorHex, splatSeed & 3))
        splats.push(splat)
      }
      splatCursor = (splatCursor + 1) % MAX_SPLATS
      splat.material = splatMaterial(colorHex, splatSeed & 3)
      splat.removeFromParent()
      anchor.add(splat)
      anchor.updateWorldMatrix(true, false)
      _inverse.copy(anchor.matrixWorld).invert()
      splat.position.copy(_surface).applyMatrix4(_inverse)
      _localNormal.copy(_normal).transformDirection(_inverse).normalize()
      _quaternion.setFromUnitVectors(_forward, _localNormal)
      splat.quaternion.copy(_quaternion)
      splat.rotateZ(random * Math.PI * 2)
      const size = SPLAT_MIN_SIZE + (SPLAT_MAX_SIZE - SPLAT_MIN_SIZE) * random
      splat.scale.set(size, size * (0.82 + random * 0.36), 1)
      splat.renderOrder = 12
      splat.visible = true
      fadedOut = false
    },
    muzzleWorld(out) {
      // Only the chain down to the muzzle node, not the whole avatar: this runs on every
      // remote shot, and the rest of the body was already updated for this frame.
      weapon.muzzle.updateWorldMatrix(true, false)
      return out.setFromMatrixPosition(weapon.muzzle.matrixWorld)
    },
    fire(kind) {
      if ((kind ?? weaponKind) === 'knife') swungAt = performance.now()
      else firedAt = performance.now()
    },
    hittable() {
      updateCapsule()
      return hittable
    },
    dispose() {
      clearSplats()
      // Out of the tree before the traverse below, so its geometries are disposed once, by it.
      weapon.object.removeFromParent()
      weapon.dispose()
      root.removeFromParent()
      root.traverse((object) => {
        if (object instanceof Mesh) object.geometry.dispose()
      })
      for (const material of materials) material.dispose()
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

  /** Nearest body part to a world point, as an index into `shapes` / `splatAnchors`. */
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
    for (const splat of splats) splat.removeFromParent()
    splats.length = 0
    splatCursor = 0
    fadedOut = false
  }
}

function part(
  parent: Group,
  geometry: BoxGeometry | CapsuleGeometry | SphereGeometry,
  material: MeshStandardMaterial,
  position: [number, number, number],
): Mesh {
  const mesh = new Mesh(geometry, material)
  mesh.position.fromArray(position)
  mesh.castShadow = true
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

/** Combine the materials of one rigid body-part pivot into a single grouped mesh. */
function mergeRigidParts(parent: Object3D, parts: Mesh[], name: string): Mesh {
  const batches = new Map<Material, BufferGeometry[]>()
  for (const mesh of parts) {
    if (Array.isArray(mesh.material)) throw new Error('Avatar parts must have one material')
    mesh.updateMatrix()
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrix)
    const batch = batches.get(mesh.material)
    if (batch) batch.push(geometry)
    else batches.set(mesh.material, [geometry])
  }

  const materials: Material[] = []
  const materialGeometries: BufferGeometry[] = []
  for (const [material, geometries] of batches) {
    const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false)
    if (!merged) throw new Error(`Could not merge ${name} material batch`)
    for (const geometry of geometries) if (geometry !== merged) geometry.dispose()
    materials.push(material)
    materialGeometries.push(merged)
  }

  const geometry = materialGeometries.length === 1
    ? materialGeometries[0]
    : mergeGeometries(materialGeometries, true)
  if (!geometry) throw new Error(`Could not merge ${name}`)
  for (const materialGeometry of materialGeometries) {
    if (materialGeometry !== geometry) materialGeometry.dispose()
  }
  for (const mesh of parts) {
    mesh.removeFromParent()
    mesh.geometry.dispose()
  }

  const mesh = new Mesh(geometry, materials.length === 1 ? materials[0] : materials)
  mesh.name = name
  mesh.castShadow = true
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
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

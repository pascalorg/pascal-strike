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
} from 'three'
import { PLAYER, TEAMS } from '../config'
import type { HitShape, Hittable, TeamId } from '../types'
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
  setName(name: string): void
  setNameTagVisible(visible: boolean): void
  /**
   * Stick a paint splat on the body part nearest to `worldPoint`. The splat is projected onto
   * that part's surface (so a slightly desynced hit point still lands on the avatar) and
   * parented to it, so it follows the limb. Oldest one is recycled past `MAX_SPLATS`.
   */
  addSplat(worldPoint: Vector3, worldNormal: Vector3 | null, colorHex: number): void
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

  const torso = part(body, new CapsuleGeometry(0.25, 0.48, 4, 8), teamMaterial, [0, 1.1, 0])
  torso.scale.set(1, 1, 0.72)
  const headPivot = new Group()
  headPivot.position.set(0, 1.53, 0)
  body.add(headPivot)
  const head = part(headPivot, new SphereGeometry(0.22, 10, 7), teamMaterial, [0, 0, 0])
  const visor = part(headPivot, new BoxGeometry(0.36, 0.105, 0.08), visorMaterial, [0, 0.02, -0.18])
  visor.rotation.x = -0.04

  const leftLeg = limb(body, -0.13)
  const rightLeg = limb(body, 0.13)
  const leftArm = arm(body, -0.31)
  const rightArm = arm(body, 0.31)
  // The marker is the real weapon model at avatar detail, held in the right hand. Its origin is
  // the grip and it fires along -Z, so the hand anchor only has to sit where the fist is.
  const weapon: WeaponModel = createWeaponModel({ team: initialTeam, quality: 'third' })
  const weaponHand = new Group()
  weaponHand.position.set(-0.1, -0.44, -0.05)
  rightArm.add(weaponHand)
  weaponHand.add(weapon.object)
  // Paint sticks to these, not to the meshes: the torso mesh is squashed on Z and the limb
  // pivots are not, so an anchor per part keeps every splat round wherever it lands.
  const torsoAnchor = new Group()
  torsoAnchor.position.set(0, 1.1, 0)
  body.add(torsoAnchor)
  /** Index-aligned with `createHitShapes()`: head, torso, arm L, arm R, leg L, leg R. */
  const splatAnchors: Object3D[] = [headPivot, torsoAnchor, leftArm, rightArm, leftLeg, rightLeg]
  /**
   * Surfaces paint can land on, and where a splat that lands on each of them is parented. The
   * hit shapes are thinner than the meshes that draw them (torso: 0.20 vs 0.25 m), so a splat
   * placed on the shape would be buried inside the body — paint goes where the mesh actually is.
   */
  const paintMeshes: Mesh[] = [torso, head, visor, ...limbMeshes]
  const anchorByMesh = new Map<Mesh, Object3D>([
    [torso, torsoAnchor],
    [head, headPivot],
    [visor, headPivot],
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
  let nameTag = makeNameTag(currentName, initialTeam)
  nameTag.position.set(0, 2, 0)
  root.add(nameTag)

  let team = initialTeam
  let alive = true
  let crouching = false
  let phase = 0
  let flashUntil = 0
  let deathStarted = 0
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

  function limb(parent: Group, x: number): Group {
    const pivot = new Group()
    pivot.position.set(x, 0.67, 0)
    parent.add(pivot)
    const mesh = part(pivot, new CapsuleGeometry(0.105, 0.44, 4, 7), limbMaterial, [0, -0.27, 0])
    limbPairs.push([pivot, mesh])
    limbMeshes.push(mesh)
    return pivot
  }

  function arm(parent: Group, x: number): Group {
    const pivot = new Group()
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
      headPivot.rotation.x = pitch * 0.45
      body.position.y = crouching ? -0.18 : 0
      body.scale.y = crouching ? 0.78 : 1
      torso.rotation.x = Math.min(speed / 5.5, 1) * 0.08
      // Cancel the arm's own rotation so the barrel ends up pointing where the avatar looks,
      // damped like the head so a steep look does not swing the marker through the chest.
      weaponHand.rotation.x = clamp(pitch * 0.8, -0.6, 0.6) - rightArm.rotation.x
      weaponHand.rotation.y = Math.sin(phase * 0.5) * 0.015
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
    setName(value) {
      currentName = value
      replaceNameTag(value)
    },
    setNameTagVisible(visible) {
      nameTagVisible = visible
      nameTag.visible = visible
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
  const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: true })
  const sprite = new Sprite(material)
  sprite.scale.set(1.5, 0.375, 1)
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

/**
 * Blender-authored GLBs, with the original primitive models as loading fallbacks.
 *
 * Fallback silhouette (rifle): a compact futuristic SMG blaster — matte white polymer body
 * with chamfered panels and shallow panel lines, charcoal receiver / grip / folding stock, a
 * full-length top rail with front and rear sights, an angled foregrip, a squared muzzle
 * shroud, and the team colour carried by a thin accent strip, the translucent paint hopper
 * and the muzzle ring. The pistol and the knife (`weapon-model-sidearms.ts`) speak the same
 * language with fewer words.
 *
 * Conventions
 * - Authored at real-world scale: the rifle is 0.63 m from butt plate to muzzle.
 * - Origin = the grip (top of the grip, at the trigger). +Z points BACKWARD (toward the
 *   shooter), −Z is the firing direction, so the group can be parented to the camera as-is.
 * - The chamfers are faked the cheap way: a wide/short box crossed with a narrow/tall box
 *   reads as an octagonal extrusion from every angle that matters, for two draw calls.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Matrix4,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
  type Material,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { TEAMS } from '../config'
import type { TeamId, WeaponKind } from '../types'
import { buildKnife, buildPistol } from './weapon-model-sidearms'
import { createAssetWeapon } from './weapon-assets'

export type WeaponQuality = 'first' | 'third'

export interface WeaponModelOptions {
  /** Which weapon to build; missing = rifle. */
  kind?: WeaponKind
  team: TeamId
  /** `'first'` = full detail for the view model, `'third'` = ~60 % of the parts for avatars. */
  quality: WeaponQuality
}

export interface WeaponModel {
  readonly kind: WeaponKind
  readonly ready?: Promise<void>
  readonly object: Group
  /** Empty node at the bore exit (the blade tip for the knife); effects read its world position. */
  readonly muzzle: Object3D
  /** Overall length in metres (butt plate → muzzle), for anyone mounting the model. */
  readonly length: number
  setTeam(team: TeamId): void
  /** 0 = off, 1 = full muzzle flash. */
  setFireFlash(intensity: number): void
  /** 0..1 paint remaining, drives the level inside the translucent hopper. */
  setPaintLevel(level: number): void
  dispose(): void
}

/**
 * What a builder is handed: the tracked `add` helper and the shared material set, so every
 * weapon disposes through one list and recolours through one `setTeam`.
 */
export interface ModelKit {
  detail: boolean
  add(
    parent: Object3D,
    geometry: BufferGeometry,
    material: Material,
    position: readonly [number, number, number],
    rotation?: readonly [number, number, number],
  ): Mesh
  white: MeshStandardMaterial
  whiteShade: MeshStandardMaterial
  line: MeshStandardMaterial
  charcoal: MeshStandardMaterial
  charcoalLight: MeshStandardMaterial
  black: MeshStandardMaterial
  accent: MeshStandardMaterial
  tank: MeshStandardMaterial
  paint: MeshStandardMaterial
  flashMaterial: MeshBasicMaterial
  /** Fills `group` with the additive card stack every firearm shows at its muzzle. */
  muzzleFlash(group: Group): void
}

export interface ModelBuild {
  muzzle: Object3D
  length: number
  /** Reservoir fill is the only solid part that changes transform after construction. */
  paintLevel?: Mesh
  /** 0..1 → visible paint. A weapon with no reservoir passes a no-op. */
  setPaintLevel(level: number): void
}

/** Butt plate (+Z) to muzzle (−Z). */
const MODEL_LENGTH = 0.63
/** Height of the bore line above the origin; everything on the body is built around it. */
const BORE_Y = 0.026

export function createWeaponModel(options: WeaponModelOptions): WeaponModel {
  if (typeof window !== 'undefined') return createAssetWeapon(options, () => createPrimitiveWeaponModel(options))
  return createPrimitiveWeaponModel(options)
}

/** Immediate loading/offline fallback; the Blender GLBs replace it once ready. */
function createPrimitiveWeaponModel(options: WeaponModelOptions): WeaponModel {
  const kind: WeaponKind = options.kind ?? 'rifle'
  const detail = options.quality === 'first'
  const teamHex = TEAMS[options.team].colorHex

  const geometries = new Set<BufferGeometry>()
  const materials: Material[] = []
  const track = <T extends BufferGeometry>(geometry: T): T => {
    geometries.add(geometry)
    return geometry
  }
  const use = <T extends Material>(material: T): T => {
    materials.push(material)
    return material
  }

  // --- materials -----------------------------------------------------------
  const white = use(new MeshStandardMaterial({ color: 0xe9e9ec, roughness: 0.55, metalness: 0.05 }))
  const whiteShade = use(new MeshStandardMaterial({ color: 0xd2d2d8, roughness: 0.6, metalness: 0.05 }))
  const line = use(new MeshStandardMaterial({ color: 0x9a9ba4, roughness: 0.65, metalness: 0.1 }))
  const charcoal = use(new MeshStandardMaterial({ color: 0x1f2024, roughness: 0.7, metalness: 0.28 }))
  const charcoalLight = use(new MeshStandardMaterial({ color: 0x34353c, roughness: 0.6, metalness: 0.35 }))
  const black = use(new MeshStandardMaterial({ color: 0x08080a, roughness: 0.9, metalness: 0 }))
  const accent = use(new MeshStandardMaterial({
    color: teamHex,
    emissive: teamHex,
    emissiveIntensity: 0.6,
    roughness: 0.35,
    metalness: 0.1,
  }))
  const tank = use(new MeshStandardMaterial({
    color: teamHex,
    emissive: teamHex,
    emissiveIntensity: 0.12,
    roughness: 0.14,
    metalness: 0,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: DoubleSide,
  }))
  const paint = use(new MeshStandardMaterial({
    color: teamHex,
    emissive: teamHex,
    emissiveIntensity: 0.18,
    roughness: 0.4,
    metalness: 0,
  }))
  const flashMaterial = use(new MeshBasicMaterial({
    color: teamHex,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
  }))

  const root = new Group()
  root.name = `paintball-${kind}`

  const add = (
    parent: Object3D,
    geometry: BufferGeometry,
    material: Material,
    position: readonly [number, number, number],
    rotation?: readonly [number, number, number],
  ): Mesh => {
    const mesh = new Mesh(track(geometry), material)
    mesh.position.set(position[0], position[1], position[2])
    if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2])
    mesh.castShadow = !detail
    mesh.receiveShadow = false
    mesh.frustumCulled = false
    parent.add(mesh)
    return mesh
  }

  const muzzleFlash = (group: Group): void => {
    add(group, new SphereGeometry(0.020, 10, 8), flashMaterial, [0, 0, -0.006])
    add(group, new ConeGeometry(0.026, 0.058, 12, 1, true), flashMaterial, [0, 0, -0.030], [-Math.PI / 2, 0, 0])
    add(group, new PlaneGeometry(0.115, 0.011), flashMaterial, [0, 0, -0.008], [0, 0, 0.62])
    add(group, new PlaneGeometry(0.115, 0.011), flashMaterial, [0, 0, -0.008], [0, 0, -0.62])
    add(group, new PlaneGeometry(0.048, 0.048), flashMaterial, [0, 0, -0.008], [0, 0, 0.4])
  }

  const kit: ModelKit = {
    detail,
    add,
    white,
    whiteShade,
    line,
    charcoal,
    charcoalLight,
    black,
    accent,
    tank,
    paint,
    flashMaterial,
    muzzleFlash,
  }

  const flash = new Group()
  flash.visible = false
  const build =
    kind === 'pistol' ? buildPistol(kit, root, flash)
      : kind === 'knife' ? buildKnife(kit, root, flash)
        : buildRifle(kit, root, flash)

  // Every authored primitive is rigid after construction except the reservoir fill. Baking
  // their transforms into one grouped geometry preserves the material boundaries while turning
  // dozens of scene nodes (48 on the third-person rifle) into one Mesh. The flash stays under
  // its muzzle pivot and the paint stays under its hopper pivot because both animate at runtime.
  const flashParts: Mesh[] = []
  flash.traverse((object) => {
    if (object instanceof Mesh) flashParts.push(object)
  })
  const flashPartSet = new Set(flashParts)
  const staticParts: Mesh[] = []
  root.traverse((object) => {
    if (object instanceof Mesh && object !== build.paintLevel && !flashPartSet.has(object)) {
      staticParts.push(object)
    }
  })
  mergeRigidMeshes(root, staticParts, 'weapon-static', !detail, geometries)
  mergeRigidMeshes(flash, flashParts, 'muzzle-flash', false, geometries)

  if (detail) {
    // The view model is drawn last so it never fights the world for depth, but it still
    // depth-tests against itself — the chamfer trick above only reads with a depth buffer.
    root.traverse((object) => {
      if (object instanceof Mesh) object.renderOrder = 100
    })
  }

  build.setPaintLevel(1)

  return {
    kind,
    object: root,
    muzzle: build.muzzle,
    length: build.length,
    setTeam(team) {
      const hex = TEAMS[team].colorHex
      accent.color.setHex(hex)
      accent.emissive.setHex(hex)
      tank.color.setHex(hex)
      tank.emissive.setHex(hex)
      paint.color.setHex(hex)
      paint.emissive.setHex(hex)
      flashMaterial.color.setHex(hex)
    },
    setFireFlash(intensity) {
      const clamped = intensity <= 0 ? 0 : intensity >= 1 ? 1 : intensity
      flash.visible = clamped > 0.004 && flash.children.length > 0
      if (!flash.visible) return
      flashMaterial.opacity = 0.3 + clamped * 0.7
      flash.scale.setScalar(0.6 + clamped * 0.5)
      flash.rotation.z = clamped * 5.7
    },
    setPaintLevel: build.setPaintLevel,
    dispose() {
      root.removeFromParent()
      for (const geometry of geometries) geometry.dispose()
      for (const material of materials) material.dispose()
      geometries.clear()
      materials.length = 0
    },
  }
}

/** The 0.63 m marker: the weapon every other one is a variation on. */
function buildRifle(kit: ModelKit, root: Group, flash: Group): ModelBuild {
  const { add, detail } = kit

  // --- white polymer body ---------------------------------------------------
  // Core + a taller/narrower crossing box: the pair reads as a chamfered extrusion.
  add(root, new BoxGeometry(0.070, 0.062, 0.260), kit.white, [0, BORE_Y + 0.004, -0.060])
  add(root, new BoxGeometry(0.056, 0.076, 0.255), kit.white, [0, BORE_Y + 0.004, -0.060])
  add(root, new BoxGeometry(0.052, 0.046, 0.110), kit.white, [0, BORE_Y + 0.002, -0.135])
  add(root, new BoxGeometry(0.0665, 0.012, 0.250), kit.whiteShade, [0, BORE_Y + 0.029, -0.060])
  add(root, new BoxGeometry(0.0585, 0.012, 0.132), kit.whiteShade, [0, BORE_Y + 0.025, -0.245])

  // Handguard, one step slimmer than the body so the hand has a place to sit.
  add(root, new BoxGeometry(0.062, 0.056, 0.140), kit.white, [0, BORE_Y, -0.245])
  add(root, new BoxGeometry(0.048, 0.068, 0.135), kit.white, [0, BORE_Y, -0.245])

  if (detail) {
    // Shallow panel lines: thin slivers standing 2 mm proud of each face.
    add(root, new BoxGeometry(0.0735, 0.0035, 0.170), kit.line, [0, BORE_Y - 0.016, -0.070])
    add(root, new BoxGeometry(0.0655, 0.0035, 0.100), kit.line, [0, BORE_Y - 0.014, -0.245])
    add(root, new BoxGeometry(0.0735, 0.030, 0.0035), kit.line, [0, BORE_Y + 0.004, -0.178])
    // Cooling slots on the handguard.
    for (let i = 0; i < 3; i++) {
      add(root, new BoxGeometry(0.0655, 0.007, 0.020), kit.charcoalLight, [0, BORE_Y + 0.008, -0.205 - i * 0.042])
    }
  }

  add(root, new BoxGeometry(0.050, 0.011, 0.185), kit.charcoalLight, [0, BORE_Y - 0.033, -0.152])

  // --- barrel + squared muzzle shroud --------------------------------------
  add(root, new CylinderGeometry(0.019, 0.019, 0.100, 12), kit.charcoal, [0, BORE_Y, -0.352], [Math.PI / 2, 0, 0])
  if (detail) {
    add(root, new CylinderGeometry(0.024, 0.024, 0.012, 12), kit.charcoalLight, [0, BORE_Y, -0.316], [Math.PI / 2, 0, 0])
  }
  add(root, new BoxGeometry(0.054, 0.054, 0.085), kit.white, [0, BORE_Y, -0.3875])
  if (detail) add(root, new BoxGeometry(0.042, 0.064, 0.082), kit.white, [0, BORE_Y, -0.3875])
  add(root, new BoxGeometry(0.058, 0.058, 0.014), kit.charcoal, [0, BORE_Y, -0.4230])
  add(root, new TorusGeometry(0.019, 0.005, 8, 20), kit.accent, [0, BORE_Y, -0.4295])
  if (detail) add(root, new CylinderGeometry(0.013, 0.013, 0.022, 12), kit.black, [0, BORE_Y, -0.4270], [Math.PI / 2, 0, 0])

  // --- full-length top rail -------------------------------------------------
  add(root, new BoxGeometry(0.034, 0.010, 0.475), kit.charcoal, [0, 0.066, -0.1425])
  add(root, new BoxGeometry(0.026, 0.008, 0.475), kit.charcoal, [0, 0.074, -0.1425])
  if (detail) {
    const notch = new BoxGeometry(0.030, 0.010, 0.012)
    for (let i = 0; i < 8; i++) {
      add(root, notch.clone(), kit.charcoalLight, [0, 0.079, -0.350 + i * 0.058])
    }
    notch.dispose()
  }

  // Front sight: post inside a low hood. Rear sight: blade with an aperture.
  add(root, new BoxGeometry(0.020, 0.016, 0.024), kit.charcoal, [0, 0.086, -0.300])
  add(root, new BoxGeometry(0.007, 0.026, 0.008), kit.charcoal, [0, 0.101, -0.300])
  if (detail) add(root, new BoxGeometry(0.024, 0.006, 0.010), kit.charcoal, [0, 0.115, -0.300])
  add(root, new BoxGeometry(0.026, 0.018, 0.022), kit.charcoal, [0, 0.085, 0.055])
  add(root, new BoxGeometry(0.030, 0.022, 0.008), kit.charcoal, [0, 0.098, 0.058])
  if (detail) add(root, new BoxGeometry(0.009, 0.010, 0.012), kit.black, [0, 0.100, 0.058])

  // --- charcoal receiver ----------------------------------------------------
  add(root, new BoxGeometry(0.064, 0.072, 0.115), kit.charcoal, [0, 0.024, 0.086])
  add(root, new BoxGeometry(0.050, 0.084, 0.110), kit.charcoal, [0, 0.024, 0.086])
  if (detail) {
    add(root, new BoxGeometry(0.068, 0.026, 0.060), kit.charcoalLight, [0, 0.034, 0.085])
    add(root, new BoxGeometry(0.012, 0.010, 0.050), kit.charcoalLight, [-0.036, 0.054, 0.060])
  }

  // --- grip, trigger group --------------------------------------------------
  const gripRake: readonly [number, number, number] = [-0.26, 0, 0]
  add(root, new BoxGeometry(0.046, 0.115, 0.054), kit.charcoal, [0, -0.070, 0.028], gripRake)
  add(root, new BoxGeometry(0.034, 0.118, 0.062), kit.charcoal, [0, -0.070, 0.028], gripRake)
  if (detail) add(root, new BoxGeometry(0.043, 0.070, 0.040), kit.charcoalLight, [0, -0.085, 0.032], gripRake)
  add(root, new BoxGeometry(0.050, 0.005, 0.032), kit.accent, [0, -0.026, 0.022], gripRake)
  add(root, new BoxGeometry(0.018, 0.012, 0.092), kit.charcoal, [0, -0.053, -0.004])
  add(root, new BoxGeometry(0.018, 0.034, 0.012), kit.charcoal, [0, -0.038, -0.043])
  if (detail) add(root, new BoxGeometry(0.008, 0.024, 0.008), kit.charcoalLight, [0, -0.034, -0.014], [-0.2, 0, 0])

  // --- angled foregrip ------------------------------------------------------
  const foreRake: readonly [number, number, number] = [0.40, 0, 0]
  add(root, new BoxGeometry(0.032, 0.080, 0.040), kit.charcoal, [0, -0.040, -0.245], foreRake)
  add(root, new BoxGeometry(0.024, 0.084, 0.030), kit.charcoal, [0, -0.040, -0.245], foreRake)
  if (detail) add(root, new BoxGeometry(0.035, 0.045, 0.026), kit.charcoalLight, [0, -0.062, -0.254], foreRake)

  // --- folding stock --------------------------------------------------------
  add(root, new BoxGeometry(0.024, 0.013, 0.110), kit.charcoal, [0, 0.055, 0.150])
  add(root, new BoxGeometry(0.024, 0.013, 0.100), kit.charcoal, [0, -0.006, 0.155])
  add(root, new BoxGeometry(0.030, 0.086, 0.013), kit.charcoal, [0, 0.024, 0.198])
  add(root, new CylinderGeometry(0.012, 0.012, 0.028, 12), kit.charcoalLight, [0, 0.024, 0.130], [0, 0, Math.PI / 2])
  if (detail) add(root, new BoxGeometry(0.028, 0.076, 0.005), kit.charcoalLight, [0, 0.024, 0.204])

  // --- translucent paint hopper -------------------------------------------
  // Small, canted off the sight line and cradled by a charcoal saddle so it reads as part
  // of the marker rather than a canister taped to it.
  add(root, new BoxGeometry(0.050, 0.030, 0.072), kit.charcoal, [-0.018, 0.044, -0.082], [0, 0, 0.30])
  const hopper = new Group()
  hopper.position.set(-0.038, 0.056, -0.082)
  hopper.rotation.set(-0.14, 0, 0.34)
  root.add(hopper)
  add(hopper, new CylinderGeometry(0.031, 0.028, 0.082, 18, 1, true), kit.tank, [0, 0, 0])
  const paintLevel = add(hopper, new CylinderGeometry(0.026, 0.024, 0.074, 14), kit.paint, [0, 0, 0])
  add(hopper, new CylinderGeometry(0.026, 0.032, 0.008, 18), kit.charcoal, [0, 0.045, 0])
  add(hopper, new CylinderGeometry(0.024, 0.022, 0.016, 12), kit.charcoal, [0, -0.045, 0])
  if (detail) add(hopper, new TorusGeometry(0.0315, 0.003, 8, 20), kit.accent, [0, 0.040, 0], [Math.PI / 2, 0, 0])

  // --- team accent strips ---------------------------------------------------
  for (const side of [-1, 1]) {
    add(root, new BoxGeometry(0.004, 0.008, 0.230), kit.accent, [side * 0.0365, BORE_Y + 0.014, -0.055])
    add(root, new BoxGeometry(0.004, 0.008, 0.130), kit.accent, [side * 0.0325, BORE_Y + 0.014, -0.245])
    add(root, new BoxGeometry(0.004, 0.008, 0.030), kit.accent, [side * 0.0175, BORE_Y + 0.014, -0.176])
  }
  add(root, new BoxGeometry(0.020, 0.006, 0.004), kit.accent, [0, 0.040, 0.201])

  // --- muzzle node + flash --------------------------------------------------
  const muzzle = new Object3D()
  muzzle.position.set(0, BORE_Y, -0.435)
  root.add(muzzle)
  muzzle.add(flash)
  kit.muzzleFlash(flash)

  return {
    muzzle,
    length: MODEL_LENGTH,
    paintLevel,
    setPaintLevel(level) {
      const clamped = level <= 0 ? 0 : level >= 1 ? 1 : level
      paintLevel.visible = clamped > 0.001
      paintLevel.scale.y = clamped
      paintLevel.position.y = -0.037 + 0.037 * clamped
    },
  }
}

/**
 * Bake meshes relative to one rigid pivot, first coalescing equal materials and then putting the
 * material batches into one grouped BufferGeometry. A grouped mesh still renders each material
 * correctly, but traversal, culling and the shadow pass no longer process every tiny primitive.
 */
function mergeRigidMeshes(
  pivot: Object3D,
  meshes: Mesh[],
  name: string,
  castShadow: boolean,
  owned: Set<BufferGeometry>,
): Mesh | null {
  if (meshes.length === 0) return null

  pivot.updateWorldMatrix(true, true)
  const inversePivot = new Matrix4().copy(pivot.matrixWorld).invert()
  const transform = new Matrix4()
  const batches = new Map<Material, BufferGeometry[]>()

  for (const mesh of meshes) {
    if (Array.isArray(mesh.material)) {
      throw new Error('Weapon primitives must have exactly one material before batching')
    }
    const geometry = mesh.geometry.clone()
    transform.multiplyMatrices(inversePivot, mesh.matrixWorld)
    geometry.applyMatrix4(transform)
    const batch = batches.get(mesh.material)
    if (batch) batch.push(geometry)
    else batches.set(mesh.material, [geometry])
  }

  const materials: Material[] = []
  const materialGeometries: BufferGeometry[] = []
  for (const [material, parts] of batches) {
    const geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)
    if (!geometry) throw new Error(`Could not merge ${name} material batch`)
    for (const part of parts) {
      if (part !== geometry) part.dispose()
    }
    materials.push(material)
    materialGeometries.push(geometry)
  }

  const geometry = materialGeometries.length === 1
    ? materialGeometries[0]
    : mergeGeometries(materialGeometries, true)
  if (!geometry) throw new Error(`Could not merge ${name}`)
  for (const materialGeometry of materialGeometries) {
    if (materialGeometry !== geometry) materialGeometry.dispose()
  }

  for (const mesh of meshes) {
    mesh.removeFromParent()
    if (owned.delete(mesh.geometry)) mesh.geometry.dispose()
  }

  owned.add(geometry)
  const merged = new Mesh(geometry, materials.length === 1 ? materials[0] : materials)
  merged.name = name
  merged.castShadow = castShadow
  merged.receiveShadow = false
  merged.frustumCulled = false
  pivot.add(merged)
  return merged
}

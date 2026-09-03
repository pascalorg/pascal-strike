/**
 * The paintball marker as a piece of industrial design, built entirely from primitives.
 *
 * Reference silhouette: a compact futuristic SMG blaster — matte white polymer body with
 * chamfered panels and shallow panel lines, charcoal receiver / grip / folding stock, a
 * full-length top rail with front and rear sights, an angled foregrip, a squared muzzle
 * shroud, and the team colour carried by a thin accent strip, the translucent paint hopper
 * and the muzzle ring.
 *
 * Conventions
 * - Authored at real-world scale: the marker is 0.63 m from butt plate to muzzle.
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
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
  type Material,
} from 'three'
import { TEAMS } from '../config'
import type { TeamId, WeaponKind } from '../types'

export type WeaponQuality = 'first' | 'third'

export interface WeaponModelOptions {
  /** Which weapon to build; missing = rifle. Pistol and knife are built by the weapons package. */
  kind?: WeaponKind
  team: TeamId
  /** `'first'` = full detail for the view model, `'third'` = ~60 % of the parts for avatars. */
  quality: WeaponQuality
}

export interface WeaponModel {
  readonly object: Group
  /** Empty node at the bore exit; effects read its world position. */
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

/** Butt plate (+Z) to muzzle (−Z). */
const MODEL_LENGTH = 0.63
/** Height of the bore line above the origin; everything on the body is built around it. */
const BORE_Y = 0.026

export function createWeaponModel(options: WeaponModelOptions): WeaponModel {
  const detail = options.quality === 'first'
  const teamHex = TEAMS[options.team].colorHex

  const geometries: BufferGeometry[] = []
  const materials: Material[] = []
  const track = <T extends BufferGeometry>(geometry: T): T => {
    geometries.push(geometry)
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
  root.name = 'paintball-marker'

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

  // --- white polymer body ---------------------------------------------------
  // Core + a taller/narrower crossing box: the pair reads as a chamfered extrusion.
  add(root, new BoxGeometry(0.070, 0.062, 0.260), white, [0, BORE_Y + 0.004, -0.060])
  add(root, new BoxGeometry(0.056, 0.076, 0.255), white, [0, BORE_Y + 0.004, -0.060])
  add(root, new BoxGeometry(0.052, 0.046, 0.110), white, [0, BORE_Y + 0.002, -0.135])
  add(root, new BoxGeometry(0.0665, 0.012, 0.250), whiteShade, [0, BORE_Y + 0.029, -0.060])
  add(root, new BoxGeometry(0.0585, 0.012, 0.132), whiteShade, [0, BORE_Y + 0.025, -0.245])

  // Handguard, one step slimmer than the body so the hand has a place to sit.
  add(root, new BoxGeometry(0.062, 0.056, 0.140), white, [0, BORE_Y, -0.245])
  add(root, new BoxGeometry(0.048, 0.068, 0.135), white, [0, BORE_Y, -0.245])

  if (detail) {
    // Shallow panel lines: thin slivers standing 2 mm proud of each face.
    add(root, new BoxGeometry(0.0735, 0.0035, 0.170), line, [0, BORE_Y - 0.016, -0.070])
    add(root, new BoxGeometry(0.0655, 0.0035, 0.100), line, [0, BORE_Y - 0.014, -0.245])
    add(root, new BoxGeometry(0.0735, 0.030, 0.0035), line, [0, BORE_Y + 0.004, -0.178])
    // Cooling slots on the handguard.
    for (let i = 0; i < 3; i++) {
      add(root, new BoxGeometry(0.0655, 0.007, 0.020), charcoalLight, [0, BORE_Y + 0.008, -0.205 - i * 0.042])
    }
  }

  add(root, new BoxGeometry(0.050, 0.011, 0.185), charcoalLight, [0, BORE_Y - 0.033, -0.152])

  // --- barrel + squared muzzle shroud --------------------------------------
  add(root, new CylinderGeometry(0.019, 0.019, 0.100, 12), charcoal, [0, BORE_Y, -0.352], [Math.PI / 2, 0, 0])
  if (detail) {
    add(root, new CylinderGeometry(0.024, 0.024, 0.012, 12), charcoalLight, [0, BORE_Y, -0.316], [Math.PI / 2, 0, 0])
  }
  add(root, new BoxGeometry(0.054, 0.054, 0.085), white, [0, BORE_Y, -0.3875])
  if (detail) add(root, new BoxGeometry(0.042, 0.064, 0.082), white, [0, BORE_Y, -0.3875])
  add(root, new BoxGeometry(0.058, 0.058, 0.014), charcoal, [0, BORE_Y, -0.4230])
  add(root, new TorusGeometry(0.019, 0.005, 8, 20), accent, [0, BORE_Y, -0.4295])
  if (detail) add(root, new CylinderGeometry(0.013, 0.013, 0.022, 12), black, [0, BORE_Y, -0.4270], [Math.PI / 2, 0, 0])

  // --- full-length top rail -------------------------------------------------
  add(root, new BoxGeometry(0.034, 0.010, 0.475), charcoal, [0, 0.066, -0.1425])
  add(root, new BoxGeometry(0.026, 0.008, 0.475), charcoal, [0, 0.074, -0.1425])
  if (detail) {
    const notch = new BoxGeometry(0.030, 0.010, 0.012)
    for (let i = 0; i < 8; i++) {
      add(root, notch.clone(), charcoalLight, [0, 0.079, -0.350 + i * 0.058])
    }
    notch.dispose()
  }

  // Front sight: post inside a low hood. Rear sight: blade with an aperture.
  add(root, new BoxGeometry(0.020, 0.016, 0.024), charcoal, [0, 0.086, -0.300])
  add(root, new BoxGeometry(0.007, 0.026, 0.008), charcoal, [0, 0.101, -0.300])
  if (detail) add(root, new BoxGeometry(0.024, 0.006, 0.010), charcoal, [0, 0.115, -0.300])
  add(root, new BoxGeometry(0.026, 0.018, 0.022), charcoal, [0, 0.085, 0.055])
  add(root, new BoxGeometry(0.030, 0.022, 0.008), charcoal, [0, 0.098, 0.058])
  if (detail) add(root, new BoxGeometry(0.009, 0.010, 0.012), black, [0, 0.100, 0.058])

  // --- charcoal receiver ----------------------------------------------------
  add(root, new BoxGeometry(0.064, 0.072, 0.115), charcoal, [0, 0.024, 0.086])
  add(root, new BoxGeometry(0.050, 0.084, 0.110), charcoal, [0, 0.024, 0.086])
  if (detail) {
    add(root, new BoxGeometry(0.068, 0.026, 0.060), charcoalLight, [0, 0.034, 0.085])
    add(root, new BoxGeometry(0.012, 0.010, 0.050), charcoalLight, [-0.036, 0.054, 0.060])
  }

  // --- grip, trigger group --------------------------------------------------
  const gripRake: readonly [number, number, number] = [-0.26, 0, 0]
  add(root, new BoxGeometry(0.046, 0.115, 0.054), charcoal, [0, -0.070, 0.028], gripRake)
  add(root, new BoxGeometry(0.034, 0.118, 0.062), charcoal, [0, -0.070, 0.028], gripRake)
  if (detail) add(root, new BoxGeometry(0.043, 0.070, 0.040), charcoalLight, [0, -0.085, 0.032], gripRake)
  add(root, new BoxGeometry(0.050, 0.005, 0.032), accent, [0, -0.026, 0.022], gripRake)
  add(root, new BoxGeometry(0.018, 0.012, 0.092), charcoal, [0, -0.053, -0.004])
  add(root, new BoxGeometry(0.018, 0.034, 0.012), charcoal, [0, -0.038, -0.043])
  if (detail) add(root, new BoxGeometry(0.008, 0.024, 0.008), charcoalLight, [0, -0.034, -0.014], [-0.2, 0, 0])

  // --- angled foregrip ------------------------------------------------------
  const foreRake: readonly [number, number, number] = [0.40, 0, 0]
  add(root, new BoxGeometry(0.032, 0.080, 0.040), charcoal, [0, -0.040, -0.245], foreRake)
  add(root, new BoxGeometry(0.024, 0.084, 0.030), charcoal, [0, -0.040, -0.245], foreRake)
  if (detail) add(root, new BoxGeometry(0.035, 0.045, 0.026), charcoalLight, [0, -0.062, -0.254], foreRake)

  // --- folding stock --------------------------------------------------------
  add(root, new BoxGeometry(0.024, 0.013, 0.110), charcoal, [0, 0.055, 0.150])
  add(root, new BoxGeometry(0.024, 0.013, 0.100), charcoal, [0, -0.006, 0.155])
  add(root, new BoxGeometry(0.030, 0.086, 0.013), charcoal, [0, 0.024, 0.198])
  add(root, new CylinderGeometry(0.012, 0.012, 0.028, 12), charcoalLight, [0, 0.024, 0.130], [0, 0, Math.PI / 2])
  if (detail) add(root, new BoxGeometry(0.028, 0.076, 0.005), charcoalLight, [0, 0.024, 0.204])

  // --- translucent paint hopper -------------------------------------------
  // Small, canted off the sight line and cradled by a charcoal saddle so it reads as part
  // of the marker rather than a canister taped to it.
  add(root, new BoxGeometry(0.050, 0.030, 0.072), charcoal, [-0.018, 0.044, -0.082], [0, 0, 0.30])
  const hopper = new Group()
  hopper.position.set(-0.038, 0.056, -0.082)
  hopper.rotation.set(-0.14, 0, 0.34)
  root.add(hopper)
  add(hopper, new CylinderGeometry(0.031, 0.028, 0.082, 18, 1, true), tank, [0, 0, 0])
  const paintLevel = add(hopper, new CylinderGeometry(0.026, 0.024, 0.074, 14), paint, [0, 0, 0])
  add(hopper, new CylinderGeometry(0.026, 0.032, 0.008, 18), charcoal, [0, 0.045, 0])
  add(hopper, new CylinderGeometry(0.024, 0.022, 0.016, 12), charcoal, [0, -0.045, 0])
  if (detail) add(hopper, new TorusGeometry(0.0315, 0.003, 8, 20), accent, [0, 0.040, 0], [Math.PI / 2, 0, 0])

  // --- team accent strips ---------------------------------------------------
  for (const side of [-1, 1]) {
    add(root, new BoxGeometry(0.004, 0.008, 0.230), accent, [side * 0.0365, BORE_Y + 0.014, -0.055])
    add(root, new BoxGeometry(0.004, 0.008, 0.130), accent, [side * 0.0325, BORE_Y + 0.014, -0.245])
    add(root, new BoxGeometry(0.004, 0.008, 0.030), accent, [side * 0.0175, BORE_Y + 0.014, -0.176])
  }
  add(root, new BoxGeometry(0.020, 0.006, 0.004), accent, [0, 0.040, 0.201])

  // --- muzzle node + flash --------------------------------------------------
  const muzzle = new Object3D()
  muzzle.position.set(0, BORE_Y, -0.435)
  root.add(muzzle)

  const flash = new Group()
  flash.visible = false
  muzzle.add(flash)
  add(flash, new SphereGeometry(0.020, 10, 8), flashMaterial, [0, 0, -0.006])
  add(flash, new ConeGeometry(0.026, 0.058, 12, 1, true), flashMaterial, [0, 0, -0.030], [-Math.PI / 2, 0, 0])
  add(flash, new PlaneGeometry(0.115, 0.011), flashMaterial, [0, 0, -0.008], [0, 0, 0.62])
  add(flash, new PlaneGeometry(0.115, 0.011), flashMaterial, [0, 0, -0.008], [0, 0, -0.62])
  add(flash, new PlaneGeometry(0.048, 0.048), flashMaterial, [0, 0, -0.008], [0, 0, 0.4])

  if (detail) {
    // The view model is drawn last so it never fights the world for depth, but it still
    // depth-tests against itself — the chamfer trick above only reads with a depth buffer.
    root.traverse((object) => {
      if (object instanceof Mesh) object.renderOrder = 100
    })
  }

  const setPaintLevel = (level: number): void => {
    const clamped = level <= 0 ? 0 : level >= 1 ? 1 : level
    paintLevel.visible = clamped > 0.001
    paintLevel.scale.y = clamped
    paintLevel.position.y = -0.037 + 0.037 * clamped
  }
  setPaintLevel(1)

  return {
    object: root,
    muzzle,
    length: MODEL_LENGTH,
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
      flash.visible = clamped > 0.004
      if (!flash.visible) return
      flashMaterial.opacity = 0.3 + clamped * 0.7
      flash.scale.setScalar(0.6 + clamped * 0.5)
      flash.rotation.z = clamped * 5.7
    },
    setPaintLevel,
    dispose() {
      root.removeFromParent()
      for (const geometry of geometries) geometry.dispose()
      for (const material of materials) material.dispose()
      geometries.length = 0
      materials.length = 0
    },
  }
}

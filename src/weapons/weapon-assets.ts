import { AdditiveBlending, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry, type Material } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { TEAMS } from '../config'
import type { TeamId, WeaponKind } from '../types'
import type { WeaponModel, WeaponModelOptions } from './weapon-model'

const files = new Map<WeaponKind, Promise<Group>>()
const loader = new GLTFLoader()
const flashGeometry = new PlaneGeometry(.07, .07)
const lengths: Record<WeaponKind, number> = { rifle: .71, pistol: .346, knife: .366 }

export function loadWeaponAsset(kind: WeaponKind): Promise<Group> {
  let pending = files.get(kind)
  if (!pending) {
    pending = loader.loadAsync(`/weapons/${kind}.glb`).then(gltf => gltf.scene).catch(error => { files.delete(kind); throw error })
    files.set(kind, pending)
  }
  return pending
}

export function preloadWeaponAssets(): Promise<Group[]> {
  return Promise.all((['rifle', 'pistol', 'knife'] as const).map(loadWeaponAsset))
}

/** Shared GLB geometry, independent color/fill state, and stable mount nodes while loading. */
export function createAssetWeapon(options: WeaponModelOptions, fallback: () => WeaponModel): WeaponModel {
  const kind = options.kind ?? 'rifle', object = new Group(), muzzle = new Object3D()
  object.name = `splash-${kind}`; object.userData.weaponStatus = 'loading'
  let team = options.team, level = 1, intensity = 0, disposed = false
  let primitive: WeaponModel | undefined = fallback()
  object.add(primitive.object); primitive.muzzle.add(muzzle)
  let fill: Object3D | undefined
  const materials = new Map<Material, MeshStandardMaterial>()
  const flashMaterial = new MeshBasicMaterial({ color: TEAMS[team].colorHex, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false })
  const flash = new Group(); flash.visible = false
  if (kind !== 'knife') {
    for (let i=0;i<2;i++) {
      const card = new Mesh(flashGeometry, flashMaterial)
      card.rotation.z = i * Math.PI / 4; card.scale.set(.35,1,1)
      card.renderOrder = options.quality === 'first' ? 102 : 2
      flash.add(card)
    }
  }
  const setTeam = (value: TeamId) => {
    team = value; primitive?.setTeam(value)
    for (const material of materials.values()) {
      if (material.name.startsWith('TeamPaint') || material.name.startsWith('TeamGlass')) material.color.setHex(TEAMS[value].colorHex)
    }
    flashMaterial.color.setHex(TEAMS[value].colorHex)
  }
  const setPaintLevel = (value: number) => {
    level = Math.max(0, Math.min(1, value)); primitive?.setPaintLevel(level)
    if (fill) { fill.scale.y = Math.max(.001, level); fill.visible = level > .001 }
  }
  const setFireFlash = (value: number) => {
    intensity = Math.max(0, Math.min(1, value)); primitive?.setFireFlash(intensity)
    flash.visible = !primitive && kind !== 'knife' && intensity > .004
    flashMaterial.opacity = intensity * .85; flash.scale.setScalar(.7 + intensity * .6)
    flash.rotation.z = intensity * 5.7
  }
  const ready = loadWeaponAsset(kind).then(source => {
    if (disposed) return
    const model = source.clone(true)
    model.traverse(node => {
      if (!(node instanceof Mesh)) return
      const copy = (original: Material) => {
        let clone = materials.get(original)
        if (!clone) {
          clone = (original as MeshStandardMaterial).clone()
          if (clone.transparent) clone.depthWrite = false
          materials.set(original, clone)
        }
        return clone
      }
      node.material = Array.isArray(node.material) ? node.material.map(copy) : copy(node.material)
      node.castShadow = options.quality === 'third'; node.receiveShadow = true
      if (options.quality === 'first') node.renderOrder = 100
    })
    const bore = model.getObjectByName('Muzzle_export')
    if (!bore) throw new Error(`${kind}.glb is missing its muzzle mount`)
    fill = model.getObjectByName('PaintLevel_export')
    muzzle.removeFromParent(); primitive?.dispose(); primitive = undefined
    object.add(model); bore.add(muzzle); muzzle.add(flash)
    setTeam(team); setPaintLevel(level); setFireFlash(intensity)
    object.userData.weaponStatus = 'ready'
  }).catch(error => {
    if (disposed) return
    object.userData.weaponStatus = 'error'
    console.error('[weapon asset]', error)
    // Keep the playable primitive if loading fails (offline/stale deployment).
  })
  return {
    kind, object, muzzle, ready, length: lengths[kind], setTeam, setPaintLevel, setFireFlash,
    dispose() {
      disposed = true; muzzle.removeFromParent(); primitive?.dispose(); object.removeFromParent(); object.clear()
      for (const material of materials.values()) material.dispose()
      materials.clear(); flashMaterial.dispose()
      // Cached GLB geometry and the shared flash quad belong to the asset cache.
    },
  }
}

import { AnimationClip, Box3, Group, Mesh, MeshStandardMaterial, SkinnedMesh, Vector3 } from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { PLAYER } from '../config'
import type { CharacterSelection } from '../types'
import { DEFAULT_CHARACTERS, STUDIO_ORIGIN } from './catalog'

/** A cold baked variant can answer 503 while the worker prepares it. */
async function fetchCharacterResource(url: string): Promise<Response> {
  const deadline = Date.now() + 120000
  for (;;) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (response.ok) return response
    if (response.status !== 503 || Date.now() >= deadline) throw new Error(`Could not load character (${response.status}). Try again.`)
    const delay = Math.max(1, Math.min(15, Number(response.headers.get('Retry-After')) || 3)) * 1000
    await new Promise(resolve => setTimeout(resolve, delay))
  }
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
const files = new Map<string, Promise<GLTF>>()
const assets = new Map<string, Promise<CharacterAsset>>()
export interface CharacterAsset { model: Group; clips: AnimationClip[]; sockets: Record<string, { three: string }>; }
export interface CharacterInstance {
  object: Group
  model: Group
  clips: AnimationClip[]
  materials: MeshStandardMaterial[]
  sockets: CharacterAsset['sockets']
  dispose(): void
}

function file(url: string): Promise<GLTF> {
  let pending = files.get(url)
  if (!pending) {
    pending = (async () => {
      const response = await fetchCharacterResource(url)
      return loader.parseAsync(await response.arrayBuffer(), new URL('.', response.url).href)
    })().catch(error => { files.delete(url); throw error })
    files.set(url, pending)
  }
  return pending
}

export function loadCharacterAsset(character: CharacterSelection): Promise<CharacterAsset> {
  let pending = assets.get(character.manifestUrl)
  if (!pending) {
    pending = (async () => {
      const response = await fetchCharacterResource(character.manifestUrl)
      if (!response.ok) throw new Error(`Character Studio could not load this character (${response.status}).`)
      const manifest = await response.json()
      if (manifest.schema !== 'character-studio.manifest.v1' || manifest.gender !== character.gender) throw new Error('Unsupported Character Studio manifest.')
      const preset = DEFAULT_CHARACTERS.find(c => c.id === character.id)
      let modelUrl = preset ? `/characters/${preset.id}.glb` : manifest.urls.model
      // The rig contract shares one library per gender. Use our pinned copy for customs too:
      // no duplicate downloads, and no dependency on the redirect route's CDN CORS cache.
      const animationUrl = `/characters/${character.gender}-animations.glb`
      if (!preset) {
        if (manifest.bakeId !== character.id) throw new Error('Character bake does not match the export.')
        const model = new URL(modelUrl), animation = new URL(manifest.urls.animations)
        if (model.origin !== STUDIO_ORIGIN || animation.origin !== STUDIO_ORIGIN ||
            !/^\/api\/models\/b\/[\w-]+\.glb$/.test(model.pathname) ||
            animation.pathname !== `/api/models/animations/${character.gender}.glb`) throw new Error('Invalid character asset URLs.')
        model.search = 'quality=medium&morphs=none'
        modelUrl = model.href
      }
      const [model, library] = await Promise.all([file(modelUrl), file(animationUrl)])
      const clips = library.animations.filter(c => c.name.startsWith('Rig|') && !c.name.endsWith('_RM')).map(source => {
        const clip = source.clone()
        clip.tracks = clip.tracks.filter(t => !t.name.endsWith('.scale'))
        return clip
      })
      if (!clips.some(c => c.name === 'Rig|Idle_Loop')) throw new Error('Character animation library is missing Idle_Loop.')
      return { model: model.scene, clips, sockets: manifest.rig.sockets }
    })().catch(error => { assets.delete(character.manifestUrl); throw error })
    assets.set(character.manifestUrl, pending)
  }
  return pending
}

export function instantiateCharacter(asset: CharacterAsset): CharacterInstance {
  const model = clone(asset.model) as Group
  const object = new Group()
  object.name = 'studio-character'
  object.add(model)
  const materials: MeshStandardMaterial[] = []
  const clones = new Map<MeshStandardMaterial, MeshStandardMaterial>()
  model.traverse(node => {
    if (!(node instanceof Mesh)) return
    node.castShadow = true
    node.receiveShadow = true
    if (node instanceof SkinnedMesh) node.frustumCulled = false
    const copy = (source: MeshStandardMaterial) => {
      let material = clones.get(source)
      if (!material) { material = source.clone(); clones.set(source, material); materials.push(material) }
      return material
    }
    node.material = Array.isArray(node.material) ? node.material.map(m => copy(m as MeshStandardMaterial)) : copy(node.material as MeshStandardMaterial)
  })
  // Normalize the baked model once to the game's shared capsule. Rig height remains intact;
  // customization cannot grant a smaller target or put a tall character through the ceiling.
  model.updateMatrixWorld(true)
  const box = new Box3().setFromObject(model, true)
  const scale = PLAYER.height / box.getSize(new Vector3()).y
  object.scale.setScalar(scale)
  model.position.y -= box.min.y
  return { object, model, clips: asset.clips, materials, sockets: asset.sockets, dispose() {
    object.removeFromParent()
    materials.forEach(m => m.dispose())
    const skeletons = new Set<SkinnedMesh['skeleton']>()
    model.traverse(node => { if (node instanceof SkinnedMesh) skeletons.add(node.skeleton) })
    skeletons.forEach(skeleton => skeleton.dispose())
  } }
}

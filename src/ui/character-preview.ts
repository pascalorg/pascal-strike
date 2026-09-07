import { AnimationMixer, AmbientLight, DirectionalLight, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, CylinderGeometry, NeutralToneMapping } from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { instantiateCharacter, loadCharacterAsset, type CharacterInstance } from '../characters/assets'
import type { CharacterSelection } from '../types'

export async function createCharacterPreview(mount: HTMLElement) {
  const renderer = new WebGPURenderer({ antialias: true, alpha: true, forceWebGL: new URLSearchParams(location.search).has('webgl') })
  await renderer.init()
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
  renderer.toneMapping = NeutralToneMapping
  renderer.domElement.setAttribute('aria-label', 'Animated character preview. Drag to rotate.')
  mount.appendChild(renderer.domElement)
  const scene = new Scene()
  const camera = new PerspectiveCamera(32, 1, 0.1, 30)
  camera.position.set(-0.5, 1.1, -3.6)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.set(0, 0.9, 0)
  controls.enablePan = false; controls.enableZoom = false
  controls.minPolarAngle = Math.PI * 0.32; controls.maxPolarAngle = Math.PI * 0.55
  controls.update()
  scene.add(new AmbientLight(0xffffff, 2))
  const key = new DirectionalLight(0xfff2df, 3.5); key.position.set(-3, 5, -4); scene.add(key)
  const rim = new DirectionalLight(0x7be8de, 2.5); rim.position.set(2, 3, 2); scene.add(rim)
  const stage = new Mesh(new CylinderGeometry(0.65, 0.68, 0.06, 64), new MeshStandardMaterial({ color: 0x24282d, roughness: 0.65 }))
  stage.position.y = -0.04; scene.add(stage)
  const pivot = new Group(); scene.add(pivot)
  let instance: CharacterInstance | undefined
  let mixer: AnimationMixer | undefined
  let disposed = false, version = 0, last = performance.now()
  const observer = new ResizeObserver(() => {
    const { width, height } = mount.getBoundingClientRect()
    if (!width || !height) return
    renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix()
  })
  observer.observe(mount)
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min((now - last) / 1000, 0.1); last = now
    if (document.hidden) return
    mixer?.update(dt)
    renderer.render(scene, camera)
  })
  return {
    async show(character: CharacterSelection) {
      const current = ++version
      const asset = await loadCharacterAsset(character)
      if (disposed || current !== version) return
      mixer?.stopAllAction()
      if (instance) mixer?.uncacheRoot(instance.model)
      instance?.dispose()
      instance = instantiateCharacter(asset); pivot.add(instance.object)
      mixer = new AnimationMixer(instance.model)
      mixer.clipAction(asset.clips.find(c => c.name === 'Rig|Idle_Loop')!).play()

    },
    dispose() {
      if (disposed) return
      disposed = true; version++; observer.disconnect(); controls.dispose()
      renderer.setAnimationLoop(null); mixer?.stopAllAction(); if (instance) mixer?.uncacheRoot(instance.model); instance?.dispose()
      stage.geometry.dispose(); stage.material.dispose(); renderer.dispose(); renderer.domElement.remove()
    },
  }
}

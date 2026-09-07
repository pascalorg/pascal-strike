/** Inspect the exact Blender GLBs and their runtime material/fill controls. */
import { AmbientLight, Box3, Color, DirectionalLight, NeutralToneMapping, PerspectiveCamera, Scene, Vector3 } from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createWeaponModel } from '../weapons/weapon-model'
import type { TeamId, WeaponKind } from '../types'
import { el } from '../ui/dom'

export async function start() {
  const renderer = new WebGPURenderer({ antialias: true, forceWebGL: new URLSearchParams(location.search).has('webgl') })
  await renderer.init(); renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.toneMapping = NeutralToneMapping
  document.getElementById('app')!.append(renderer.domElement)
  const scene = new Scene(); scene.background = new Color(0x242b35)
  const camera = new PerspectiveCamera(36, innerWidth / innerHeight, .01, 30)
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true
  scene.add(new AmbientLight(0xffffff, 1.8))
  for (const [color, intensity, position] of [[0xffead4,3,[2,3,-1]],[0xa0d4ff,2,[-2,1,1]]] as const) {
    const light = new DirectionalLight(color,intensity); light.position.set(position[0],position[1],position[2]); scene.add(light)
  }
  const models = Object.fromEntries((['rifle','pistol','knife'] as const).map(kind => {
    const model=createWeaponModel({kind,team:'a',quality:'third'});scene.add(model.object);model.object.visible=false;return [kind,model]
  })) as Record<WeaponKind, ReturnType<typeof createWeaponModel>>
  await Promise.all(Object.values(models).map(m=>m.ready))
  const bar=el('div',{style:'position:absolute;left:24px;bottom:24px;right:24px;display:flex;gap:10px;align-items:center;flex-wrap:wrap'})
  const title=el('div',{style:'position:absolute;left:28px;top:24px;color:#e7e0d5;font:24px var(--font-display)',text:'SPLASH ARMORY · Blender GLBs'})
  const button=(text:string,fn:()=>void)=>{const b=el('button',{class:'ps-btn',text});b.onclick=fn;bar.append(b)}
  let active:WeaponKind='rifle',team:TeamId='a'
  const select=(kind:WeaponKind)=>{
    active=kind;for(const model of Object.values(models))model.object.visible=model.kind===kind
    const box=new Box3().setFromObject(models[kind].object),center=box.getCenter(new Vector3()),size=box.getSize(new Vector3()).length()
    controls.target.copy(center);camera.position.copy(center).add(new Vector3(.9,.42,-.65).normalize().multiplyScalar(size*1.65));controls.update()
  }
  button('Marker',()=>select('rifle'));button('Sidearm',()=>select('pistol'));button('Scraper',()=>select('knife'))
  button('Team color',()=>{team=team==='a'?'b':'a';Object.values(models).forEach(m=>m.setTeam(team))})
  button('Half paint',()=>models[active].setPaintLevel(.5));button('Full paint',()=>models[active].setPaintLevel(1))
  button('Fire',()=>{models[active].setFireFlash(1);setTimeout(()=>models[active].setFireFlash(0),90)})
  document.getElementById('app')!.append(title,bar);select('rifle')
  renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera)})
  window.addEventListener('resize',()=>{renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix()})
  Object.assign(window,{__psWeapons:{models,scene,camera,renderer,select}})
}

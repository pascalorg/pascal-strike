/** Real avatar/rendering fixture: also useful for tuning Studio grip and animation transitions. */
import { AmbientLight, Color, DirectionalLight, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Scene, Vector3, NeutralToneMapping } from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { DEFAULT_CHARACTERS } from '../characters/catalog'
import { createAvatar } from '../player/avatar'
import type { WeaponKind } from '../types'
import { el } from '../ui/dom'

export async function start() {
  const renderer = new WebGPURenderer({ antialias: true, forceWebGL: new URLSearchParams(location.search).has('webgl') })
  await renderer.init(); renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.toneMapping = NeutralToneMapping
  document.getElementById('app')!.appendChild(renderer.domElement)
  const scene = new Scene()
  scene.background = new Color(0x24282c)
  const camera = new PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 100)
  camera.position.set(-1.5, 2.7, -8)
  const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, .9, 0); controls.update()
  scene.add(new AmbientLight(0xffffff, 2))
  const sun = new DirectionalLight(0xfff3df, 3); sun.position.set(-3, 6, -4); scene.add(sun)
  const fill = new DirectionalLight(0x9ce8df, 2); fill.position.set(3, 3, 1); scene.add(fill)
  const floor = new Mesh(new PlaneGeometry(40,40), new MeshStandardMaterial({color:0x343b3c,roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.02;scene.add(floor)
  const avatars = DEFAULT_CHARACTERS.map((c,i) => { const a=createAvatar(i%2?'b':'a',c.name,c.id,c);scene.add(a.object);return a })
  const positions=avatars.map((_,i)=>new Vector3((i-1.5)*1.5,0,0))
  let speed=0, crouch=false, grounded=true, reload=false, weapon:WeaponKind='rifle'
  const bar=el('div',{style:'position:absolute;left:20px;right:20px;bottom:20px;display:flex;gap:8px;flex-wrap:wrap;z-index:5'})
  const button=(name:string,fn:()=>void)=>{ const b=el('button',{class:'ps-btn',text:name});b.onclick=fn;bar.append(b) }
  button('Idle',()=>{speed=0;crouch=false;grounded=true;reload=false})
  button('Walk',()=>{speed=2.8;crouch=false;grounded=true})
  button('Run',()=>{speed=5.5;crouch=false;grounded=true})
  button('Crouch',()=>{crouch=!crouch})
  button('Jump',()=>{grounded=false;setTimeout(()=>grounded=true,650)})
  button('Fire',()=>avatars.forEach(a=>a.fire(weapon)))
  button('Reload',()=>{reload=true;setTimeout(()=>reload=false,1700)})
  button('Hit',()=>avatars.forEach(a=>{a.flashHit();a.addSplat(a.object.position.clone().add(new Vector3(0,1.25,-.2)),null,0xf97316)}))
  button('Death',()=>avatars.forEach(a=>a.die()))
  button('Respawn',()=>avatars.forEach(a=>a.spawn()))
  for(const kind of ['rifle','pistol','knife'] as const) button(kind,()=>{weapon=kind;avatars.forEach(a=>a.setWeapon(kind))})
  document.getElementById('app')!.append(bar)
  await Promise.all(avatars.map(a=>a.ready))
  renderer.setAnimationLoop(()=>{ avatars.forEach((a,i)=>{positions[i].y=grounded?0:.35;a.set(positions[i],0,0,crouch,speed,grounded,reload)});renderer.render(scene,camera) })
  Object.assign(window,{__psCharacters:{avatars,scene,camera,renderer,positions}})
  window.addEventListener('resize',()=>{renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix()})
}

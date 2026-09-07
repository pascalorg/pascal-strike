import { AnimationMixer, Group, SkinnedMesh, Vector3, type BufferGeometry } from 'three'
import type { CharacterSelection, WeaponKind } from '../types'
import { createWeaponGrip } from './grip'
import { instantiateCharacter, loadCharacterAsset } from './assets'

/** Use the selected character's real hands and sleeves, cropped at the upper arms. */
export async function createFirstPersonArms(character: CharacterSelection) {
  const instance = instantiateCharacter(await loadCharacterAsset(character))
  const geometries: BufferGeometry[] = []
  const armIndices: { geometry: BufferGeometry; both: number[]; right: number[] }[] = []
  instance.model.traverse(node => {
    if (!(node instanceof SkinnedMesh)) return
    const geometry = node.geometry
    const joints = geometry.getAttribute('skinIndex'), weights = geometry.getAttribute('skinWeight')
    const armBones = new Set(node.skeleton.bones.map((b, i) => /^(DEF-(forearm|hand|thumb|f_|palm)|DEF-upper_arm)/.test(b.name) ? i : -1))
    armBones.delete(-1)
    const belongs = (vertex: number) => {
      let weight = 0
      for (let c=0;c<4;c++) if (armBones.has(joints.getComponent(vertex,c))) weight += weights.getComponent(vertex,c)
      return weight > 0.85
    }
    const indices: number[] = [], right: number[] = []
    const rightBones = new Set(node.skeleton.bones.map((bone,i) => /R(?:\d*)$/.test(bone.name) && armBones.has(i) ? i : -1))
    const onRight = (vertex: number) => {
      let weight = 0
      for (let c=0;c<4;c++) if (rightBones.has(joints.getComponent(vertex,c))) weight += weights.getComponent(vertex,c)
      return weight > .85
    }
    const count = geometry.index?.count ?? joints.count
    for (let i=0;i<count;i+=3) {
      const a=geometry.index?.getX(i)??i,b=geometry.index?.getX(i+1)??i+1,c=geometry.index?.getX(i+2)??i+2
      if (belongs(a) && belongs(b) && belongs(c)) indices.push(a,b,c)
      if (onRight(a) && onRight(b) && onRight(c)) right.push(a,b,c)
    }
    if (!indices.length) { node.visible = false; return }
    const cropped=geometry.clone();cropped.setIndex(indices);cropped.clearGroups();node.geometry=cropped;geometries.push(cropped)
    armIndices.push({geometry:cropped,both:indices,right})
    node.castShadow=false;node.receiveShadow=false;node.renderOrder=99
  })
  const object=new Group();object.name='studio-first-person-arms';object.add(instance.object)
  const mixer=new AnimationMixer(instance.model)
  mixer.clipAction(instance.clips.find(c=>c.name==='Rig|Pistol_Idle_Loop')!).play()
  mixer.update(0)
  object.updateMatrixWorld(true)
  const hand=instance.model.getObjectByName(instance.sockets.handRight.three)!
  const position=new Vector3()
  const knuckle = instance.model.getObjectByName('DEF-f_middle01R')
  const thumb = instance.model.getObjectByName('DEF-thumb02R')
  if (knuckle && thumb) {
    knuckle.getWorldPosition(position)
    position.add(thumb.getWorldPosition(new Vector3())).multiplyScalar(.5)
  } else hand.getWorldPosition(position)
  // The socket is the wrist, not the palm. Center the actual grasp around the GLB grip.
  instance.object.position.sub(position).add(new Vector3(0,-.055,.025))
  const grip = createWeaponGrip(instance.model, instance.clips)
  let weapon: WeaponKind = 'rifle'
  grip.apply(weapon)
  let supportHand = true
  return { object, setWeapon(kind: WeaponKind) {
    weapon = kind; grip.restore(); grip.apply(kind)
  }, setSupportHand(visible:boolean) {
    if (supportHand === visible) return
    supportHand = visible
    for (const part of armIndices) part.geometry.setIndex(visible ? part.both : part.right)
  }, update(dt:number) { grip.restore(); mixer.update(dt); grip.apply(weapon) }, dispose() {
    object.removeFromParent();mixer.stopAllAction();mixer.uncacheRoot(instance.model);instance.dispose();geometries.forEach(g=>g.dispose())
  } }
}

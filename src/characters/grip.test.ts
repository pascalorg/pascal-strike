// @ts-ignore Bun test runtime.
import { expect, test } from 'bun:test'
import { AnimationClip, Bone, Group, Quaternion, QuaternionKeyframeTrack, Vector3 } from 'three'
import { createWeaponGrip } from './grip'

function fixture() {
  const model = new Group(), hand = new Bone(), index = new Bone(), middle = new Bone()
  hand.name='DEF-handR';index.name='DEF-f_index01R';middle.name='DEF-f_middle02R';model.add(hand);hand.add(index,middle)
  const pose = (name: string, angle: number) => new AnimationClip(name,1,[index,middle].map(bone => {
    const q=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),angle)
    return new QuaternionKeyframeTrack(`${bone.name}.quaternion`,[0,1],[...q.toArray(),...q.toArray()])
  }))
  const clips=[pose('Rig|Pistol_Idle_Loop',.1),pose('Rig|Sword_Idle',1.2)]
  return {model,hand,index,middle,clips,grip:createWeaponGrip(model,clips)}
}

test('scraper closes every finger; guns retain a looser trigger finger without moving the wrist',()=>{
  const {hand,index,middle,grip}=fixture(),wrist=hand.quaternion.clone()
  grip.apply('pistol');const gun=index.quaternion.clone()
  expect(gun.angleTo(new Quaternion())).toBeLessThan(middle.quaternion.angleTo(new Quaternion()))
  grip.apply('knife')
  expect(index.quaternion.angleTo(new Quaternion())).toBeCloseTo(1.2,5)
  expect(hand.quaternion.equals(wrist)).toBe(true)
  grip.apply('rifle');expect(index.quaternion.angleTo(gun)).toBeLessThan(1e-7)
})

test('finger overrides never accumulate and restore the current animation before reload/death',()=>{
  const {index,middle,grip,clips}=fixture(),source=Array.from(clips[0].tracks[0].values)
  for(let frame=0;frame<1200;frame++) {
    grip.restore()
    index.quaternion.setFromAxisAngle(new Vector3(0,1,0),frame*.0003)
    middle.quaternion.setFromAxisAngle(new Vector3(0,0,1),frame*.0002)
    const a=index.quaternion.clone(),b=middle.quaternion.clone()
    grip.apply(frame%2?'knife':'pistol');grip.apply('rifle');grip.restore()
    expect(index.quaternion.angleTo(a)).toBeLessThan(1e-7)
    expect(middle.quaternion.angleTo(b)).toBeLessThan(1e-7)
  }
  expect(Array.from(clips[0].tracks[0].values)).toEqual(source)
})

test('missing optional finger tracks leave the animation untouched',()=>{
  const model=new Group(),hand=new Bone();hand.name='DEF-handR';model.add(hand)
  const grip=createWeaponGrip(model,[]),before=hand.quaternion.clone()
  grip.apply('knife');grip.restore();expect(hand.quaternion.equals(before)).toBe(true)
})

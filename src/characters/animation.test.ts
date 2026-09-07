// @ts-ignore Bun test runtime.
import { expect, test } from 'bun:test'
import { AnimationClip, Bone, Group, Quaternion, QuaternionKeyframeTrack } from 'three'
import { createCharacterAnimation } from './animation'

function fixture() {
  const model = new Group(), chest = new Bone(), arm = new Bone(), hips = new Bone()
  chest.name = 'DEF-spine002'; arm.name = 'DEF-upper_armR'; hips.name = 'DEF-hips'
  model.add(hips); hips.add(chest); chest.add(arm)
  const rest = new Quaternion().setFromAxisAngle({x:1,y:0,z:0}, .8).toArray()
  const clip = (name: string) => new AnimationClip(`Rig|${name}`, 1, [
    new QuaternionKeyframeTrack('DEF-upper_armR.quaternion', [0, 1], [...rest, ...rest]),
    new QuaternionKeyframeTrack('DEF-hips.quaternion', [0, 1], [0,0,0,1,0,0,0,1]),
  ])
  const animation = createCharacterAnimation({ object: model, model, clips: ['Idle_Loop','Pistol_Idle_Loop','Pistol_Shoot','Pistol_Reload','Death01'].map(clip), materials: [], sockets: {}, dispose() {} })
  return { animation, chest, arm }
}

test('an untracked spine never accumulates aim while idle or after a background-tab gap', () => {
  const { animation, chest } = fixture()
  animation.update(1/60, 0, false, .6)
  const expected = chest.quaternion.clone()
  for (let i=0;i<1200;i++) animation.update(i===600?10:1/60,0,false,.6)
  expect(chest.quaternion.angleTo(expected)).toBeLessThan(1e-6)
  animation.update(1/60,0,false,0)
  expect(chest.quaternion.angleTo(new Quaternion())).toBeLessThan(1e-6)
  animation.dispose()
})

test('automatic fire always retains a posed upper body, through interruption and respawn', () => {
  const { animation, arm } = fixture()
  for (let i=0;i<600;i++) {
    if (i%6===0) animation.fire('rifle')
    animation.update(1/60,0,false,0)
    expect(arm.quaternion.angleTo(new Quaternion())).toBeGreaterThan(.7)
  }
  animation.die(); animation.update(.1,0,false,0); animation.spawn(); animation.update(1/60,0,false,0)
  expect(arm.quaternion.angleTo(new Quaternion())).toBeGreaterThan(.7)
  animation.dispose()
})

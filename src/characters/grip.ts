import { Quaternion, type AnimationClip, type Object3D } from 'three'
import type { WeaponKind } from '../types'

/** Finger-only overrides: keep the animation's wrist/arm pose and restore before each mixer update. */
export function createWeaponGrip(model: Object3D, clips: AnimationClip[]) {
  const pistol = clips.find(clip => clip.name === 'Rig|Pistol_Idle_Loop')
  const sword = clips.find(clip => clip.name === 'Rig|Sword_Idle')
  const fingers: { bone: Object3D; base: Quaternion; gun: Quaternion; knife: Quaternion }[] = []
  if (pistol && sword) for (const track of pistol.tracks) {
    if (!/^DEF-(?:f_(?:index|middle|ring|pinky)0[123]|thumb0[123])R\.quaternion$/.test(track.name)) continue
    const closed = sword.tracks.find(candidate => candidate.name === track.name)
    const bone = model.getObjectByName(track.name.slice(0, -'.quaternion'.length))
    if (!bone || !closed) continue
    const open = new Quaternion().fromArray(track.values).normalize()
    const knife = new Quaternion().fromArray(closed.values).normalize()
    // The scraper takes the authored full fist. Firearms retain room for the larger grip
    // and keep the index knuckle forward, curling its final two joints onto the trigger.
    const indexBase = track.name.includes('index01')
    const gun = open.clone().slerp(knife, indexBase ? .28 : .65)
    fingers.push({ bone, base: new Quaternion(), gun, knife })
  }
  let applied = false
  return {
    restore() {
      if (!applied) return
      for (const finger of fingers) finger.bone.quaternion.copy(finger.base)
      applied = false
    },
    apply(weapon: WeaponKind) {
      // Idempotent even when a static first-person pose switches without a mixer tick.
      if (!applied) for (const finger of fingers) finger.base.copy(finger.bone.quaternion)
      for (const finger of fingers) finger.bone.quaternion.copy(weapon === 'knife' ? finger.knife : finger.gun)
      applied = true
    },
  }
}

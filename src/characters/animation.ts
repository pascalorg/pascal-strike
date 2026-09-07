import { AnimationClip, AnimationMixer, LoopOnce, LoopRepeat, Quaternion, type AnimationAction, type Object3D } from 'three'
import { PLAYER } from '../config'
import { createWeaponGrip } from './grip'
import type { WeaponKind } from '../types'
import type { CharacterInstance } from './assets'

type Layer = 'full' | 'upper' | 'lower'
interface WeightedAction { action: AnimationAction; weight: number }

/** Keep each layer fully posed, including repeated shots and throttled/background frames. */
export function createCharacterAnimation(character: CharacterInstance) {
  const mixer = new AnimationMixer(character.model)
  const fingers = createWeaponGrip(character.model, character.clips)
  const upperBones = new Set<string>()
  const chest = character.model.getObjectByName('DEF-spine002')
  chest?.traverse(node => upperBones.add(node.name))
  character.model.traverse(node => {
    if (/^DEF-(?:upper_arm|forearm|hand|shoulder|thumb|f_|palm|head|neck|jaw|eye|brow|lid|lip|nose|cheek|ear|teeth|tongue)/.test(node.name)) upperBones.add(node.name)
  })
  const actions = new Map<string, WeightedAction>()
  const layers: Record<Layer, WeightedAction[]> = { full: [], upper: [], lower: [] }
  const targets: Partial<Record<Layer, WeightedAction>> = {}
  const sources = new Map(character.clips.map(c => [c.name.slice(4), c]))
  let upperUntil = 0, time = 0, dead = false, reloading = false, grounded = true
  const aim = new Quaternion(), chestBase = new Quaternion()
  const aimAxis = { x: 1, y: 0, z: 0 }
  let aimApplied = false

  function select(name: string, layer: Layer, once = false, restart = false) {
    const key = `${name}:${layer}`
    let entry = actions.get(key)
    if (!entry) {
      const source = sources.get(name)
      if (!source) return undefined
      const tracks = layer === 'full' ? source.tracks : source.tracks.filter(t => upperBones.has(t.name.slice(0, t.name.lastIndexOf('.'))) === (layer === 'upper'))
      entry = { action: mixer.clipAction(new AnimationClip(key, source.duration, tracks)), weight: 0 }
      actions.set(key, entry); layers[layer].push(entry)
    }
    if (targets[layer] !== entry || restart) {
      // Reset time, never fade back through the bind pose when the same shot interrupts itself.
      entry.action.reset().setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Infinity).play()
      entry.action.clampWhenFinished = once
      if (!targets[layer]) entry.weight = 1
      targets[layer] = entry
    }
    return entry
  }
  function beat(name: string) {
    if (dead) return
    const entry = select(name, 'upper', true, true)
    if (entry) upperUntil = time + entry.action.getClip().duration - 0.08
  }
  function weights(layer: Layer, dt: number, strength: number) {
    const list = layers[layer], target = targets[layer]
    const follow = 1 - Math.exp(-dt * 22)
    let sum = 0
    for (const entry of list) { entry.weight += ((entry === target ? 1 : 0) - entry.weight) * follow; sum += entry.weight }
    for (const entry of list) {
      entry.action.enabled = entry.weight > 0.0001
      entry.action.setEffectiveWeight(sum ? entry.weight / sum * strength : 0)
    }
  }
  return {
    mixer,
    update(dt: number, speed: number, crouching: boolean, pitch: number, nextGrounded = true, nextReloading = false, weapon: WeaponKind = 'rifle', backwards = false) {
      dt = Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), 0.1)
      // Some Studio spine bones have no track; AnimationMixer then leaves their transform alone.
      // Undo last frame's additive aim BEFORE the mixer so it cannot accumulate into a somersault.
      if (chest && aimApplied) chest.quaternion.copy(chestBase)
      fingers.restore()
      time += dt
      if (!dead) {
        grounded = nextGrounded
        if (nextReloading && !reloading) beat('Pistol_Reload')
        reloading = nextReloading
        const motion = !grounded ? 'Jump_Loop' : crouching ? (speed > .2 ? 'Crouch_Fwd_Loop' : 'Crouch_Idle_Loop') : speed > PLAYER.walkSpeed + .5 ? 'Sprint_Loop' : speed > .2 ? 'Walk_Loop' : 'Idle_Loop'
        const lower = select(motion, 'lower')
        if (lower) lower.action.timeScale = speed > .2 && grounded ? Math.max(.65, Math.min(1.5, speed / (crouching ? PLAYER.crouchSpeed : speed > PLAYER.walkSpeed + .5 ? PLAYER.runSpeed : PLAYER.walkSpeed))) * (backwards ? -1 : 1) : 1
        if (time >= upperUntil) select(weapon === 'knife' ? 'Sword_Idle' : 'Pistol_Idle_Loop', 'upper')
      }
      weights('lower', dt, dead ? 0 : 1); weights('upper', dt, dead ? 0 : 1); weights('full', dt, dead ? 1 : 0)
      mixer.update(dt)
      if (!dead && !nextReloading) fingers.apply(weapon)
      aimApplied = !dead && !!chest
      if (aimApplied && chest) {
        chestBase.copy(chest.quaternion)
        aim.setFromAxisAngle(aimAxis, -Math.max(-.65, Math.min(.65, Number.isFinite(pitch) ? pitch : 0)) * .65)
        chest.quaternion.multiply(aim)
      }
    },
    fire(kind: WeaponKind) { if (!reloading) beat(kind === 'knife' ? 'Sword_Attack' : 'Pistol_Shoot') },
    hit() { if (time >= upperUntil) beat('Hit_Chest') },
    die() { if (!dead) { dead = true; select('Death01', 'full', true, true) } },
    spawn() {
      if (chest && aimApplied) chest.quaternion.copy(chestBase)
      fingers.restore()
      aimApplied = false; mixer.stopAllAction()
      for (const layer of ['full', 'upper', 'lower'] as const) { delete targets[layer]; for (const entry of layers[layer]) entry.weight = 0 }
      dead = false; upperUntil = 0; grounded = true; reloading = false
    },
    grip(socket: Object3D, out: Quaternion) {
      const source = sources.get('Pistol_Idle_Loop')!
      const action = mixer.clipAction(source).play(); mixer.update(0)
      character.object.updateWorldMatrix(true, true)
      socket.getWorldQuaternion(out).invert()
      action.stop(); mixer.uncacheAction(source); mixer.update(0)
    },
    dispose() { mixer.stopAllAction(); mixer.uncacheRoot(character.model) },
  }
}

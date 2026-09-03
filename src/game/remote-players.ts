/**
 * Avatars for everyone who is not you (W2): remote humans and bots alike.
 *
 * The registry is the truth — this module only mirrors it into the scene. Positions come from
 * the interpolator (`net/client.ts`) for remotes and from the bot runner for host bots, so both
 * paths end up in `entity.position` and this file never cares which.
 */
import { Vector3 } from 'three'
import type { Scene } from 'three'
import { createAvatar, NAME_TAG_MAX_DISTANCE, type Avatar } from '../player/avatar'
import type { EntityRegistry } from './entities'
import type { Hittable, PlayerEntity, WeaponKind } from '../types'

export interface RemotePlayers {
  /**
   * Sync avatars with the registry and pose them. `now` is the host clock (invincibility),
   * `eye` the local camera position so we can drop avatars that are inside our own head.
   */
  update(now: number, eye?: Vector3): void
  /** Capsules the local projectile sim tests against. Rebuilt only when membership changes. */
  hittables(): Hittable[]
  /** Feet positions of every remote actor — door proximity. */
  positions(): Vector3[]
  /** `colorHex` paints the death splat in the killer's team colour. */
  kill(id: string, colorHex?: number): void
  spawn(id: string): void
  flashHit(id: string): void
  /** Paint a hit on the victim's body, in the shooter's team colour. */
  splat(id: string, point: [number, number, number], colorHex: number): void
  /**
   * World position of a remote's weapon muzzle, written into `out`. False when we have no
   * avatar for them (they left, or their first snapshot has not landed): the caller then
   * falls back to the shot's own origin.
   */
  muzzleFor(id: string, out: Vector3): boolean
  /**
   * They fired: kick the arms and flash the model's muzzle (or swing, for a knife). `weapon`
   * comes from the shot, which knows even when the entity's `w` state has not arrived yet.
   */
  fire(id: string, weapon?: WeaponKind): boolean
  has(id: string): boolean
  /** Drop every avatar (map change); they come back on the next `update()`. */
  clear(): void
  dispose(): void
}

interface Slot {
  avatar: Avatar
  entity: PlayerEntity
  team: string
  name: string
  weapon: WeaponKind
  alive: boolean
  invincible: boolean
  tagVisible: boolean
}

/**
 * Horizontal distance under which a remote avatar is not drawn for us: the camera is then inside
 * their capsule, so all we would see is a wall of torso and marker box clipped by the near plane.
 * They stay hittable — this only skips the draw.
 */
const HIDE_RADIUS = 0.5
const HIDE_RADIUS_SQ = HIDE_RADIUS * HIDE_RADIUS

const _splatPoint = new Vector3()

export function createRemotePlayers(scene: Scene, registry: EntityRegistry): RemotePlayers {
  const slots = new Map<string, Slot>()
  const hittableList: Hittable[] = []
  const positionList: Vector3[] = []
  let membershipDirty = true

  const add = (entity: PlayerEntity): Slot => {
    const avatar = createAvatar(entity.team, entity.name, entity.id)
    if (entity.weapon) avatar.setWeapon(entity.weapon)
    avatar.object.position.copy(entity.position)
    scene.add(avatar.object)
    const slot: Slot = {
      avatar,
      entity,
      team: entity.team,
      name: entity.name,
      weapon: entity.weapon ?? 'rifle',
      alive: true,
      invincible: false,
      tagVisible: true,
    }
    if (!entity.alive) {
      avatar.die()
      slot.alive = false
    }
    slots.set(entity.id, slot)
    membershipDirty = true
    return slot
  }

  const drop = (id: string) => {
    const slot = slots.get(id)
    if (!slot) return
    slot.avatar.dispose()
    slots.delete(id)
    membershipDirty = true
  }

  const offChange = registry.onChange((change, entity) => {
    if (change === 'removed') {
      if (entity) drop(entity.id)
      else for (const id of [...slots.keys()]) drop(id)
    }
  })

  return {
    update(now, eye) {
      for (const entity of registry.list()) {
        if (entity.isLocal) continue
        let slot = slots.get(entity.id)
        if (!slot) slot = add(entity)

        if (slot.team !== entity.team) {
          slot.team = entity.team
          slot.avatar.setTeam(entity.team)
        }
        if (slot.name !== entity.name) {
          slot.name = entity.name
          slot.avatar.setName(entity.name)
        }
        // Weapon switches are rare, so rebuilding the mounted model on the edge is cheaper
        // than keeping three of them alive per avatar.
        const weapon = entity.weapon ?? 'rifle'
        if (slot.weapon !== weapon) {
          slot.weapon = weapon
          slot.avatar.setWeapon(weapon)
        }
        // `kill`/`respawn` RPCs drive the FX, but reliable state can also flip `alive` on its
        // own (join mid-death, host migration) — reconcile so an avatar never lies.
        if (slot.alive !== entity.alive) {
          slot.alive = entity.alive
          if (entity.alive) slot.avatar.spawn()
          else slot.avatar.die()
        }
        const invincible = entity.alive && entity.invincibleUntil > now
        if (slot.invincible !== invincible) {
          slot.invincible = invincible
          slot.avatar.setInvincible(invincible)
        }
        slot.avatar.set(entity.position, entity.yaw, entity.pitch, entity.crouching, entity.speed)
        if (eye) {
          const dx = entity.position.x - eye.x
          const dz = entity.position.z - eye.z
          slot.avatar.object.visible =
            dx * dx + dz * dz > HIDE_RADIUS_SQ || Math.abs(entity.position.y - eye.y) > 2
          // Name tags are labels, not geometry: constant pixel height whatever the range, and
          // gone past NAME_TAG_MAX_DISTANCE, where they are unreadable anyway.
          const tagDistance = slot.avatar.sizeNameTagFor(eye)
          const tagVisible = tagDistance <= NAME_TAG_MAX_DISTANCE
          if (slot.tagVisible !== tagVisible) {
            slot.tagVisible = tagVisible
            slot.avatar.setNameTagVisible(tagVisible)
          }
        }
      }

      // Anyone the registry dropped without an event (defensive).
      if (slots.size > 0) {
        for (const [id] of slots) {
          const entity = registry.get(id)
          if (!entity || entity.isLocal) drop(id)
        }
      }

      if (membershipDirty) {
        hittableList.length = 0
        positionList.length = 0
        for (const slot of slots.values()) {
          hittableList.push(slot.avatar.hittable())
          positionList.push(slot.avatar.object.position)
        }
        membershipDirty = false
      } else {
        // `hittable()` refreshes the capsule from the avatar's current transform.
        let i = 0
        for (const slot of slots.values()) {
          hittableList[i] = slot.avatar.hittable()
          hittableList[i].alive = slot.entity.alive
          i++
        }
      }
    },

    hittables() {
      return hittableList
    },
    positions() {
      return positionList
    },
    kill(id, colorHex) {
      const slot = slots.get(id)
      if (!slot || !slot.alive) return
      slot.alive = false
      slot.avatar.die(colorHex)
      slot.avatar.setInvincible(false)
      slot.invincible = false
    },
    spawn(id) {
      const slot = slots.get(id)
      if (!slot) return
      slot.alive = true
      slot.avatar.spawn()
    },
    flashHit(id) {
      slots.get(id)?.avatar.flashHit()
    },
    splat(id, point, colorHex) {
      const slot = slots.get(id)
      if (!slot || !slot.alive) return
      _splatPoint.set(point[0], point[1], point[2])
      // The avatar snaps the point onto the nearest body part, so a hit point computed on the
      // shooter's machine still lands on the body here.
      slot.avatar.addSplat(_splatPoint, null, colorHex)
    },
    muzzleFor(id, out) {
      const slot = slots.get(id)
      if (!slot) return false
      slot.avatar.muzzleWorld(out)
      return true
    },
    fire(id, weapon) {
      const slot = slots.get(id)
      if (!slot) return false
      slot.avatar.fire(weapon)
      return true
    },
    has(id) {
      return slots.has(id)
    },
    clear() {
      for (const id of [...slots.keys()]) drop(id)
      hittableList.length = 0
      positionList.length = 0
    },
    dispose() {
      offChange()
      for (const id of [...slots.keys()]) drop(id)
      hittableList.length = 0
      positionList.length = 0
    },
  }
}

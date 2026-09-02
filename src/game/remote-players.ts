/**
 * Avatars for everyone who is not you (W2): remote humans and bots alike.
 *
 * The registry is the truth — this module only mirrors it into the scene. Positions come from
 * the interpolator (`net/client.ts`) for remotes and from the bot runner for host bots, so both
 * paths end up in `entity.position` and this file never cares which.
 */
import type { Scene, Vector3 } from 'three'
import { createAvatar, type Avatar } from '../player/avatar'
import type { EntityRegistry } from './entities'
import type { Hittable, PlayerEntity } from '../types'

export interface RemotePlayers {
  /** Sync avatars with the registry and pose them. `now` is the host clock (invincibility). */
  update(now: number): void
  /** Capsules the local projectile sim tests against. Rebuilt only when membership changes. */
  hittables(): Hittable[]
  /** Feet positions of every remote actor — door proximity. */
  positions(): Vector3[]
  kill(id: string): void
  spawn(id: string): void
  flashHit(id: string): void
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
  alive: boolean
  invincible: boolean
}

export function createRemotePlayers(scene: Scene, registry: EntityRegistry): RemotePlayers {
  const slots = new Map<string, Slot>()
  const hittableList: Hittable[] = []
  const positionList: Vector3[] = []
  let membershipDirty = true

  const add = (entity: PlayerEntity): Slot => {
    const avatar = createAvatar(entity.team, entity.name, entity.id)
    avatar.object.position.copy(entity.position)
    scene.add(avatar.object)
    const slot: Slot = {
      avatar,
      entity,
      team: entity.team,
      name: entity.name,
      alive: true,
      invincible: false,
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
    update(now) {
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
    kill(id) {
      const slot = slots.get(id)
      if (!slot || !slot.alive) return
      slot.alive = false
      slot.avatar.die()
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

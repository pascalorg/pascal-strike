/**
 * The registry of everyone in the match: the local player, remote humans and host bots.
 *
 * `PlayerEntity` objects are long-lived and mutated in place — renderers, the HUD and the
 * bot brains all keep references to them, and `position` is a `Vector3` that is written
 * every frame by the interpolator (never reassigned).
 */
import { Vector3 } from 'three'
import { PLAYER } from '../config'
import type { PlayerEntity, TeamId } from '../types'

/** Everything except `id` is optional when upserting; missing fields keep their value. */
export type EntityInit = Partial<Omit<PlayerEntity, 'id' | 'position'>> & {
  id: string
  position?: { x: number; y: number; z: number }
}

export type EntityChange = 'added' | 'removed' | 'updated'

export interface EntityRegistry {
  /** The local player, or null before we know who we are. */
  readonly local: PlayerEntity | null
  /** Create or update in place; returns the (stable) entity object. */
  upsert(init: EntityInit): PlayerEntity
  remove(id: string): void
  get(id: string): PlayerEntity | undefined
  /** Live view — do not mutate the array. Rebuilt only when membership changes. */
  list(): PlayerEntity[]
  byTeam(team: TeamId): PlayerEntity[]
  /** Everyone whose team differs from `team` (bots + humans). */
  enemiesOf(team: TeamId): PlayerEntity[]
  setLocal(id: string | null): void
  /** Called on add/remove and when `notify()` is called after a field change. */
  onChange(cb: (change: EntityChange, entity: PlayerEntity | null) => void): () => void
  notify(entity?: PlayerEntity): void
  clear(): void
  readonly size: number
}

function makeEntity(id: string): PlayerEntity {
  return {
    id,
    name: 'Player',
    team: 'a',
    isBot: false,
    isLocal: false,
    hp: PLAYER.maxHp,
    alive: true,
    invincibleUntil: 0,
    kills: 0,
    deaths: 0,
    position: new Vector3(),
    yaw: 0,
    pitch: 0,
    crouching: false,
    speed: 0,
  }
}

export function createEntityRegistry(): EntityRegistry {
  const map = new Map<string, PlayerEntity>()
  const listeners = new Set<(c: EntityChange, e: PlayerEntity | null) => void>()
  let localId: string | null = null
  let cache: PlayerEntity[] | null = null

  const emit = (change: EntityChange, entity: PlayerEntity | null) => {
    for (const cb of listeners) cb(change, entity)
  }

  const registry: EntityRegistry = {
    get local() {
      return localId ? (map.get(localId) ?? null) : null
    },
    get size() {
      return map.size
    },
    upsert(init) {
      let entity = map.get(init.id)
      const isNew = !entity
      if (!entity) {
        entity = makeEntity(init.id)
        map.set(init.id, entity)
        cache = null
      }
      if (init.armor !== undefined) entity.armor = init.armor
      if (init.taggedUntil !== undefined) entity.taggedUntil = init.taggedUntil
      if (init.character !== undefined) entity.character = init.character
      if (init.grounded !== undefined) entity.grounded = init.grounded
      if (init.reloading !== undefined) entity.reloading = init.reloading
      if (init.name !== undefined) entity.name = init.name
      if (init.team !== undefined) entity.team = init.team
      if (init.isBot !== undefined) entity.isBot = init.isBot
      if (init.isLocal !== undefined) entity.isLocal = init.isLocal
      if (init.hp !== undefined) entity.hp = init.hp
      if (init.alive !== undefined) entity.alive = init.alive
      if (init.spectating !== undefined) entity.spectating = init.spectating
      if (init.invincibleUntil !== undefined) entity.invincibleUntil = init.invincibleUntil
      if (init.kills !== undefined) entity.kills = init.kills
      if (init.deaths !== undefined) entity.deaths = init.deaths
      if (init.yaw !== undefined) entity.yaw = init.yaw
      if (init.pitch !== undefined) entity.pitch = init.pitch
      if (init.crouching !== undefined) entity.crouching = init.crouching
      if (init.speed !== undefined) entity.speed = init.speed
      if (init.position) entity.position.set(init.position.x, init.position.y, init.position.z)
      if (localId === entity.id) entity.isLocal = true
      if (isNew) emit('added', entity)
      return entity
    },
    remove(id) {
      const entity = map.get(id)
      if (!entity) return
      map.delete(id)
      cache = null
      if (localId === id) localId = null
      emit('removed', entity)
    },
    get(id) {
      return map.get(id)
    },
    list() {
      if (!cache) cache = [...map.values()]
      return cache
    },
    byTeam(team) {
      return registry.list().filter((e) => e.team === team)
    },
    enemiesOf(team) {
      return registry.list().filter((e) => e.team !== team)
    },
    setLocal(id) {
      localId = id
      for (const e of map.values()) e.isLocal = e.id === id
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    notify(entity) {
      emit('updated', entity ?? null)
    },
    clear() {
      map.clear()
      cache = null
      localId = null
      emit('removed', null)
    },
  }

  return registry
}

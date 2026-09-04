import { Vector3, type Box3, type Mesh } from 'three'
import { NET } from '../config'
import { createCharacterController } from '../player/controller'
import type {
  BotRunner,
  BotRunnerOptions,
  CharacterController,
  Navigation,
  PlayerEntity,
  PlayerSnapshot,
} from '../types'
import { createMarker, type Marker } from '../weapons/marker'
import { createBotBrain, type BotBrain } from './brain'
import { createPathFollower } from './navigation'
import { createRoamTargetSet } from './roam'

interface SimulatedBot {
  entity: PlayerEntity
  controller: CharacterController
  marker: Marker
  brain: BotBrain
  enemies: PlayerEntity[]
  allies: PlayerEntity[]
  origin: Vector3
  direction: Vector3
  snapshot: PlayerSnapshot
  snapshotElapsed: number
}

/** Host-only bot simulation. All external effects are routed through BotRunnerOptions. */
export function createBotRunner(opts: BotRunnerOptions): BotRunner {
  const bots: SimulatedBot[] = []
  const snapshotPeriod = 1 / NET.botSnapshotHz
  const roamTargets = createRoamTargetSet(opts.map, opts.world, opts.nav)
  // Door leaves and window sashes are out of the movement collider, so a bot only stops at a
  // shut door if its controller tests the leaves themselves. Bots open what is in their way
  // (host-side.ts, DOORS.botOpenRadius), which is what keeps them moving.
  const dynamicColliders: Mesh[] = []
  for (const door of opts.map.doors) for (const leaf of door.leafMeshes) dynamicColliders.push(leaf)

  function findBot(id: string): SimulatedBot | undefined {
    for (let index = 0; index < bots.length; index++) {
      if (bots[index].entity.id === id) return bots[index]
    }
    return undefined
  }

  return {
    update(dt) {
      if (!(dt > 0)) return
      const now = opts.now()
      const entities = opts.entities()
      const spawns = opts.spawns()

      for (let botIndex = 0; botIndex < bots.length; botIndex++) {
        const bot = bots[botIndex]
        const entity = bot.entity
        if (!entity.alive) continue

        bot.enemies.length = 0
        bot.allies.length = 0
        for (let entityIndex = 0; entityIndex < entities.length; entityIndex++) {
          const candidate = entities[entityIndex]
          if (!candidate.alive || candidate.id === entity.id) continue
          if (candidate.team === entity.team) bot.allies.push(candidate)
          else bot.enemies.push(candidate)
        }

        const decision = bot.brain.update(dt, now, bot.enemies, bot.allies, spawns)
        bot.controller.update(dt, decision.move, decision.yaw)
        entity.position.copy(bot.controller.state.position)
        entity.yaw = decision.yaw
        entity.pitch = decision.pitch
        entity.crouching = bot.controller.state.crouching
        entity.speed = Math.hypot(bot.controller.state.velocity.x, bot.controller.state.velocity.z)

        bot.origin.copy(entity.position)
        bot.origin.y += bot.controller.eyeHeight
        const cosPitch = Math.cos(entity.pitch)
        bot.direction.set(
          -Math.sin(entity.yaw) * cosPitch,
          Math.sin(entity.pitch),
          -Math.cos(entity.yaw) * cosPitch,
        )

        bot.marker.setTeam(entity.team)
        // Same call the local player makes every frame: without it the marker keeps its
        // standing sigma, so a bot sprinting sideways shot as straight as one standing still.
        // Bots never walk (no Shift), so the walking flag is always false.
        bot.marker.setMotion(
          entity.speed,
          bot.controller.state.grounded,
          bot.controller.state.crouching,
          false,
        )
        const shots = bot.marker.update(dt, decision.fire, false, bot.origin, bot.direction)
        for (let shotIndex = 0; shotIndex < shots.length; shotIndex++) {
          opts.onShot(entity, shots[shotIndex])
        }

        bot.snapshotElapsed += dt
        if (bot.snapshotElapsed >= snapshotPeriod) {
          bot.snapshotElapsed %= snapshotPeriod
          const snapshot = bot.snapshot
          snapshot.x = entity.position.x
          snapshot.y = entity.position.y
          snapshot.z = entity.position.z
          snapshot.yaw = entity.yaw
          snapshot.pitch = entity.pitch
          snapshot.c = entity.crouching ? 1 : 0
          snapshot.t = now
          opts.onSnapshot(entity, snapshot)
        }
      }
    },

    addBot(entity) {
      if (!entity.isBot) throw new Error(`Cannot simulate non-bot entity ${entity.id}`)
      if (findBot(entity.id)) return

      const controller = createCharacterController(opts.map.collider)
      controller.setDynamicColliders?.(dynamicColliders)
      controller.setPosition(entity.position)
      const rng = mulberry32(mixSeed(opts.seed ?? 0, hashString(entity.id)))
      const botNavigation = createSeededNavigation(opts.nav, opts.map.bounds, rng)
      const pathFollower = createPathFollower(botNavigation)
      const marker = createMarker({ ownerId: entity.id, team: entity.team, now: opts.now })
      const brain = createBotBrain({
        self: entity,
        world: opts.world,
        nav: botNavigation,
        rng,
        pathFollower,
        roamTargets,
      })

      bots.push({
        entity,
        controller,
        marker,
        brain,
        enemies: [],
        allies: [],
        origin: new Vector3(),
        direction: new Vector3(0, 0, -1),
        snapshot: {
          x: entity.position.x,
          y: entity.position.y,
          z: entity.position.z,
          yaw: entity.yaw,
          pitch: entity.pitch,
          c: entity.crouching ? 1 : 0,
          t: opts.now(),
        },
        snapshotElapsed: 0,
      })
    },

    removeBot(id) {
      for (let index = 0; index < bots.length; index++) {
        if (bots[index].entity.id !== id) continue
        bots.splice(index, 1)
        return
      }
    },

    respawn(id, position, yaw) {
      const bot = findBot(id)
      if (!bot) return
      bot.controller.setPosition(position)
      bot.entity.position.copy(position)
      bot.entity.yaw = yaw
      bot.entity.pitch = 0
      bot.entity.crouching = false
      bot.entity.speed = 0
      bot.marker.reset()
      bot.brain.reset(opts.now())
      bot.snapshotElapsed = snapshotPeriod
    },

    dispose() {
      bots.length = 0
    },
  }
}

/** Navigation's random-point contract has no RNG parameter, so the runner samples a
 * deterministic point and snaps it to the shared navmesh instead. */
function createSeededNavigation(nav: Navigation, bounds: Box3, rng: () => number): Navigation {
  const sample = new Vector3()
  return {
    ready: nav.ready,
    findPath: (from, to) => nav.findPath(from, to),
    randomPoint() {
      sample.set(
        bounds.min.x + (bounds.max.x - bounds.min.x) * rng(),
        bounds.min.y + 0.5,
        bounds.min.z + (bounds.max.z - bounds.min.z) * rng(),
      )
      return nav.closestPoint(sample)
    },
    randomPointAround(center, radius) {
      const angle = rng() * Math.PI * 2
      const distance = Math.sqrt(rng()) * radius
      sample.set(
        center.x + Math.cos(angle) * distance,
        center.y,
        center.z + Math.sin(angle) * distance,
      )
      return nav.closestPoint(sample)
    },
    closestPoint: (point) => nav.closestPoint(point),
  }
}

function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function mixSeed(seed: number, idHash: number): number {
  let mixed = (seed ^ idHash ^ 0x9e3779b9) >>> 0
  mixed = Math.imul(mixed ^ mixed >>> 16, 0x21f0aaad)
  mixed = Math.imul(mixed ^ mixed >>> 15, 0x735a2d97)
  return (mixed ^ mixed >>> 15) >>> 0
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let next = value
    next = Math.imul(next ^ next >>> 15, next | 1)
    next ^= next + Math.imul(next ^ next >>> 7, next | 61)
    return ((next ^ next >>> 14) >>> 0) / 4294967296
  }
}

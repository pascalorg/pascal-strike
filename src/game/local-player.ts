/**
 * The player you actually control (W2).
 *
 * Pipeline, once per frame: input → look → character controller → FPS camera → view model →
 * marker → `onShot`. The controller runs on the engine's fixed step so it stays deterministic
 * and identical to the one the host runs for bots; everything visual runs per frame.
 *
 * Movement and shooting are gated on pointer lock, except when a debug override is active —
 * that is how the automated playtests drive the player without a real mouse.
 */
import { MathUtils, Vector3 } from 'three'
import { PLAYER, WEAPON } from '../config'
import type { Audio, AudioListenerPose } from '../engine/audio'
import type { Input } from '../engine/input'
import type { Engine } from '../engine/renderer'
import { createFpsCamera, type FpsCamera } from '../player/camera'
import { createCharacterController } from '../player/controller'
import { createViewModel, type ViewModel } from '../player/viewmodel'
import type {
  CharacterController,
  Hittable,
  MoveInput,
  PlayerEntity,
  PlayerSnapshot,
  ShotEvent,
  TeamId,
} from '../types'
import { createMarker, type Marker } from '../weapons/marker'
import type { MapSession } from './map-session'

export interface LocalPlayerOptions {
  engine: Engine
  input: Input
  audio: Audio
  session: MapSession
  entity: PlayerEntity
  now: () => number
  /** Spawn the projectile locally and tell everyone else about the shot. */
  onShot: (shot: ShotEvent) => void
  /** The controller left the world — ask the host to put us back. */
  onFell: () => void
}

/** Injected input for headless playtests (`window.__ps`). */
export interface LocalPlayerDebug {
  /** Overrides WASD until `clear()`. */
  setMove(forward: number, right: number, jump?: boolean, crouch?: boolean): void
  /** Radians-free: same units as raw mouse movement (pixels). */
  look(dx: number, dy: number): void
  setFire(on: boolean): void
  reload(): void
  clear(): void
  readonly active: boolean
}

export interface LocalPlayer {
  readonly controller: CharacterController
  readonly position: Vector3
  readonly yaw: number
  readonly pitch: number
  readonly dead: boolean
  readonly marker: Marker
  /** 0..1 crosshair bloom from recoil. */
  readonly spread: number
  /** Camera eye + look direction, for positional audio. */
  readonly listener: AudioListenerPose
  setSession(session: MapSession): void
  setTeam(team: TeamId): void
  fixedUpdate(dt: number): void
  frameUpdate(dt: number): void
  snapshot(): PlayerSnapshot
  hittable(): Hittable
  place(position: Vector3 | [number, number, number], yaw: number): void
  die(): void
  revive(): void
  debug: LocalPlayerDebug
  dispose(): void
}

const MAX_PITCH = Math.PI / 2 - 0.05
const FOOTSTEP_DISTANCE = 2.2
/** Frame delta cap for the critically damped camera/view-model springs. */
const SPRING_MAX_DT = 1 / 30
/** How fast the crosshair bloom decays back to zero. */
const SPREAD_DECAY = 3.4

const _eye = new Vector3()
const _look = new Vector3()
const _spawn = new Vector3()

export function createLocalPlayer(opts: LocalPlayerOptions): LocalPlayer {
  const { engine, input, audio, entity } = opts
  const camera = engine.camera
  // A view model parented to the camera only renders if the camera itself is in the scene.
  if (!camera.parent) engine.scene.add(camera)

  let session = opts.session
  let controller = makeController(session)
  const fpsCamera: FpsCamera = createFpsCamera(camera)
  const viewModel: ViewModel = createViewModel(camera)
  viewModel.setTeam(entity.team)
  const marker: Marker = createMarker({ ownerId: entity.id, team: entity.team, now: opts.now })

  const move: MoveInput = { forward: 0, right: 0, jump: false, crouch: false }
  const override: MoveInput = { forward: 0, right: 0, jump: false, crouch: false }
  const listener: AudioListenerPose = { position: new Vector3(), forward: new Vector3(0, 0, -1) }
  const hittable: Hittable = {
    id: entity.id,
    team: entity.team,
    alive: true,
    capsuleStart: new Vector3(),
    capsuleEnd: new Vector3(),
    capsuleRadius: PLAYER.radius,
  }

  let yaw = 0
  let pitch = 0
  let dead = false
  let deathDrop = 0
  let deathTilt = 0
  let spread = 0
  let footstepDistance = 0
  let wasGrounded = true
  let wasReloading = false
  let pendingLookX = 0
  let pendingLookY = 0
  let overrideMove = false
  let overrideFire: boolean | null = null
  let overrideReload = false

  function makeController(next: MapSession): CharacterController {
    return createCharacterController(next.map.collider, { onFellOut: () => opts.onFell() })
  }

  const player: LocalPlayer = {
    get controller() {
      return controller
    },
    get position() {
      return controller.state.position
    },
    get yaw() {
      return yaw
    },
    get pitch() {
      return pitch
    },
    get dead() {
      return dead
    },
    marker,
    get spread() {
      return spread
    },
    listener,

    setSession(next) {
      session = next
      const previous = controller.state.position.clone()
      controller = makeController(next)
      controller.setPosition(previous)
    },

    setTeam(team) {
      hittable.team = team
      marker.setTeam(team)
      viewModel.setTeam(team)
    },

    fixedUpdate(dt) {
      if (dead) return
      const source = overrideMove ? override : input.locked ? input.move : ZERO_MOVE
      move.forward = source.forward
      move.right = source.right
      move.jump = source.jump
      move.crouch = source.crouch
      const fallSpeed = controller.state.velocity.y
      controller.update(dt, move, yaw)
      if (!wasGrounded && controller.state.grounded) fpsCamera.landing(fallSpeed)
      wasGrounded = controller.state.grounded
    },

    frameUpdate(dt) {
      const mouse = input.consumeLook()
      const dx = (input.locked ? mouse.dx : 0) + pendingLookX
      const dy = (input.locked ? mouse.dy : 0) + pendingLookY
      pendingLookX = 0
      pendingLookY = 0
      if (!dead) {
        yaw -= dx * PLAYER.lookSensitivity
        pitch = MathUtils.clamp(pitch - dy * PLAYER.lookSensitivity, -MAX_PITCH, MAX_PITCH)
      }

      const speed = Math.hypot(controller.state.velocity.x, controller.state.velocity.z)
      // The camera and view-model springs (`-95x - 18v`) go unstable above ~0.11 s, and a frame
      // can easily be that long while the navmesh builds or a shader compiles. Weapon timing
      // still uses the real dt; only the cosmetic springs are clamped.
      const springDt = dt > SPRING_MAX_DT ? SPRING_MAX_DT : dt

      if (dead) {
        // Camera stays where we fell over: a slow drop to knee height plus a roll.
        deathDrop = Math.min(1, deathDrop + springDt * 2.2)
        deathTilt = Math.min(1, deathTilt + springDt * 1.6)
        camera.position.set(
          controller.state.position.x,
          controller.state.position.y + controller.eyeHeight - deathDrop * (controller.eyeHeight - 0.45),
          controller.state.position.z,
        )
        camera.rotation.order = 'YXZ'
        camera.rotation.set(pitch - deathTilt * 0.25, yaw, deathTilt * 0.5)
        camera.updateMatrixWorld()
      } else {
        fpsCamera.update(
          springDt,
          controller.state.position,
          controller.eyeHeight,
          yaw,
          pitch,
          speed,
          controller.state.grounded,
        )
      }

      fpsCamera.getEyePosition(_eye)
      fpsCamera.getLookDirection(_look)
      listener.position.copy(_eye)
      listener.forward.copy(_look)

      const firing = !dead && (overrideFire ?? (input.locked ? input.fire : false))
      const reloading = (input.locked && input.reload) || overrideReload
      overrideReload = false
      const shots = marker.update(dt, firing, reloading, _eye, _look)
      for (const shot of shots) {
        viewModel.fire()
        fpsCamera.kick(WEAPON.recoilPitch, (shot.seed & 1 ? 1 : -1) * WEAPON.recoilPitch * 0.25)
        session.effects.muzzle(_eye, _look, shot.team)
        audio.play('shot')
        spread = Math.min(1, spread + 0.22)
        opts.onShot(shot)
      }

      spread = Math.max(0, spread - dt * SPREAD_DECAY)
      if (marker.reloading) viewModel.reload(marker.reloadProgress)
      if (!wasReloading && marker.reloading) audio.play('reload')
      wasReloading = marker.reloading
      viewModel.update(springDt, speed, controller.state.grounded)
      viewModel.object.visible = !dead

      if (!dead && controller.state.grounded) {
        footstepDistance += speed * dt
        if (footstepDistance > FOOTSTEP_DISTANCE) {
          footstepDistance = 0
          audio.play('footstep')
        }
      }

      // The registry entry is what the rest of the game (HUD, doors, bots) reads.
      entity.position.copy(controller.state.position)
      entity.yaw = yaw
      entity.pitch = pitch
      entity.crouching = controller.state.crouching
      entity.speed = speed
      input.update()
    },

    snapshot() {
      const p = controller.state.position
      return {
        x: p.x,
        y: p.y,
        z: p.z,
        yaw,
        pitch,
        c: controller.state.crouching ? 1 : 0,
        t: opts.now(),
      }
    },

    hittable() {
      const p = controller.state.position
      hittable.alive = !dead
      hittable.team = entity.team
      hittable.capsuleStart.set(p.x, p.y + PLAYER.radius, p.z)
      hittable.capsuleEnd.set(p.x, p.y + controller.height - PLAYER.radius, p.z)
      return hittable
    },

    place(position, yawValue) {
      if (Array.isArray(position)) _spawn.set(position[0], position[1], position[2])
      else _spawn.copy(position)
      controller.setPosition(_spawn)
      yaw = yawValue
      pitch = 0
      wasGrounded = false
      footstepDistance = 0
    },

    die() {
      if (dead) return
      dead = true
      deathDrop = 0
      deathTilt = 0
      hittable.alive = false
      marker.reset()
    },

    revive() {
      dead = false
      deathDrop = 0
      deathTilt = 0
      hittable.alive = true
      marker.reset()
      spread = 0
    },

    debug: {
      setMove(forward, right, jump = false, crouch = false) {
        overrideMove = true
        override.forward = forward
        override.right = right
        override.jump = jump
        override.crouch = crouch
      },
      look(dx, dy) {
        pendingLookX += dx
        pendingLookY += dy
      },
      setFire(on) {
        overrideFire = on
      },
      reload() {
        overrideReload = true
      },
      clear() {
        overrideMove = false
        overrideFire = null
        override.forward = 0
        override.right = 0
        override.jump = false
        override.crouch = false
      },
      get active() {
        return overrideMove || overrideFire !== null
      },
    },

    dispose() {
      viewModel.dispose()
    },
  }

  return player
}

const ZERO_MOVE: MoveInput = { forward: 0, right: 0, jump: false, crouch: false }

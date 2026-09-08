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
import { taggingScale } from './combat'
import type { Audio, AudioListenerPose } from '../engine/audio'
import type { Input } from '../engine/input'
import type { Engine } from '../engine/renderer'
import { createFpsCamera, type FpsCamera } from '../player/camera'
import { createCharacterController } from '../player/controller'
import { createViewModel, type ViewModel } from '../player/viewmodel'
import { computeHitShapes, createHitShapes } from '../player/hitshapes'
import type {
  CharacterController,
  HitEvent,
  Hittable,
  MoveInput,
  PlayerEntity,
  PlayerSnapshot,
  ShotEvent,
  TeamId,
  WeaponKind,
} from '../types'
import { createMarker, weaponSpec, WEAPON_BY_SLOT, type Marker } from '../weapons/marker'
import { createMelee, type Melee } from '../weapons/melee'
import {
  bindFootstepAudio,
  createFootstepCadence,
  didStartJump,
  localLandingGain,
  LOCAL_RUN_THRESHOLD,
} from './footsteps'
import type { MapSession } from './map-session'

export interface LocalPlayerOptions {
  engine: Engine
  input: Input
  audio: Audio
  session: MapSession
  entity: PlayerEntity
  players?: () => readonly PlayerEntity[]
  now: () => number
  /** Spawn the projectile locally and tell everyone else about the shot. */
  onShot: (shot: ShotEvent) => void
  /** The controller left the world — ask the host to put us back. */
  onFell: () => void
  /**
   * The player switched weapon. The game owner writes it to the room
   * (`room.me.setState('w', kind, true)`) so remotes can show the right model in the avatar's
   * hands; without it the weapon is local-only. See `PlayerEntity.weapon` in types.ts.
   */
  onWeapon?: (kind: WeaponKind) => void
  /**
   * Where a hit this client detected goes. Defaults to the projectile sim's own callback
   * list, which the game already routes to the host — melee travels the paintball's path.
   */
  onHit?: (hit: HitEvent) => void
}

/** Injected input for headless playtests (`window.__ps`). */
export interface LocalPlayerDebug {
  /** Overrides WASD until `clear()`. */
  setMove(forward: number, right: number, jump?: boolean, crouch?: boolean, walk?: boolean): void
  /** Select a weapon by kind or by slot number (1/2/3), as the number keys would. */
  setWeapon(weapon: WeaponKind | number): void
  /** Radians-free: same units as raw mouse movement (pixels). */
  look(dx: number, dy: number): void
  setFire(on: boolean): void
  reload(): void
  clear(): void
}

export interface LocalPlayer {
  readonly controller: CharacterController
  readonly position: Vector3
  readonly yaw: number
  readonly pitch: number
  readonly dead: boolean
  /** True while we are on the team screen: no body, no weapon, no camera of our own. */
  readonly spectating: boolean
  readonly marker: Marker
  /** The weapon in hand. */
  readonly weapon: WeaponKind
  /** 0..1 crosshair bloom from recoil. */
  readonly spread: number
  /** Camera eye + look direction, for positional audio. */
  readonly listener: AudioListenerPose
  setSession(session: MapSession): void
  setTeam(team: TeamId): void
  /**
   * Enter or leave spectate (W5-A): before you have picked a side you have no body in the house
   * and no camera of your own — the team screen's overview camera flies the engine camera, so
   * `frameUpdate` must not fight it for the transform.
   */
  setSpectating(on: boolean): void
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
/** Frame delta cap for the critically damped camera/view-model springs. */
const SPRING_MAX_DT = 1 / 30
/** How fast the crosshair follows `marker.currentSpreadDeg` (it is already damped there). */
const SPREAD_FOLLOW = 12
/** `currentSpreadDeg` that maps to a fully open crosshair (running + saturated bloom). */
const SPREAD_MAX_DEG = WEAPON.spreadRunningDeg + WEAPON.spreadBloomMaxDeg
/** Shift walk: steadier camera and quieter steps than the default run. */
const WALK_BOB_SCALE = 0.55

const _eye = new Vector3()
const _look = new Vector3()
const _spawn = new Vector3()
const _muzzle = new Vector3()
const _smear = new Vector3()
const _smearPoint = new Vector3()
const _up = new Vector3(0, 1, 0)

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
  const melee: Melee = createMelee({ ownerId: entity.id, team: entity.team, now: opts.now })
  /** Swings are numbered on their own so a swing id can never collide with a shot id. */
  let swingCounter = 0
  entity.weapon = marker.weapon

  const move: MoveInput = { forward: 0, right: 0, jump: false, crouch: false, walk: false }
  const override: MoveInput = { forward: 0, right: 0, jump: false, crouch: false, walk: false }
  const listener: AudioListenerPose = { position: new Vector3(), forward: new Vector3(0, 0, -1) }
  const unbindFootstepAudio = bindFootstepAudio(engine.scene, audio, listener)
  const footsteps = createFootstepCadence(LOCAL_RUN_THRESHOLD)
  const hittable: Hittable = {
    id: entity.id,
    team: entity.team,
    alive: true,
    capsuleStart: new Vector3(),
    capsuleEnd: new Vector3(),
    capsuleRadius: PLAYER.radius,
    // Body parts so the host's projectile sim (bots shooting me) applies head/limb damage.
    shapes: createHitShapes(),
  }

  let yaw = 0
  let pitch = 0
  let dead = false
  let spectating = false
  let deathDrop = 0
  let deathTilt = 0
  let spread = 0
  let wasGrounded = true
  let wasReloading = false
  let pendingLookX = 0
  let pendingLookY = 0
  let overrideMove = false
  let overrideFire: boolean | null = null
  let overrideReload = false
  let pendingSlot = 0

  /**
   * Switch slots. The marker owns the 0.35 s lockout and the per-weapon magazines; the view
   * model plays the lower/raise; the entity and the room state carry the choice to everyone
   * else (`PlayerEntity.weapon`, player state `w`).
   */
  function selectWeapon(kind: WeaponKind): void {
    if (!marker.setWeapon(kind)) return
    // Drop a half-finished swing: putting the knife away has to cancel it, or its hit frame
    // resolves the next time the knife comes up.
    melee.reset()
    viewModel.setWeapon(kind)
    input.setWeaponSlot(weaponSpec(kind).slot)
    entity.weapon = kind
    audio.play('weaponSwitch')
    // The game orchestrator takes it from here: the room state `w` for everyone else, and the
    // HUD's weapon widget (which it also drives from its own poll).
    opts.onWeapon?.(kind)
  }

  function makeController(next: MapSession): CharacterController {
    return createCharacterController(next.map.collider, {
      onFellOut: () => opts.onFell(),
      playerCollisions: opts.players ? { id: entity.id, players: opts.players } : undefined,
    })
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
    get spectating() {
      return spectating
    },
    marker,
    get weapon() {
      return marker.weapon
    },
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
      melee.setTeam(team)
      viewModel.setTeam(team)
    },

    setSpectating(on) {
      if (spectating === on) return
      spectating = on
      entity.spectating = on
      hittable.alive = !on && !dead
      viewModel.object.visible = !on
      if (on) {
        // Drop a half-pressed trigger and a half-finished reload: the marker comes back with a
        // full hopper when we spawn, exactly like a respawn.
        marker.reset()
        melee.reset()
      } else {
        spread = 0
        wasGrounded = false
        footsteps.reset()
      }
    },

    fixedUpdate(dt) {
      if (dead || spectating) return
      const source = overrideMove ? override : input.locked ? input.move : ZERO_MOVE
      // A lighter weapon moves you faster (`WEAPONS[kind].moveSpeedScale`): the controller
      // takes it as a target-speed multiplier, because the wish vector it would otherwise
      // scale is clamped to 1 and could only ever slow the player down.
      move.forward = source.forward
      move.right = source.right
      move.jump = source.jump
      move.crouch = source.crouch
      move.walk = source.walk ?? false
      const groundedBeforeUpdate = controller.state.grounded
      const fallSpeed = controller.state.velocity.y
      controller.update(dt, move, yaw, marker.moveSpeedScale * taggingScale(entity.taggedUntil, performance.now()))
      // Host bots run next in this fixed step and must collide with our current pose.
      entity.position.copy(controller.state.position)
      entity.crouching = controller.state.crouching
      if (didStartJump(groundedBeforeUpdate, controller.state.grounded, move.jump, controller.state.velocity.y)) {
        audio.play('jump')
      }
      const landGain = localLandingGain(groundedBeforeUpdate, controller.state.grounded, fallSpeed)
      if (landGain > 0) audio.play('land', undefined, undefined, landGain)
      if (!wasGrounded && controller.state.grounded) fpsCamera.landing(fallSpeed)
      wasGrounded = controller.state.grounded
    },

    frameUpdate(dt) {
      const mouse = input.consumeLook()
      const dx = (input.locked ? mouse.dx : 0) + pendingLookX
      const dy = (input.locked ? mouse.dy : 0) + pendingLookY
      pendingLookX = 0
      pendingLookY = 0
      if (spectating) {
        // Nothing of ours drives the camera here — the overview orbit owns it — so all this
        // does is keep the audio listener on the flying camera and drain the input edges that
        // `input.update()` would otherwise hand to the next frame as a jump or a shot.
        camera.getWorldPosition(_eye)
        camera.getWorldDirection(_look)
        listener.position.copy(_eye)
        listener.forward.copy(_look)
        viewModel.object.visible = false
        pendingSlot = 0
        overrideReload = false
        input.update()
        return
      }
      if (!dead) {
        yaw -= dx * PLAYER.lookSensitivity
        pitch = MathUtils.clamp(pitch - dy * PLAYER.lookSensitivity, -MAX_PITCH, MAX_PITCH)
      }

      const speed = Math.hypot(controller.state.velocity.x, controller.state.velocity.z)
      // The camera and view-model springs (`-95x - 18v`) go unstable above ~0.11 s, and a frame
      // can easily be that long while the navmesh builds or a shader compiles. Weapon timing
      // still uses the real dt; only the cosmetic springs are clamped.
      const springDt = dt > SPRING_MAX_DT ? SPRING_MAX_DT : dt
      const walking = move.walk === true

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
          walking ? WALK_BOB_SCALE : 1,
        )
      }

      fpsCamera.getEyePosition(_eye)
      fpsCamera.getLookDirection(_look)
      listener.position.copy(_eye)
      listener.forward.copy(_look)

      // Slot keys and the wheel. Read before `input.update()` clears the edge (it runs at the
      // end of this function), and ignored while dead — you respawn with what you had.
      const slot = pendingSlot || (input.locked ? input.weaponSlot : 0)
      pendingSlot = 0
      if (slot >= 1 && slot <= WEAPON_BY_SLOT.length && !dead) selectWeapon(WEAPON_BY_SLOT[slot - 1])

      const firing = !dead && (overrideFire ?? (input.locked ? input.fire : false))
      const reloading = (input.locked && input.reload) || overrideReload
      overrideReload = false
      marker.setMotion(speed, controller.state.grounded, controller.state.crouching, walking)
      const shots = marker.update(dt, firing, reloading, _eye, _look)
      // The knife: `marker` only holds the switch lockout, the swing itself lives in melee.ts.
      if (marker.weapon === 'knife' && !marker.switching) {
        const swing = melee.update(dt, firing, _eye, _look, session.projectiles.targets, session.world)
        if (swing.started) {
          viewModel.swing()
          audio.play('knifeSwing')
          // Nobody else can see a swing otherwise: melee.ts sends only a `hit` to the host, and
          // `DamageEvent` carries no weapon, so a knife that misses (or kills) leaves no trace
          // on other screens. Ride the shot path — it is already broadcast to OTHERS and
          // already knows to animate the swing instead of spawning a ball.
          opts.onShot({
            id: `${entity.id}:swing:${++swingCounter}`,
            by: entity.id,
            team: entity.team,
            origin: [_eye.x, _eye.y, _eye.z],
            dir: [_look.x, _look.y, _look.z],
            speed: 0,
            t: Date.now(),
            seed: swing.seed,
            weapon: 'knife',
          })
        }
        for (const hit of swing.hits) {
          audio.play('knifeHit')
          if (opts.onHit) opts.onHit(hit)
          else session.projectiles.reportHit(hit)
        }
        // A miss that lands on a wall wipes paint off the blade: two overlapping splats
        // along the swing read as a smear rather than a bullet splat.
        if (swing.surface) {
          const target = swing.surface.object as Parameters<typeof session.decals.add>[0]
          _smear.copy(swing.surface.normal).cross(_up)
          if (_smear.lengthSq() < 1e-6) _smear.set(1, 0, 0)
          else _smear.normalize()
          for (let i = -1; i <= 1; i++) {
            _smearPoint.copy(swing.surface.point).addScaledVector(_smear, i * 0.09)
            session.decals.add(target, _smearPoint, swing.surface.normal, entity.team, swing.seed + i)
          }
          session.effects.splat(swing.surface.point, swing.surface.normal, entity.team)
          audio.play('splat', swing.surface.point, listener)
        }
      }
      for (const shot of shots) {
        viewModel.fire()
        // Yaw kick is +-30 % of the pitch kick, side picked from the shot seed so the
        // recoil pattern is identical on every client replaying the same shots.
        const yawSign = shot.seed & 1 ? 1 : -1
        const yawScale = 0.3 * (0.35 + ((shot.seed >>> 8) & 0xff) / 255 * 0.65)
        fpsCamera.kick(WEAPON.recoilPitch, yawSign * WEAPON.recoilPitch * yawScale)
        session.effects.muzzle(viewModel.muzzleWorld(_muzzle), _look, shot.team)
        audio.play(shot.weapon === 'pistol' ? 'pistolShot' : 'shot')
        opts.onShot(shot)
      }
      if (marker.dryFire) audio.play('dryFire')

      // The HUD crosshair is a direct read-out of the marker's accuracy, not a separate
      // animation, so what the player sees is what the next shot actually does.
      const spreadTarget = MathUtils.clamp(
        (marker.currentSpreadDeg - WEAPON.spreadStandingDeg) /
          (SPREAD_MAX_DEG - WEAPON.spreadStandingDeg),
        0,
        1,
      )
      spread += (spreadTarget - spread) * Math.min(1, dt * SPREAD_FOLLOW)
      viewModel.setHopper(marker.hopper, marker.magazine)
      if (marker.reloading) viewModel.reload(marker.reloadProgress)
      if (!wasReloading && marker.reloading) audio.play('reloadStart')
      if (wasReloading && !marker.reloading) audio.play('reloadEnd')
      wasReloading = marker.reloading
      viewModel.update(springDt, speed, controller.state.grounded)
      viewModel.object.visible = !dead

      if (
        footsteps.update(
          dt,
          speed,
          !dead && controller.state.grounded,
          controller.state.crouching || walking,
        )
      ) {
        audio.play('footstep')
      }

      // The registry entry is what the rest of the game (HUD, doors, bots) reads.
      entity.position.copy(controller.state.position)
      entity.yaw = yaw
      entity.pitch = pitch
      entity.crouching = controller.state.crouching
      entity.speed = speed
      entity.grounded = controller.state.grounded
      entity.reloading = marker.reloading
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
        // `Date.now()`, as the contract says — never the estimated host clock. Receivers play
        // snapshots back on their own arrival timeline (`net/sync.ts`), so all this has to be
        // is a monotonic stamp from this machine; an estimate that steps every 5 s is worse.
        t: Date.now(),
      }
    },

    hittable() {
      const p = controller.state.position
      hittable.alive = !dead && !spectating
      hittable.team = entity.team
      hittable.capsuleStart.set(p.x, p.y + PLAYER.radius, p.z)
      hittable.capsuleEnd.set(p.x, p.y + controller.height - PLAYER.radius, p.z)
      computeHitShapes(hittable.shapes!, p, entity.yaw, controller.state.crouching)
      return hittable
    },

    place(position, yawValue) {
      if (Array.isArray(position)) _spawn.set(position[0], position[1], position[2])
      else _spawn.copy(position)
      controller.setPosition(_spawn)
      yaw = yawValue
      pitch = 0
      wasGrounded = false
      footsteps.reset()
    },

    die() {
      if (dead) return
      dead = true
      deathDrop = 0
      deathTilt = 0
      hittable.alive = false
      marker.reset()
      melee.reset()
      footsteps.reset()
    },

    revive() {
      dead = false
      deathDrop = 0
      deathTilt = 0
      // The host spawns us the moment we pick a side, so the respawn RPC can land a frame before
      // the game takes us out of spectate; staying unhittable until it does is the honest answer.
      hittable.alive = !spectating
      marker.reset()
      melee.reset()
      spread = 0
    },

    debug: {
      setMove(forward, right, jump = false, crouch = false, walk = false) {
        overrideMove = true
        override.forward = forward
        override.right = right
        override.jump = jump
        override.crouch = crouch
        override.walk = walk
      },
      setWeapon(weapon) {
        const kind = typeof weapon === 'number'
          ? WEAPON_BY_SLOT[Math.round(weapon) - 1]
          : weapon
        if (!kind) return
        // Go through the same edge the keys use, so a debug switch is a real switch.
        pendingSlot = weaponSpec(kind).slot
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
        override.walk = false
      },
    },

    dispose() {
      unbindFootstepAudio()
      viewModel.dispose()
    },
  }

  return player
}

const ZERO_MOVE: MoveInput = { forward: 0, right: 0, jump: false, crouch: false, walk: false }

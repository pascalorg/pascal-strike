import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  MathUtils,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Timer,
  Vector3,
} from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { PLAYER, TEAMS, WEAPON } from '../config'
import { createAudio } from '../engine/audio'
import { createInput } from '../engine/input'
import { createAvatar, type Avatar } from '../player/avatar'
import { createFpsCamera } from '../player/camera'
import { createCharacterController } from '../player/controller'
import { createViewModel } from '../player/viewmodel'
import type { MoveInput } from '../types'
import { createDecals } from '../weapons/decals'
import { createEffects } from '../weapons/effects'
import { createMarker } from '../weapons/marker'
import { createProjectiles } from '../weapons/projectiles'
import { buildTestRoom } from './test-room'

interface Dummy {
  avatar: Avatar
  hp: number
  position: Vector3
  base: Vector3
  phase: number
  enemy: boolean
  deadUntil: number
}

interface SandboxDebug {
  input: ReturnType<typeof createInput>
  controller: ReturnType<typeof createCharacterController>
  marker: ReturnType<typeof createMarker>
  projectiles: ReturnType<typeof createProjectiles>
  decals: ReturnType<typeof createDecals>
  effects: ReturnType<typeof createEffects>
  dummies: Dummy[]
  autopilot: { enabled: boolean; stage: number; wallShots: number; dummyShots: number }
}

declare global {
  interface Window { __ps?: SandboxDebug }
}

const eye = new Vector3()
const look = new Vector3()
const targetDirection = new Vector3()
const moveInput: MoveInput = { forward: 0, right: 0, jump: false, crouch: false }
const FIXED_DT = 1 / 120

export async function start(): Promise<void> {
  const app = document.getElementById('app') ?? document.body
  app.innerHTML = ''
  document.body.style.margin = '0'
  document.body.style.overflow = 'hidden'

  const renderer = new WebGPURenderer({ antialias: true })
  await renderer.init()
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.shadowMap.enabled = true
  app.append(renderer.domElement)

  const scene = new Scene()
  scene.background = new Color(0x18181b)
  scene.fog = new Fog(0x18181b, 15, 35)
  const camera = new PerspectiveCamera(PLAYER.fov, innerWidth / innerHeight, 0.03, 80)
  scene.add(camera)

  const hemi = new HemisphereLight(0xdbeafe, 0x27272a, 2.1)
  scene.add(hemi)
  const sun = new DirectionalLight(0xffffff, 3)
  sun.position.set(4, 8, 3)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.left = sun.shadow.camera.bottom = -10
  sun.shadow.camera.right = sun.shadow.camera.top = 10
  scene.add(sun)

  const room = buildTestRoom(scene)
  const controller = createCharacterController(room.collider)
  controller.setPosition(new Vector3(-4.2, 0.05, 2.5))
  const input = createInput(renderer.domElement)
  const fpsCamera = createFpsCamera(camera)
  const viewModel = createViewModel(camera)
  viewModel.setTeam('a')
  const marker = createMarker({ ownerId: 'sandbox-local', team: 'a' })
  const muzzlePoint = new Vector3()
  let controls: MoveInput = input.move
  const audio = createAudio()
  const overlay = makeOverlay(app)
  const effects = createEffects(scene, {
    hitMarker: () => {
      overlay.crosshair.classList.add('hit')
      window.setTimeout(() => overlay.crosshair.classList.remove('hit'), 100)
    },
    damageVignette: () => {
      overlay.vignette.classList.add('show')
      window.setTimeout(() => overlay.vignette.classList.remove('show'), 140)
    },
  })
  const decals = createDecals(scene)
  const projectiles = createProjectiles(scene, room.world, decals, effects, audio)
  const dummies = createDummies(scene)
  const hittables = dummies.map((dummy) => dummy.avatar.hittable())

  projectiles.onPlayerHit((hit) => {
    const dummy = dummies.find((candidate) => candidate.avatar.hittable().id === hit.target)
    if (!dummy || performance.now() < dummy.deadUntil) return
    dummy.avatar.flashHit()
    dummy.hp -= PLAYER.hitDamage
    effects.hitMarker()
    audio.play('hit', dummy.position, { position: camera.position, forward: look })
    if (autopilot.stage > route.length) autopilot.dummyShots++
    if (dummy.hp <= 0) {
      dummy.avatar.die()
      dummy.deadUntil = performance.now() + PLAYER.respawnDelayMs
      audio.play('death', dummy.position, { position: camera.position, forward: look })
    }
  })

  renderer.domElement.addEventListener('pointerdown', () => {
    void audio.resume()
  }, { once: true })
  input.onLockChange((locked) => overlay.locked.hidden = locked)

  let yaw = 0
  let pitch = 0
  let accumulator = 0
  let previousTime = performance.now()
  let fpsSmoothed = 60
  let previousGrounded = false
  let previousReloading = false
  let footstepDistance = 0
  // THREE.Clock is deprecated in r185 and warns on construction; Timer is the replacement.
  const clock = new Timer()
  const autopilot = {
    enabled: new URLSearchParams(location.search).get('autopilot') === '1',
    stage: 0,
    wallShots: 0,
    dummyShots: 0,
  }
  overlay.locked.hidden = autopilot.enabled
  const route = [
    { point: new Vector3(-4.2, 0, -1.6), crouch: false },
    { point: new Vector3(-2.35, 0, -1.8), crouch: false },
    { point: new Vector3(-2.35, 0, 2.35), crouch: false },
    { point: new Vector3(-0.5, 0, 2.25), crouch: false },
    { point: new Vector3(-0.5, 0, -1.5), crouch: true },
    { point: new Vector3(1.05, 0, -1.5), crouch: true },
    { point: new Vector3(1.05, 0, 4.05), crouch: false },
    { point: new Vector3(2.5, 0, 4.05), crouch: false },
    { point: new Vector3(2.5, 0, 0.55), crouch: false },
  ]

  window.__ps = { input, controller, marker, projectiles, decals, effects, dummies, autopilot }

  const onResize = () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  }
  window.addEventListener('resize', onResize)

  function frame(now: number): void {
    const cpuStarted = performance.now()
    const frameDt = Math.min((now - previousTime) / 1000, 0.1)
    previousTime = now
    fpsSmoothed += ((frameDt > 0 ? 1 / frameDt : 60) - fpsSmoothed) * 0.08
    accumulator = Math.min(accumulator + frameDt, FIXED_DT * 5)

    const mouse = input.consumeLook()
    if (!autopilot.enabled) {
      yaw -= mouse.dx * PLAYER.lookSensitivity
      pitch = MathUtils.clamp(
        pitch - mouse.dy * PLAYER.lookSensitivity,
        -Math.PI / 2 + 0.05,
        Math.PI / 2 - 0.05,
      )
    }

    let scriptedFire = false
    while (accumulator >= FIXED_DT) {
      if (autopilot.enabled) {
        scriptedFire = updateAutopilot(route, autopilot, controller.state.position, dummies, moveInput)
        if (autopilot.stage < route.length) {
          const target = route[autopilot.stage].point
          yaw = Math.atan2(-(target.x - controller.state.position.x), -(target.z - controller.state.position.z))
          pitch = 0
        } else if (autopilot.stage === route.length) {
          targetDirection.set(6 - controller.state.position.x, 2.2 - controller.state.position.y - controller.eyeHeight, -6 - controller.state.position.z).normalize()
          yaw = Math.atan2(-targetDirection.x, -targetDirection.z)
          pitch = Math.asin(targetDirection.y)
        } else {
          aimAt(dummies[0].position, controller.state.position, controller.eyeHeight, targetDirection)
          yaw = Math.atan2(-targetDirection.x, -targetDirection.z)
          pitch = Math.asin(targetDirection.y)
        }
      }

      controls = autopilot.enabled ? moveInput : input.move
      const fallingVelocity = controller.state.velocity.y
      controller.update(FIXED_DT, controls, yaw)
      if (!previousGrounded && controller.state.grounded) fpsCamera.landing(fallingVelocity)
      previousGrounded = controller.state.grounded
      accumulator -= FIXED_DT
    }

    const speed = Math.hypot(controller.state.velocity.x, controller.state.velocity.z)
    fpsCamera.update(frameDt, controller.state.position, controller.eyeHeight, yaw, pitch, speed, controller.state.grounded)
    fpsCamera.getEyePosition(eye)
    fpsCamera.getLookDirection(look)
    marker.setMotion(speed, controller.state.grounded, controller.state.crouching, Boolean(controls.walk))
    const shots = marker.update(frameDt, input.fire || scriptedFire, input.reload, eye, look)
    for (const shot of shots) {
      projectiles.spawn(shot, { detectPlayers: true })
      viewModel.fire()
      fpsCamera.kick(WEAPON.recoilPitch, (shot.seed & 1 ? 1 : -1) * WEAPON.recoilPitch * 0.25)
      effects.muzzle(viewModel.muzzleWorld(muzzlePoint), look, shot.team)
      audio.play('shot')
      if (autopilot.stage === route.length) autopilot.wallShots++
    }
    if (!previousReloading && marker.reloading) audio.play('reload')
    previousReloading = marker.reloading
    if (marker.reloading) viewModel.reload(marker.reloadProgress)
    viewModel.setHopper(marker.hopper, WEAPON.hopperSize)
    viewModel.update(frameDt, speed, controller.state.grounded)
    projectiles.update(frameDt, hittables)
    effects.update(frameDt)
    clock.update(now)
    updateDummies(dummies, clock.getElapsed(), audio)

    footstepDistance += speed * frameDt
    if (controller.state.grounded && footstepDistance > 2.2) {
      audio.play('footstep')
      footstepDistance = 0
    }
    overlay.hp.textContent = 'HP 100'
    overlay.hopper.textContent = marker.reloading
      ? `RELOADING ${Math.round(marker.reloadProgress * 100)}%`
      : `${marker.hopper} / ∞`
    overlay.fps.textContent = `${fpsSmoothed.toFixed(0)} FPS · ${(performance.now() - cpuStarted).toFixed(2)} ms CPU`
    input.update()
    renderer.render(scene, camera)
    requestAnimationFrame(frame)
  }

  requestAnimationFrame(frame)
}

function updateAutopilot(
  route: { point: Vector3; crouch: boolean }[],
  state: { enabled: boolean; stage: number; wallShots: number; dummyShots: number },
  position: Vector3,
  dummies: Dummy[],
  input: MoveInput,
): boolean {
  input.forward = 0
  input.right = 0
  input.jump = false
  input.crouch = false
  if (!state.enabled) return false
  if (state.stage < route.length) {
    const waypoint = route[state.stage]
    input.forward = 1
    input.crouch = waypoint.crouch
    const horizontalDistance = Math.hypot(waypoint.point.x - position.x, waypoint.point.z - position.z)
    if (horizontalDistance < 0.32) state.stage++
    return false
  }
  if (state.stage === route.length) {
    if (state.wallShots >= 10) state.stage++
    return state.wallShots < 10
  }
  if (state.dummyShots >= 3 || performance.now() < dummies[0].deadUntil) return false
  return true
}

function aimAt(target: Vector3, feet: Vector3, eyeHeight: number, out: Vector3): Vector3 {
  return out.set(target.x - feet.x, target.y + 0.9 - feet.y - eyeHeight, target.z - feet.z).normalize()
}

function createDummies(scene: Scene): Dummy[] {
  const settings: [string, 'a' | 'b', [number, number, number], number][] = [
    ['Target One', 'b', [2.5, 0, -3.2], 0],
    ['Target Two', 'b', [-5.4, 0, -3.4], Math.PI],
    ['Friendly', 'a', [5.2, 0, 2.7], 0],
  ]
  return settings.map(([name, team, coords, phase], index) => {
    const avatar = createAvatar(team, name)
    const position = new Vector3().fromArray(coords)
    scene.add(avatar.object)
    avatar.set(position, phase, 0, false, 0)
    return { avatar, hp: PLAYER.maxHp, position, base: position.clone(), phase: index * 2, enemy: team === 'b', deadUntil: 0 }
  })
}

function updateDummies(
  dummies: Dummy[],
  time: number,
  audio: ReturnType<typeof createAudio>,
): void {
  for (const dummy of dummies) {
    if (dummy.deadUntil > 0 && performance.now() >= dummy.deadUntil) {
      dummy.deadUntil = 0
      dummy.hp = PLAYER.maxHp
      dummy.avatar.spawn()
      dummy.avatar.setInvincible(true)
      audio.play('respawn', dummy.position)
      window.setTimeout(() => dummy.avatar.setInvincible(false), PLAYER.invincibleMs)
    }
    const moving = dummy.enemy && dummy.deadUntil === 0
    dummy.position.x = dummy.base.x + (moving ? Math.sin(time * 0.45 + dummy.phase) * 0.7 : 0)
    dummy.avatar.set(dummy.position, moving ? Math.cos(time * 0.45 + dummy.phase) * 0.18 : 0, 0, false, moving ? 0.32 : 0)
  }
}

function makeOverlay(parent: HTMLElement) {
  const element = document.createElement('div')
  element.innerHTML = `
    <style>
      .ps-hud{position:fixed;inset:0;pointer-events:none;color:#fafafa;font:600 15px Inter,system-ui;text-shadow:0 1px 4px #000}
      .ps-stats{position:absolute;left:24px;bottom:22px;display:grid;gap:5px}.ps-fps{position:absolute;right:18px;top:16px;font:12px monospace;color:#d4d4d8}
      .ps-lock{position:absolute;inset:0;display:grid;place-items:center;background:#09090b88;font:700 18px Barlow,system-ui}.ps-lock[hidden]{display:none}
      .ps-cross{position:absolute;left:50%;top:50%;width:8px;height:8px;border:2px solid white;border-radius:50%;transform:translate(-50%,-50%)}.ps-cross.hit{border-color:#facc15;transform:translate(-50%,-50%) scale(1.8)}
      .ps-vignette{position:absolute;inset:0;box-shadow:inset 0 0 90px 20px transparent}.ps-vignette.show{box-shadow:inset 0 0 90px 20px #ef444477}
    </style>
    <div class="ps-hud"><div class="ps-stats"><span data-hp></span><span data-hopper></span></div><span class="ps-fps" data-fps></span><span class="ps-cross"></span><span class="ps-vignette"></span><div class="ps-lock">CLICK TO PLAY · WASD · SPACE · CTRL/C · R</div></div>`
  parent.append(element)
  return {
    hp: element.querySelector<HTMLElement>('[data-hp]')!,
    hopper: element.querySelector<HTMLElement>('[data-hopper]')!,
    fps: element.querySelector<HTMLElement>('[data-fps]')!,
    locked: element.querySelector<HTMLElement>('.ps-lock')!,
    crosshair: element.querySelector<HTMLElement>('.ps-cross')!,
    vignette: element.querySelector<HTMLElement>('.ps-vignette')!,
  }
}

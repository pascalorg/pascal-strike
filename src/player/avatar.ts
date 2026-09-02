import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  CapsuleGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three'
import { PLAYER, TEAMS } from '../config'
import type { Hittable, TeamId } from '../types'

export interface Avatar {
  readonly object: Group
  set(position: Vector3, yaw: number, pitch: number, crouching: boolean, speed: number): void
  flashHit(): void
  die(): void
  spawn(): void
  setInvincible(value: boolean): void
  setTeam(team: TeamId): void
  setName(name: string): void
  setNameTagVisible(visible: boolean): void
  hittable(): Hittable
  dispose(): void
}

let avatarCounter = 0

export function createAvatar(initialTeam: TeamId, initialName: string, id?: string): Avatar {
  const root = new Group()
  root.name = id ?? `avatar-${++avatarCounter}`
  const body = new Group()
  root.add(body)

  const teamMaterial = new MeshStandardMaterial({ color: TEAMS[initialTeam].colorHex, roughness: 0.72 })
  const limbMaterial = new MeshStandardMaterial({ color: 0x3f3f46, roughness: 0.82 })
  const visorMaterial = new MeshStandardMaterial({ color: 0x09090b, roughness: 0.25, metalness: 0.25 })
  const markerMaterial = new MeshStandardMaterial({ color: 0x18181b, roughness: 0.4 })
  const materials = [teamMaterial, limbMaterial, visorMaterial, markerMaterial]

  const torso = part(body, new CapsuleGeometry(0.25, 0.48, 4, 8), teamMaterial, [0, 1.1, 0])
  torso.scale.set(1, 1, 0.72)
  const headPivot = new Group()
  headPivot.position.set(0, 1.53, 0)
  body.add(headPivot)
  part(headPivot, new SphereGeometry(0.22, 10, 7), teamMaterial, [0, 0, 0])
  const visor = part(headPivot, new BoxGeometry(0.36, 0.105, 0.08), visorMaterial, [0, 0.02, -0.18])
  visor.rotation.x = -0.04

  const leftLeg = limb(body, -0.13)
  const rightLeg = limb(body, 0.13)
  const leftArm = arm(body, -0.31)
  const rightArm = arm(body, 0.31)
  const marker = part(body, new BoxGeometry(0.13, 0.12, 0.48), markerMaterial, [0, 1.04, -0.34])
  marker.rotation.x = -0.04

  const shieldMaterial = new MeshStandardMaterial({
    color: TEAMS[initialTeam].colorHex,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    blending: AdditiveBlending,
  })
  materials.push(shieldMaterial)
  const shield = new Mesh(new SphereGeometry(0.65, 16, 10), shieldMaterial)
  shield.position.y = 0.9
  shield.scale.y = 1.45
  shield.visible = false
  root.add(shield)
  const deathSplat = makeDeathSplat(initialTeam)
  deathSplat.position.set(0, 0.9, 0)
  deathSplat.visible = false
  root.add(deathSplat)

  let currentName = initialName
  let nameTagVisible = true
  let nameTag = makeNameTag(currentName, initialTeam)
  nameTag.position.set(0, 2, 0)
  root.add(nameTag)

  let team = initialTeam
  let alive = true
  let crouching = false
  let phase = 0
  let flashUntil = 0
  let deathStarted = 0
  const capsuleStart = new Vector3()
  const capsuleEnd = new Vector3()
  const hittable: Hittable = {
    id: root.name,
    team,
    alive,
    capsuleStart,
    capsuleEnd,
    capsuleRadius: PLAYER.radius,
  }

  function limb(parent: Group, x: number): Group {
    const pivot = new Group()
    pivot.position.set(x, 0.67, 0)
    parent.add(pivot)
    part(pivot, new CapsuleGeometry(0.105, 0.44, 4, 7), limbMaterial, [0, -0.27, 0])
    return pivot
  }

  function arm(parent: Group, x: number): Group {
    const pivot = new Group()
    pivot.position.set(x, 1.28, 0)
    pivot.rotation.x = -0.75
    parent.add(pivot)
    part(pivot, new BoxGeometry(0.13, 0.52, 0.13), limbMaterial, [0, -0.23, -0.08])
    return pivot
  }

  return {
    object: root,
    set(position, yaw, pitch, nextCrouching, speed) {
      const now = performance.now()
      root.position.copy(position)
      root.rotation.y = yaw
      crouching = nextCrouching
      phase += 0.055 * speed
      const swing = Math.sin(phase) * Math.min(speed / 5.5, 1) * 0.65
      leftLeg.rotation.x = swing
      rightLeg.rotation.x = -swing
      leftArm.rotation.x = -0.75 - swing * 0.2
      rightArm.rotation.x = -0.75 + swing * 0.2
      headPivot.rotation.x = pitch * 0.45
      body.position.y = crouching ? -0.18 : 0
      body.scale.y = crouching ? 0.78 : 1
      torso.rotation.x = Math.min(speed / 5.5, 1) * 0.08
      marker.rotation.y = Math.sin(phase * 0.5) * 0.015
      teamMaterial.emissive.setHex(now < flashUntil ? 0xffffff : 0x000000)
      teamMaterial.emissiveIntensity = now < flashUntil ? 1.5 : 0
      if (!alive) {
        const elapsed = Math.min((now - deathStarted) / 1000, 1)
        body.rotation.z = elapsed * Math.PI * 0.47
        deathSplat.visible = true
        deathSplat.scale.setScalar(0.35 + elapsed * 1.4)
        ;(deathSplat.material as SpriteMaterial).opacity = 1 - elapsed
        for (const material of materials) {
          material.transparent = true
          material.opacity = 1 - elapsed
        }
      }
      updateCapsule()
    },
    flashHit() {
      flashUntil = performance.now() + 80
    },
    die() {
      if (!alive) return
      alive = false
      deathStarted = performance.now()
      hittable.alive = false
    },
    spawn() {
      alive = true
      body.rotation.set(0, 0, 0)
      deathSplat.visible = false
      for (const material of materials) {
        material.opacity = material === shieldMaterial ? 0.18 : 1
        if (material !== shieldMaterial) material.transparent = false
      }
      hittable.alive = true
    },
    setInvincible(value) {
      shield.visible = value
    },
    setTeam(value) {
      team = value
      hittable.team = value
      teamMaterial.color.setHex(TEAMS[value].colorHex)
      shieldMaterial.color.setHex(TEAMS[value].colorHex)
      ;(deathSplat.material as SpriteMaterial).color.setHex(TEAMS[value].colorHex)
      replaceNameTag(currentName)
    },
    setName(value) {
      currentName = value
      replaceNameTag(value)
    },
    setNameTagVisible(visible) {
      nameTagVisible = visible
      nameTag.visible = visible
    },
    hittable() {
      updateCapsule()
      return hittable
    },
    dispose() {
      root.removeFromParent()
      root.traverse((object) => {
        if (object instanceof Mesh) object.geometry.dispose()
      })
      for (const material of materials) material.dispose()
      disposeSprite(nameTag)
      disposeSprite(deathSplat)
    },
  }

  function replaceNameTag(value: string): void {
      const next = makeNameTag(value, team)
      next.position.copy(nameTag.position)
      next.visible = nameTagVisible
      root.remove(nameTag)
      disposeSprite(nameTag)
      nameTag = next
      root.add(nameTag)
  }

  function updateCapsule(): void {
    const height = crouching ? PLAYER.crouchHeight : PLAYER.height
    capsuleStart.set(root.position.x, root.position.y + PLAYER.radius, root.position.z)
    capsuleEnd.set(root.position.x, root.position.y + height - PLAYER.radius, root.position.z)
  }
}

function part(
  parent: Group,
  geometry: BoxGeometry | CapsuleGeometry | SphereGeometry,
  material: MeshStandardMaterial,
  position: [number, number, number],
): Mesh {
  const mesh = new Mesh(geometry, material)
  mesh.position.fromArray(position)
  mesh.castShadow = true
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

function makeNameTag(name: string, team: TeamId): Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const context = canvas.getContext('2d')!
  context.font = '600 52px Inter, sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.lineWidth = 8
  context.strokeStyle = '#09090b'
  context.strokeText(name, 256, 64)
  context.fillStyle = TEAMS[team].color
  context.fillText(name, 256, 64)
  const texture = new CanvasTexture(canvas)
  const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: true })
  const sprite = new Sprite(material)
  sprite.scale.set(1.5, 0.375, 1)
  return sprite
}

function makeDeathSplat(team: TeamId): Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'
  context.beginPath()
  for (let index = 0; index < 18; index++) {
    const angle = index / 18 * Math.PI * 2
    const radius = index % 3 === 0 ? 112 : 75 + (index * 17 % 28)
    const x = 128 + Math.cos(angle) * radius
    const y = 128 + Math.sin(angle) * radius
    if (index === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  }
  context.closePath()
  context.fill()
  const texture = new CanvasTexture(canvas)
  const material = new SpriteMaterial({
    map: texture,
    color: TEAMS[team].colorHex,
    transparent: true,
    depthWrite: false,
  })
  return new Sprite(material)
}

function disposeSprite(sprite: Sprite): void {
  const material = sprite.material as SpriteMaterial
  material.map?.dispose()
  material.dispose()
}

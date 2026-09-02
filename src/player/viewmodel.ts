import {
  BoxGeometry,
  Camera,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
} from 'three'
import { TEAMS } from '../config'
import type { TeamId } from '../types'

export interface ViewModel {
  readonly object: Group
  update(dt: number, speed: number, grounded: boolean, aiming?: boolean): void
  fire(): void
  reload(progress: number): void
  setTeam(team: TeamId): void
  dispose(): void
}

export function createViewModel(camera: Camera): ViewModel {
  const root = new Group()
  root.name = 'paintball-viewmodel'
  root.position.set(0.29, -0.25, -0.52)
  camera.add(root)

  const dark = new MeshStandardMaterial({ color: 0x242428, roughness: 0.38, metalness: 0.32, depthTest: false })
  const black = new MeshStandardMaterial({ color: 0x09090b, roughness: 0.42, depthTest: false })
  const glove = new MeshStandardMaterial({ color: 0x3f3f46, roughness: 0.9, depthTest: false })
  const accent = new MeshStandardMaterial({ color: TEAMS.a.colorHex, roughness: 0.6, depthTest: false })
  const materials = [dark, black, glove, accent]

  addPart(root, new BoxGeometry(0.2, 0.13, 0.38), dark, [0, 0, 0])
  addPart(root, new BoxGeometry(0.205, 0.025, 0.34), accent, [0, 0.075, 0])
  const barrel = addPart(root, new CylinderGeometry(0.035, 0.043, 0.42, 10), black, [0, 0.015, -0.39])
  barrel.rotation.x = Math.PI / 2
  const hopper = addPart(root, new SphereGeometry(0.105, 12, 8), dark, [0, 0.17, -0.02])
  hopper.scale.set(1.15, 0.95, 1)
  const grip = addPart(root, new BoxGeometry(0.085, 0.22, 0.1), black, [0, -0.15, 0.08])
  grip.rotation.x = -0.18
  addPart(root, new BoxGeometry(0.11, 0.09, 0.15), glove, [-0.09, -0.2, 0.12])
  const supportHand = addPart(root, new BoxGeometry(0.12, 0.09, 0.16), glove, [0.09, -0.08, -0.22])
  supportHand.rotation.z = -0.18

  root.traverse((object) => {
    if (object instanceof Mesh) object.renderOrder = 100
  })

  let time = 0
  let kick = 0
  let kickVelocity = 0
  let reloadTilt = 0
  let reloadTarget = 0

  return {
    object: root,
    update(dt, speed, grounded, aiming = false) {
      time += dt * (5 + speed)
      kickVelocity += (-95 * kick - 18 * kickVelocity) * dt
      kick += kickVelocity * dt
      reloadTilt += (reloadTarget - reloadTilt) * Math.min(1, dt * 14)
      const bob = grounded ? Math.min(speed / 5.5, 1) : 0
      const aim = aiming ? 0.4 : 1
      root.position.set(
        0.29 * aim + Math.sin(time) * 0.006 * bob,
        -0.25 * aim + Math.abs(Math.cos(time)) * 0.007 * bob,
        -0.52 + kick,
      )
      root.rotation.set(-0.05 + reloadTilt, -0.04, -0.03 - reloadTilt * 0.35)
      reloadTarget = 0
    },
    fire() {
      kickVelocity += 0.8
    },
    reload(progress) {
      reloadTarget = Math.sin(Math.max(0, Math.min(1, progress)) * Math.PI) * 0.75
    },
    setTeam(team) {
      accent.color.setHex(TEAMS[team].colorHex)
    },
    dispose() {
      root.removeFromParent()
      root.traverse((object) => {
        if (object instanceof Mesh) object.geometry.dispose()
      })
      for (const material of materials) material.dispose()
    },
  }
}

function addPart(
  parent: Group,
  geometry: BoxGeometry | CylinderGeometry | SphereGeometry,
  material: MeshStandardMaterial,
  position: [number, number, number],
): Mesh {
  const mesh = new Mesh(geometry, material)
  mesh.position.fromArray(position)
  mesh.castShadow = false
  mesh.frustumCulled = false
  parent.add(mesh)
  return mesh
}

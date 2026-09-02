/**
 * `?dev=map` — W1-A dev entry: load a Pascal GLB, fly around it, inspect everything the map
 * pipeline produced (zones, spawns, doors, collider, navmesh, raycasts).
 *
 * Controls: click to capture the mouse (or drag), WASD + Q/E, Shift to sprint, Esc to release.
 * Overlays: Z zones · S spawns · D doors · C collider · N navmesh · R raycast probe.
 * S and D only toggle while the cursor is free, because they double as movement keys.
 */
import {
  DoubleSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three'
import { TEAMS } from '../config'
import { createRenderer } from '../engine/renderer'
import { createLoaders } from '../engine/loaders'
import { createEnvironment } from '../engine/environment'
import { loadMap } from '../map/map-loader'
import { colliderTriangleCount, createWorldQuery } from '../map/collider'
import { createDoorSystem } from '../map/doors'
import { resolveSpawns } from '../map/spawns'
import { buildNavigation, createNavMeshHelper } from '../map/navmesh'
import type { HitResult, MapData, SpawnLayout } from '../types'

type OverlayKey = 'z' | 's' | 'd' | 'c' | 'n' | 'r'

const OVERLAY_LABELS: Record<OverlayKey, string> = {
  z: 'zones',
  s: 'spawns',
  d: 'doors',
  c: 'collider',
  n: 'navmesh',
  r: 'raycast',
}

const FLY_SPEED = 6
const FLY_SPRINT = 18
const LOOK_SENSITIVITY = 0.0022
const PROBE_RANGE = 60
const MAX_PITCH = Math.PI / 2 - 0.02

const _forward = new Vector3()
const _right = new Vector3()
const _move = new Vector3()
const _probeDir = new Vector3()
const _probeEnd = new Vector3()
const _actors: Vector3[] = [new Vector3()]

export async function start(): Promise<void> {
  const container = document.getElementById('app')!
  container.style.cssText = 'position:fixed;inset:0;margin:0;background:#0d0d0f;overflow:hidden'

  const params = new URLSearchParams(location.search)
  const mapUrl = params.get('map') ?? '/maps/pascal-house.glb'

  const engine = await createRenderer(container)
  const loaders = createLoaders(engine.renderer)

  const t0 = performance.now()
  const map = await loadMap(mapUrl, loaders)
  const loadMs = performance.now() - t0
  engine.scene.add(map.root)

  const environment = createEnvironment(engine, map.bounds)
  const world = createWorldQuery(map.collider, map.doors)
  const doors = createDoorSystem(map)
  const nav = await buildNavigation(map)
  const spawns = resolveSpawns(map, world, nav)

  doors.onToggle((door, open) => {
    console.info(`[doors] ${door.label} (${door.id}) → ${open ? 'open' : 'closed'}`)
  })

  // ---- overlays -----------------------------------------------------------
  const overlays = new Group()
  overlays.name = 'debug-overlays'
  engine.scene.add(overlays)

  const zoneOverlay = buildZoneOverlay(map)
  const spawnOverlay = buildSpawnOverlay(spawns)
  const doorOverlay = buildDoorOverlay(map)
  const colliderOverlay = buildColliderOverlay(map)
  const navOverlay = createNavMeshHelper(nav) ?? new Group()
  const probeOverlay = buildProbeOverlay()
  overlays.add(zoneOverlay.group, spawnOverlay, doorOverlay.group, colliderOverlay, navOverlay, probeOverlay.group)

  const visible: Record<OverlayKey, boolean> = { z: false, s: true, d: true, c: false, n: false, r: false }
  const objects: Record<OverlayKey, Object3D> = {
    z: zoneOverlay.group,
    s: spawnOverlay,
    d: doorOverlay.group,
    c: colliderOverlay,
    n: navOverlay,
    r: probeOverlay.group,
  }
  const applyVisibility = () => {
    for (const key of Object.keys(objects) as OverlayKey[]) objects[key].visible = visible[key]
  }
  applyVisibility()

  // ---- fly camera ---------------------------------------------------------
  const camera = engine.camera
  const center = map.bounds.getCenter(new Vector3())
  const size = map.bounds.getSize(new Vector3())
  camera.position.set(center.x, Math.max(2, map.bounds.min.y + 1.7), center.z + Math.min(size.z, 14) * 0.5 + 6)
  camera.rotation.order = 'YXZ'
  let yaw = Math.atan2(-(center.x - camera.position.x), -(center.z - camera.position.z))
  let pitch = -0.12

  const keys = new Set<string>()
  let pointerLocked = false
  let dragging = false
  const canvas = engine.renderer.domElement

  const moveActive = () => pointerLocked || dragging

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !pointerLocked) {
      // Chrome rejects the promise when the lock was released moments ago — ignore it so the
      // console stays clean.
      const pending = canvas.requestPointerLock?.() as unknown as Promise<void> | undefined
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
      dragging = true
    }
  })
  window.addEventListener('mouseup', () => {
    dragging = false
  })
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas
    if (!pointerLocked) keys.clear()
  })
  window.addEventListener('mousemove', (e) => {
    if (!moveActive()) return
    yaw -= e.movementX * LOOK_SENSITIVITY
    pitch -= e.movementY * LOOK_SENSITIVITY
    pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch))
  })

  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase()
    keys.add(key)
    if (!(key in OVERLAY_LABELS)) return
    // S and D are also movement keys — only treat them as toggles with the cursor free.
    if ((key === 's' || key === 'd') && moveActive()) return
    if (e.repeat) return
    const overlayKey = key as OverlayKey
    visible[overlayKey] = !visible[overlayKey]
    applyVisibility()
  })
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()))
  window.addEventListener('blur', () => keys.clear())

  // ---- HUD ----------------------------------------------------------------
  const panel = document.createElement('div')
  panel.style.cssText = [
    'position:fixed;top:12px;left:12px;z-index:10',
    'font:11px/1.55 "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace',
    'color:#e4e4e7;background:rgba(13,13,15,.82);border:1px solid #27272a;border-radius:10px',
    // `white-space:pre` cannot wrap, so the box sizes to its widest line instead of clipping.
    'padding:10px 12px;white-space:pre;pointer-events:none;backdrop-filter:blur(6px)',
    'width:max-content;max-height:calc(100vh - 24px);overflow:hidden',
  ].join(';')
  container.appendChild(panel)

  const sceneTris = countSceneTriangles(map)
  const colliderTris = colliderTriangleCount(map.collider)
  // First point of each team in grid order — the true anchors are printed to the console by
  // resolveSpawns, since SpawnLayout has nowhere to carry them.
  const firstA = spawns.a[0]?.position
  const firstB = spawns.b[0]?.position

  let probeHit: HitResult | null = null
  let fps = 0
  let fpsAccum = 0
  let fpsFrames = 0
  let panelDue = 0

  function renderPanel(now: number) {
    if (now < panelDue) return
    panelDue = now + 200
    const doorStates = map.doors
      .map((d) => `${d.label} ${doors.isOpen(d.id) ? 'OPEN' : 'shut'} ${doors.openness(d.id).toFixed(2)}`)
      .join('\n  ')
    panel.textContent = [
      `PASCAL STRIKE · map viewer`,
      `map        ${map.name}`,
      `backend    ${engine.backend}   ${fps.toFixed(0)} fps`,
      `load       ${loadMs.toFixed(0)} ms`,
      `tris       ${sceneTris.toLocaleString()} scene / ${colliderTris.toLocaleString()} collider`,
      `levels     ${map.levels.length}   zones ${map.zones.length}   doors ${map.doors.length}   spawnNodes ${map.spawnNodes.length}`,
      `bounds     ${fmt(map.bounds.min)} → ${fmt(map.bounds.max)}`,
      `spawns     source=${spawns.source}  a=${spawns.a.length} b=${spawns.b.length}`,
      `  first A  ${firstA ? fmt(firstA) : '—'}`,
      `  first B  ${firstB ? fmt(firstB) : '—'}`,
      `navmesh    ${nav.ready ? 'ready' : 'FAILED (straight-line fallback)'}`,
      `camera     ${fmt(camera.position)}`,
      map.doors.length ? `doors\n  ${doorStates}` : 'doors      none',
      visible.r
        ? `probe      ${probeHit ? `${probeHit.kind} @ ${probeHit.distance.toFixed(2)} m  n=${fmt(probeHit.normal, 2)}` : 'no hit'}`
        : 'probe      off (R)',
      '',
      `overlays   ${(Object.keys(OVERLAY_LABELS) as OverlayKey[])
        .map((k) => `${k.toUpperCase()}:${OVERLAY_LABELS[k]}${visible[k] ? '*' : ''}`)
        .join(' ')}`,
      `click to fly · WASD QE · Shift fast · Esc frees cursor`,
      `(S/D toggle only while the cursor is free)`,
    ].join('\n')
  }

  // ---- frame --------------------------------------------------------------
  engine.onUpdate((dt) => {
    if (moveActive()) {
      _forward.set(-Math.sin(yaw), 0, -Math.cos(yaw))
      _right.set(Math.cos(yaw), 0, -Math.sin(yaw))
      _move.set(0, 0, 0)
      if (keys.has('w')) _move.add(_forward)
      if (keys.has('s')) _move.sub(_forward)
      if (keys.has('d')) _move.add(_right)
      if (keys.has('a')) _move.sub(_right)
      if (keys.has('e')) _move.y += 1
      if (keys.has('q')) _move.y -= 1
      if (_move.lengthSq() > 0) {
        _move.normalize().multiplyScalar((keys.has('shift') ? FLY_SPRINT : FLY_SPEED) * dt)
        camera.position.add(_move)
      }
    }

    _actors[0].copy(camera.position)
    doors.update(dt, _actors)
  })

  engine.onRender((_alpha, dt) => {
    camera.rotation.set(pitch, yaw, 0)
    environment.update(camera.position)
    doorOverlay.update(doors)

    probeHit = null
    if (visible.r) {
      camera.getWorldDirection(_probeDir)
      probeHit = world.raycast(camera.position, _probeDir, PROBE_RANGE)
      _probeEnd.copy(probeHit ? probeHit.point : _probeDir.multiplyScalar(PROBE_RANGE).add(camera.position))
      probeOverlay.update(camera.position, _probeEnd, probeHit)
    }

    fpsAccum += dt
    fpsFrames++
    if (fpsAccum >= 0.25) {
      fps = fpsFrames / fpsAccum
      fpsAccum = 0
      fpsFrames = 0
    }
    renderPanel(performance.now())
  })

  engine.start()

  console.info(
    `[map-viewer] ${map.name} · backend=${engine.backend} · ${loadMs.toFixed(0)} ms · ` +
      `${map.levels.length} levels, ${map.zones.length} zones, ${map.doors.length} doors, ` +
      `${colliderTris} collider tris · spawns=${spawns.source} · navmesh=${nav.ready}`,
  )

  // Optional debugging handle (allowed by ARCHITECTURE.md).
  ;(window as unknown as { __ps: unknown }).__ps = { engine, map, world, doors, spawns, nav, environment }
}

// ---------------------------------------------------------------------------
// Overlay builders
// ---------------------------------------------------------------------------

function buildZoneOverlay(map: MapData): { group: Group } {
  const group = new Group()
  group.name = 'overlay-zones'
  for (const zone of map.zones) {
    const color = new Color(zone.color || '#8b8b93')
    const positions = new Float32Array(zone.polygon.length * 3)
    zone.polygon.forEach((p, i) => {
      positions[i * 3] = p.x
      positions[i * 3 + 1] = zone.floorY + 0.03
      positions[i * 3 + 2] = p.y
    })
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    group.add(new LineLoop(geometry, new LineBasicMaterial({ color, depthTest: false })))
    const sprite = makeLabel(zone.label, zone.color || '#e4e4e7')
    sprite.position.set(zone.centroid.x, zone.floorY + 1.2, zone.centroid.z)
    group.add(sprite)
  }
  return { group }
}

function buildSpawnOverlay(spawns: SpawnLayout): Group {
  const group = new Group()
  group.name = 'overlay-spawns'
  const cone = new ConeGeometry(0.18, 0.55, 10)
  const arrow = new BoxGeometry(0.04, 0.04, 0.7)
  for (const team of ['a', 'b'] as const) {
    // depthTest off, like the door markers: spawns are usually indoors and you want to see
    // where they are from outside the building.
    const material = new MeshBasicMaterial({ color: TEAMS[team].colorHex, depthTest: false })
    for (const point of spawns[team]) {
      const marker = new Mesh(cone, material)
      marker.position.copy(point.position).y += 0.3
      group.add(marker)
      const dir = new Mesh(arrow, material)
      dir.position.copy(point.position).y += 0.12
      dir.rotation.order = 'YXZ'
      dir.rotation.y = point.yaw
      dir.translateZ(-0.45)
      group.add(dir)
    }
  }
  return group
}

function buildDoorOverlay(map: MapData): {
  group: Group
  update(doors: { isOpen(id: string): boolean; openness(id: string): number }): void
} {
  const group = new Group()
  group.name = 'overlay-doors'
  const geometry = new SphereGeometry(0.13, 12, 8)
  const entries = map.doors.map((door) => {
    const material = new MeshBasicMaterial({ color: 0xef4444, depthTest: false })
    const mesh = new Mesh(geometry, material)
    mesh.position.copy(door.center)
    group.add(mesh)
    return { id: door.id, material }
  })
  const open = new Color(0x22c55e)
  const shut = new Color(0xef4444)
  const mid = new Color()
  return {
    group,
    update(doors) {
      for (const entry of entries) {
        mid.copy(shut).lerp(open, doors.openness(entry.id))
        entry.material.color.copy(mid)
      }
    },
  }
}

function buildColliderOverlay(map: MapData): Mesh {
  const mesh = new Mesh(
    map.collider.geometry,
    new MeshBasicMaterial({ color: 0x22d3ee, wireframe: true, transparent: true, opacity: 0.35, side: DoubleSide }),
  )
  mesh.name = 'overlay-collider'
  mesh.matrixAutoUpdate = false
  mesh.matrixWorldAutoUpdate = false
  mesh.frustumCulled = false
  return mesh
}

function buildProbeOverlay(): {
  group: Group
  update(from: Vector3, to: Vector3, hit: HitResult | null): void
} {
  const group = new Group()
  group.name = 'overlay-probe'
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(6), 3))
  const line = new Line(geometry, new LineBasicMaterial({ color: 0xfacc15, depthTest: false }))
  line.frustumCulled = false
  const marker = new Mesh(
    new SphereGeometry(0.06, 10, 8),
    new MeshBasicMaterial({ color: 0xfacc15, depthTest: false }),
  )
  marker.frustumCulled = false
  group.add(line, marker)
  const attribute = geometry.getAttribute('position') as BufferAttribute
  return {
    group,
    update(from, to, hit) {
      attribute.setXYZ(0, from.x, from.y, from.z)
      attribute.setXYZ(1, to.x, to.y, to.z)
      attribute.needsUpdate = true
      marker.visible = hit !== null
      if (hit) marker.position.copy(to)
    },
  }
}

function makeLabel(text: string, color: string): Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'rgba(13,13,15,0.75)'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.font = '600 64px Inter, system-ui, sans-serif'
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, canvas.width / 2, canvas.height / 2)
  const sprite = new Sprite(new SpriteMaterial({ map: new CanvasTexture(canvas), depthTest: false }))
  sprite.scale.set(2, 0.5, 1)
  return sprite
}

function countSceneTriangles(map: MapData): number {
  let total = 0
  map.root.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const index = mesh.geometry.getIndex()
    const position = mesh.geometry.getAttribute('position')
    if (index) total += index.count / 3
    else if (position) total += position.count / 3
  })
  return Math.floor(total)
}

function fmt(v: Vector3, digits = 1): string {
  return `${v.x.toFixed(digits)}, ${v.y.toFixed(digits)}, ${v.z.toFixed(digits)}`
}

/**
 * Walk a Pascal-exported glTF scene and pull out the gameplay registry (W1-A).
 *
 * The contract is documented in docs/ARCHITECTURE.md ("The Pascal GLB contract"). Everything is
 * optional: a plain GLB from anywhere parses to empty lists and stays fully static.
 */
import {
  AnimationClip,
  Box3,
  Euler,
  Matrix4,
  Mesh,
  Object3D,
  PropertyBinding,
  Quaternion,
  Vector2,
  Vector3,
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { DoorInfo, LevelInfo, PascalExtras, SpawnNodeInfo, ZoneInfo } from '../types'

export interface ParsedScene {
  levels: LevelInfo[]
  zones: ZoneInfo[]
  spawnNodes: SpawnNodeInfo[]
  doors: DoorInfo[]
  /**
   * Subtrees driven by a baked animation clip: door leaves AND window sashes (W3-D made
   * windows openable too). They must be kept out of the merged static collider because their
   * world matrix changes at runtime; bullets still stop on them, through the per-leaf BVHs
   * `collider.ts` builds for every `DoorInfo.leafMeshes`.
   */
  animatedNodes: Set<Object3D>
  /** Zone and spawn marker nodes — excluded from the collider so markers never block anything. */
  markerNodes: Set<Object3D>
}

const _matrix = new Matrix4()
const _position = new Vector3()
const _quaternion = new Quaternion()
const _scale = new Vector3()
const _euler = new Euler(0, 0, 0, 'YXZ')
const _box = new Box3()
const _size = new Vector3()
const _local = new Vector3()

export function parsePascalScene(gltf: GLTF): ParsedScene {
  const root = gltf.scene
  root.updateMatrixWorld(true)

  const levels: LevelInfo[] = []
  const zones: ZoneInfo[] = []
  const spawnNodes: SpawnNodeInfo[] = []
  const doors: DoorInfo[] = []
  const animatedNodes = new Set<Object3D>()
  const markerNodes = new Set<Object3D>()

  // Levels first: zones/spawns/doors resolve their owning level by walking up the tree.
  const levelByNode = new Map<Object3D, LevelInfo>()

  root.traverse((node) => {
    const extras = extrasOf(node)
    if (extras?.kind !== 'level') return
    const level: LevelInfo = {
      id: extras.pascalId ?? node.name ?? `level_${levels.length}`,
      label: extras.label ?? `Level ${levels.length}`,
      node,
      y: worldY(node),
    }
    levels.push(level)
    levelByNode.set(node, level)
  })
  levels.sort((a, b) => a.y - b.y)

  root.traverse((node) => {
    const extras = extrasOf(node)
    if (!extras) return

    switch (extras.kind) {
      case 'zone': {
        markerNodes.add(node)
        const zone = parseZone(node, extras, levelOf(node, levelByNode))
        if (zone) zones.push(zone)
        break
      }
      case 'spawn': {
        markerNodes.add(node)
        spawnNodes.push(parseSpawnNode(node, extras, levelOf(node, levelByNode), spawnNodes.length))
        break
      }
      // Doors and windows are the same thing to the game: a node with a baked "open" clip.
      case 'door':
      case 'window': {
        const openable = parseOpenable(gltf, node, extras)
        if (openable) {
          doors.push(openable.info)
          for (const animated of openable.animatedNodes) animatedNodes.add(animated)
        }
        break
      }
      default:
        break
    }
  })

  return { levels, zones, spawnNodes, doors, animatedNodes, markerNodes }
}

// ---------------------------------------------------------------------------

function extrasOf(node: Object3D): PascalExtras | null {
  const data = node.userData as Partial<PascalExtras> | undefined
  if (!data || typeof data.kind !== 'string') return null
  return data as PascalExtras
}

function worldY(node: Object3D): number {
  node.updateWorldMatrix(true, false)
  node.matrixWorld.decompose(_position, _quaternion, _scale)
  return _position.y
}

function levelOf(node: Object3D, levelByNode: Map<Object3D, LevelInfo>): LevelInfo | null {
  let current: Object3D | null = node.parent
  while (current) {
    const level = levelByNode.get(current)
    if (level) return level
    current = current.parent
  }
  return null
}

/** World yaw of a node (radians, three convention: 0 = facing -Z). */
function worldYaw(node: Object3D): number {
  node.updateWorldMatrix(true, false)
  _matrix.copy(node.matrixWorld)
  _matrix.decompose(_position, _quaternion, _scale)
  _euler.setFromQuaternion(_quaternion, 'YXZ')
  return _euler.y
}

function parseZone(node: Object3D, extras: PascalExtras, level: LevelInfo | null): ZoneInfo | null {
  const raw = extras.polygon
  if (!Array.isArray(raw) || raw.length < 3) return null

  node.updateWorldMatrix(true, false)
  const polygon: Vector2[] = []
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length < 2) continue
    _local.set(pair[0], 0, pair[1])
    node.localToWorld(_local)
    polygon.push(new Vector2(_local.x, _local.z))
  }
  if (polygon.length < 3) return null

  const floorY = level ? level.y + 0.05 : worldY(node)
  const centroid2 = polygonCentroid(polygon)

  return {
    id: extras.pascalId ?? node.name,
    label: extras.label ?? extras.pascalId ?? node.name,
    color: extras.color ?? '#8b8b93',
    levelId: level?.id ?? null,
    node,
    polygon,
    centroid: new Vector3(centroid2.x, floorY, centroid2.y),
    floorY,
  }
}

function parseSpawnNode(
  node: Object3D,
  extras: PascalExtras,
  level: LevelInfo | null,
  index: number,
): SpawnNodeInfo {
  node.updateWorldMatrix(true, false)
  node.matrixWorld.decompose(_position, _quaternion, _scale)
  const extraYaw = typeof extras.rotation === 'number' ? extras.rotation : 0
  return {
    id: extras.pascalId ?? node.name ?? `spawn_${index}`,
    label: extras.label ?? `Spawn ${index + 1}`,
    levelId: level?.id ?? null,
    position: _position.clone(),
    yaw: normalizeAngle(worldYaw(node) + extraYaw),
  }
}

/**
 * A door or an openable window → `DoorInfo`. Both carry `openable: true` plus a 1 s "open"
 * clip whose tracks target the moving leaves (door panels, `casement-window-sash`).
 */
function parseOpenable(
  gltf: GLTF,
  node: Object3D,
  extras: PascalExtras,
): { info: DoorInfo; animatedNodes: Object3D[] } | null {
  if (extras.openable !== true) return null
  const clipNames = extras.clips
  if (!Array.isArray(clipNames) || clipNames.length === 0) return null

  let clip: AnimationClip | undefined
  for (const name of clipNames) {
    clip = gltf.animations.find((a) => a.name === name)
    if (clip) break
  }
  if (!clip) return null

  // Track names target the animated LEAF nodes. Pascal leaves them unnamed, so GLTFLoader falls
  // back to the object uuid — PropertyBinding.findNode resolves both.
  const animatedNodes: Object3D[] = []
  for (const track of clip.tracks) {
    const parsed = PropertyBinding.parseTrackName(track.name)
    const nodeName = parsed.nodeName
    if (!nodeName) continue
    const target = PropertyBinding.findNode(gltf.scene, nodeName) as Object3D | null
    // findNode returns the root itself when it cannot resolve the name — never accept that.
    if (!target || target === gltf.scene) continue
    if (!isDescendantOf(target, node)) continue
    if (!animatedNodes.includes(target)) animatedNodes.push(target)
  }
  if (animatedNodes.length === 0) return null

  const leafMeshes: Mesh[] = []
  for (const animated of animatedNodes) {
    animated.traverse((child) => {
      if ((child as Mesh).isMesh) leafMeshes.push(child as Mesh)
    })
  }

  node.updateWorldMatrix(true, true)
  node.matrixWorld.decompose(_position, _quaternion, _scale)
  const center = _position.clone()

  _box.makeEmpty()
  _box.setFromObject(node)
  const halfWidth = _box.isEmpty()
    ? 0.45
    : Math.max(0.45, Math.max(_box.getSize(_size).x, _size.z) * 0.5)

  return {
    info: {
      id: extras.pascalId ?? node.name,
      label: extras.label ?? extras.pascalId ?? node.name,
      kind: extras.kind === 'window' ? 'window' : 'door',
      node,
      clip,
      center,
      leafMeshes,
      halfWidth,
    },
    animatedNodes,
  }
}

function isDescendantOf(node: Object3D, ancestor: Object3D): boolean {
  let current: Object3D | null = node
  while (current) {
    if (current === ancestor) return true
    current = current.parent
  }
  return false
}

/** Area-weighted centroid of a simple polygon; falls back to the average for degenerate input. */
export function polygonCentroid(polygon: Vector2[]): Vector2 {
  let area = 0
  let cx = 0
  let cz = 0
  for (let i = 0, n = polygon.length; i < n; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % n]
    const cross = a.x * b.y - b.x * a.y
    area += cross
    cx += (a.x + b.x) * cross
    cz += (a.y + b.y) * cross
  }
  area *= 0.5
  if (Math.abs(area) < 1e-6) {
    let ax = 0
    let az = 0
    for (const p of polygon) {
      ax += p.x
      az += p.y
    }
    return new Vector2(ax / polygon.length, az / polygon.length)
  }
  return new Vector2(cx / (6 * area), cz / (6 * area))
}

/** Standard even-odd point-in-polygon test on the XZ plane. */
export function pointInPolygon(polygon: Vector2[], x: number, z: number): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (a.y > z !== b.y > z && x < ((b.x - a.x) * (z - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

function normalizeAngle(a: number): number {
  let r = a % (Math.PI * 2)
  if (r > Math.PI) r -= Math.PI * 2
  if (r < -Math.PI) r += Math.PI * 2
  return r
}

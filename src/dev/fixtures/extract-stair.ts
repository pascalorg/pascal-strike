/**
 * One-off extractor (W4-E): pull real collider triangles out of a loaded Pascal map so a
 * headless test can walk the very geometry the game builds, not a synthetic stand-in.
 *
 * It is not wired into any dev entry — it is driven from the browser on any page of the dev
 * server, which is the only place the whole map pipeline (meshopt + KTX2 + batching + collider
 * bake) actually runs:
 *
 *   const m = await import('/src/dev/fixtures/extract-stair.ts')
 *   const fixture = await m.extractColliderTriangles({ min: [0, 0, -0.9], max: [1.4, 3.6, 1.9] })
 *
 * The result is written to `pascal-stair.json` next to this file.
 */
import { Box3, Vector3 } from 'three'
import { createLoaders } from '../../engine/loaders'
import { createRenderer } from '../../engine/renderer'
import { loadMap } from '../../map/map-loader'

export interface ExtractOptions {
  /** Defaults to the built-in Pascal house. */
  mapUrl?: string
  /** World-space box to keep, as `[x, y, z]` pairs. A triangle counts if any vertex is inside. */
  min?: [number, number, number]
  max?: [number, number, number]
  /**
   * Instead of an explicit box: every node whose name starts with this (`'stair_'`), expanded
   * by `pad`. The resolved box comes back in the result.
   */
  around?: string
  pad?: number
  /** `'movement'` (default) is the collider the character controller walks on. */
  collider?: 'movement' | 'bullet'
}

export interface ColliderFixture {
  source: string
  collider: string
  box: { min: number[]; max: number[] }
  triangleCount: number
  /** World-space vertices, 9 numbers per triangle (ax ay az bx by bz cx cy cz). */
  positions: number[]
  /** Every distinct vertex height in the box, sorted — the riser heights read off directly. */
  levels: number[]
}

const _tri = new Box3()
const _a = new Vector3()
const _b = new Vector3()
const _c = new Vector3()

export async function extractColliderTriangles(opts: ExtractOptions): Promise<ColliderFixture> {
  const mapUrl = opts.mapUrl ?? '/maps/pascal-house.glb'
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;left:-4000px;top:0;width:320px;height:200px'
  document.body.appendChild(container)

  const engine = await createRenderer(container)
  const loaders = createLoaders(engine.renderer)
  try {
    // No static batching: the merged batches would empty the very nodes `around` looks for, and
    // the colliders are baked from the original meshes before batching either way.
    const map = await loadMap(mapUrl, loaders, { batchStatic: false })
    const collider = opts.collider === 'bullet' ? (map.bulletCollider ?? map.collider) : map.collider
    const box = new Box3()
    if (opts.min && opts.max) box.set(new Vector3(...opts.min), new Vector3(...opts.max))
    if (opts.around) {
      const pattern = opts.around
      map.root.updateWorldMatrix(true, true)
      let matched = 0
      map.root.traverse((node) => {
        if (!node.name.startsWith(pattern)) return
        matched++
        box.union(new Box3().setFromObject(node))
      })
      if (matched === 0) throw new Error(`extractColliderTriangles: no node named ${pattern}*`)
      box.expandByScalar(opts.pad ?? 0)
    }
    if (box.isEmpty()) throw new Error('extractColliderTriangles: empty box')
    const position = collider.geometry.getAttribute('position')
    const index = collider.geometry.getIndex()
    const count = index ? index.count : position.count

    const positions: number[] = []
    const levels = new Set<number>()
    for (let i = 0; i < count; i += 3) {
      const ia = index ? index.getX(i) : i
      const ib = index ? index.getX(i + 1) : i + 1
      const ic = index ? index.getX(i + 2) : i + 2
      _a.fromBufferAttribute(position, ia)
      _b.fromBufferAttribute(position, ib)
      _c.fromBufferAttribute(position, ic)
      // AABB overlap, not vertex containment: the floor slab under the flight is one huge quad
      // whose corners are all far outside the box, and leaving it out would drop the player
      // into the void before the first tread.
      _tri.makeEmpty()
      _tri.expandByPoint(_a)
      _tri.expandByPoint(_b)
      _tri.expandByPoint(_c)
      if (!box.intersectsBox(_tri)) continue
      for (const v of [_a, _b, _c]) {
        positions.push(round(v.x), round(v.y), round(v.z))
        levels.add(round(v.y))
      }
    }

    return {
      source: mapUrl,
      collider: opts.collider ?? 'movement',
      box: { min: box.min.toArray().map(round), max: box.max.toArray().map(round) },
      triangleCount: positions.length / 9,
      positions,
      levels: [...levels].sort((a, b) => a - b),
    }
  } finally {
    loaders.dispose()
    engine.dispose()
    container.remove()
  }
}

/** Sub-millimetre precision keeps the fixture readable without moving any surface. */
function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

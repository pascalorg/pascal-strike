# W4-A — Breakable glass + openable leaves out of the movement collider

You own `src/map/*` and `src/dev/map-viewer.ts`. Contracts: `GlassPane`, `MapData.breakables`
in `src/types.ts`.

## 1. Breakable glass
- `map-parse.ts`: collect glass panes = every `Mesh` whose material is transparent
  (`material.transparent || opacity < 1 || alphaMode BLEND`), whether static (fixed windows) or
  inside an openable leaf (sashes, French-door panes). Ids `glass:<n>` in traversal order so
  every client agrees. `breakables: GlassPane[]` on `MapData`.
- Colliders: glass panes leave the **bullet** collider (they get their own boundsTree and are
  tested dynamically by `WorldQuery` while `!broken`, using their live `matrixWorld`; a
  `HitResult.kind = 'glass'` — extend the `kind` union in `types.ts`, that one edit is yours —
  and `HitResult.object` = the pane). They stay in the movement collider and the navmesh source.
- `map-loader.ts` / `batch.ts`: panes are never merged into a batch (each stays its own mesh so
  it can be hidden); glass inside merged leaves must be kept out of the leaf merge as well.
- New `src/map/glass.ts`: `createGlassSystem(map, scene) → { break(id, impactPoint?, dir?),
  isBroken(id), states(), restore(id) }`: `break` hides the pane, marks it broken (so raycasts
  skip it), spawns 10–16 shard particles (thin flat quads, pane colour, tumbling, gravity, 0.8 s)
  + a sparkle, and returns true when it changed. Host mirrors broken ids into global `glass`
  state for late joiners (the game agent wires the RPC/state; you provide `states()` and
  `break()`).
- Map viewer: `G` toggles glass debug (panes highlighted), clicking with `R` probe on a pane
  breaks it.

## 2. Openable leaves and the movement collider
Doors AND window sashes now block players physically wherever they are (closed = solid, open =
you can pass; the controller does this via `setDynamicColliders(leafMeshes)`, another package).
So: **both** door leaves and window sashes leave the movement collider (as door leaves already
do); the navmesh source keeps window sashes at their closed pose (bots never use windows) and
excludes door leaves (bots open doors). Make sure every leaf mesh has a boundsTree.

## Verify (headless Chrome, `--mute-audio`, kill after; dev server http://localhost:5180; never
start a second Vite instance on this repo)
- pascal-house: number of panes found (expect fixed windows + 2 sashes + French-door panes),
  a paintball on an intact pane returns `glass` and after `break()` passes through to whatever
  is behind; shards visible in a screenshot; batched draw calls still ≈ 90 + panes.
- Movement collider excludes sashes and door leaves; navmesh still connects the floors and does
  not route through windows.
- `bun run typecheck`, `bun test` green. Stage only your files; commit.

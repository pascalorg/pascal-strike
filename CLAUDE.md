# Pascal Strike

3v3 paintball deathmatch in Pascal-built houses. three.js 0.185 WebGPU + Playroom Kit + Vite.

**Read `docs/ARCHITECTURE.md` first**, then `src/types.ts` and `src/config.ts`. They are the
contract; the architect owns them.

- `bun dev` · `bun run typecheck` (must pass) · `bun run build` · `bun run inspect-glb <glb>`
- Do not add dependencies. Do not edit files owned by another work package.
- Import core classes from `three`; renderer/node materials from `three/webgpu`; TSL from `three/tsl`.
- Gameplay numbers → `src/config.ts`. Cross-module interfaces → `src/types.ts`.
- No allocations in per-frame code (module-level scratch vectors).
- Test map: `public/maps/pascal-house.glb` (Pascal export; doors have baked "open" clips, no stairs yet).

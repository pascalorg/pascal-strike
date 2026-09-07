# Splash armory

Three Blender-authored replacements follow the supplied references: the main marker, Splashblaster 3000 sidearm, and paint scraper melee weapon. They are used in first-person view and on remote characters; gameplay stats are unchanged.

## Files and inspection

- Editable source: `art/weapons/splash-armory.blend`, with separate named parts and a collection per weapon.
- Rebuild script: `art/weapons/build.py` (also embedded as a Blender text block). Run in a fresh Blender scene; `BASE` selects the export directory.
- Runtime exports: `public/weapons/rifle.glb`, `pistol.glb`, `knife.glb`.
- Blender product renders: `art/weapons/previews/`.
- Runtime viewer: `?dev=weapons` (append `&webgl=1` for the WebGL fallback). Orbit, switch assets, change team color, test paint levels and muzzle flashes.

All modelling, modifier evaluation, and GLB exports were executed through Blender MCP. No external model generator or third-party asset library was used.

## Runtime contract

Blender uses metres, +Y forward, +Z up. The GLB exporter converts that to the game's −Z firing direction and +Y up. The origin is the hand grip; the scraper stands upright along +Y in the GLB. `Grip_export` and `Muzzle_export` mark the grip and bore/tip. `PaintLevel_export` is the bottom-aligned liquid pivot; scaling its local Y drains the reservoir without changing the shell.

Materials beginning with `TeamPaint` and `TeamGlass` use the player's team color. Cream shells, navy rubber, cyan indicators, and the scraper's secondary paint colors remain authored colors. Each weapon instance clones its materials and transforms; immutable GLB geometry is cached and shared. No textures or external buffers are required.

The exports contain roughly 22k / 23k / 18k triangles and total about 1.7 MB. Static parts are combined into one mesh with seven material primitives per weapon. Liquid remains separate on the two firearms. Both views currently use the same geometry. First-person hands align by the palm grasp rather than the wrist socket; sidearms hide the support hand. `characters/grip.ts` reuses the sword animation’s closed finger pose for the scraper and blends a looser firearm grip with a curled trigger finger. Only the right finger bones change, preserving wrist/arm motion. Third-person reloads and deaths retain their authored hand animation. Overrides are restored before each mixer update, so repeated shots or weapon switches cannot accumulate finger rotation. No source animation or model re-export is required. The primitive weapons remain as immediate loading/offline fallbacks; the lobby preloads all three GLBs before joining a match.

## Verification

`bun test` and `bun run build` cover the existing game contracts and typecheck. `scripts/verify-weapons.mjs` checks the real GLBs in WebGPU and WebGL, including muzzle coordinates, independent team colors/fill levels, and disposal/recreation from cached geometry. `scripts/verify-characters.mjs` checks third-person hand mounts, and `scripts/verify-gameplay.mjs` exercises actual shooting between two clients.

Browser scripts use an existing Playwright installation through `PLAYWRIGHT_MODULE`; no project dependency is added.

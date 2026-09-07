# Character Studio integration

The lobby offers Wawa, Brian, Janette, and Nova, with an animated preview and a **Create my character** button. The button opens Character Studio in a modal iframe. Choose **Done** in Studio to bake and import the character. No Studio account is required. The selection is remembered in this browser and sent to everyone in the room.

## Assets

`public/characters/` contains four immutable Studio bakes, portraits, and the shared man/woman animation libraries. Default characters work without a running Studio server. The manifest and source URLs are recorded in `roster.json`; `sources.json` records the downloaded CDN URLs, byte sizes, and SHA-256 hashes. Brian Tuxedo and Nova were refreshed from their published Studio characters on September 7, 2026, including their lobby portraits. Models use medium quality with no face morph targets. Textures and geometry are shared across instances; skeletons, mixers, and mutable materials are independent.

`node scripts/sync-characters.mjs` refreshes models from the pinned bake IDs and downloads the current shared animation libraries. Review changed hashes and run the browser checks after refreshing. Portraits are copied from the original Studio character thumbnails.

## Creator contract

The default origin is `https://characterstudio.wawasensei.dev`. Set `VITE_CHARACTER_STUDIO_URL` to another Studio origin when developing the creator locally (for example `http://localhost:3000`). Restart Vite after changing it.

The host passes its exact origin to `/embed`, checks both `event.origin` and `event.source`, and accepts only versioned `cs.v1` events. Exports must point at a pinned `/api/models/b/<bakeId>.json` manifest on that Studio origin. The host validates the manifest and loads both the model and animation library before selecting the custom character. Load/save errors remain visible in the dialog so the visitor can retry. Closing a dialog cancels its pending import and restores focus.

Character Studio references:

- [Embed contract](https://github.com/wass08/character-studio/blob/main/docs/integration/embed.md)
- [GLB, rig and animation contract](https://github.com/wass08/character-studio/blob/main/docs/integration/character-studio-glb.md)

## Gameplay

`src/characters/assets.ts` loads Meshopt GLBs, removes animation scale tracks, clones the skin correctly, and normalizes the outer group to the shared player capsule. It never overwrites the baked Rig transform. Custom proportions do not change collision or damage rules.

`animation.ts` crossfades the Studio idle, walk, sprint, crouch, jump, shooting, reload, sword, hit, and death clips. Disjoint upper/lower bone tracks let a player aim or reload while moving. The marker, pistol, and knife attach to Studio's right-hand socket; the actual muzzle still supplies remote projectile effects. Paint follows the outfit’s own triangles and skin weights, including deformation across joints. Name tags, weapon accents, and spawn shields communicate team colors without repainting the chosen outfit.

The first-person view uses the selected Studio model's hands and sleeves. The crop keeps only triangles weighted to the arms; weapon recoil, reload tilt, and switch motion remain driven by the weapon controller.

The reliable player state stores a validated character descriptor plus grounded/reload changes. Bots choose deterministic defaults by player ID, including after host migration. A remote custom model that becomes unavailable falls back to a bundled default. All defaults and the local selection are loaded before joining a room.

## Verification

- `bun run typecheck`
- `bun test` — physics, damage, network, weapon and avatar lifecycle checks.
- `bun run build`
- `?dev=characters` — four real avatars and controls for every gameplay animation, weapon and death/respawn; add `&webgl=1` to force WebGL2.
- `node scripts/verify-characters.mjs` against `bun dev` — actual GLB/animation playback and cloning, both render backends, socket mounting, lifecycle, lobby persistence, portraits, and iframe origin/source checks. This uses an existing Playwright installation; set `PLAYWRIGHT_MODULE` to its importable module path when it is outside this project. `BASE_URL` and `ARTIFACT_DIR` override the server and screenshot destination.

The live creator round trip and a two-client Playroom match also need browser verification when changing the embed or networking contract. The local fixture deliberately does not pretend that a synthetic message proves Studio can export a character.

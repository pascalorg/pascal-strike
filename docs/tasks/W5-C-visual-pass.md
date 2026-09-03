# W5-C — Visual pass: lighting, shadows, post-processing

The user wants a proper aesthetic pass. Reference: Pascal's viewer render mode in
`/Users/wawa/Documents/Projects/pascal/private-editor/editor/packages/viewer/src/components/viewer/post-processing.tsx`
and `index.tsx` (WebGPU `PostProcessing` with TSL nodes: read what they use — AO, bloom, tone
mapping, AA — and their parameters). You are free to do better if you have good ideas; it must
run at 60 fps at 1080p on an Apple-silicon Mac on WebGPU and degrade gracefully on WebGL2.

You own `src/engine/renderer.ts`, `src/engine/environment.ts`, `src/engine/post.ts` (new),
`src/map/map-loader.ts` **only for material tweaks at load** (envMapIntensity, roughness clamps),
`src/dev/map-viewer.ts` (a `P` toggle to compare), and `src/game/map-session.ts` only if the
environment needs the map bounds it does not get today.

## Targets
1. **Sky + sun**: a physically plausible sky (`SkyMesh` from `three/examples/jsm/objects/SkyMesh.js`
   for WebGPU) driven by a sun elevation of ~35°, warm late-afternoon light; `scene.environment`
   from the sky via PMREM (so walls pick up sky blue and sun warmth); `environmentIntensity`
   tuned so interiors are lit but not flat.
2. **Shadows**: sun shadow map 4096 fitted to the play area (the house, not the 30 m lawn),
   soft edges (PCF soft, radius tuned, or VSM if it looks better in WebGPU), normal bias so no
   acne on walls; the frustum follows the player as today.
3. **Ambient occlusion**: GTAO (`three/examples/jsm/tsl/display/GTAONode.js`) — this is what
   makes rooms read; radius ~0.35 m, scale tuned, denoised; falls back to none on WebGL2 if
   unsupported.
4. **Bloom**: subtle (`three/examples/jsm/tsl/display/BloomNode.js`), threshold high so only the
   sun-lit highlights, muzzle flashes and shields glow; paint decals must NOT bloom.
5. **Tone mapping + grade**: AgX or ACES (compare), exposure 1.0–1.2, a gentle S-curve/saturation
   lift so the team colours pop, slight vignette (0.25). Optional: film grain at 2 %.
6. **Anti-aliasing**: MSAA via the renderer if PostProcessing supports it, else FXAA/SMAA node
   at the end of the chain (`three/examples/jsm/tsl/display/FXAANode.js` / `SMAANode.js`); text
   HUD is DOM so it is unaffected.
7. Keep the debug overlays, decals (`polygonOffset`), view model (rendered last, no AO on it if
   it looks wrong) and the transparent glass working. Check the paint splats still read
   correctly under AO/bloom.

## Verify (headless Chrome `--mute-audio`, kill after; http://localhost:5180; no second Vite;
WebGPU is available headless on this machine)
Before/after screenshots at 1920×1080 of: exterior at spawn, a lit room, a dark corridor, a
firefight with decals, the view model. Frame time mean/p95 and draw calls before/after (report
the cost of each effect separately: AO, bloom, AA). `bun run typecheck`, `bun test`. Stage only
your files; commit each effect separately so any one can be reverted.

Note: Pascal's render mode uses SSGI (`three/addons/tsl/display/SSGINode.js`) + denoise + an
AgX grade. SSGI is expensive; for a 60 fps shooter prefer GTAO + a good environment, and only add
SSGI behind a quality toggle if it stays under budget. Report the numbers either way.

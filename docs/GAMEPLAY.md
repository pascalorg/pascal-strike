# Gameplay tuning pass

## Movement and fights

Normal running stays at 5.5 m/s and the map is untouched. Crouching is now 1.8 m/s (previously 2.6). Bot encounters no longer involve continuous full-speed strafing during firing: bots plant their feet for a burst and reposition during its pause.

The original marker could land its three unarmored body hits at 0, 83, and 167 ms. Headshots already required two hits, not one. To give players more time to react, everyone now spawns with 100 HP plus 50 armor/helmet, and the marker fires 10 rounds/s.

Armor absorbs 35% of bullet damage to the head, torso and arms, consuming its own pool. Legs and melee bypass armor. It resets on respawn and does not regenerate. With fresh armor, the marker requires three head hits (200 ms between first and lethal hit) or five body hits (400 ms). Host authority owns the calculation; armor is mirrored through player state, damage events and bot state, and survives host migration.

A confirmed hit holds the victim's movement at 55% for 120 ms, then smoothly returns to full speed over 380 ms. Another hit refreshes that duration; penalties never stack into immobility. The same path affects humans and host-simulated bots. Respawning clears the penalty.

## Feedback and tab testing

Confirmed player hits give a bright crosshair marker (gold for the head), an audible hit cue, a visible central paint burst, and larger body paint. The shooter's hit sound now follows host-confirmed damage; simulated bot shots no longer play a false local confirmation. Eliminations add a separate sound and a brief centered “ELIMINATED” banner. Armor is shown above health.

**P** releases the pointer without opening the menu. Click the canvas or press P again to recapture. Esc still accesses the menu. Unlocking or blurring clears movement, firing, edge inputs, and accumulated mouse motion; a click used to recapture does not also fire a shot.

## Animation fixes

Some Studio spine bones have no animation track. Multiplying pitch into one every frame accumulated rotation because the mixer did not overwrite that bone. The previous additive aim is now removed before each mixer update.

Repeated automatic shots previously stopped/restarted a fade-in while the upper body had no underlying action at full weight. Each animation layer now retains normalized pose weights through interruptions, and restarting a shot preserves its current contribution. Actions are created lazily. Regression tests cover 1,200 idle frames, a simulated background-frame gap, 100 repeated shots, death, and respawn.

## Performance evidence

Measurements are JavaScript CPU costs on the development machine, not whole-game FPS promises:

| Operation | Before | After | Test |
| --- | ---: | ---: | --- |
| Place character paint | 6.43 ms average | 1.87 ms average | 30 hits against the real Wawa GLB |
| Project a wall decal | 27.38 ms average | 0.10 ms average | 30 decals on a 180,000-triangle stress surface |

Character paint queries use cached triangle clusters with conservative bounds that follow every influencing bone. Only nearby clusters are skinned for the surface query. Paint then copies the outfit’s own triangles and skin weights, with a projected alpha footprint, so it bends with clothing and cannot extend beyond its silhouette. Misses create no fallback plane. The earlier 0.12 ms approximation used ellipsoids and flat planes; those were faster but could leave paint floating beside the body, so that path was removed.

Wall decals now use the existing collision BVH to select nearby triangles before clipping, instead of projecting against the entire merged house. A test compares the resulting geometry with the original projector on a translated, rotated, nonuniformly scaled surface. Small surfaces without a BVH keep the original projection path.

Crosshair feedback now uses cancelable browser animations rather than forcing layout on every hit.

## Checks

- `bun test` — combat/armor/tagging, animation regressions, decal geometry equivalence, existing physics/network/weapons/audio checks.
- `bun run build` — typecheck and production bundle.
- `scripts/verify-paint.mjs` — all four real outfits retain surface attachment while walking, crouching, firing and reloading in WebGPU/WebGL; respawn clears paint.
- `scripts/verify-characters.mjs` — actual character animation and rendering in WebGPU and WebGL2.
- `scripts/verify-gameplay.mjs` — two real Playroom clients: P unlock/recapture, Esc menu, stable inactive-tab aim, actual controller slowdown (5.5 → 3.025 m/s), replicated armor/damage, automatic projectiles, elimination feedback, and respawn. Run against a built preview at port 5181. Uses an existing Playwright installation; `PLAYWRIGHT_MODULE`, `BASE_URL`, and `ARTIFACT_DIR` can override its defaults.

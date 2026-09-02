# W3-A — Weapon look and feel

Player feedback after the first playtest:
- "Even if it's paintball I want them to be precise where we aim, ok to be less precise when
  running, and feel powerful going straight ahead."
- "The aesthetic of the weapon should look more sexy" — reference: a compact futuristic
  bullpup/SMG blaster: **matte white polymer body** with chamfered panels and shallow panel
  lines, **dark charcoal receiver/grip/stock**, a full-length top rail with small front and rear
  sights, an angled foregrip under the front, a squared muzzle shroud, a folding-style stock.
  Add the paint colour (team colour) as accent: a thin light strip along the body, the hopper/
  tank tinted translucent in team colour, and the muzzle ring.
- "The character should walk when pressing Shift" (default = run).

You own: `src/weapons/weapon-model.ts` (new), `src/player/viewmodel.ts`, `src/weapons/marker.ts`,
`src/weapons/effects.ts`, `src/engine/audio.ts`, `src/player/camera.ts`, `src/game/local-player.ts`.
Contracts already updated (read them): `src/config.ts` (`PLAYER.runSpeed/walkSpeed`, `WEAPON.spread*`,
`recoilPitch`, `projectileSpeed 95`), `src/types.ts` (`MoveInput.walk`), `src/engine/input.ts`
(`move.walk` = Shift held, `interact` = E edge — do not handle E here, another package does),
`src/player/controller.ts` (already uses `walk`).

## Deliverables

1. **`weapon-model.ts`**: `createWeaponModel(opts: { team: TeamId; quality: 'first' | 'third' })
   → { object: Group; setTeam(team); muzzle: Object3D; setFireFlash(intensity) }` built from
   primitives (boxes with `BoxGeometry` + bevel via slightly inset secondary boxes, cylinders for
   the barrel/muzzle, a thin rail with 6–8 notches as small boxes). Materials: white
   `MeshStandardMaterial` (roughness 0.55, metalness 0.05), charcoal (0x1f2024, roughness 0.7),
   team accent (emissive team colour, `emissiveIntensity 0.6`) and a translucent hopper
   (team colour, opacity 0.55). Total ≈ 40 parts, no textures. The `'third'` quality is the
   same model with ~60 % of the parts, used on avatars later (export it; the avatar owner mounts it).
   The model's origin is the grip; +Z points **backward** (toward the shooter), −Z is the muzzle
   direction, so it can be parented to the camera at the current rest pose.
2. **`viewmodel.ts`**: use the new model. Keep the API (`update`, `fire`, `reload`, `setTeam`) and
   rest pose constants. Add a subtle idle sway, a stronger but short kick on `fire()` (back 3 cm +
   up 1°, recover in 120 ms), muzzle flash (bright team-colour sprite at `muzzle` for 40 ms) and
   the hopper "paint level" dropping with the hopper count (`setHopper(n, max)`).
3. **`marker.ts` accuracy model**: replace the single `spreadDeg` with the tiers in `WEAPON`:
   base sigma by motion state (`setMotion(speedXZ, grounded, crouching, walking)` called by the
   local player each frame; blend walking→running by speed between `PLAYER.walkSpeed` and
   `runSpeed`; crouching standing still = `spreadStandingDeg * 0.7`), plus a per-shot bloom
   (`spreadPerShotDeg` added per shot, recovering at `spreadRecoveryPerSec`). Expose
   `currentSpreadDeg` for the HUD crosshair (the HUD already has a crosshair expand API; the
   local player passes it through). Projectile speed 95 m/s from config. Fire rate unchanged.
4. **Punch**: `camera.ts` recoil per shot from `WEAPON.recoilPitch` with a small random yaw
   component (±30 % of pitch), and a 2 px screen shake decaying in 80 ms. `effects.ts`: muzzle
   flash sprite + a short **tracer** (a thin additive line from the muzzle 1.5 m forward for one
   frame) so shots read as powerful. `audio.ts`: punchier `shot` (add a low 80 Hz thump under the
   thwip, 60 ms) and a distinct dry-fire click when the hopper is empty.
5. **`local-player.ts`**: pass `move.walk` through (already in `MoveInput`), call
   `marker.setMotion(...)`, feed spread to the HUD crosshair, keep everything else. Walking
   (Shift) also reduces view bob and footstep volume.

## Verification
- `bun run typecheck`, `bun test` green. Add `src/weapons/marker.test.ts`: 200 shots standing
  still have sigma ≤ 0.2°, 200 shots running have sigma ≥ 1.2°, bloom decays back within 1 s.
- Visual check in the browser (claude-in-chrome if connected, else headless Chrome over CDP
  like previous agents: `?sandbox=1` renders the view model; screenshot it at 1920×1080 and judge
  it against the reference description — it must look like a designed product, not primitives
  glued together). Iterate on proportions until it does.
- Stage only your files; commit.

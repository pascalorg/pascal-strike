# W4-B — Three weapons: rifle (1), pistol (2), knife (3)

You own `src/weapons/marker.ts` (+test), `src/weapons/weapon-model.ts`, `src/weapons/projectiles.ts`
(+test), `src/weapons/melee.ts` (new), `src/player/viewmodel.ts`, `src/engine/input.ts`,
`src/game/local-player.ts`, `src/ui/hud.ts` (ammo/weapon widget only), and `src/config.ts` **only
for the `WEAPONS` table values** (already there: rifle 30 rounds auto 9/s, pistol 12 rounds
semi-auto 5/s tighter spread, knife 60 dmg / 1.7 m / 25° cone / backstab ×2). Contracts:
`WeaponKind`, `ShotEvent.weapon`, `HitEvent.weapon`, `PlayerEntity.weapon` in `src/types.ts`.
The host already scales damage by `WEAPONS[weapon].damageScale` and uses `WEAPONS.knife.damage`
for knife hits.

## Deliverables
1. **Input**: keys 1/2/3 and mouse wheel select the slot (`input.weaponSlot` edge, 1–3).
2. **Weapon models** (`weapon-model.ts`): `kind` option builds the pistol (compact white/charcoal
   sidearm in the same design language: chamfered slide, charcoal grip, short rail, team accent,
   small translucent paint reservoir) and the knife (a paint-dipped combat knife: charcoal
   handle, brushed white blade, team-colour paint on the edge). Same `'first' | 'third'` quality.
3. **Marker → weapons**: `marker.ts` becomes per-weapon: `createMarker` takes the `WEAPONS`
   entry; `setWeapon(kind)` swaps (0.35 s switch time during which you cannot fire; each weapon
   keeps its own ammo/reload state). Rifle = today's behaviour with 30 rounds. Pistol =
   semi-auto (one shot per click, no auto), 12 rounds, `spreadScale 0.5`, faster projectile.
   `ShotEvent.weapon` set. Ammo `Infinity` for the knife.
4. **Knife** (`melee.ts`): a swing every `1/fireRate` s while the button is held; on the swing's
   hit frame (120 ms in) test every enemy `Hittable` within `range` of the eye and inside
   `coneDeg` of the look direction (capsule-vs-cone: nearest point on the capsule segment),
   plus a `WorldQuery.lineOfSight` check; produce a `HitEvent` with `weapon: 'knife'`, `part`
   from the shapes, and `point`. Backstab: if the victim faces away (dot(victim forward, to
   attacker) < -0.3) the host applies ×2 — pass it as `part: 'head'`? No: add nothing to the
   wire; instead set `weapon: 'knife'` and let the host apply backstab only when
   `HitEvent.point` is behind the victim (compute on the host from the victim's yaw; the host
   file is another agent's, so document the rule in `net/protocol.ts` comments and leave a
   TODO for the host owner — flat 60 is fine for now). Knife slash also paints a small smear
   decal on walls when it hits static geometry within range.
5. **View model**: holds one model per kind, switch animation (lower current 0.2 s, raise next
   0.15 s), knife swing animation (arc + return), pistol kick, rifle unchanged. `setHopper` per
   weapon.
6. **Local player**: wire slot selection, `marker.setWeapon`, melee update, weapon on the
   entity + player state `w` (reliable, via the room; read how `name`/`team` are set),
   `moveSpeedScale` applied to the controller's target speed (pass a multiplier; the controller
   is another agent's file — add an optional `speedScale` argument to `update` only if it is
   trivially additive, else scale the input vector).
7. **HUD** ammo widget: shows the weapon label and slot dots (1 2 3) with the active one lit,
   ammo `12 / ∞` style, knife shows "—".
8. **Audio** names to call (the audio package provides them; until it lands call them anyway —
   `audio.play` ignores unknown names): `pistolShot`, `knifeSwing`, `knifeHit`, `weaponSwitch`,
   `reloadStart`, `reloadEnd`.

## Verify (headless Chrome `--mute-audio`, kill after; dev server http://localhost:5180; no
second Vite instance) via `?sandbox=1` and the default route with `window.__ps`
- rifle: 30 rounds, reload; pistol: 12, one shot per click even when held; knife: kills a bot in
  2 swings from the front (60 + 60), paints a smear on the wall; switching with 1/2/3 and wheel;
  HUD widget; screenshots of each view model. `bun run typecheck`, `bun test` (add marker tests
  for pistol semi-auto and switch lockout, a melee cone test). Stage only your files; commit.

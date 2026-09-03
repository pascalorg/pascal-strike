# W4-D — Remote players: smooth movement, shots from the gun, visible firing

You own `src/net/sync.ts`, `src/game/remote-players.ts`, `src/player/avatar.ts`,
`src/weapons/effects.ts`, and the **remote-shot spawn block** in `src/game/game.ts` (another
agent edits other blocks of that file: re-read before editing, keep your edit small).

## 1. Movement is not smooth ("they teleport a bit")
Diagnose with two browsers before changing anything: log, for one remote, the render-time
position deltas per frame and the interpolator's bracketing state (interpolating /
extrapolating / snapped-to-latest) at 60 fps for 10 s. Likely causes to check: sender
timestamps (`snapshot.t` from the sender's `Date.now()`) do not line up with the receiver's
clock, so `now − interpDelay` never falls between two samples and the sampler snaps to the
newest; the 20 Hz sender skipping "unchanged" snapshots while the player is turning; bots'
15 Hz snapshots; the sampler being called from the fixed step instead of every render.
Fix properly: buffer by **arrival time** (a jitter buffer: each snapshot gets
`receivedAt = performance.now()`; render at `receivedAt − NET.interpDelayMs` using the sender's
`t` only to order and to measure the sender interval), adapt the delay to the measured
interval (≥ 1.5 × interval), interpolate position and yaw/pitch (shortest arc) every render
frame, extrapolate ≤ 100 ms with the last velocity, then hold. Also feed the avatars a smoothed
speed for the leg animation. Prove it: per-frame delta variance before/after and a screenshot
sequence.

## 2. Shots leave the gun, not the head
Remote `ShotEvent.origin` is the shooter's eye. For **remote** shots (spawned with
`detectPlayers: false`) start the visual projectile at the avatar's muzzle: add
`Avatar.muzzleWorld(out)` (the mounted weapon model exposes `muzzle`) and
`RemotePlayers.muzzleFor(id, out)`; in the game's remote-shot block replace `origin` with the
muzzle position but keep `dir` and `speed` (paint lands within a few cm of where the shooter
saw it; that is fine). Bots too (they are remote on every non-host client; on the host their
shots are local — leave those).

## 3. Visible firing
When a remote shot arrives: muzzle flash sprite at the avatar's muzzle (team colour, 40 ms),
a small smoke/dust puff drifting up (3–4 sprites, 0.5 s), a brief arm/weapon kick on the
avatar, and the existing shot sound positioned at the shooter. Knife swings (weapon 'knife'
on the entity, another package): a swing animation when a `hit` with weapon knife is seen or
when the entity's `w` is knife and it fires — keep it simple: animate on the shot/hit event.

## 4. Weapon on avatars
`PlayerEntity.weapon` (player state `w`, missing = rifle) → `Avatar.setWeapon(kind)` mounts
`createWeaponModel({ kind, quality: 'third', team })`; the model factory already accepts `kind`
(the pistol/knife meshes come from the weapons package; until then any kind renders the rifle).

## Verify (two headless Chromes `--mute-audio`, kill after; http://localhost:5180; no second
Vite instance): the delta-variance numbers, a screenshot of a remote muzzle flash at the gun,
and no console errors. `bun run typecheck`, `bun test`. Stage only your files; commit.

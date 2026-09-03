# W4-C — Esc overlay over the live game + team swap

You own `src/game/overlays.ts`, `src/game/game.ts` (menu/team/glass-state wiring blocks only),
`src/net/host.ts`, `src/net/protocol.ts`, `src/net/client.ts`, `src/ui/styles.css` (menu styles).

## 1. Esc as an overlay
The pause menu currently covers the game with an opaque panel. Make it a translucent overlay
(blurred dark glass, `backdrop-filter`, ≈ 55 % black) with the game still rendering and
running behind it (the local player is frozen only because pointer lock is released; remotes,
bots, timer, kill feed keep going and stay visible around the panel). Layout: a centred card
with Resume, Invite link (copy), Team (below), Map (host), Bots fill (host, existing), Sound,
Leave. Keep the keyboard hints row. Esc or Resume closes and re-locks the pointer.

## 2. Team swap
- Menu section "Team": two buttons Orange / Teal with counts (humans + bots), the current one
  highlighted. Clicking the other sends RPC `team` `{ team }` to the HOST (new in
  `protocol.ts`).
- Host (`host.ts`): accept when the human counts stay balanced within 1 (bots do not count: if
  bots fill is on, the host kicks a bot from the destination team when needed and adds one to
  the source team so it stays 3v3); otherwise reply `{ ok: false, reason }` and the menu shows a
  toast "Teams would be unbalanced". On accept: set `team` state, kill-less respawn (`alive`
  false → respawn immediately at the new team's spawn with the usual invincibility), scoreboard
  updates. Rate-limit one swap per player per 10 s.
- Also expose the knife backstab rule if trivial: in `applyHit`, when `hit.weapon === 'knife'`
  and the impact point lies behind the victim (dot of the victim's facing (from yaw) with
  (point − victim) < 0), multiply by `WEAPONS.knife.backstabScale`.

## 3. Glass state (small)
The map package adds `MapData.breakables` and a `createGlassSystem` with `break(id)` /
`states()`. Wire it like doors: on a `glass` break locally (the projectile system reports the
`HitResult.kind === 'glass'` object's pane id — read the map package's API once it lands, or
grep `breakables`), send RPC `glass` `{ id, by }` (ALL) so every client breaks it; host mirrors
broken ids into global `glass` state; late joiners and map changes apply it. If the map package
has not landed when you get there, leave a clearly marked TODO block and report it.

## Verify (headless Chrome `--mute-audio`, kill after; http://localhost:5180; no second Vite)
Two browsers: Esc overlay shows the game moving behind it (screenshot with a bot walking); team
swap from B to A succeeds when balanced (state + respawn + colours on both clients), is refused
when it would unbalance (toast), and rebalances bots when fill is on. `bun run typecheck`,
`bun test`. Stage only your files; commit each part separately.

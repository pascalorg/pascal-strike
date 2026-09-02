# W2 — Game integration

You own: `src/game/game.ts`, `src/main.ts` (default route), `src/game/local-player.ts`,
`src/game/remote-players.ts`, `src/game/map-session.ts`. Read `docs/ARCHITECTURE.md`,
`src/types.ts`, `src/config.ts`, and every delivered W1 module's public API (engine/*, map/*,
player/*, weapons/*, net/*, ui/*, storage/*).

## Flow (`main.ts` default route)

1. Platform check: touch-only device or no WebGPU/WebGL2 → `ui/unsupported`.
2. `showLobby()` → `{ name, map, roomCode }`.
3. `joinRoom({ name, roomCode, map })`. Host: `setGlobal('map', map)` (built-in default if none).
   Joiner: `waitForState('map')`.
4. `createEngine`, `createLoaders`, `loadMap(map.url)` with a loading overlay (progress from
   fetch when possible), `createEnvironment`, `buildStaticCollider`/`WorldQuery`, `DoorSystem`,
   `buildNavigation` (async, non-blocking; bots wait for it), `resolveSpawns`.
5. `createGame(...)` and `engine.start()`.

## `game.ts` responsibilities

- **Registry** (`entities.ts`) is the single truth for who exists. Local entity is created
  from `room.me`; remotes/bots from `bindNetToRegistry`.
- **Local player** (`local-player.ts`): input → controller → FPS camera → view model → marker →
  projectiles (`detectPlayers: true`) → `room.rpc.call('shot', shot, 'others')`; on
  `projectiles.onPlayerHit` → `room.rpc.call('hit', hit, 'host')`. Snapshot sender from the
  controller state. Dead: freeze input, show respawn overlay, camera stays where it died
  (slight drop + tilt). On `respawn` event for me: `controller.setPosition`, yaw set, shield.
  Invincible: no `hit` RPCs are applied by host anyway, but also show the shield on my view
  model. Fell out of the map → ask host for respawn (`hit` on self with a special flag is NOT
  allowed; instead call a `'fell'` RPC to host that W1-C did not define: add it to
  `net/protocol.ts` — that file is now shared with you).
- **Remote players** (`remote-players.ts`): one `Avatar` per remote/bot entity, updated from
  the interpolator each render; `hittable()` list fed to the local projectiles. Kill/respawn
  events drive `die()` / `spawn()`; `damage` events drive `flashHit()`. Name tags hidden for
  enemies behind walls? No — keep it simple: always visible within 25 m.
- **Doors**: `doors.update(dt, positions of all entities)`; `onToggle` → door SFX.
- **HUD** wiring: hp, hopper/reload, scores + timer (`clock.now()`), kill feed, hit marker,
  damage vignette (direction from `DamageEvent.point` relative to camera yaw), respawn
  countdown, invincibility, room chip with invite link, scoreboard on Tab, end screen on
  `match.phase === 'ended'`. Warmup shows "Match starts in N".
- **Host** (`startHostAuthority`) when `room.isHost()`; restart on host change. The host also
  runs `bots/bot.ts` (`createBotRunner`) — if W2-B is not delivered yet, host still fills bots
  via `host.ts`; they will simply stand at spawn.
- **Map session** (`map-session.ts`): everything that must be torn down and rebuilt when the
  host changes `map` (dispose map root, collider, decals, navmesh, avatars; keep room/registry).
  Host in-game menu (Esc): change map (built-in list + drop zone → upload), copy invite, leave.
- **Escape menu** (Esc, releases pointer lock): resume, invite link, change map (host only),
  audio toggle, leave to lobby.
- Audio listener follows the camera; `audio.resume()` on first click.
- Debug: `?debug=1` shows FPS, backend, entity count, ping-less clock offset, navmesh helper
  toggle (N), collider (C).

## Verification
- `bun run typecheck` clean, `bun test` green, `bun run build` succeeds.
- Play in Chrome with the claude-in-chrome tools: lobby → play → house loads → you can walk,
  doors open, shooting paints walls, bots exist on both teams (3v3 with you), scoreboard works.
  Two tabs: the second tab joins via the invite link, sees the first player's avatar moving,
  hits register (hp goes down on the host's side, kill feed shows), respawn works both ways.
- Commit only your own files (plus `net/protocol.ts` if you extended it).

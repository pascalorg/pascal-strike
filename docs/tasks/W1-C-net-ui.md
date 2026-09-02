# W1-C — Networking + Game state + UI + Storage package

You own: `src/net/*`, `src/game/match.ts`, `src/game/teams.ts`, `src/game/entities.ts`,
`src/ui/*` (including `styles.css`), `src/storage/*`, `src/dev/ui-showcase.ts`,
`src/dev/net-harness.ts`. Nothing else (except reading).
Read `docs/ARCHITECTURE.md`, `src/types.ts`, `src/config.ts`, `CLAUDE.md` first.
Playroom API reference: `node_modules/playroomkit/types.d.ts` (read it; note `Bot` class,
`RPC.Mode`, `onPlayerJoin`, `isHost`, `addBot`, `waitForState`). Supabase: `@supabase/supabase-js`.
No three.js in this package (except `Vector3` types in entities).

## Deliverables

### `src/net/protocol.ts`
Constants for state keys and RPC names from ARCHITECTURE.md "Networking", plus payload types
re-exported from `types.ts`. A single source of truth; the host and clients import from here.

### `src/game/entities.ts`
`createEntityRegistry() → EntityRegistry`: `Map<string, PlayerEntity>`, `upsert`, `remove`,
`get`, `list()`, `byTeam(team)`, `local`, plus `onChange(cb)`. `PlayerEntity` objects are
long-lived and mutated in place (positions are `Vector3`).

### `src/net/room.ts`
`joinRoom(opts: { name: string; roomCode?: string; map?: MapSelection }) → Promise<Room>`:
```ts
interface Room {
  me: PlayerState; isHost(): boolean; roomCode: string; inviteUrl: string
  players(): PlayerState[]            // humans + bots, current
  onJoin(cb: (p: PlayerState) => void): () => void
  onLeave(cb: (id: string) => void): () => void
  onHostChange(cb: (isHost: boolean) => void): () => void   // poll isHost() at 1 Hz, fire on change
  getGlobal<T>(key: string): T | undefined; setGlobal(key, value, reliable?)
  addBot(): Promise<PlayerState>; kick(id: string): void
  rpc: { register<T>(name, cb: (payload: T, sender: PlayerState) => void | Promise<any>): () => void;
         call(name, payload, mode: 'host' | 'all' | 'others'): Promise<any> }
  leave(): void
}
```
`insertCoin({ gameId: ENV.playroomGameId, skipLobby: true, maxPlayersPerRoom: MATCH.maxPlayers,
enableBots: true, botOptions: { botClass: PascalBot }, roomCode, defaultPlayerStates, defaultStates })`.
`class PascalBot extends Bot` lives in `src/net/room.ts` for now (W2-B will move the brain
next to it): constructor only calls `super(params)`; state is initialised by the host in
`host.ts` (`isHost()` guard — Playroom calls the constructor on every client).
`inviteUrl` = `${location.origin}${location.pathname}#r=${roomCode}`.
Handle `insertCoin` rejection (room full → `ROOM_LIMIT_EXCEEDED`, bad game id) with typed errors.

### `src/net/sync.ts`
- `createSnapshotSender(room, getLocal: () => PlayerSnapshot)`: timer at `NET.snapshotHz`
  writing `p` unreliable. Skip when unchanged.
- `createInterpolator(entity)`: `push(snapshot)`, `sample(now, outPos, out: { yaw, pitch,
  crouching, speed })` with `NET.interpDelayMs`, shortest-arc yaw, ≤ 100 ms extrapolation,
  speed derived from the two bracketing samples.
- `createClock(room)`: host writes `hostNow` every 5 s; clients compute `offset` (median of
  last 5 observations, use `Date.now()` at receipt); `now()` returns host time.

### `src/net/host.ts`
`startHostAuthority(room, registry, spawnsProvider, events: EventBus, clock) → { stop() }`
per ARCHITECTURE.md "Networking" + "Match": team assignment, bot fill/kick, `hit` validation
(reject if shooter dead, target dead/invincible, same team, duplicate shotId (keep a ring of
512), point farther than 3 m from the target's last known position), damage (`hp` state +
`damage` RPC), death (`alive=false`, `deaths++`, `kills++` for shooter, `kill` RPC, score),
respawn timer → pick spawn via `spawnsProvider(team)` → `respawn` RPC + `inv` state, match
machine driven by `match.ts`. Everything host-side is idempotent and re-entrant so it can be
started again after host migration (`room.onHostChange`).

### `src/net/client.ts` (also yours)
`bindNetToRegistry(room, registry, events, clock)`: creates/removes entities on join/leave,
reads `name/team/hp/alive/inv/kills/deaths` reactively (poll at 10 Hz — Playroom has no
per-key change event in vanilla JS; keep it cheap), feeds `p` snapshots into the interpolator
for remotes, registers `damage/kill/respawn/shot` RPC handlers that emit on the `EventBus`.

### `src/game/match.ts`
Pure state machine: `createMatch(clock) → { state: MatchState; update(now, scores) → MatchState |
null (when changed) }` with the phases and durations from `config.ts`. No Playroom imports.

### `src/game/teams.ts`
`pickTeam(entities) → TeamId` (smaller, tie → 'a'), `botName(i)`, `TEAMS` re-export helpers.

### `src/storage/maps-upload.ts`
`uploadMap(file, onProgress?) → Promise<MapSelection>` per ARCHITECTURE.md "Storage".
`getSupabase()` lazy singleton, throws a friendly error if env vars are missing.

### `src/ui/*`
`styles.css` (extend the tokens already there), `lobby.ts`, `hud.ts`, `scoreboard.ts`,
`unsupported.ts` per ARCHITECTURE.md "Lobby / UI". Each UI module exports a factory returning
`{ el: HTMLElement; ...methods; dispose() }`, renders into `#app`, and is driven by plain
method calls (`hud.setHp(n)`, `hud.setHopper(n, reloading)`, `hud.setScores(a, b, msLeft)`,
`hud.killFeed(event)`, `hud.hitMarker()`, `hud.damageFrom(dirXZ, team)`, `hud.setRespawn(ms)`,
`hud.setInvincible(bool)`, `hud.setRoom(code, url)`, `scoreboard.show(entities, match)`,
`scoreboard.hide()`, `scoreboard.end(match, entities)`). Lobby: `showLobby(opts) →
Promise<{ name: string; map: MapSelection | null; roomCode?: string }>` (resolves on Play).
Detect `#r=CODE` in the URL → join mode. Crosshair is an inline SVG. All text uses the Pascal
fonts (loaded in `index.html`). Must look **good**: this is the marketing face of the game.
Logo: `/brand/pascal-logo-full.svg` (dark theme: invert to white via CSS filter if the SVG is black).

### `src/dev/ui-showcase.ts`
`start()`: shows the lobby with a fake map list, then on Play shows the HUD over a dark gradient
background with a fake match running (timer counts down, scores tick, kill feed events every
3 s, a hit marker every 2 s, a damage vignette every 5 s, respawn overlay once), Tab shows the
scoreboard with 6 fake entities (2 bots), after 40 s the end screen.

### `src/dev/net-harness.ts`
`start()`: **real Playroom** connection, text-only. Landing: name + "Create" / "Join code".
After joining: prints room code + invite link, host flag, the entity list (id, name, team, bot,
hp, alive, kills, deaths, last snapshot age) refreshed at 5 Hz, match state, clock offset.
Host runs `host.ts` for real (bots are added automatically to fill 3v3, humans replace them).
Each client sends fake `p` snapshots (random walk). Buttons: "Send shot", "Send hit on <id>"
(picks a random enemy; the host should apply damage, kill on the third, respawn after 2.5 s),
"Leave". Route: `main.ts` → add `if (params.get('dev') === 'net')` → `./dev/net-harness`
(this is the one edit you may make in `main.ts`).

## Verification (do all, report exactly what you saw)
1. `bun run typecheck` clean.
2. `bun dev` (background). With the `claude-in-chrome` MCP tools (load via ToolSearch
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_console_messages,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find`):
   - `?dev=ui`: screenshot lobby and HUD; check console clean; check the layout at 1280×720 and
     1920×1080 (`resize_window`). Judge it honestly: is it something Pascal would ship?
   - `?dev=net`: tab 1 creates a room → confirm 5 bots fill in with balanced teams; tab 2 joins
     via the invite link → confirm a bot is kicked and the human gets the smaller team; send
     hits from tab 2 on a bot → hp 66, 32, dead → respawn ~2.5 s later with `inv` set; close
     tab 1 → tab 2 becomes host and the bots keep being managed.
3. Commit your work on completion with a clear message (git user is already configured).

Report: what works, what you could not verify, any contract gaps you found in `types.ts`.

# Pascal Strike

3v3 paintball deathmatch in houses you build with **Pascal**. Export your project as a GLB,
drop it in a private lobby, invite friends, and paint the walls — or choose **Play online** to
find other players without an invite. Empty slots are filled with bots
from the first second.

three.js 0.185 (WebGPU, WebGL2 fallback) · Playroom Kit multiplayer · recast navmesh bots ·
Vite + TypeScript, no framework.

## Run

```
bun install
cp .env.example .env    # fill in the Playroom game id and the Supabase bucket credentials
bun dev                 # http://localhost:5180
bun run build           # static bundle in dist/
```

Dev routes: `?dev=map` (fly through a map with debug overlays), `?sandbox=1` (player + weapon
in a test room), `?dev=ui` (lobby/HUD showcase), `?dev=net` (text-only Playroom harness).
`?dev=characters` previews the four Character Studio players and their combat animations.
`?debug=1` adds a stats panel to the game. `bun test` runs the headless physics/weapon/bot tests.

## Characters

Pick Wawa, Brian, Janette, or Nova in the lobby, or use **Create my character** to open
Character Studio. Choose **Done** to bring your creation into the game. Your selection is
remembered and shared with the room; the four defaults and their animations are bundled.
See [the integration guide](docs/CHARACTERS.md) for configuration and verification.

## Play

**Play online** uses [Playroom matchmaking](https://docs.joinplayroom.com/features/games/matchmaking)
to find an open public room, creating one if none is available. The room's host owns its map
and bot setting; a new public room starts with Pascal House and bots. Bots yield their seats
as humans join. Choose **Private · invite friends** to select/upload a map and set bots before
creating a private room. Invite links and **Join with code** go directly to that room.
Playroom matches production players at the same URL; local development is isolated by public IP.

| | |
|---|---|
| Move | WASD, Space jump, Ctrl/C crouch, **Shift walk** (slow and precise) |
| Weapons | **1** marker (30 rounds, auto) · **2** pistol (12, semi-auto, precise) · **3** knife (2 hits, 1 from behind) · wheel cycles · R reload |
| Doors / windows | **E** while looking at one within 2.5 m; open windows are a way out, glass breaks |
| Teams | pick Orange / Teal / Auto when you join; Esc → Change team |
| Scoreboard | Tab · Menu: Esc (graphics, invite link, bots on/off and map as host, sound, leave) |
| Two-tab testing | **P** frees only the pointer; click the game or press P again to resume |

Team deathmatch: first to 30 kills or 5 minutes. Spawn with **100 HP + 50 armor/helmet**.
Armor absorbs 35% of bullet damage to the head, torso and arms until depleted. Raw damage is
50 head, 34 torso, 20 limbs; legs and knives bypass armor. The marker fires 10 rounds/s:
fresh armor takes **3 head hits or 5 body hits**. The knife does 60, doubled from behind.
Hits briefly slow movement, then smoothly recover; bots stop for bursts and reposition between them. Respawn 2.5 s after going down, 3 s of invincibility. Accuracy
is tight when standing or walking and opens up when running or airborne.
See [gameplay tuning and verification](docs/GAMEPLAY.md) for the current balance and performance checks.

## Graphics

Choose **Auto**, **Low**, **Medium**, or **High** in the lobby or Esc menu. The preference is
saved on this browser and applies immediately. Auto starts at Medium, or Low for WebGL2 and
devices reporting at most four CPU cores or 4 GB RAM. After a 10-second warmup it steps down
if most of a six-second window runs below 48 FPS. It ignores background tabs and long stalls,
and stays at the reduced quality for the session to avoid switching back and forth.

| Profile | Render pixel budget | Sun shadows | Effects |
|---|---|---|---|
| Low | 1280 × 720 | 1024² | Direct render, flat sky, environment lighting retained |
| Medium | 1920 × 1080 | 2048² | FXAA, color grading, vignette, sky |
| High | 2560 × 1440 | 4096² | SMAA, bloom, AO and grain (AO/grain require WebGPU) |

These budgets preserve the viewport's aspect ratio and cap device pixel ratio; they never
force a smaller display to use the full budget. See [performance verification](docs/PERFORMANCE.md).

## Building a map in Pascal

The lobby and host's in-game map picker include **Pascal House**, **fy_iceworld**, and **Corridors**.
fy_iceworld uses the v3 baked export with its four authored spawn areas (two per team),
original scale and ice materials. Its terrain does not receive the house's grass tint.
Corridors also retains its authored materials and four spawn zones (two per team).
Click **Build it in Pascal** in the lobby for spawn-zone instructions and a link to
[the Pascal editor](https://editor.pascal.app).

Export a baked GLB from Pascal (any LOD). The game reads Pascal's node metadata:

- **Spawn areas**: draw two zones and name them `Spawn A` and `Spawn B` (also accepted:
  `Spawn 1` / `Spawn 2`, `Spawn Orange` / `Spawn Teal`, `Spawn Red` / `Spawn Blue`). Players
  appear at random points inside the polygon. Without spawn zones the game picks the two
  farthest-apart rooms on the ground floor.
- **Doors and windows** with an operable leaf open with E and block paintballs when closed.
  Doors let players through; windows do not.
- **Stairs** connect floors for players and bots. Furniture, fences, roofs, glass: all solid.
- Keep the play area compact (a 12 × 8 m house is a good size for 3v3) and give both teams
  cover near their spawn.

Choose **Private · invite friends** and drop the GLB on the lobby's map card. It is uploaded to a public Supabase Storage bucket
(content-addressed, immutable) and shared with everyone in the room. Any plain GLB works too;
it just has no doors or spawn zones.

## Layout

See `docs/ARCHITECTURE.md` for the full design. `src/types.ts` holds the cross-module
contracts, `src/config.ts` every gameplay number.

The weapons use Blender-authored GLBs. See [the armory files and runtime viewer](docs/WEAPONS.md).

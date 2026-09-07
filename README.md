# Pascal Strike

3v3 paintball deathmatch in houses you build with **Pascal**. Export your project as a GLB,
drop it in the lobby, invite two friends, and paint the walls. Empty slots are filled with bots
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

| | |
|---|---|
| Move | WASD, Space jump, Ctrl/C crouch, **Shift walk** (slow and precise) |
| Weapons | **1** marker (30 rounds, auto) · **2** pistol (12, semi-auto, precise) · **3** knife (2 hits, 1 from behind) · wheel cycles · R reload |
| Doors / windows | **E** while looking at one within 2.5 m; open windows are a way out, glass breaks |
| Teams | pick Orange / Teal / Auto when you join; Esc → Change team |
| Scoreboard | Tab · Menu: Esc (invite link, bots on/off and map as host, sound, leave) |
| Two-tab testing | **P** frees only the pointer; click the game or press P again to resume |

Team deathmatch: first to 30 kills or 5 minutes. Spawn with **100 HP + 50 armor/helmet**.
Armor absorbs 35% of bullet damage to the head, torso and arms until depleted. Raw damage is
50 head, 34 torso, 20 limbs; legs and knives bypass armor. The marker fires 10 rounds/s:
fresh armor takes **3 head hits or 5 body hits**. The knife does 60, doubled from behind.
Hits briefly slow movement, then smoothly recover; bots stop for bursts and reposition between them. Respawn 2.5 s after going down, 3 s of invincibility. Accuracy
is tight when standing or walking and opens up when running or airborne.
See [gameplay tuning and verification](docs/GAMEPLAY.md) for the current balance and performance checks.

## Building a map in Pascal

The lobby and host's in-game map picker include **Pascal House** and **fy_iceworld**.
fy_iceworld uses the v3 baked export with its four authored spawn areas (two per team),
original scale and ice materials. Its terrain does not receive the house's grass tint.

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

Drop the GLB on the lobby's map card. It is uploaded to a public Supabase Storage bucket
(content-addressed, immutable) and shared with everyone in the room. Any plain GLB works too;
it just has no doors or spawn zones.

## Layout

See `docs/ARCHITECTURE.md` for the full design. `src/types.ts` holds the cross-module
contracts, `src/config.ts` every gameplay number.

The weapons use Blender-authored GLBs. See [the armory files and runtime viewer](docs/WEAPONS.md).

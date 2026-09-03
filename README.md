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
`?debug=1` adds a stats panel to the game. `bun test` runs the headless physics/weapon/bot tests.

## Play

| | |
|---|---|
| Move | WASD, Space jump, Ctrl/C crouch, **Shift walk** (slow and precise) |
| Weapons | **1** marker (30 rounds, auto) · **2** pistol (12, semi-auto, precise) · **3** knife (2 hits, 1 from behind) · wheel cycles · R reload |
| Doors / windows | **E** while looking at one within 2.5 m; open windows are a way out, glass breaks |
| Teams | pick Orange / Teal / Auto when you join; Esc → Change team |
| Scoreboard | Tab · Menu: Esc (invite link, bots on/off and map as host, sound, leave) |

Team deathmatch: first to 30 kills or 5 minutes. 100 hp; a paintball does 50 to the head, 34 to
the torso, 20 to arms and legs; the knife does 60, doubled from behind. Respawn 2.5 s after going down, 3 s of invincibility. Accuracy
is tight when standing or walking and opens up when running or airborne.

## Building a map in Pascal

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

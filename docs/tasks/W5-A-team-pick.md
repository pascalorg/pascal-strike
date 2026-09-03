# W5-A — Pick your team before you play (Orange / Teal / Auto)

User feedback: "when we start, we shouldn't be automatically in orange or teal. It's when we
pick that we should be in a team and that it hides the screen. Also add an auto."

You own `src/game/overlays.ts` (new `team-pick` screen), `src/game/game.ts` (start flow),
`src/game/local-player.ts` (spectate mode), `src/net/host.ts`, `src/net/protocol.ts`,
`src/net/client.ts`, `src/ui/styles.css` (screen styles), `src/dev/net-harness.ts`.

1. **State**: a human joins with `team` unset (`null`/missing) = spectator: no spawn, no
   hittable, not counted for balance or bot fill, shown in the scoreboard under "Choosing…".
   Bots are unaffected (host assigns them as today).
2. **Screen**: right after the map loads (before the first spawn) show a full-screen glass panel
   over a **slow orbiting overview camera** of the house (camera circles the map bounds at
   ~12 m radius, 25° down, one turn per 40 s; the game keeps running behind, HUD hidden):
   title "Choose your team", two big cards Orange / Teal with the current roster (names, bots
   marked, counts `2/3`) and a third "Auto" card ("Join the smaller team"). Keyboard 1/2/3 and
   Enter. When a card is refused (host rule) shake it and show the reason.
3. **Host** (`host.ts`): RPC `team` accepts `'a' | 'b' | 'auto'`; auto = smaller human count,
   tie → the team with fewer bots, tie → 'a'. Rules as for swap (bots on: destination humans
   ≤ teamSize; bots off: ±1 balance). On accept: set `team`, rebalance bots, spawn immediately
   (warmup invincibility) — the client hides the screen on the `team` state arriving, resumes
   the FPS camera and pointer lock. Host migration: an unassigned player stays unassigned.
4. **Esc menu**: the "Team" section becomes "Change team" and opens the same screen (with the
   current team highlighted and a Back button); swapping keeps the existing cooldown rules.
5. **Net harness**: shows unassigned players and lets you pick.

Verify (muted headless Chrome, distinct ports, kill your own; dev server 5180 or a static
build; never a second Vite): join → screen with orbiting camera (screenshot) → pick Teal →
spawned on team b with the screen gone; second browser picks Auto → lands on the smaller team;
bots fill around both; a spectator is invisible to bots and cannot be hit; Esc → Change team
works. `bun run typecheck`, `bun test`. Stage only your files; commit.

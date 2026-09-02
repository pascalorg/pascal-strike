# W3-D — Doors and windows on E, synced

Player feedback: "it'd be better to hit E to open doors; also handle windows (those that have an
animation can be opened)." Auto-open on approach is gone for players; bots still open doors on
their path.

You own: `src/map/doors.ts`, `src/map/map-parse.ts`, `src/map/collider.ts`, `src/map/map-loader.ts`,
`src/game/game.ts` (interaction + door RPC wiring only), `src/game/host-side.ts` (bot door
opening), `src/net/protocol.ts` (door RPC), `src/ui/prompt.ts` (new), `src/dev/map-viewer.ts`.
Contracts already updated: `src/config.ts` (`DOORS.interactRange`, `botOpenRadius`),
`src/types.ts` (`DoorInfo.kind: 'door' | 'window'`), `src/engine/input.ts` (`input.interact`
is the E edge, already implemented).

## Work
1. **Openables**: `map-parse.ts` turns every `openable && clips` node of kind `door` OR `window`
   into a `DoorInfo` with `kind`. The animated subtrees of BOTH kinds are excluded from the
   static movement collider (`collider.ts`/`map-loader.ts`) and their leaf meshes get BVHs for
   bullets (already the case for doors). Verify a closed window sash blocks a paintball and an
   open one does not; the glass inside the sash paints when hit.
2. **`doors.ts`**: replace auto-open with `toggle(id)`, `setOpen(id, open)`, `isOpen`, `openness`,
   `onToggle`, plus `findInteractable(origin, dir, range) → DoorInfo | null` (raycast against
   leaf meshes and the door/window node bbox so the frame counts too; nearest wins). Keep the
   mixer, `update(dt)` (no actors param), smooth reversal mid-animation.
3. **Network sync**: `protocol.ts` adds RPC `door` `{ id, open, by }` (mode ALL). `game.ts`:
   on `input.interact` → `findInteractable` from the camera → `RPC door` (everyone applies,
   including the caller via ALL). Late joiners: the host keeps `doors` global state
   `{ [id]: open }` (reliable) and a joining client applies it after the map loads (jump the
   animation to its end state, no tween).
4. **Prompt**: `ui/prompt.ts` shows a small centred label under the crosshair "E · Open door" /
   "E · Close window" while an interactable is in range (Pascal style: mono font, 12 px,
   muted background pill). `game.ts` updates it each render.
5. **Bots**: `host-side.ts` — for each bot each frame, if a closed door (kind door only) is
   within `DOORS.botOpenRadius` of the bot's feet, toggle it via the same RPC path (rate-limit
   one toggle per door per 1.5 s). Bots never touch windows.
6. **Map viewer**: `?dev=map` keeps working: E toggles the door under the fly camera; the door
   overlay shows kind.

## Verification
- `bun run typecheck`, `bun test` green.
- Headless browser (CDP, as previous agents) on the default route: E opens/closes a door and a
  window, the prompt appears/disappears, a second client sees the same state, a late joiner sees
  doors already open, a bot walks through a door it opened, a closed window stops a paintball.
- Stage only your files; commit.

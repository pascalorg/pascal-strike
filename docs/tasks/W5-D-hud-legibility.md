# W5-D — HUD legibility

User feedback: "the top clock is gray on top of black shadows, hard to read; same for the
weapon bottom-right; the HP bar doesn't really read as HP; the rest of the UI is nice."

You own `src/ui/hud.ts`, `src/ui/styles.css` (HUD rules only), `src/dev/ui-showcase.ts`.

1. **Top bar (scores + clock)**: put it on a translucent dark pill (`rgba(13,13,15,.55)`,
   `backdrop-filter: blur(6px)`, 1 px `--border` at 40 %), clock in JetBrains Mono at 22 px
   white with a subtle text-shadow, team scores in their team colours on the pill; under one
   minute the clock turns orange and pulses at 10 s.
2. **Weapon widget (bottom-right)**: same pill treatment; weapon name in Barlow 600 uppercase
   14 px; ammo `12 / ∞` in mono 26 px white, the "/ ∞" muted; slot dots become three small
   rounded chips `1 2 3` with the active one filled in `--accent`; reloading shows a thin
   progress line under the ammo; low ammo (< 25 %) tints the number orange.
3. **Health**: make it unmistakably health: a pill bottom-left with a heart/cross glyph (inline
   SVG), the numeric hp `100` in mono 26 px, and the bar (10 px tall, rounded, team-neutral
   white, orange < 40, red < 20, trailing ghost kept) inside the pill; label "HP" in tiny caps.
4. Kill feed, hit markers, crosshair, room chip, prompts: keep, but check they sit on the same
   contrast baseline (text-shadow or pill) so nothing is gray-on-dark anywhere.
5. Respect `prefers-reduced-motion`. No layout overlaps at 1280×720 and 1920×1080 (measure).

Verify in `?dev=ui` and in the real game over the darkest spot you can find (a corridor with
shadow), screenshots before/after at both sizes. `bun run typecheck`. Stage only your files;
commit.

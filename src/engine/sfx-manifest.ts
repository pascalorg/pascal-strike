import type { SoundName } from './audio'

export interface SfxManifestEntry {
  /** Primary OGG and AAC URLs. Variant entries end in `-1`; the player substitutes the index. */
  readonly urls: readonly [ogg: string, m4a: string]
  readonly gain: number
  readonly variants?: number
  /** Maximum random playback-rate offset, expressed as a fraction of normal speed. */
  readonly pitchJitter: number
}

const entry = (
  stem: string,
  gain: number,
  pitchJitter = 0.06,
  variants?: number,
): SfxManifestEntry => ({
  urls: [`/sfx/${stem}.ogg`, `/sfx/${stem}.m4a`],
  gain,
  pitchJitter,
  ...(variants === undefined ? {} : { variants }),
})

export const SFX_MANIFEST = {
  shot: entry('shot-1', 0.9, 0.06, 2),
  pistolShot: entry('pistol-shot', 0.82),
  splat: entry('splat-1', 0.72, 0.06, 2),
  hit: entry('mechanical-click', 0.5),
  hitConfirm: entry('mechanical-click', 0.58),
  reload: entry('mechanical-click', 0.64),
  reloadStart: entry('mechanical-click', 0.58),
  reloadEnd: entry('mechanical-click', 0.72),
  respawn: entry('respawn-chime', 0.55, 0.025),
  door: entry('door-handle', 0.62),
  footstep: entry('footstep-1', 0.52, 0.06, 2),
  death: entry('splat-1', 0.78),
  knifeSwing: entry('door-handle', 0.25),
  knifeHit: entry('splat-1', 0.82),
  weaponSwitch: entry('mechanical-click', 0.46),
  glassBreak: entry('glass-1', 0.76, 0.06, 2),
  shardTinkle: entry('glass-1', 0.24),
  dryFire: entry('mechanical-click', 0.52),
} as const satisfies Record<SoundName, SfxManifestEntry>

export function variantUrls(entry: SfxManifestEntry, variant: number): readonly [string, string] {
  if ((entry.variants ?? 1) === 1) return entry.urls
  return entry.urls.map((url) => url.replace(/-1(\.[^.]+)$/, `-${variant}$1`)) as [string, string]
}

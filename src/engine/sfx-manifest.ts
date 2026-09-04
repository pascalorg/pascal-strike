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
  shot: entry('shot-1', 0.65, 0.06, 2),
  pistolShot: entry('pistol-shot', 0.4),
  splat: entry('splat-1', 0.48, 0.06, 3),
  hit: entry('soft-hit', 0.32),
  hitConfirm: entry('soft-hit', 0.35),
  reload: entry('reload-end', 0.35),
  reloadStart: entry('reload-start', 0.34),
  reloadEnd: entry('reload-end', 0.39),
  respawn: entry('respawn-chime', 0.24, 0.025),
  door: entry('door-handle', 0.39),
  footstep: entry('footstep-1', 0.23, 0.06, 4),
  death: entry('splat-3', 0.54),
  knifeSwing: entry('knife-swing', 0.32),
  knifeHit: entry('splat-3', 0.52),
  weaponSwitch: entry('mechanical-click', 0.28),
  glassBreak: entry('glass-1', 0.54, 0.06, 2),
  shardTinkle: entry('shard-tinkle', 0.28),
  dryFire: entry('mechanical-click', 0.31),
} as const satisfies Record<SoundName, SfxManifestEntry>

export function variantUrls(entry: SfxManifestEntry, variant: number): readonly [string, string] {
  if ((entry.variants ?? 1) === 1) return entry.urls
  return entry.urls.map((url) => url.replace(/-1(\.[^.]+)$/, `-${variant}$1`)) as [string, string]
}

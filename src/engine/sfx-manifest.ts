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

/** Prepared samples; gameplay wiring and the existing SoundName API are unchanged. */
export type OptionalSoundName = 'deny' | 'announcerHeadshot' | 'announcerTenLeft'

export const SFX_MANIFEST = {
  shot: entry('shot-1', 0.9, 0.06, 3),
  pistolShot: entry('pistol-shot', 0.9),
  splat: entry('splat-1', 0.8, 0.06, 3),
  hit: entry('body-hit', 0.8),
  hitConfirm: entry('hit-confirm', 0.35, 0.025),
  reload: entry('reload-end', 0.35),
  reloadStart: entry('reload-start', 0.34),
  reloadEnd: entry('reload-end', 0.39),
  respawn: entry('respawn-chime', 0.24, 0.025),
  // Apply the requested -6 dB in the mix, preserving normalized file peaks.
  door: entry('door-handle', 0.39 * 10 ** (-6 / 20)),
  footstep: entry('footstep-1', 0.23, 0.06, 4),
  death: entry('death', 0.8),
  knifeSwing: entry('knife-swing', 0.32),
  knifeHit: entry('knife-hit', 0.8),
  weaponSwitch: entry('weapon-switch', 0.28),
  glassBreak: entry('glass-1', 0.54, 0.06, 2),
  shardTinkle: entry('shard-tinkle', 0.28),
  dryFire: entry('dry-fire', 0.31),
  deny: entry('deny', 0.6, 0),
  // 0.7 is approximately -3 dB; no pitch randomization on spoken phrases.
  announcerHeadshot: entry('announcer-headshot', 0.7, 0),
  announcerTenLeft: entry('announcer-ten-left', 0.7, 0),
} as const satisfies Record<SoundName | OptionalSoundName, SfxManifestEntry>

export function variantUrls(entry: SfxManifestEntry, variant: number): readonly [string, string] {
  if ((entry.variants ?? 1) === 1) return entry.urls
  return entry.urls.map((url) => url.replace(/-1(\.[^.]+)$/, `-${variant}$1`)) as [string, string]
}

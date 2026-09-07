import { ARMOR, TAGGING } from '../config'
import type { BodyPart, WeaponKind } from '../types'

/** Kevlar + helmet: bullets consume armor; legs and melee bypass it. */
export function armoredDamage(raw: number, armor: number, part: BodyPart, weapon: WeaponKind) {
  const absorbed = weapon === 'knife' || part === 'leg' ? 0 : Math.min(Math.max(0, armor), Math.round(raw * ARMOR.absorption))
  return { amount: raw - absorbed, armor: Math.max(0, armor - absorbed), absorbed }
}

/** Refreshable tagging, with a short hold followed by a smooth recovery (never stacks). */
export function taggingScale(until: number | undefined, now: number): number {
  const remaining = (until ?? 0) - now
  if (remaining <= 0) return 1
  const recovery = Math.max(0, 1 - remaining / TAGGING.recoveryMs)
  return TAGGING.speedScale + (1 - TAGGING.speedScale) * recovery * recovery * (3 - 2 * recovery)
}

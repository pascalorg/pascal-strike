// @ts-ignore Bun test runtime.
import { expect, test } from 'bun:test'
import { ARMOR, DAMAGE, TAGGING, WEAPONS } from '../config'
import { armoredDamage, taggingScale } from './combat'

test('starting armor makes the marker take 3 head hits or 5 body hits, with no regeneration', () => {
  for (const [part, expected] of [['head', 3], ['torso', 5]] as const) {
    let armor = ARMOR.max, hp = 100, hits = 0
    while (hp > 0) { const result = armoredDamage(DAMAGE[part], armor, part, 'rifle'); armor = result.armor; hp -= result.amount; hits++ }
    expect(hits).toBe(expected)
    expect(armor).toBe(0)
  }
  expect(4 / WEAPONS.rifle.fireRate).toBe(.4)
  expect(armoredDamage(50, 0, 'head', 'rifle').amount).toBe(50)
  expect(armoredDamage(20, 50, 'leg', 'rifle')).toEqual({ amount: 20, armor: 50, absorbed: 0 })
  expect(armoredDamage(60, 50, 'torso', 'knife')).toEqual({ amount: 60, armor: 50, absorbed: 0 })
})

test('tagging holds, then smoothly recovers; refreshing a hit does not stack or freeze movement', () => {
  const now = 1000, until = now + TAGGING.holdMs + TAGGING.recoveryMs
  expect(taggingScale(until, now)).toBe(TAGGING.speedScale)
  expect(taggingScale(until, now + TAGGING.holdMs)).toBe(TAGGING.speedScale)
  let previous = 0
  for (let time = now; time <= until; time += 10) { const scale = taggingScale(until, time); expect(scale).toBeGreaterThanOrEqual(previous); expect(scale).toBeLessThanOrEqual(1); previous = scale }
  expect(taggingScale(until, until)).toBe(1)
  expect(taggingScale(undefined, now)).toBe(1)
})

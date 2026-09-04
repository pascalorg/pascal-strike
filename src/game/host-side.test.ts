// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import type { HitEvent } from '../types'
import { createHitQueue, PENDING_HIT_TTL_MS } from './host-side'

function hit(shotId: string, by = 'shooter'): HitEvent {
  return {
    shotId,
    by,
    target: 'victim',
    point: [0, 1, 0],
    normal: [0, 0, 1],
    part: 'torso',
    weapon: 'rifle',
  }
}

test('hits fired during the gate window come back out in order, with their claimant', () => {
  const queue = createHitQueue()
  queue.push(hit('a:1'), 'a', 1_000)
  queue.push(hit('b:1'), 'b', 1_100)
  expect(queue.size).toBe(2)

  const replayed = queue.drain(1_200)
  expect(replayed.map((p) => p.hit.shotId)).toEqual(['a:1', 'b:1'])
  // The claimant travels with the hit: `submitHit` refuses a hit claimed by anyone but its
  // shooter, so replaying somebody else's queued RPC as our own would throw it away again.
  expect(replayed.map((p) => p.senderId)).toEqual(['a', 'b'])
  expect(queue.size).toBe(0)
  expect(queue.drain(1_300)).toEqual([])
})

test('a hit older than the TTL is dropped rather than applied to a match that moved on', () => {
  const queue = createHitQueue()
  queue.push(hit('old:1'), 'a', 0)
  queue.push(hit('fresh:1'), 'a', PENDING_HIT_TTL_MS)

  const replayed = queue.drain(PENDING_HIT_TTL_MS + 1)
  expect(replayed.map((p) => p.hit.shotId)).toEqual(['fresh:1'])
})

test('the queue is bounded, and it is the stale end that goes', () => {
  const queue = createHitQueue(1_000, 3)
  for (let index = 0; index < 10; index++) queue.push(hit(`x:${index}`), 'a', 500 + index)
  expect(queue.size).toBe(3)
  expect(queue.drain(600).map((p) => p.hit.shotId)).toEqual(['x:7', 'x:8', 'x:9'])

  // Ageing runs before the cap: a window long enough to fill the queue must not let hits from
  // five seconds ago push out the one that just landed.
  const mixed = createHitQueue(1_000, 3)
  for (let index = 0; index < 3; index++) mixed.push(hit(`old:${index}`), 'a', 0)
  mixed.push(hit('new:1'), 'a', 2_000)
  expect(mixed.size).toBe(1)
  expect(mixed.drain(2_100).map((p) => p.hit.shotId)).toEqual(['new:1'])
})

test('clear throws the window away — a tab that stopped hosting judges nothing', () => {
  const queue = createHitQueue()
  queue.push(hit('a:1'), 'a', 1_000)
  queue.clear()
  expect(queue.size).toBe(0)
})

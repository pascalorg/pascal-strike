// @ts-ignore Bun provides the test runtime.
import { expect, test } from 'bun:test'
import { DEFAULT_CHARACTERS, defaultCharacter, parseCharacter, STUDIO_ORIGIN } from './catalog'

const custom = { id: 'abc123', name: 'My player', gender: 'woman', manifestUrl: `${STUDIO_ORIGIN}/api/models/b/abc123.json` }

test('only pinned manifests on the configured Studio origin can enter multiplayer state', () => {
  expect(parseCharacter(custom)).toEqual(custom)
  for (const url of ['javascript:alert(1)', 'https://example.com/api/models/b/abc123.json', `${STUDIO_ORIGIN}/api/models/c/abc123.json`, `${custom.manifestUrl}?redirect=1`, `${custom.manifestUrl}#other`]) {
    expect(parseCharacter({ ...custom, manifestUrl: url })).toBeNull()
  }
  for (const value of [null, [], 'wawa', { ...custom, gender: 'unknown' }, { ...custom, id: '../abc' }, { ...custom, name: {} }]) expect(parseCharacter(value)).toBeNull()
})

test('a remote cannot replace a bundled preset URL and defaults are deterministic', () => {
  expect(new Set(DEFAULT_CHARACTERS.map(c => c.id)).size).toBe(4)
  expect(parseCharacter({ id: 'wawa', manifestUrl: 'https://example.com/model' })).toBe(DEFAULT_CHARACTERS[0])
  const assignments = ['a', 'b', 'c', 'd'].map(defaultCharacter)
  expect(new Set(assignments.map(c => c.id)).size).toBe(4)
  expect(defaultCharacter('migrating-bot')).toEqual(defaultCharacter('migrating-bot'))
})

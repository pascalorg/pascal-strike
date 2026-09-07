// @ts-ignore Bun test runtime.
import { expect, test } from 'bun:test'
import { roomJoinOptions } from './join-options'

test('online quick play enables matchmaking; private creation stays private', () => {
  expect(roomJoinOptions({ matchmaking: true })).toEqual({ roomCode: undefined, matchmaking: true })
  expect(roomJoinOptions({ matchmaking: false })).toEqual({ roomCode: undefined, matchmaking: false })
  expect(roomJoinOptions({})).toEqual({ roomCode: undefined, matchmaking: false })
})

test('typed codes and invite links bypass matchmaking; typed code wins over an old hash', () => {
  expect(roomJoinOptions({ matchmaking: true }, 'INVITE')).toEqual({ roomCode: 'INVITE', matchmaking: false })
  expect(roomJoinOptions({ matchmaking: true, roomCode: 'TYPED' }, 'OLD')).toEqual({ roomCode: 'TYPED', matchmaking: false })
})

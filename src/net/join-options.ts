/** An invite always wins over matchmaking, including links into a public room. */
export function roomJoinOptions(opts: { roomCode?: string; matchmaking?: boolean }, hashCode?: string) {
  const roomCode = opts.roomCode || hashCode || undefined
  return { roomCode, matchmaking: !roomCode && opts.matchmaking === true }
}

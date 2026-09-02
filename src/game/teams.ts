/**
 * Team helpers: balance, colours, bot names. No Playroom, no three.js.
 */
import { BOTS, TEAMS } from '../config'
import type { PlayerEntity, TeamId, TeamInfo } from '../types'

export { TEAMS }

export const TEAM_IDS: readonly TeamId[] = ['a', 'b']

export function teamInfo(team: TeamId): TeamInfo {
  return TEAMS[team]
}

export function teamColor(team: TeamId): string {
  return TEAMS[team].color
}

export function teamColorHex(team: TeamId): number {
  return TEAMS[team].colorHex
}

export function teamName(team: TeamId): string {
  return TEAMS[team].name
}

export function otherTeam(team: TeamId): TeamId {
  return team === 'a' ? 'b' : 'a'
}

/** Count members per team in one pass (no allocation beyond the result). */
export function countTeams(entities: Iterable<{ team: TeamId }>): { a: number; b: number } {
  let a = 0
  let b = 0
  for (const e of entities) {
    if (e.team === 'b') b++
    else a++
  }
  return { a, b }
}

/** The team a new participant should join: the smaller one, ties go to 'a'. */
export function pickTeam(entities: Iterable<{ team: TeamId }>): TeamId {
  const { a, b } = countTeams(entities)
  return b < a ? 'b' : 'a'
}

/**
 * A bot name that is not already taken. `taken` lets the host keep names stable and unique
 * across bot churn; falls back to a numbered name once the pool is exhausted.
 */
export function botName(index: number, taken?: Iterable<string>): string {
  const used = taken ? new Set(taken) : null
  const names = BOTS.names
  for (let i = 0; i < names.length; i++) {
    const candidate = names[(index + i) % names.length]
    if (!used || !used.has(candidate)) return candidate
  }
  return `Bot ${index + 1}`
}

/** Sort helper for scoreboards: kills desc, deaths asc, name asc. */
export function byScore(a: PlayerEntity, b: PlayerEntity): number {
  if (a.kills !== b.kills) return b.kills - a.kills
  if (a.deaths !== b.deaths) return a.deaths - b.deaths
  return a.name.localeCompare(b.name)
}

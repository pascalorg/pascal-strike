/**
 * The match state machine: warmup -> live -> ended -> (next round) warmup ...
 *
 * Pure: no Playroom, no DOM. The host drives it with `update()` and publishes the result as
 * the `match` global state; clients just render whatever the host published.
 */
import { MATCH } from '../config'
import type { MatchPhase, MatchState, TeamId } from '../types'

export interface MatchClock {
  now(): number
}

export interface Match {
  /** Live object — treat as read-only; `update()` returns a copy when it changes. */
  readonly state: MatchState
  /**
   * Advance the machine. `scores` are the host's authoritative kill counts; they are copied
   * into the state (and zeroed by the machine when a new round starts, so the caller should
   * copy `state.scores` back after a phase change).
   * Returns a snapshot when anything changed, else null.
   */
  update(now: number, scores: { a: number; b: number }): MatchState | null
  /** Adopt a state published by a previous host (host migration) or by the server. */
  adopt(state: MatchState): void
  /** Restart at round 1, warmup. */
  reset(now: number): MatchState
}

export function createInitialMatch(now: number): MatchState {
  return {
    phase: 'warmup',
    round: 1,
    startedAt: now,
    endsAt: now + MATCH.warmupMs,
    scores: { a: 0, b: 0 },
    winner: null,
  }
}

/** Milliseconds left in the current phase (never negative). */
export function msLeft(state: MatchState, now: number): number {
  return Math.max(0, state.endsAt - now)
}

/** True while damage is allowed. */
export function isLive(state: MatchState | null | undefined): boolean {
  return !!state && state.phase === 'live'
}

function phaseDuration(phase: MatchPhase): number {
  if (phase === 'warmup') return MATCH.warmupMs
  if (phase === 'live') return MATCH.durationMs
  return MATCH.endScreenMs
}

function decideWinner(scores: { a: number; b: number }): TeamId | null {
  if (scores.a === scores.b) return null
  return scores.a > scores.b ? 'a' : 'b'
}

function snapshot(state: MatchState): MatchState {
  return {
    phase: state.phase,
    round: state.round,
    startedAt: state.startedAt,
    endsAt: state.endsAt,
    scores: { a: state.scores.a, b: state.scores.b },
    winner: state.winner,
  }
}

export function createMatch(clock: MatchClock, initial?: MatchState | null): Match {
  const state: MatchState = initial ? snapshot(initial) : createInitialMatch(clock.now())

  const adopt = (next: MatchState) => {
    state.phase = next.phase
    state.round = next.round
    state.startedAt = next.startedAt
    state.endsAt = next.endsAt
    state.scores.a = next.scores?.a ?? 0
    state.scores.b = next.scores?.b ?? 0
    state.winner = next.winner ?? null
  }

  const enter = (phase: MatchPhase, now: number) => {
    state.phase = phase
    state.startedAt = now
    state.endsAt = now + phaseDuration(phase)
  }

  return {
    state,
    update(now, scores) {
      let changed = false
      if (state.scores.a !== scores.a || state.scores.b !== scores.b) {
        state.scores.a = scores.a
        state.scores.b = scores.b
        changed = true
      }

      if (state.phase === 'warmup') {
        if (now >= state.endsAt) {
          enter('live', now)
          changed = true
        }
      } else if (state.phase === 'live') {
        const reachedTarget =
          state.scores.a >= MATCH.killTarget || state.scores.b >= MATCH.killTarget
        if (reachedTarget || now >= state.endsAt) {
          state.winner = decideWinner(state.scores)
          enter('ended', now)
          changed = true
        }
      } else if (now >= state.endsAt) {
        state.round++
        state.scores.a = 0
        state.scores.b = 0
        state.winner = null
        enter('warmup', now)
        changed = true
      }

      return changed ? snapshot(state) : null
    },
    adopt,
    reset(now) {
      adopt(createInitialMatch(now))
      return snapshot(state)
    },
  }
}

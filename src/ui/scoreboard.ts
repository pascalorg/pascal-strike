/**
 * Tab scoreboard and the end-of-round screen. Both render the same table so the transition
 * between them is just a header swap.
 */
import { TEAMS } from '../config'
import { byScore } from '../game/teams'
import type { MatchState, PlayerEntity, TeamId } from '../types'
import { appRoot, el, formatClock } from './dom'

export interface ScoreboardOptions {
  mount?: HTMLElement
  /** Host clock, for the "next round in" countdown. */
  now?: () => number
  /** Id of the local player, highlighted in the table. */
  localId?: string
}

export interface Scoreboard {
  el: HTMLElement
  show(entities: PlayerEntity[], match: MatchState | null): void
  hide(): void
  end(match: MatchState, entities: PlayerEntity[]): void
  setLocalId(id: string | null): void
  readonly visible: boolean
  dispose(): void
}

export function createScoreboard(opts: ScoreboardOptions = {}): Scoreboard {
  const mount = opts.mount ?? appRoot()
  const now = opts.now ?? (() => Date.now())
  let localId = opts.localId ?? null

  const head = el('div', { class: 'ps-board-head' })
  const cols = el('div', { class: 'ps-board-cols' })
  const foot = el('div', { class: 'ps-board-foot' })
  const winner = el('div', { class: 'ps-winner', style: 'display:none' })
  const inner = el('div', { class: 'ps-board-inner' }, [winner, head, cols, foot])
  const root = el('div', { class: 'ps-board' }, [inner])
  mount.appendChild(root)

  let countdown = 0
  let endState: MatchState | null = null

  const renderTable = (entities: PlayerEntity[], team: TeamId, score: number) => {
    const rows = entities
      .filter((e) => e.team === team)
      .sort(byScore)
      .map((e) =>
        el('tr', { class: `${e.id === localId ? 'is-me' : ''} ${e.alive ? '' : 'is-dead'}`.trim() }, [
          el('td', {}, [e.name, e.isBot ? el('span', { class: 'ps-tag', text: 'BOT' }) : null]),
          el('td', { text: String(e.kills) }),
          el('td', { text: String(e.deaths) }),
          el('td', { class: 'ps-dim', text: '—' }),
        ]),
      )
    return el('div', { class: `ps-board-col ps-team-${team}` }, [
      el('div', { class: 'ps-team-head' }, [
        el('span', { text: TEAMS[team].name }),
        el('b', { text: String(score) }),
      ]),
      el('table', {}, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'Player' }),
            el('th', { text: 'K' }),
            el('th', { text: 'D' }),
            el('th', { text: 'Ping' }),
          ]),
        ]),
        el('tbody', {}, rows),
      ]),
    ])
  }

  const render = (entities: PlayerEntity[], match: MatchState | null) => {
    const scores = match?.scores ?? { a: 0, b: 0 }
    head.replaceChildren(
      el('h2', { text: match ? `Round ${match.round}` : 'Scoreboard' }),
      el('span', {
        text: match
          ? match.phase === 'live'
            ? `${formatClock(match.endsAt - now())} left`
            : match.phase === 'warmup'
              ? 'Warmup'
              : 'Round over'
          : '',
      }),
    )
    cols.replaceChildren(renderTable(entities, 'a', scores.a), renderTable(entities, 'b', scores.b))
    foot.replaceChildren(
      el('span', { text: 'Hold TAB for the scoreboard' }),
      el('span', { text: `${entities.length} players · first to 30 kills` }),
    )
  }

  const board: Scoreboard = {
    el: root,
    show(entities, match) {
      winner.style.display = 'none'
      render(entities, match)
      root.classList.add('is-on')
    },
    hide() {
      if (endState) return // the end screen is not dismissible
      root.classList.remove('is-on')
    },
    end(match, entities) {
      endState = match
      const team = match.winner
      winner.style.display = ''
      winner.replaceChildren(
        el('h1', {
          text: team ? `${TEAMS[team].name} wins` : 'Draw',
          style: team ? `color:${TEAMS[team].color}` : '',
        }),
        el('p', { class: 'ps-next', text: 'Next round starting…' }),
      )
      render(entities, match)
      root.classList.add('is-on')
      window.clearInterval(countdown)
      const next = winner.querySelector('.ps-next') as HTMLElement | null
      const tickCountdown = () => {
        const left = Math.max(0, match.endsAt - now())
        if (next) next.textContent = `Next round in ${Math.ceil(left / 1000)}s`
        if (left <= 0) {
          window.clearInterval(countdown)
          endState = null
          root.classList.remove('is-on')
          winner.style.display = 'none'
        }
      }
      tickCountdown()
      countdown = window.setInterval(tickCountdown, 250)
    },
    setLocalId(id) {
      localId = id
    },
    get visible() {
      return root.classList.contains('is-on')
    },
    dispose() {
      window.clearInterval(countdown)
      root.remove()
    },
  }

  return board
}

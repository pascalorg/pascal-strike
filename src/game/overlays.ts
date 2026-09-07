/**
 * The DOM the game owns on top of the HUD (W2): the loading screen, the team screen, the Esc
 * menu and the `?debug=1` panel — plus the status snapshot both the panel and
 * `window.__ps.state()` read.
 *
 * Everything here is plain DOM on the shared Pascal tokens from `ui/styles.css`; the in-match
 * HUD proper lives in `ui/hud.ts` and is not touched by this file.
 */
import type { Mesh, PerspectiveCamera } from 'three'
import { Box3, Vector3 } from 'three'
import { BUILTIN_MAPS, MATCH, TEAMS } from '../config'
import type { Room } from '../net/room'
import type { TeamChoice, TeamResult } from '../net/protocol'
import { isConfigured, uploadMap } from '../storage/maps-upload'
import type { MapData, MapSelection, MatchState, TeamId } from '../types'
import { el } from '../ui/dom'
import { createGraphicsSettings } from '../ui/graphics-settings'
import type { Graphics } from '../engine/graphics'
import type { EntityRegistry } from './entities'
import type { LocalPlayer } from './local-player'
import type { MapSession } from './map-session'
import { msLeft } from './match'

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadingOverlay {
  set(progress: number, text: string): void
  show(): void
  hide(): void
  dispose(): void
}

export function createLoadingOverlay(mount: HTMLElement): LoadingOverlay {
  const bar = el('i', {
    style: 'display:block;height:100%;width:0;background:var(--team-a);transition:width 160ms',
  })
  const label = el('div', { class: 'ps-map-meta', style: 'margin-top:10px', text: 'Loading' })
  const screen = el('div', { class: 'ps-screen', style: 'z-index:20' }, [
    el('div', { class: 'ps-card', style: 'max-width:420px;text-align:center' }, [
      el('h1', { class: 'ps-title', html: 'Pascal <em>Strike</em>' }),
      el(
        'div',
        { style: 'height:6px;border-radius:99px;background:#27272a;overflow:hidden;margin-top:18px' },
        [bar],
      ),
      label,
    ]),
  ])
  mount.appendChild(screen)
  return {
    set(progress, text) {
      bar.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`
      label.textContent = text
    },
    show() {
      screen.style.display = ''
    },
    hide() {
      screen.style.display = 'none'
    },
    dispose() {
      screen.remove()
    },
  }
}

// ---------------------------------------------------------------------------
// Team screen (W5-A) — pick a side before you play
// ---------------------------------------------------------------------------

/** One line of a team card's roster. */
export interface RosterMember {
  id: string
  name: string
  isBot: boolean
  isLocal: boolean
}

export interface TeamRoster {
  a: RosterMember[]
  b: RosterMember[]
  /** Humans who have not picked yet — us included while the screen is up. */
  choosing: RosterMember[]
}

export type TeamScreenMode = 'join' | 'change'

export interface TeamScreenOptions {
  mount: HTMLElement
  audio?: { play(name: 'deny'): void }
  /** Polled while the screen is open; bots and counts move under it. */
  roster(): TeamRoster
  /** Our team, or null while we are still choosing. */
  myTeam(): TeamId | null
  /** Ask the host. The screen shakes the card and shows the reason when it says no. */
  onPick(choice: TeamChoice): Promise<TeamResult>
  /** "Back" (and Esc) in `change` mode — the join mode has no way out but picking. */
  onBack(): void
}

export interface TeamScreen {
  readonly isOpen: boolean
  readonly mode: TeamScreenMode | null
  open(mode: TeamScreenMode): void
  close(): void
  dispose(): void
}

const REFUSE_SHAKE_MS = 500
const ROSTER_POLL_MS = 400
/** Card order = the 1/2/3 keys. */
const PICK_KEYS: readonly TeamChoice[] = ['a', 'b', 'auto']

export function createTeamScreen(opts: TeamScreenOptions): TeamScreen {
  let open = false
  let mode: TeamScreenMode | null = null
  let busy = false
  /** What Enter confirms: follows the keys, the pointer and (on open) our current side. */
  let selected: TeamChoice = 'auto'
  let refuseTimer = 0
  let pollTimer = 0

  const note = el('div', { class: 'ps-note ps-pick-note' })
  const cards: Record<string, HTMLButtonElement> = {}
  const counts: Record<string, HTMLElement> = {}
  const rosters: Record<string, HTMLElement> = {}
  const autoHint = el('span', { class: 'ps-pick-hint', text: 'Join the smaller team' })

  const card = (choice: TeamChoice, index: number): HTMLButtonElement => {
    const name = choice === 'auto' ? 'Auto' : TEAMS[choice].name
    const count = el('span', { class: 'ps-pick-count ps-mono' })
    const list = el('div', { class: 'ps-pick-roster' })
    counts[choice] = count
    rosters[choice] = list
    const node = el(
      'button',
      { class: `ps-pick ps-pick--${choice}`, type: 'button', 'aria-pressed': 'false' },
      [
        el('span', { class: 'ps-pick-top' }, [
          el('span', { class: 'ps-team-dot' }),
          el('span', { class: 'ps-pick-name', text: name }),
          el('span', { class: 'ps-pick-key ps-mono', text: String(index + 1) }),
        ]),
        choice === 'auto' ? autoHint : count,
        list,
      ],
    )
    node.addEventListener('click', () => pick(choice))
    node.addEventListener('pointerenter', () => {
      selected = choice
      renderSelection()
    })
    cards[choice] = node
    return node
  }

  const back = el('button', { class: 'ps-btn ps-btn--ghost', style: 'display:none' }, ['Back'])
  const title = el('h1', { class: 'ps-title', text: 'Choose your team' })
  const tagline = el('p', {
    class: 'ps-tagline',
    html: 'Pick a side to drop into the house. <b>1</b> / <b>2</b> / <b>3</b> or <b>ENTER</b>.',
  })
  const choosing = el('div', { class: 'ps-choosing' })
  const screen = el('div', { class: 'ps-screen ps-screen--glass ps-screen--teams', style: 'z-index:18;display:none' }, [
    el('div', { class: 'ps-card ps-card--teams' }, [
      title,
      tagline,
      el('div', { class: 'ps-picks' }, PICK_KEYS.map(card)),
      choosing,
      note,
      el('div', { class: 'ps-pick-foot' }, [back]),
    ]),
  ])
  opts.mount.appendChild(screen)
  back.addEventListener('click', () => opts.onBack())

  /** The card the host refused: a 0.5 s shake, then it is a normal card again. */
  const refuse = (choice: TeamChoice, reason: string) => {
    note.textContent = reason
    opts.audio?.play('deny')
    const node = cards[choice]
    window.clearTimeout(refuseTimer)
    for (const key of PICK_KEYS) cards[key].classList.remove('is-refused')
    // Reflow between remove and add, or a second refusal on the same card plays no animation.
    void node.offsetWidth
    node.classList.add('is-refused')
    refuseTimer = window.setTimeout(() => node.classList.remove('is-refused'), REFUSE_SHAKE_MS)
  }

  const pick = (choice: TeamChoice) => {
    if (!open || busy) return
    selected = choice
    if (choice !== 'auto' && opts.myTeam() === choice) return void opts.onBack()
    busy = true
    note.textContent = 'Asking the host…'
    renderSelection()
    void opts
      .onPick(choice)
      .then((result) => {
        if (result?.ok) note.textContent = ''
        else refuse(choice, result?.reason || 'The host turned that down')
      })
      .catch((err: Error) => refuse(choice, err.message))
      .finally(() => {
        busy = false
        renderSelection()
      })
  }

  const renderSelection = () => {
    const mine = opts.myTeam()
    for (const choice of PICK_KEYS) {
      const node = cards[choice]
      node.classList.toggle('is-selected', choice === selected)
      node.setAttribute('aria-pressed', String(choice !== 'auto' && choice === mine))
      node.toggleAttribute('disabled', busy)
    }
  }

  const renderRoster = () => {
    const roster = opts.roster()
    for (const team of TEAM_KEYS) {
      const members = roster[team]
      counts[team].textContent = `${members.length}/${MATCH.teamSize}`
      rosters[team].replaceChildren(...members.map(memberRow))
    }
    // Auto's own preview of what the host would decide, by the same rule (smaller side first).
    const smaller = roster.b.length < roster.a.length ? 'b' : 'a'
    autoHint.textContent =
      roster.a.length === roster.b.length
        ? 'Join the smaller team'
        : `Join the smaller team · ${TEAMS[smaller].name}`
    rosters.auto.replaceChildren(
      el('span', { class: 'ps-pick-member ps-dim', text: 'The host decides' }),
    )
    const waiting = roster.choosing
    choosing.replaceChildren(
      el('span', { class: 'ps-label', text: `Choosing… ${waiting.length}` }),
      el('span', {
        class: 'ps-choosing-names',
        text: waiting.length ? waiting.map((m) => (m.isLocal ? `${m.name} (you)` : m.name)).join(' · ') : '—',
      }),
    )
    renderSelection()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return
    // Every key this screen uses is swallowed here, not just defaulted away: 1/2/3 are also the
    // weapon slots and Escape also opens the Esc menu, and both of those listen on `document`
    // too. Picking Teal with the 2 key must not put a pistol in your hands on the way in.
    const take = () => {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }
    const digit = /^(?:Digit|Numpad)([1-3])$/.exec(event.code)
    if (digit) {
      take()
      pick(PICK_KEYS[Number(digit[1]) - 1])
      return
    }
    if (event.code === 'Enter' || event.code === 'NumpadEnter') {
      take()
      // Enter on the side we are already on means "never mind": the same as Back.
      pick(selected)
      return
    }
    if (event.code === 'Escape' && mode === 'change') {
      take()
      opts.onBack()
    }
  }
  // Capture, so this runs before the input module and the game's own Escape handler.
  document.addEventListener('keydown', onKeyDown, true)

  const teamScreen: TeamScreen = {
    get isOpen() {
      return open
    },
    get mode() {
      return mode
    },
    open(next) {
      mode = next
      note.textContent = ''
      busy = false
      selected = opts.myTeam() ?? 'auto'
      title.textContent = next === 'change' ? 'Change team' : 'Choose your team'
      back.style.display = next === 'change' ? '' : 'none'
      renderRoster()
      if (open) return
      open = true
      screen.style.display = ''
      window.clearInterval(pollTimer)
      pollTimer = window.setInterval(renderRoster, ROSTER_POLL_MS)
    },
    close() {
      if (!open) return
      open = false
      mode = null
      screen.style.display = 'none'
      window.clearInterval(pollTimer)
    },
    dispose() {
      window.clearInterval(pollTimer)
      window.clearTimeout(refuseTimer)
      document.removeEventListener('keydown', onKeyDown, true)
      screen.remove()
    },
  }
  return teamScreen
}

function memberRow(member: RosterMember): HTMLElement {
  return el('span', { class: `ps-pick-member${member.isLocal ? ' is-me' : ''}` }, [
    member.name,
    member.isBot ? el('span', { class: 'ps-tag', text: 'BOT' }) : null,
  ])
}

// ---------------------------------------------------------------------------
// Overview camera (W5-A) — what the team screen looks at
// ---------------------------------------------------------------------------

export interface OverviewCamera {
  /** Fly one frame. Call it instead of the FPS camera while the team screen is up. */
  update(dt: number): void
  /** Start the turn from the north side again (a fresh screen). */
  reset(): void
}

/** One turn per this long, and how far down the camera tilts. */
const ORBIT_PERIOD_S = 40
const ORBIT_PITCH_DEG = 25
/**
 * How the house sits in the frame: over the turn it takes this much of the height on average
 * (a corner-on view is taller than a face-on one) and never more than `_MAX`, never more than
 * `ORBIT_FILL_WIDTH` of the width, and its centre lands `ORBIT_CENTRE_FROM_TOP` down from the
 * top — the card is a bottom sheet (`.ps-screen--teams`), so the house belongs in the upper two
 * thirds.
 */
const ORBIT_FILL_HEIGHT = 0.6
const ORBIT_FILL_HEIGHT_MAX = 0.66
const ORBIT_FILL_WIDTH = 0.92
const ORBIT_CENTRE_FROM_TOP = 0.35
/** The circle never tightens past this, whatever the box says (a broken export, a shed). */
const ORBIT_MIN_RADIUS = 4
const ORBIT_MAX_RADIUS = 200
/** A mesh wider than this on X or Z is the lot, not the house (the loader's terrain rule). */
const BUILDING_MAX_EXTENT = 20
/** Angles sampled around the circle when fitting: the house is a box, and a box turns. */
const ORBIT_FIT_SAMPLES = 12
const ORBIT_FIT_STEPS = 20
/**
 * The fit measures a spread of the house's own vertices rather than its box: the box's corners
 * stand well clear of a pitched roof, and fitting them left the house at 40 % of the frame.
 */
const ORBIT_FIT_POINTS = 1024

const _orbitCenter = new Vector3()
const _orbitSize = new Vector3()
const _levelBox = new Box3()
const _corner = new Vector3()
const _meshSize = new Vector3()
const _orbitTarget = new Vector3()

/**
 * The BUILDING's box, not the map's. `MapData.bounds` is the collider's, and the collider
 * includes Pascal's 30 m terrain plane, which would push the circle out to 25 m and 15 m up —
 * from there the roof is the whole picture. Measured from what actually renders (after batching
 * the level nodes hold nothing but hidden originals, and the roofs live in their own batch),
 * skipping anything lot-sized; a plain GLB with nothing else falls back to the collider's box.
 */
function buildingMeshes(map: MapData): Mesh[] {
  const meshes: Mesh[] = []
  map.root.updateMatrixWorld(true)
  map.root.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh || !mesh.visible) return
    const geometry = mesh.geometry
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    if (!geometry.boundingBox) return
    _levelBox.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld).getSize(_meshSize)
    if (_meshSize.x > BUILDING_MAX_EXTENT || _meshSize.z > BUILDING_MAX_EXTENT) return
    meshes.push(mesh)
  })
  return meshes
}

function buildingBounds(map: MapData, meshes: Mesh[]): Box3 {
  const box = new Box3()
  for (const mesh of meshes) {
    box.union(_levelBox.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld))
  }
  return box.isEmpty() ? box.copy(map.bounds) : box
}

/**
 * About `ORBIT_FIT_POINTS` of the house's vertices in world space, taken at a fixed stride
 * across every mesh so the sample follows the geometry — where the roofs actually peak, not
 * where their box does. Empty when the map has no building meshes (the box's corners then).
 */
function buildingPoints(meshes: Mesh[], box: Box3): Float32Array {
  let total = 0
  for (const mesh of meshes) total += mesh.geometry.getAttribute('position')?.count ?? 0
  if (total === 0) {
    const corners = new Float32Array(8 * 3)
    for (let i = 0; i < 8; i++) {
      corners[i * 3] = i & 1 ? box.max.x : box.min.x
      corners[i * 3 + 1] = i & 2 ? box.max.y : box.min.y
      corners[i * 3 + 2] = i & 4 ? box.max.z : box.min.z
    }
    return corners
  }
  const stride = Math.max(1, Math.floor(total / ORBIT_FIT_POINTS))
  const points = new Float32Array(Math.ceil(total / stride) * 3)
  let written = 0
  let next = 0
  let seen = 0
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position')
    if (!position) continue
    for (let i = 0; i < position.count; i++, seen++) {
      if (seen < next) continue
      next = seen + stride
      _corner.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld)
      points[written++] = _corner.x
      points[written++] = _corner.y
      points[written++] = _corner.z
    }
  }
  return points.subarray(0, written)
}

/**
 * A slow circle around the house while the player picks a side: the match runs behind the
 * screen, so this is the only camera work the game does for a spectator.
 *
 * The circle is fitted, not fixed: the radius is the tightest at which the house, seen from every
 * angle of the turn, stays inside `ORBIT_FILL_HEIGHT` of the frame, and the aim point is then
 * lowered until the house's centre sits at `ORBIT_CENTRE_FROM_TOP`. The fit is redone when the
 * camera's aspect or field of view changes (a resize), never per frame.
 */
export function createOverviewCamera(camera: PerspectiveCamera, map: MapData): OverviewCamera {
  const meshes = buildingMeshes(map)
  const bounds = buildingBounds(map, meshes)
  const points = buildingPoints(meshes, bounds)
  bounds.getCenter(_orbitCenter)
  bounds.getSize(_orbitSize)
  const center = _orbitCenter.clone()
  const tan = Math.tan((ORBIT_PITCH_DEG * Math.PI) / 180)
  let radius = ORBIT_MIN_RADIUS
  let aimY = bounds.min.y + _orbitSize.y * 0.35
  let fittedAspect = 0
  let fittedFov = 0
  let angle = 0

  /** Park the camera on the circle at `a`, looking at the aim point. */
  function place(a: number, r: number, y: number): void {
    camera.position.set(center.x + Math.sin(a) * r, y + r * tan, center.z + Math.cos(a) * r)
    camera.up.set(0, 1, 0)
    _orbitTarget.set(center.x, y, center.z)
    camera.lookAt(_orbitTarget)
    camera.updateMatrixWorld()
  }

  // NDC extent of the house's sample points at one camera pose. Written to the four slots below.
  let top = 0
  let bottom = 0
  let left = 0
  let right = 0
  function measure(): void {
    top = -Infinity
    bottom = Infinity
    left = Infinity
    right = -Infinity
    for (let i = 0; i < points.length; i += 3) {
      _corner.fromArray(points, i).project(camera)
      if (_corner.y > top) top = _corner.y
      if (_corner.y < bottom) bottom = _corner.y
      if (_corner.x > right) right = _corner.x
      if (_corner.x < left) left = _corner.x
    }
  }

  /** The turn's fill against its three budgets, as a fraction of each: 1 means it just fits. */
  function worstFill(r: number, y: number): number {
    let sumY = 0
    let maxY = 0
    let maxX = 0
    for (let i = 0; i < ORBIT_FIT_SAMPLES; i++) {
      place((i / ORBIT_FIT_SAMPLES) * Math.PI * 2, r, y)
      measure()
      const fillY = (top - bottom) * 0.5
      const fillX = (right - left) * 0.5
      sumY += fillY
      if (fillY > maxY) maxY = fillY
      if (fillX > maxX) maxX = fillX
    }
    return Math.max(
      sumY / ORBIT_FIT_SAMPLES / ORBIT_FILL_HEIGHT,
      maxY / ORBIT_FILL_HEIGHT_MAX,
      maxX / ORBIT_FILL_WIDTH,
    )
  }

  /** Mean NDC y of the house's centre over the turn. */
  function meanCentre(r: number, y: number): number {
    let sum = 0
    for (let i = 0; i < ORBIT_FIT_SAMPLES; i++) {
      place((i / ORBIT_FIT_SAMPLES) * Math.PI * 2, r, y)
      measure()
      sum += (top + bottom) * 0.5
    }
    return sum / ORBIT_FIT_SAMPLES
  }

  function fit(): void {
    fittedAspect = camera.aspect
    fittedFov = camera.fov
    const wantCentre = 1 - 2 * ORBIT_CENTRE_FROM_TOP
    // Radius and aim point pull on each other (a lower aim tilts the house up the frame and
    // changes its extent), so alternate: each pass is a bisection, three passes settle it.
    for (let pass = 0; pass < 3; pass++) {
      let lo = ORBIT_MIN_RADIUS
      let hi = ORBIT_MAX_RADIUS
      for (let step = 0; step < ORBIT_FIT_STEPS; step++) {
        const mid = (lo + hi) * 0.5
        if (worstFill(mid, aimY) > 1) lo = mid
        else hi = mid
      }
      radius = hi
      let yLo = bounds.min.y - _orbitSize.y * 2
      let yHi = bounds.max.y + _orbitSize.y * 2
      for (let step = 0; step < ORBIT_FIT_STEPS; step++) {
        const mid = (yLo + yHi) * 0.5
        // The house sits too low in the frame: aim lower, and it rises.
        if (meanCentre(radius, mid) < wantCentre) yHi = mid
        else yLo = mid
      }
      aimY = (yLo + yHi) * 0.5
    }
  }

  return {
    update(dt) {
      if (camera.aspect !== fittedAspect || camera.fov !== fittedFov) fit()
      angle += (dt / ORBIT_PERIOD_S) * Math.PI * 2
      place(angle, radius, aimY)
    },
    reset() {
      angle = 0
    },
  }
}

// ---------------------------------------------------------------------------
// Pause / Esc menu
// ---------------------------------------------------------------------------

export interface PauseMenuOptions {
  mount: HTMLElement
  graphics: Graphics
  room: Room
  isHost(): boolean
  onResume(): void
  onMap(map: MapSelection): void
  onAudio(on: boolean): void
  onLeave(): void
  /** Room state: does the host fill empty slots with bots? Read while the menu is open. */
  botsFill(): boolean
  /** Host-only — the menu never calls this for anyone else. */
  setBotsFill(on: boolean): void
  /** Heads on each team, bots included — what the scoreboard shows. Polled while open. */
  teams(): { a: number; b: number }
  /** Our team, or null while we are still choosing. */
  myTeam(): TeamId | null
  /**
   * Open the team screen over the match (W5-A). The menu no longer swaps sides itself: one
   * screen owns the decision, with the rosters and the same rules whether it is your first
   * pick or your fourth.
   */
  onChangeTeam(): void
}

export interface PauseMenu {
  readonly isOpen: boolean
  open(): void
  close(): void
  /** A line of feedback under the card (host refusals, mostly). Fades after a few seconds. */
  toast(text: string): void
  dispose(): void
}

const TOAST_MS = 3_400

export function createPauseMenu(opts: PauseMenuOptions): PauseMenu {
  const graphics = createGraphicsSettings(opts.graphics)
  const note = el('div', { class: 'ps-note' })
  const mapsRow = el('div', { class: 'ps-maps', style: 'margin-top:10px' })
  const mapsField = el('div', { class: 'ps-field', style: 'display:none' }, [
    el('label', { class: 'ps-label', text: 'Change map — everyone reloads' }),
    mapsRow,
  ])
  const resume = el('button', { class: 'ps-btn ps-btn--primary ps-btn--block' }, ['Play'])
  const invite = el('button', { class: 'ps-btn ps-btn--block' }, ['Copy invite link'])
  const sound = el('button', { class: 'ps-btn ps-btn--block' }, ['Sound: on'])
  const bots = el('button', { class: 'ps-btn ps-btn--block' }, ['Bots: on'])
  const leave = el('button', { class: 'ps-btn ps-btn--ghost ps-btn--block' }, ['Leave to lobby'])
  const toastNode = el('div', { class: 'ps-toast' })
  const teamDot = el('span', { class: 'ps-team-dot' })
  const teamLabel = el('span', { class: 'ps-team-name', text: 'Choosing…' })
  const teamAction = el('span', { class: 'ps-team-count', text: 'Change' })
  const teamButton = el('button', { class: 'ps-team-pick ps-team-pick--a', type: 'button' }, [
    teamDot,
    teamLabel,
    teamAction,
  ])
  const teamField = el('div', { class: 'ps-field', style: 'margin-top:18px' }, [
    el('label', { class: 'ps-label', text: 'Team' }),
    el('div', { class: 'ps-teams ps-teams--one' }, [teamButton]),
  ])
  /**
   * The menu is glass, not a wall: the match keeps rendering *and* running behind it (remotes,
   * bots, the timer and the kill feed all carry on) — the only thing that stops is us, because
   * releasing the pointer lock stops feeding the controller. Hence `ps-screen--glass`: no opaque
   * gradient, no grid, just ≈ 55 % black and a blur light enough to read the HUD through.
   */
  const screen = el('div', { class: 'ps-screen ps-screen--glass', style: 'z-index:15;display:none' }, [
    el('div', { class: 'ps-card ps-card--menu' }, [
      el('h1', { class: 'ps-title', html: 'Pascal <em>Strike</em>' }),
      el('p', {
        class: 'ps-tagline',
        html: '<b>WASD</b> move · <b>SHIFT</b> walk · <b>SPACE</b> jump · <b>CTRL</b> crouch · <b>R</b> reload · <b>E</b> doors · <b>TAB</b> scores · <b>ESC</b> menu',
      }),
      el('div', { class: 'ps-actions' }, [resume, invite]),
      teamField,
      mapsField,
      graphics.node,
      el('div', { class: 'ps-actions' }, [bots, sound, leave, note]),
    ]),
    toastNode,
  ])
  opts.mount.appendChild(screen)

  const fileInput = el('input', { type: 'file', accept: '.glb', style: 'display:none' })
  screen.appendChild(fileInput)
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (!file) return
    note.textContent = `Uploading ${file.name}…`
    uploadMap(file, (p) => {
      note.textContent = `Uploading ${file.name}… ${Math.round(p * 100)}%`
    })
      .then((map) => {
        note.textContent = `${map.name} is live for everyone.`
        opts.onMap(map)
      })
      .catch((err: Error) => {
        note.textContent = err.message
      })
  })

  const renderMaps = () => {
    mapsField.style.display = opts.isHost() ? '' : 'none'
    if (!opts.isHost() || mapsRow.childElementCount > 0) return
    for (const builtin of BUILTIN_MAPS) {
      const card = el('button', { class: 'ps-map', type: 'button' }, [
        el('span', { class: 'ps-map-name', text: builtin.name }),
        el('span', { class: 'ps-map-meta', text: 'Built-in · Pascal export' }),
      ])
      card.addEventListener('click', () => opts.onMap({ ...builtin }))
      mapsRow.appendChild(card)
    }
    if (isConfigured()) {
      const drop = el('button', { class: 'ps-drop', type: 'button' }, [
        el('span', { html: '<b>Upload a Pascal GLB</b> &nbsp;·&nbsp; everyone reloads' }),
      ])
      drop.addEventListener('click', () => fileInput.click())
      mapsRow.appendChild(drop)
    }
  }

  /**
   * The host owns the setting, so everyone else gets the same line without a button: the state
   * is the room's, not this client's. Re-read on a timer so a flip by the host (or a host
   * migration) shows up on a menu that is already open.
   */
  const renderBots = () => {
    const on = opts.botsFill()
    const host = opts.isHost()
    bots.textContent = host
      ? `Bots fill empty slots: ${on ? 'on' : 'off'}`
      : `Bots: ${on ? 'on' : 'off'}`
    bots.toggleAttribute('disabled', !host)
    bots.title = host
      ? 'Off empties the room of bots; on refills both teams to three.'
      : 'Only the host can change this.'
  }

  let open = false
  let audioOn = true
  let toastTimer = 0
  /** The very first open is the "click to start" screen; every one after it is a pause. */
  let played = false

  /**
   * One row now: which side we are on and the way back to the team screen (W5-A). Counts
   * include bots on purpose — three heads a side is what the player sees, and the host moves a
   * bot the other way when a human swaps, so "3/3" stays true through the swap.
   */
  const renderTeams = () => {
    const counts = opts.teams()
    const mine = opts.myTeam()
    teamButton.className = `ps-team-pick ps-team-pick--${mine ?? 'a'}`
    teamDot.style.opacity = mine ? '1' : '0.35'
    teamLabel.textContent = mine
      ? `${TEAMS[mine].name} · ${counts[mine] ?? 0}/${MATCH.teamSize}`
      : 'Choosing…'
    teamAction.textContent = mine ? 'Change team' : 'Pick a team'
    teamButton.setAttribute('aria-pressed', String(!!mine))
  }
  teamButton.addEventListener('click', () => {
    menu.close()
    opts.onChangeTeam()
  })

  const menu: PauseMenu = {
    get isOpen() {
      return open
    },
    open() {
      if (open) return
      open = true
      resume.textContent = played ? 'Resume' : 'Play'
      renderMaps()
      renderBots()
      renderTeams()
      screen.style.display = ''
    },
    close() {
      if (!open) return
      open = false
      screen.style.display = 'none'
    },
    toast(text) {
      toastNode.textContent = text
      toastNode.classList.add('is-on')
      window.clearTimeout(toastTimer)
      toastTimer = window.setTimeout(() => toastNode.classList.remove('is-on'), TOAST_MS)
    },
    dispose() {
      window.clearInterval(botsTimer)
      graphics.dispose()
      window.clearTimeout(toastTimer)
      screen.remove()
    },
  }

  // The room decides both of these, not this client: a flip by the host, a joining player or a
  // host migration has to show up on a menu that is already open.
  const botsTimer = window.setInterval(() => {
    if (!open) return
    renderBots()
    renderTeams()
  }, 500)

  resume.addEventListener('click', () => {
    played = true
    menu.close()
    opts.onResume()
  })
  invite.addEventListener('click', () => {
    note.textContent = opts.room.inviteUrl
    void navigator.clipboard?.writeText(opts.room.inviteUrl).then(() => {
      note.textContent = 'Invite link copied to the clipboard.'
    })
  })
  sound.addEventListener('click', () => {
    audioOn = !audioOn
    sound.textContent = `Sound: ${audioOn ? 'on' : 'off'}`
    opts.onAudio(audioOn)
  })
  bots.addEventListener('click', () => {
    if (!opts.isHost()) return
    const next = !opts.botsFill()
    opts.setBotsFill(next)
    renderBots()
    note.textContent = next
      ? 'Bots will refill both teams to three.'
      : 'Bots kicked — humans only until you turn this back on.'
  })
  leave.addEventListener('click', () => opts.onLeave())

  return menu
}

const TEAM_KEYS: readonly TeamId[] = ['a', 'b']

// ---------------------------------------------------------------------------
// Debug panel + status snapshot
// ---------------------------------------------------------------------------

/** Everything the debug panel and `window.__ps.state()` need, sampled at call time. */
export interface GameStatus {
  backend: string
  fps: number
  room: Room
  clockOffset: number
  now: number
  registry: EntityRegistry
  /** Null for the length of a map change: the old world is gone, the next one is loading. */
  session: MapSession | null
  match: MatchState | null
  local: LocalPlayer
  bots: boolean
  /** Room setting, not "is the bot runner up": whether empty slots get filled with bots. */
  botsFill: boolean
  menuOpen: boolean
  locked: boolean
  /** Our side, or null while the team screen is up (W5-A). */
  myTeam: TeamId | null
  /** Which team screen is showing, if any. */
  teamScreen: TeamScreenMode | null
  /** Names of everyone still choosing, us included. */
  choosing: string[]
  /**
   * Is `room.isHost()` believed yet? The authority only starts once it has held for
   * `HOST_STABLE_MS`, so this and `isHost` disagree for a few seconds around a migration.
   */
  hostConfirmed: boolean
  /**
   * Why the host last refused one of our hits, for a couple of seconds after it said so, or
   * null. The one thing that turns "my shots do nothing" into a report with a cause in it.
   */
  hitRejection: string | null
}

/** JSON-friendly view of the whole game — the playtest harness asserts against this. */
export function statusSnapshot(s: GameStatus) {
  const me = s.registry.local
  const session = s.session
  return {
    backend: s.backend,
    fps: Math.round(s.fps),
    room: s.room.roomCode,
    invite: s.room.inviteUrl,
    isHost: s.room.isHost(),
    hostConfirmed: s.hostConfirmed,
    /** Null while a map change is in flight — the playtests read it as "still loading". */
    map: session?.selection.name ?? null,
    mapUrl: session?.selection.url ?? null,
    navReady: !!session?.nav?.ready,
    spawns: session && {
      a: session.spawns.a.length,
      b: session.spawns.b.length,
      source: session.spawns.source,
    },
    doorsOpen: session
      ? session.map.doors.filter((d) => session.doors.isOpen(d.id)).map((d) => d.label)
      : [],
    decals: session?.decals.count ?? 0,
    balls: session?.projectiles.liveCount ?? 0,
    bots: s.bots,
    botsFill: s.botsFill,
    menuOpen: s.menuOpen,
    locked: s.locked,
    teamScreen: s.teamScreen,
    spectating: s.local.spectating,
    myTeam: s.myTeam,
    choosing: s.choosing,
    hitRejection: s.hitRejection,
    match: s.match && {
      phase: s.match.phase,
      round: s.match.round,
      scores: { ...s.match.scores },
      msLeft: Math.round(msLeft(s.match, s.now)),
    },
    me: me && {
      id: me.id.slice(0, 6),
      name: me.name,
      // The entity always carries a side (it has nowhere to put "none"); `myTeam` above is the
      // honest one while we are choosing.
      team: s.myTeam,
      hp: me.hp,
      alive: me.alive,
      kills: me.kills,
      deaths: me.deaths,
      frozen: s.local.dead,
      pos: round2(s.local.position),
      yaw: Number(s.local.yaw.toFixed(3)),
    },
    entities: s.registry.list().map((e) => ({
      id: e.id.slice(0, 6),
      name: e.name,
      team: e.team,
      bot: e.isBot,
      local: e.isLocal,
      hp: e.hp,
      alive: e.alive,
      kills: e.kills,
      deaths: e.deaths,
      pos: round2(e.position),
    })),
  }
}

export interface DebugPanel {
  update(): void
  dispose(): void
}

export function createDebugPanel(
  mount: HTMLElement,
  enabled: boolean,
  read: () => GameStatus,
): DebugPanel {
  if (!enabled) return { update() {}, dispose() {} }
  // Below the HUD's room-code chip (`.ps-room`, top-left at `--hud-pad`), not on top of it:
  // the chip is ~28 px tall, so the panel starts one chip plus a gap further down.
  const node = el('div', {
    class: 'ps-debug',
    style:
      'position:absolute;left:var(--hud-pad);top:calc(var(--hud-pad) + 42px);z-index:9;' +
      'font:11px/1.5 JetBrains Mono,monospace;' +
      'color:#a1a1aa;background:#09090bcc;border:1px solid #27272a;border-radius:8px;' +
      'padding:8px 10px;pointer-events:none;white-space:pre',
  })
  mount.appendChild(node)
  return {
    update() {
      const s = read()
      const p = s.local.position
      const session = s.session
      node.textContent = [
        `${s.backend} · ${Math.round(s.fps)} fps`,
        `room ${s.room.roomCode}${s.room.isHost() ? (s.hostConfirmed ? ' (host)' : ' (host?)') : ''} · clock ${s.clockOffset} ms`,
        `team ${s.myTeam ?? '—'}${s.teamScreen ? ` · picking (${s.teamScreen})` : ''}${
          s.choosing.length ? ` · choosing ${s.choosing.length}` : ''
        }`,
        `entities ${s.registry.size} · bots ${s.bots ? 'on' : 'off'} · fill ${s.botsFill ? 'on' : 'off'} · nav ${session?.nav?.ready ? 'ready' : '…'}`,
        session
          ? `spawns ${session.spawns.source} a=${session.spawns.a.length} b=${session.spawns.b.length}`
          : 'loading the next map…',
        `decals ${session?.decals.count ?? 0} · balls ${session?.projectiles.liveCount ?? 0}`,
        `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)} · yaw ${s.local.yaw.toFixed(2)}`,
        s.match
          ? `${s.match.phase} r${s.match.round} ${s.match.scores.a}:${s.match.scores.b} ${Math.round(msLeft(s.match, s.now) / 1000)}s`
          : 'match —',
        s.hitRejection ? `hit refused · ${s.hitRejection}` : null,
        'N navmesh · C collider',
      ]
        .filter((line): line is string => line !== null)
        .join('\n')
    },
    dispose() {
      node.remove()
    },
  }
}

function round2(v: { x: number; y: number; z: number }): [number, number, number] {
  return [Number(v.x.toFixed(2)), Number(v.y.toFixed(2)), Number(v.z.toFixed(2))]
}
